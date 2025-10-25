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
const fetch = require('node-fetch');

// DocsBot + Desktop mirror config
const DOCSBOT_API_KEY = (process.env.DOCSBOT_API_KEY || '').trim();
const DOCSBOT_MAP = {
  "1stanswerbot": "Tuy1mgF9xidg0KhsHmMr/eF9K4VnlybhOGpIqz0iH",
  "serverpartners": "Tuy1mgF9xidg0KhsHmMr/CHJTUkAyMBecrlVp51Zq"
};
const DESKTOP_PATH = "/Users/ethanpoto/Desktop/docsbot-backend"; // desktop mirror root
// ---- DocsBot Refresh Helper (force re-index) ----
// ------------ DOCSBOT REFRESH HELPER ------------
async function refreshDocsBot(slug) {
  try {
    const fetch = (await import('node-fetch')).default;

    const botMap = {
      '1stanswerbot': 'Tuy1mgF9xidg0KhsHmMr/eF9K4VnlybhOGpIqz0iH',
      'serverpartners': 'Tuy1mgF9xidg0KhsHmMr/CHJTUkAyMBecrlVp51Zq'
    };

    const botId = botMap[slug] || null;
    if (!botId) {
      console.warn(`⚠️  No DocsBot ID for slug: ${slug}`);
      return;
    }

    const pdfUrl = `${BASE_URL}/public/${slug}/escalation-qa.pdf`;

    const resp = await fetch(`https://docsbot.ai/api/v1/admin/teams/${DOCSBOT_TEAM_ID}/bots/${botId}/sources`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DOCSBOT_API_KEY.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'url',
        value: pdfUrl,
        title: 'Escalation Q/A',
        replace: true,
        force: true
      })
    });

    const data = await resp.json();
    console.log(`✅ DocsBot re-index requested for ${slug}:`, data);
  } catch (err) {
    console.error(`❌ Error refreshing DocsBot for ${slug}:`, err);
  }
}


    if (response.ok) {
      console.log(`✅ DocsBot refreshed for ${slug}: ${pdfUrl}`);
    } else {
      console.error(`❌ DocsBot refresh failed for ${slug}: ${response.status}`);
    }
  } catch (err) {
    console.error(`Error refreshing DocsBot for ${slug}:`, err);
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

  // DATA side
  const base = path.join(DATA_DIR, safe);
  const archive = path.join(base, 'archive');

  // PUBLIC side
  const publicSlug = path.join(PUBLIC_DIR, safe);
  const publicArchive = path.join(publicSlug, 'archive');

  const storePath = path.join(base, 'qa_store.json');
  const todayPdf = path.join(publicSlug, 'qa-today.pdf');

  // ensure dirs
  [base, archive, publicSlug, publicArchive].forEach(p => {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });

  return { base, archive, publicSlug, publicArchive, storePath, todayPdf, slug: safe };
}

function loadStore(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { items: [] }; }
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
function writeTodayPdf(pdfPath, slug, items) {
  const PDFDocument = require('pdfkit');
  const fs = require('fs');
  const path = require('path');
  const { DateTime } = require('luxon');

  // Make sure target directory exists
  const publicSlug = path.dirname(pdfPath);
  fs.mkdirSync(publicSlug, { recursive: true });

  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
  const tmp = pdfPath + '.tmp';
  const stream = fs.createWriteStream(tmp);
  doc.pipe(stream);

  const ts = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd HH:mm');
  const company = displayNameFromSlug(slug);

  doc.fontSize(18).text(`Escalation Q/A — ${company}`, { underline: true });
  doc.moveDown(0.25);
  doc.fontSize(10).text(`Generated: ${ts} ${TIMEZONE}`);
  doc.moveDown();

  if (!items.length) {
    doc.fontSize(12).text('No entries yet.');
  } else {
    items.forEach((it, i) => {
      const ans = (it.a && String(it.a).trim()) ? it.a : '(pending)';
      doc.moveDown(0.5);
      doc.fontSize(13).text(`${i + 1}. Q: ${it.q}`);
      doc.moveDown(0.2);
      doc.fontSize(12).text(`   A: ${ans}`);
      doc.moveDown(0.4);
      doc.moveTo(40, doc.y).lineTo(550, doc.y).stroke();
    });
  }

  doc.end();

  stream.on('finish', () => {
    try {
      fs.renameSync(tmp, pdfPath);

      // --- Mirror locally only if this is your Mac (NOT Render) ---
      if (process.platform === 'darwin') {
        try {
          const pdfName = path.basename(pdfPath);
          const destDir = path.join('/Users/ethanpoto/Desktop/docsbot-backend', slug);
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(pdfPath, path.join(destDir, pdfName));
          console.log(`🖥️  Local copy saved for ${slug}`);
        } catch (mirrorErr) {
          console.warn('⚠️  Desktop mirror skipped:', mirrorErr.message);
        }
      }

      console.log(`✅ PDF updated for ${slug}: ${pdfPath}`);
    } catch (err) {
      console.error('❌ PDF save/mirror error', err);
    }
  });
}


