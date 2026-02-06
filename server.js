// server.js — Multi-tenant Q/A store with per-company PDFs + SendGrid inbound
console.log('BOOT', { cwd: process.cwd(), node: process.version });

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const { DateTime } = require('luxon');
const cors = require('cors');


// DocsBot + Desktop mirror config
const DOCSBOT_API_KEY = (process.env.DOCSBOT_API_KEY || '').trim();
const DOCSBOT_MAP = {
  "1stanswerbot": "Tuy1mgF9xidg0KhsHmMr/eF9K4VnlybhOGpIqz0iH",
  "serverpartners": "Tuy1mgF9xidg0KhsHmMr/CHJTUkAyMBecrlVp51Zq"
};

const DESKTOP_PATH = "/Users/ethanpoto/Desktop/docsbot-backend"; // desktop mirror root

// --- DOCSBOT AUTO-UPLOAD HELPER (with safe replace) ---
async function uploadToDocsBot(slug, pdfPath) {
  try {
    const botMap = {
      '1stanswerbot': 'eF9K4VnlybhOGpIqz0iH',
      'serverpartners': 'CHJTUkAyMBecrlVp51Zq'
    };
    const botId = botMap[slug];
    if (!botId) {
      console.warn(`No DocsBot ID for slug "${slug}", skipping upload.`);
      return;
    }

    const teamId = process.env.DOCSBOT_TEAM_ID;
    const apiKey = process.env.DOCSBOT_API_KEY;
    const fileName = path.basename(pdfPath);
    const fileBuf = fs.readFileSync(pdfPath);

    // STEP 0: check for existing sources with same title
    console.log(`🔍 Checking existing DocsBot sources for ${slug}...`);
    try {
      const listRes = await fetch(`https://docsbot.ai/api/teams/${teamId}/bots/${botId}/sources`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const listJson = await listRes.json();
      if (listJson?.sources?.length) {
        const existing = listJson.sources.find(s => s.title === fileName);
        if (existing) {
          console.log(`🗑️  Removing old DocsBot source ${existing.id} (${fileName})`);
          await fetch(`https://docsbot.ai/api/teams/${teamId}/bots/${botId}/sources/${existing.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${apiKey}` }
          });
        }
      }
    } catch (e) {
      console.warn('⚠️  Could not fetch/delete old source, continuing normally:', e.message);
    }

    // STEP 1: get presigned upload URL
    const signUrl = `https://docsbot.ai/api/teams/${teamId}/bots/${botId}/upload-url?fileName=${encodeURIComponent(fileName)}`;
    console.log('📡 Requesting DocsBot signed URL:', signUrl);
    const pres = await fetch(signUrl, { headers: { Authorization: `Bearer ${apiKey}` }});
    const presJson = await pres.json();
    if (!pres.ok || !presJson.url || !presJson.file) {
      console.error('Failed to get signed URL:', presJson);
      return;
    }

    // STEP 2: upload to cloud
    console.log('⬆️  Uploading to DocsBot cloud…');
    const upResp = await fetch(presJson.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileBuf,
    });
    if (!upResp.ok) {
      console.error('Upload failed:', await upResp.text());
      return;
    }

    // STEP 3: create the new source
    console.log('🧩 Creating source in DocsBot…');
    const srcResp = await fetch(`https://docsbot.ai/api/teams/${teamId}/bots/${botId}/sources`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'document',
        title: fileName,
        file: presJson.file,
      }),
    });
    const srcJson = await srcResp.json();
    if (!srcResp.ok) {
      console.error('Create source failed:', srcJson);
      return;
    }

    console.log(`✅ DocsBot updated: ${slug} → source ${srcJson.id}`);
  } catch (err) {
    console.error('DocsBot upload error:', err);
  }
}

    
    // ------------ CONFIG ------------
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'America/Indiana/Indianapolis';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');        // persistent disk mount
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(process.cwd(), 'public');  // static pdfs
const BASE_URL =
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`;

const INBOUND_SECRET = process.env.INBOUND_SECRET || ''; // header x-inbound-secret OR ?secret=...
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';     // for admin-only endpoints
const DEBUG_INBOUND_ENV = /^(1|true|yes)$/i.test(String(process.env.DEBUG_INBOUND || ''));
const ARCHIVE_RETENTION_DAYS = parseInt(process.env.ARCHIVE_RETENTION_DAYS || '60', 10);

// best-effort build id for /health
const BUILD = process.env.RENDER_GIT_COMMIT || process.env.BUILD || 'dev';

// ensure root dirs
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();

// CORS (optional – safe defaults)
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Serve /public with no-cache for PDFs so the latest always shows
app.use('/public', express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.toLowerCase().endsWith('.pdf')) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// uploads for inbound
const upload = multer({ limits: { fieldSize: 1 * 1024 * 1024 } });

// ------------ HELPERS ------------
function slugDirs(slug) {
  const safe = String(slug || 'default').toLowerCase().replace(/[^a-z0-9-_]/g, '');

  // --- DATA side ---
  const base = path.join(DATA_DIR, safe);
  const archive = path.join(base, 'archive');
  const storePath = path.join(base, 'qa_store.json');

  // --- PUBLIC side ---
  const publicSlug = path.join(PUBLIC_DIR, safe);
  const publicArchive = path.join(publicSlug, 'archive');
  const todayPdf = path.join(publicSlug, 'qa-today.pdf');

  // --- Ensure directories exist ---
  [base, archive, publicSlug, publicArchive].forEach(p => {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });

  return { base, archive, publicSlug, publicArchive, storePath, todayPdf, slug: safe };
}

function loadStore(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { items: [] };
  }
}

function saveStore(p, json) {
  fs.writeFileSync(p, JSON.stringify(json, null, 2));
}

// Human-readable company name from slug (title-case-ish)
function displayNameFromSlug(slug = '') {
  const cleaned = String(slug).replace(/[-_]+/g, ' ').trim();
  return cleaned.replace(/\b\w/g, c => c.toUpperCase());
}


  
// --- Entity decode + robust HTML→text ---
function writeTodayPdf(pdfPath, slug, items = []) {
  const PDFDocument = require("pdfkit");
  const fs = require("fs");
  const path = require("path");
  const { DateTime } = require("luxon");

  // Ensure items is always an array
  if (!Array.isArray(items)) items = [];

  // Make sure directory exists for PDF output
  const publicSlug = path.dirname(pdfPath);
  fs.mkdirSync(publicSlug, { recursive: true });


  const doc = new PDFDocument({ size: "LETTER", margin: 40 });
  const tmp = pdfPath + ".tmp";
  const stream = fs.createWriteStream(tmp);
  doc.pipe(stream);

  const ts = DateTime.now().setZone(TIMEZONE).toFormat("yyyy-LL-dd HH:mm");
  const company = displayNameFromSlug(slug);

  doc.fontSize(18).text(`Escalation Q/A — ${company}`, { underline: true });
  doc.moveDown(0.25);
  doc.fontSize(10).text(`Generated: ${ts} ${TIMEZONE}`);
  doc.moveDown();

    if (!items.length) {
    doc.fontSize(12).text("No entries yet.");
  } else {
    items.forEach((it, i) => {
      doc.moveDown(0.5);
      doc.fontSize(13).text(`${i + 1}. Q: ${it.q}`);

      if (it.a && String(it.a).trim()) {
        doc.moveDown(0.2);
        doc.fontSize(12).text(`   A: ${it.a}`);
      } else {
        doc.moveDown(0.2);
        doc.fontSize(12).fillColor("gray").text("   [No answer yet]").fillColor("black");
      }
    });
  }

  doc.end();

  stream.on("finish", () => {
    fs.renameSync(tmp, pdfPath);
  });
}

// normalizer
function norm(s = '') {
  return String(s).trim().replace(/\s+/g, ' ').toLowerCase();
}

function isPendingItem(it) {
  if (!it) return false;
  if (it.status === 'pending') return true;
  return (!it.a || !String(it.a).trim());
}

function listSlugs() {
  try {
    return fs.readdirSync(DATA_DIR).filter(d => {
      try {
        return fs.statSync(path.join(DATA_DIR, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// ----- NEW: STRIP EMAIL SIGNATURES & MOBILE FOOTERS -----
function stripSignatureAndFooters(text) {
  if (!text) return '';
  
  const signaturePatterns = [
    /\n\s*--+\s*\n/,                          // Standard -- signature delimiter
    /\n\s*_{3,}\s*\n/,                        // ___ signature delimiter
    /\nSent from (my )?iPhone/i,              // Sent from iPhone
    /\nSent from (my )?iPad/i,                // Sent from iPad
    /\nSent from [\w\s]+/i,                   // Generic "Sent from X"
    /\nGet Outlook for (iOS|Android)/i,       // Outlook mobile
    /\n\s*Sent from Mail for Windows/i,       // Windows Mail
    /\n\s*Best regards?,?\s*\n/i,             // Best regards
    /\n\s*Sincerely,?\s*\n/i,                 // Sincerely
    /\n\s*Thanks?,?\s*\n/i,                   // Thanks
    /\n\s*Cheers,?\s*\n/i,                    // Cheers
    /\n\s*Regards?,?\s*\n/i                   // Regards
  ];
  
  let cleaned = text;
  
  // Find earliest match of any signature pattern
  let earliestIndex = cleaned.length;
  
  for (const pattern of signaturePatterns) {
    const match = cleaned.match(pattern);
    if (match && match.index < earliestIndex) {
      earliestIndex = match.index;
    }
  }
  
  // Cut at earliest signature marker
  if (earliestIndex < cleaned.length) {
    cleaned = cleaned.substring(0, earliestIndex);
  }
  
  return cleaned.trim();
}

// ----- PARSE EMAIL BODY FOR Q/A -----
function parseQAOrAnswerOnly(bodyText) {
  if (!bodyText) return { mode: 'NONE' };

  const lines = bodyText.split('\n').map(ln => ln.trim()).filter(Boolean);
  let q = '', a = '';
  let foundQ = false, foundA = false;

  for (const line of lines) {
    if (/^Q\d*:\s*/i.test(line)) {
      foundQ = true;
      q += line.replace(/^Q\d*:\s*/i, '').trim() + ' ';
    } else if (/^A\d*:\s*/i.test(line)) {
      foundA = true;
      // Get everything after A: and strip signatures
      const rawAnswer = line.replace(/^A\d*:\s*/i, '').trim();
      a += rawAnswer + ' ';
    } else {
      if (foundA) {
        // Continue collecting answer text until we hit a signature
        a += line + ' ';
      } else if (foundQ) {
        q += line + ' ';
      }
    }
  }

  q = q.trim();
  a = a.trim();
  
  // Strip signatures and footers from the answer
  if (a) {
    a = stripSignatureAndFooters(a);
  }

  if (q && a) return { mode: 'QA', q, a };
  if (q) return { mode: 'Q', q };
  if (a) return { mode: 'A', a };
  return { mode: 'NONE' };
}

function deriveSlugFromAddress(addr) {
  const lower = String(addr || '').toLowerCase();
  if (lower.includes('1stanswerbot')) return '1stanswerbot';
  if (lower.includes('serverpartners')) return 'serverpartners';
  return 'default';
}

// ------------ ROUTES ------------

// 1) Health
app.get('/health', (req, res) => {
  return res.status(200).json({ ok: true, build: BUILD });
});

// 2) Global status (all companies)
app.get('/api/status', (req, res) => {
  try {
    const slugs = listSlugs();
    const out = [];
    for (const slug of slugs) {
      const { storePath, todayPdf } = slugDirs(slug);
      const store = loadStore(storePath);
      const pending = store.items.filter(isPendingItem).length;
      const answered = store.items.filter(it => !isPendingItem(it)).length;

      let pdfUrl = null;
      try {
        if (fs.existsSync(todayPdf)) {
          pdfUrl = `${BASE_URL}/public/${slug}/qa-today.pdf`;
        }
      } catch {}

      out.push({ slug, pending, answered, total: store.items.length, pdfUrl });
    }
    return res.json({ ok: true, companies: out });
  } catch (err) {
    console.error('Global status error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// 3) Company-specific status
app.get('/c/:slug/api/status', (req, res) => {
  try {
    const slug = req.params.slug;
    const { storePath, todayPdf } = slugDirs(slug);
    const store = loadStore(storePath);
    const pending = store.items.filter(isPendingItem).length;
    const answered = store.items.filter(it => !isPendingItem(it)).length;

    let pdfUrl = null;
    try {
      if (fs.existsSync(todayPdf)) {
        pdfUrl = `${BASE_URL}/public/${slug}/qa-today.pdf`;
      }
    } catch {}

    return res.json({ ok: true, slug, pending, answered, total: store.items.length, pdfUrl });
  } catch (err) {
    console.error(`Status error (${req.params.slug}):`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// 4) Peek items (ADMIN only)
app.get('/c/:slug/api/peek', (req, res) => {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });

  try {
    const slug = req.params.slug;
    const { storePath } = slugDirs(slug);
    const store = loadStore(storePath);
    return res.json({ ok: true, slug, items: store.items });
  } catch (err) {
    console.error(`Peek error (${req.params.slug}):`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// 5) List archived PDFs
app.get('/c/:slug/api/archives', (req, res) => {
  try {
    const slug = req.params.slug;
    const { publicArchive } = slugDirs(slug);

    const files = fs.readdirSync(publicArchive)
      .filter(f => f.toLowerCase().endsWith('.pdf'))
      .sort((a, b) => b.localeCompare(a)); // newest first

    const urls = files.map(f => `${BASE_URL}/public/${slug}/archive/${encodeURIComponent(f)}`);
    return res.json({ ok: true, slug, archives: files, urls });
  } catch (err) {
    console.error(`Archive list error (${req.params.slug}):`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// 6) Download specific archive PDF
app.get('/c/:slug/archive/:file', (req, res) => {
  try {
    const slug = req.params.slug;
    const file = req.params.file;
    const { publicArchive } = slugDirs(slug);
    const fullPath = path.join(publicArchive, file);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    return res.sendFile(fullPath);
  } catch (err) {
    console.error(`Archive download error:`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// 7) Inbound email webhook (SendGrid Parse)
// This always expects multipart form data with 'to', 'cc', 'envelope', 'subject', 'text'
const DEBUG_INBOUND = DEBUG_INBOUND_ENV;

app.post('/inbound', upload.none(), async (req, res) => {
  try {
    const fields = req.body;
    const secret = req.query.secret || req.headers['x-inbound-secret'];

    if (DEBUG_INBOUND) {
      console.log('INBOUND RECEIVED', {
        to: fields.to || '',
        cc: fields.cc || '',
        envelope: fields.envelope || '',
        subject: fields.subject || ''
      });
    }

    // Basic validation
    if (INBOUND_SECRET && secret !== INBOUND_SECRET) {
      console.warn('Inbound auth failed');
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    let bodyText = fields.text || '';
    bodyText = bodyText.trim();

    if (!bodyText) {
      if (DEBUG_INBOUND) console.warn('No body text in inbound email');
      return res.status(200).json({ ok: false, error: 'no_body' });
    }

    // --- NEW: Multi-tenant tag detection and stripping ---
    let tagSlug = null;
    const firstLine = bodyText.split('\n')[0] || '';
    const tagMatch = firstLine.match(/^\[TENANT:\s*([a-z0-9-_]+)\]/i);
    if (tagMatch) {
      tagSlug = tagMatch[1].toLowerCase();
      if (DEBUG_INBOUND) console.log('Detected tenant tag:', tagSlug);
    }

    // --- Derive slug from recipient addresses ---
    const to = (fields.to || '').toLowerCase();
    const cc = (fields.cc || '').toLowerCase();
    const envelope = (fields.envelope || '').toLowerCase();

    const allRecips = [to, cc, envelope].filter(Boolean).join(',');
    const candidates = [];

    if (/1stanswerbot/i.test(allRecips)) candidates.push('1stanswerbot');
    if (/serverpartners/i.test(allRecips)) candidates.push('serverpartners');

    let derivedSlug = 'default';
    if (candidates.length === 1) {
      derivedSlug = candidates[0];
    } else if (candidates.length > 1) {
      if (DEBUG_INBOUND) console.warn('Multiple tenant candidates — cannot auto-select without tag', { candidates });
      if (!tagSlug) {
        return res.status(200).json({ ok: false, error: 'multiple_tenant_recipients', candidates });
      }
      derivedSlug = deriveSlugFromAddress(candidates[0]);
    }

    // If a tenant tag exists and doesn't match the derived slug, ignore this webhook
    if (tagSlug && tagSlug !== derivedSlug) {
      if (DEBUG_INBOUND) console.warn('Tenant tag mismatch — ignoring message', { tagSlug, derivedSlug });
      return res.status(200).json({ ok: true, ignored: true, reason: 'tenant_tag_mismatch', tagSlug, derivedSlug });
    }

    // If the tag matches, strip the tag line before parsing so it doesn't appear in PDFs
    if (tagSlug) {
      const i = bodyText.indexOf('\n');
      bodyText = (i >= 0 ? bodyText.slice(i + 1) : '').trim();
    }

    const parsed = parseQAOrAnswerOnly(bodyText);
    if (DEBUG_INBOUND) console.log('INBOUND PARSED', { slug: derivedSlug, mode: parsed.mode, hasQ: !!parsed.q, hasA: !!parsed.a });

    if (parsed.mode === 'NONE') {
      if (DEBUG_INBOUND) console.warn('Inbound parse failed (no Q:/A:)', { derivedSlug, sample: bodyText.slice(0, 200) });
      return res.status(200).json({ ok: false, error: 'no_q_or_a_found' });
    }

    const { storePath, todayPdf, slug } = slugDirs(derivedSlug);
    const store = loadStore(storePath);

    let resultMode = parsed.mode;

    if (parsed.mode === 'QA') {
      // Try to close a matching pending by question; else add answered
      let matched = false;
      for (let i = store.items.length - 1; i >= 0; i--) {
        const it = store.items[i];
        if (isPendingItem(it) && norm(it.q) === norm(parsed.q)) {
          it.a = parsed.a;
          it.status = 'answered';
          it.answeredTs = Date.now();
          matched = true;
          resultMode = 'QA->matched_pending';
          break;
        }
      }
      if (!matched) {
        store.items.push({
          q: parsed.q,
          a: parsed.a,
          status: 'answered',
          ts: Date.now(),
          source: 'email'
        });
        resultMode = 'QA->created_new';
      }
    } else if (parsed.mode === 'Q') {
      store.items.push({
        q: parsed.q,
        a: '',
        status: 'pending',
        ts: Date.now(),
        source: 'email'
      });
    } else if (parsed.mode === 'A') {
      // Fill most recent pending item
      let updated = false;
      for (let i = store.items.length - 1; i >= 0; i--) {
        const it = store.items[i];
        if (!it) continue;
        if (isPendingItem(it)) {
          it.a = parsed.a;
          it.status = 'answered';
          it.answeredTs = Date.now();
          updated = true;
          resultMode = 'A->updated_last_pending';
          break;
        }
      }
      if (!updated) {
        // No pending found — store as standalone entry to avoid losing the answer
        store.items.push({
          q: '(unspecified question)',
          a: parsed.a,
          status: 'answered',
          ts: Date.now(),
          source: 'email'
        });
        resultMode = 'A->no_pending_created_new';
      }
    }

    
    
    saveStore(storePath, store);
    await writeTodayPdf(path.join(PUBLIC_DIR, slug, 'qa-today.pdf'), slug, store.items);
    await uploadToDocsBot(slug, path.join(PUBLIC_DIR, slug, 'qa-today.pdf'));




    // (Optional) persist raw inbound for debugging
    if (DEBUG_INBOUND) {
      try {
        const dbg = {
          to: fields.to || '',
          cc: fields.cc || '',
          envelope: fields.envelope || '',
          derivedSlug: slug,
          subject: fields.subject || '',
          receivedAt: new Date().toISOString(),
          parsed
        };
        fs.writeFileSync(
          path.join(DATA_DIR, slug, `inbound_${Date.now()}.json`),
          JSON.stringify(dbg, null, 2)
        );
      } catch {}
    }

    const anyPending = store.items.some(it => (!it.a || !String(it.a).trim()));
    return res.status(200).json({ ok: true, slug, mode: resultMode, pending: anyPending, added: 1 });
  } catch (err) {
    console.error('Inbound error:', err);
    return res.status(200).json({ ok: false, error: 'inbound exception' });
  }
});

// ------------ NIGHTLY ARCHIVE/RESET (per company) ------------
cron.schedule('59 23 * * *', () => {
  try {
    const zone = TIMEZONE;
    const day = DateTime.now().setZone(zone).toFormat('yyyy-LL-dd');
    const cutoff = DateTime.now().minus({ days: ARCHIVE_RETENTION_DAYS });

    const slugs = listSlugs();
    slugs.forEach(slug => {
      const { storePath, archive, publicArchive, todayPdf } = slugDirs(slug);

     // ensure escalation-qa.pdf exists before copying
const store = loadStore(storePath);
writeTodayPdf(slug, store.items || []);

// Copy escalation file to both private and public archives with date-first filename
const filename = `${day}-${slug}.pdf`;
const srcPdf = todayPdf;


try {
  fs.copyFileSync(srcPdf, path.join(archive, filename));
} catch (e) {
  console.error('Archive copy (private) failed', { slug, e: String(e) });
}
try {
  fs.copyFileSync(srcPdf, path.join(publicArchive, filename));
} catch (e) {
  console.error('Archive copy (public) failed', { slug, e: String(e) });
}
console.log('Archived PDF', { slug, private: path.join(archive, filename), public: path.join(publicArchive, filename) });

// reset store and rewrite an empty escalation file
saveStore(storePath, { items: [] });
writeTodayPdf(todayPdf, slug, []);



      // purge old archives (private + public)
      try {
        const filesPriv = fs.readdirSync(archive);
        filesPriv.forEach(f => {
          if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-_]+\.pdf$/i.test(f)) return;
          const d = f.slice(0, 10); // yyyy-mm-dd
          const dt = DateTime.fromFormat(d, 'yyyy-LL-dd');
          if (dt.isValid && dt < cutoff) {
            fs.unlinkSync(path.join(archive, f));
          }
        });
      } catch (e) {
        console.error('Archive purge failed (private)', { slug, e: String(e) });
      }

      try {
        const filesPub = fs.readdirSync(publicArchive);
        filesPub.forEach(f => {
          if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-_]+\.pdf$/i.test(f)) return;

          const d = f.slice(0, 10);
          const dt = DateTime.fromFormat(d, 'yyyy-LL-dd');
          if (dt.isValid && dt < cutoff) {
            fs.unlinkSync(path.join(publicArchive, f));
          }
        });
      } catch (e) {
        console.error('Archive purge failed (public)', { slug, e: String(e) });
      }
    });
  } catch (e) {
    console.error('Archive job failed', e);
  }
}, { timezone: TIMEZONE });

// ------------ BOOTSTRAP ------------
(function ensureBootPdfs() {
  // Create an empty "today" PDF for any existing slugs on boot
  listSlugs().forEach(slug => {
    const { storePath, todayPdf } = slugDirs(slug);
    const store = loadStore(storePath);
    writeTodayPdf(todayPdf, slug, store.items || []);
  });
})();


// --- Ensure initial PDFs exist on boot ---
(function ensureInitialPdfs() {
  const slugs = ['1stanswerbot', 'serverpartners'];
  slugs.forEach(slug => {
    const { storePath, todayPdf } = slugDirs(slug);
    const store = loadStore(storePath);
    if (!fs.existsSync(todayPdf)) {
      writeTodayPdf(todayPdf, slug, store.items || []);
      console.log(`✅ Bootstrapped initial PDF for: ${slug}`);
    }
  });
})();

// ------------ START ------------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Health: /health  Status: /api/status  Company status: /c/:slug/api/status  Peek: /c/:slug/api/peek  Archives: /c/:slug/api/archives  Download: /c/:slug/archive/:file  PDFs under /public/:slug/qa-today.pdf`);
});



// Graceful-ish error logs
process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION', err));
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION', err));