// Robust text extraction from HTML (if only HTML is provided)
function htmlToText(html) {
  if (!html) return '';
  let out = String(html);

  // Keep structure
  out = out.replace(/<(\/p|br|\/li|\/div)>/gi, '$&\n');

  // Strip style/script
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '')
           .replace(/<script[\s\S]*?<\/script>/gi, '');

  // Strip tags
  out = out.replace(/<[^>]+>/g, '');

  // Decode entities
  out = decodeEntities(out);

  // Normalize and trim
  out = out.replace(/\r/g, '').trim();

  return out;
}

function listSlugs() {
  return fs.readdirSync(DATA_DIR).filter(name => {
    const p = path.join(DATA_DIR, name);
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

/**
 * Find ALL qa+...@replies... recipients in To and CC (header preferred) or envelope.
 * We will REJECT if more than one tenant candidate is present to prevent cross-tenant bleed.
 */
function findQaRepliesCandidates(fields = {}, debug = false) {
  const splitList = (s) => String(s || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  // HEADER SOURCES: To + CC (Mailio often puts QA in CC)
  const toHeaderList = splitList(fields.to);
  const ccHeaderList = splitList(fields.cc);
  const headerAll = [...toHeaderList, ...ccHeaderList];

  const headerCandidates = headerAll.filter(addr =>
    /@.*replies\./i.test(addr) && /^qa\+/i.test((addr.split('@')[0] || ''))
  );

  // ENVELOPE (fallback)
  let envTo = [];
  try {
    const env = JSON.parse(fields.envelope || '{}');
    envTo = Array.isArray(env.to) ? env.to : (env.to ? [env.to] : []);
  } catch {}
  const envCandidates = envTo.filter(addr =>
    /@.*replies\./i.test(addr) && /^qa\+/i.test((addr.split('@')[0] || ''))
  );

  const candidates = headerCandidates.length ? headerCandidates : envCandidates;

  if (debug) console.log('QA RECIPIENT CANDIDATES', {
    toHeaderList, ccHeaderList, headerCandidates, envCandidates,
    pickedFrom: headerCandidates.length ? 'header' : 'envelope'
  });

  return candidates;
}

/**
 * Derive a tenant slug from a "to" address.
 * Supports:
 *   1) Plus addressing: qa+<slug>@replies.yourdomain.com
 *   2) Subdomain style:  qa@<slug>.replies.yourdomain.com
 */
function deriveSlugFromAddress(toAddrRaw = '') {
  if (!toAddrRaw) return 'default';

  // If multiple addresses, pick first.
  let toAddr = String(toAddrRaw).split(',')[0].trim();
  // If address is in the form "Name <addr>", extract inside <>
  const mAngle = toAddr.match(/<([^>]+)>/);
  if (mAngle) toAddr = mAngle[1];

  const [local, host] = String(toAddr).split('@');

  // Try plus-addressing first: qa+<slug>@replies...
  const plus = (local || '').match(/^[^+]+?\+([a-z0-9][a-z0-9-_]{0,63})$/i);
  if (plus) {
    return plus[1].toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'default';
  }

  // Fallback: <slug>.replies.<domain>
  const mHost = (host || '').toLowerCase().match(/^([a-z0-9][a-z0-9-_]{0,63})\.replies\./i);
  if (mHost) {
    return mHost[1].replace(/[^a-z0-9-_]/g, '') || 'default';
  }

  return 'default';
}

// --- NEW: tenant tag extractor ---
function extractTenantTag(s) {
  // Matches "[tenant: slug]" at the very start (allow whitespace)
  const m = String(s || '').match(/^\s*\[\s*tenant\s*:\s*([a-z0-9][a-z0-9-_]{0,63})\s*\]/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Parse inbound body to detect:
 *   - QA: both Q and A present
 *   - Q:  Q present, A missing
 *   - A:  A present, Q missing  (used to fill the most recent pending Q)
 *
 * Returns { mode: 'QA'|'Q'|'A'|'NONE', q?: string, a?: string }
 */
function parseQAOrAnswerOnly(raw = '') {
  const t = String(raw || '');

  // Slightly more forgiving Q: pattern (Q: / Q- / Q – )
  const qMatch = t.match(/^\s*Q\s*[:\-–]\s*(.+)$/im);

  // Grab first A: block (if any) — everything until a common quote marker or another Q:
  let aMatch = t.match(/^\s*A\s*:\s*([\s\S]+)$/im);
  let aText = '';
  if (aMatch) {
    aText = aMatch[1];
    const cutAt = aText.search(/^\s*(Q\s*[:\-–]|On .* wrote:|From:|Sent:|-----|>)/im);
    if (cutAt > -1) aText = aText.slice(0, cutAt);
    aText = aText.trim();
  }

  const q = qMatch ? qMatch[1].trim() : '';
  const a = aText;

  if (q && a) return { mode: 'QA', q, a };
  if (q && !a) return { mode: 'Q', q };
  if (!q && a) return { mode: 'A', a };
  return { mode: 'NONE' };
}

const isPendingItem = (it) => it && ((!it.a || !String(it.a).trim()) || it.status === 'pending');
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ------------ BASIC ROUTES ------------
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), build: BUILD, debugInbound: DEBUG_INBOUND_ENV });
});

// Fallback health for Render (some templates check /api/status)
app.get('/api/status', (_req, res) => {
  res.json({ ok: true, note: 'prefer /health', time: new Date().toISOString(), build: BUILD });
});

app.get('/', (_req, res) => {
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.type('html').send('<h1>DocsBot Backend (multi-tenant)</h1><p>OK</p>');
});

// ------------ PER-COMPANY STATUS ------------
app.get('/c/:slug/api/status', (req, res) => {
  const raw = (req.params.slug || '').toLowerCase();
  if (!raw) return res.status(400).json({ error: 'missing slug' });
  const { storePath, slug } = slugDirs(raw);
  const store = loadStore(storePath);
  const todayPdfUrl = `${BASE_URL}/public/${encodeURIComponent(slug)}/escalation-qa.pdf`;

  res.json({ slug, count: store.items.length, todayPdfUrl });
});

// Quick peek of last N items (debugging)
app.get('/c/:slug/api/peek', (req, res) => {
  const raw = (req.params.slug || '').toLowerCase();
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '5', 10)));
  const { storePath } = slugDirs(raw);
  const store = loadStore(storePath);
  const items = store.items.slice(-limit);
  res.json({ slug: raw, count: store.items.length, last: items });
});

// ---------- ARCHIVES: LIST + DOWNLOAD + MANUAL ROLLOVER ----------
function listArchiveFiles(archiveDir) {
  try {
    const files = fs.readdirSync(archiveDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}-[a-z0-9-_]+\.pdf$/i.test(f)) // date-first + slug
      .sort()
      .reverse();
    return files;
  } catch {
    return [];
  }
}

// List archives with direct URLs (PUBLIC archive)
app.get('/c/:slug/api/archives', (req, res) => {
  const raw = (req.params.slug || '').toLowerCase();
  const { publicArchive, slug } = slugDirs(raw);
  const files = listArchiveFiles(publicArchive);
  const baseUrl = `${BASE_URL}/public/${encodeURIComponent(slug)}/archive`;
  const items = files.map(name => ({
    name,
    url: `${baseUrl}/${encodeURIComponent(name)}`
  }));
  res.json({ slug, count: items.length, items });
});

// Serve a specific archived PDF
app.get('/c/:slug/archive/:file', (req, res) => {
  const raw = (req.params.slug || '').toLowerCase();
  const file = String(req.params.file || '');
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-_]+\.pdf$/i.test(file)) {
    return res.status(400).send('bad filename');
  }
  const { publicArchive } = slugDirs(raw);
  const full = path.join(publicArchive, file);
  if (!fs.existsSync(full)) return res.status(404).send('not found');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.sendFile(full);
});

// Manual rollover (archive now + reset). Secured by ADMIN_SECRET or INBOUND_SECRET.
app.post('/c/:slug/api/archive-now', (req, res) => {
  const raw = (req.params.slug || '').toLowerCase();
  const { archive, publicArchive, storePath, todayPdf, slug } = slugDirs(raw);

  const sec = (req.query.secret || req.headers['x-admin-secret'] || req.headers['x-inbound-secret'] || '').toString();
  const okSecret = (ADMIN_SECRET && sec === ADMIN_SECRET) || (INBOUND_SECRET && sec === INBOUND_SECRET);
  if (!okSecret) return res.status(403).send('forbidden');

  const now = DateTime.now().setZone(TIMEZONE);
  const day = now.toFormat('yyyy-LL-dd');

  // Ensure today's PDF reflects current store
    // Ensure escalation PDF reflects current store
  const store = loadStore(storePath);
  writeTodayPdf(slug, store.items || []);

  // Copy to both private and public archives (from escalation-qa.pdf)
  const filename = `${day}-${slug}.pdf`;
  const srcPdf = path.join(PUBLIC_DIR, slug, 'escalation-qa.pdf');
  const outPrivate = path.join(archive, filename);
  const outPublic  = path.join(publicArchive, filename);
  try { fs.copyFileSync(srcPdf, outPrivate); } catch (e) {
    return res.status(500).json({ ok: false, error: 'copy_private_failed', detail: String(e) });
  }
  try { fs.copyFileSync(srcPdf, outPublic); } catch (e) {
    return res.status(500).json({ ok: false, error: 'copy_public_failed', detail: String(e) });
  }

  // Reset store and rewrite an empty escalation file
  saveStore(storePath, { items: [] });
  writeTodayPdf(slug, []);
  return res.json({ 
    ok: true, 
    slug, 
    archivedPrivate: path.basename(outPrivate), 
    archivedPublic: path.basename(outPublic) 
  });
});

// ------------ INBOUND (SendGrid Inbound Parse) ------------
app.post('/inbound', upload.any(), (req, res) => {
  try {
    const DEBUG_INBOUND = DEBUG_INBOUND_ENV || /^(1|true|yes)$/i.test(String(req.query.debug || ''));

    // Shared secret — accept header OR query (SendGrid can't add custom headers)
    if (INBOUND_SECRET) {
      const h = (req.headers['x-inbound-secret'] || '').toString();
      const q = (req.query.secret || '').toString();
      if (h !== INBOUND_SECRET && q !== INBOUND_SECRET) {
        if (DEBUG_INBOUND) console.warn('Inbound forbidden: bad secret', { hasHeader: Boolean(h), hasQuery: Boolean(q) });
        return res.status(403).send('forbidden');
      }
    }

    const fields = Object.fromEntries(Object.entries(req.body || {}));

    // Optional override for testing: ?forceSlug=<tenant>
    const forceSlug = (req.query.forceSlug || '').toString().trim();
    let derivedSlug = '';

    // Prefer plain text; otherwise convert HTML to text (declared 'let' so we can strip the tenant tag)
    let bodyText =
      (fields.text && fields.text.trim())
        ? fields.text
        : htmlToText(fields.html || '');

    // Extract tenant tag from the very first line, e.g., "[tenant: serverpartners]"
    const tagSlug = extractTenantTag(bodyText);

    if (forceSlug) {
      derivedSlug = forceSlug.toLowerCase().replace(/[^a-z0-9-_]/g, '');
      if (DEBUG_INBOUND) console.log('FORCED_SLUG', { derivedSlug });
    } else {
      const candidates = findQaRepliesCandidates(fields, DEBUG_INBOUND);
      if (!candidates.length) {
        if (DEBUG_INBOUND) console.warn('No qa+...@replies... recipient found', { to: fields.to, cc: fields.cc, envelope: fields.envelope });
        return res.status(200).json({ ok: false, error: 'no_tenant_recipient' });
      }
      if (candidates.length > 1) {
        if (DEBUG_INBOUND) console.warn('Multiple tenant recipients in one email — rejecting to prevent cross-tenant update', { candidates });
        return res.status(200).json({ ok: false, error: 'multiple_tenant_recipients', candidates });
      }
      derivedSlug = deriveSlugFromAddress(candidates[0]);
    }

    // If a tenant tag exists and doesn't match the derived slug, ignore this webhook
    if (tagSlug && tagSlug !== derivedSlug) {
      if (DEBUG_INBOUND) console.warn('Tenant tag mismatch — ignoring message', { tagSlug, derivedSlug });
      return res.status(200).json({ ok: true, ignored: true, reason: 'tenant_tag_mismatch', tagSlug, derivedSlug });
    }

    // If the tag matches, strip the tag line before parsing so it doesn’t appear in PDFs
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
    writeTodayPdf(slug, store.items);
    refreshDocsBot(slug);

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
const srcPdf = path.join(PUBLIC_DIR, slug, 'escalation-qa.pdf');
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
writeTodayPdf(slug, []);


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
          if (!/^\d{4}-\d{2}-\d2-[a-z0-9-_]+\.pdf$/i.test(f)) return;
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
  const { storePath } = slugDirs(slug);
  const store = loadStore(storePath);
  writeTodayPdf(slug, store.items || []);
});
})();

// ------------ START ------------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Health: /health  Status: /api/status  Company status: /c/:slug/api/status  Peek: /c/:slug/api/peek  Archives: /c/:slug/api/archives  Download: /c/:slug/archive/:file  PDFs under /public/:slug/escalation-qa.pdf`);
});


// Graceful-ish error logs
process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION', err));
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION', err));
