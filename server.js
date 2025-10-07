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
  const base = path.join(DATA_DIR, safe);
  const archive = path.join(base, 'archive');
  const publicSlug = path.join(PUBLIC_DIR, safe);
  const storePath = path.join(base, 'qa_store.json');
  const todayPdf = path.join(publicSlug, 'qa-today.pdf');

  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  if (!fs.existsSync(archive)) fs.mkdirSync(archive, { recursive: true });
  if (!fs.existsSync(publicSlug)) fs.mkdirSync(publicSlug, { recursive: true });

  return { base, archive, publicSlug, storePath, todayPdf, slug: safe };
}

function loadStore(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { items: [] }; }
}
function saveStore(p, json) {
  fs.writeFileSync(p, JSON.stringify(json, null, 2));
}

function writeTodayPdf(pdfPath, slug, items) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
  const tmp = pdfPath + '.tmp';
  const stream = fs.createWriteStream(tmp);
  doc.pipe(stream);

  const ts = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd HH:mm');
  doc.fontSize(18).text(`Q/A — ${slug} (Today)`, { underline: true });
  doc.moveDown(0.25);
  doc.fontSize(10).text(`Generated: ${ts} ${TIMEZONE}`);
  doc.moveDown();

  if (!items.length) {
    doc.fontSize(12).text('No entries yet for today.');
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
    try { fs.renameSync(tmp, pdfPath); } catch {}
  });
}

// Robust text extraction from HTML (if only HTML is provided)
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .trim();
}

function listSlugs() {
  return fs.readdirSync(DATA_DIR).filter(name => {
    const p = path.join(DATA_DIR, name);
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

/**
 * Prefer the replies.* address from envelope/headers when multiple recipients exist.
 */
function pickInboundAddress(fields = {}) {
  let rcpts = [];
  try {
    const env = JSON.parse(fields.envelope || '{}');
    rcpts = Array.isArray(env.to) ? env.to : (env.to ? [env.to] : []);
  } catch {}
  if (!rcpts.length && fields.to) {
    rcpts = String(fields.to).split(',').map(s => s.trim());
  }
  const picked = rcpts.find(x => /\.replies\./i.test(x)) || rcpts[0] || '';
  return picked;
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

  // Grab first Q: line (if any)
  const qMatch = t.match(/^\s*Q:\s*(.+)$/im);
  // Grab first A: block (if any) — everything until a common quote marker or another Q:
  let aMatch = t.match(/^\s*A:\s*([\s\S]+)$/im);
  let aText = '';
  if (aMatch) {
    aText = aMatch[1];
    const cutAt = aText.search(/^\s*(Q:|On .* wrote:|From:|Sent:|-----|>)/im);
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
  const todayPdfUrl = `${BASE_URL}/public/${encodeURIComponent(slug)}/qa-today.pdf`;
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
      .filter(f => /^qa-\d{4}-\d{2}-\d{2}\.pdf$/i.test(f))
      .sort() // ascending by name (date)
      .reverse(); // most recent first
    return files;
  } catch {
    return [];
  }
}

// List archives with direct URLs
app.get('/c/:slug/api/archives', (req, res) => {
  const raw = (req.params.slug || '').toLowerCase();
  const { archive, slug } = slugDirs(raw);
  const files = listArchiveFiles(archive);
  const items = files.map(name => ({
    name,
    url: `${BASE_URL}/c/${encodeURIComponent(slug)}/archive/${encodeURIComponent(name)}`
  }));
  res.json({ slug, count: items.length, items });
});

// Serve a specific archived PDF securely
app.get('/c/:slug/archive/:file', (req, res) => {
  const raw = (req.params.slug || '').toLowerCase();
  const file = String(req.params.file || '');
  if (!/^qa-\d{4}-\d{2}-\d{2}\.pdf$/i.test(file)) {
    return res.status(400).send('bad filename');
  }
  const { archive } = slugDirs(raw);
  const full = path.join(archive, file);
  if (!fs.existsSync(full)) return res.status(404).send('not found');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.sendFile(full);
});

// Manual rollover (archive now + reset). Secured by ADMIN_SECRET or INBOUND_SECRET.
app.post('/c/:slug/api/archive-now', (req, res) => {
  const raw = (req.params.slug || '').toLowerCase();
  const { archive, storePath, todayPdf, slug } = slugDirs(raw);

  const sec = (req.query.secret || req.headers['x-admin-secret'] || req.headers['x-inbound-secret'] || '').toString();
  const okSecret = (ADMIN_SECRET && sec === ADMIN_SECRET) || (INBOUND_SECRET && sec === INBOUND_SECRET);
  if (!okSecret) return res.status(403).send('forbidden');

  const now = DateTime.now().setZone(TIMEZONE);
  const day = now.toFormat('yyyy-LL-dd');

  // Ensure today's PDF reflects current store
  const store = loadStore(storePath);
  writeTodayPdf(todayPdf, slug, store.items || []);

  // Copy to archive
  const out = path.join(archive, `qa-${day}.pdf`);
  try {
    fs.copyFileSync(todayPdf, out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'copy_failed', detail: String(e) });
  }

  // Reset today
  saveStore(storePath, { items: [] });
  writeTodayPdf(todayPdf, slug, []);

  return res.json({ ok: true, slug, archived: path.basename(out) });
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

    // Prefer replies.* recipient to derive slug
    const toAddr = pickInboundAddress(fields);
    const derivedSlug = deriveSlugFromAddress(toAddr);

    // Prefer plain text; otherwise convert HTML to text
    const bodyText =
      (fields.text && fields.text.trim())
        ? fields.text
        : htmlToText(fields.html || '');

    const parsed = parseQAOrAnswerOnly(bodyText);
    if (DEBUG_INBOUND) console.log('INBOUND PARSED', { slug: derivedSlug, mode: parsed.mode, hasQ: !!parsed.q, hasA: !!parsed.a });

    if (parsed.mode === 'NONE') {
      if (DEBUG_INBOUND) console.warn('Inbound parse failed (no Q:/A:)', { derivedSlug, toAddr, sample: bodyText.slice(0, 200) });
      return res.status(200).json({ ok: false, error: 'No Q:/A: found' });
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
    writeTodayPdf(todayPdf, slug, store.items);

    // (Optional) persist raw inbound for debugging
    if (DEBUG_INBOUND) {
      try {
        const dbg = {
          to: toAddr,
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
cron.schedule('5 0 * * *', () => {
  try {
    const zone = TIMEZONE;
    const day = DateTime.now().setZone(zone).toFormat('yyyy-LL-dd');
    const cutoff = DateTime.now().minus({ days: ARCHIVE_RETENTION_DAYS });

    const slugs = listSlugs();
    slugs.forEach(slug => {
      const { storePath, archive, todayPdf } = slugDirs(slug);
      // ensure today's pdf exists before copying
      const store = loadStore(storePath);
      if (!fs.existsSync(todayPdf)) writeTodayPdf(todayPdf, slug, store.items || []);

      // copy today PDF to archive
      if (fs.existsSync(todayPdf)) {
        const out = path.join(archive, `qa-${day}.pdf`);
        try {
          fs.copyFileSync(todayPdf, out);
          console.log('Archived PDF', { slug, out });
        } catch (e) {
          console.error('Archive copy failed', { slug, e: String(e) });
        }
      }

      // reset today's store and PDF
      saveStore(storePath, { items: [] });
      writeTodayPdf(todayPdf, slug, []);

      // purge old archives (optional)
      try {
        const files = fs.readdirSync(archive);
        files.forEach(f => {
          if (!/^qa-\d{4}-\d{2}-\d{2}\.pdf$/i.test(f)) return;
          const d = f.slice(3, 13); // yyyy-mm-dd
          const dt = DateTime.fromFormat(d, 'yyyy-LL-dd');
          if (dt.isValid && dt < cutoff) {
            fs.unlinkSync(path.join(archive, f));
          }
        });
      } catch (e) {
        console.error('Archive purge failed', { slug, e: String(e) });
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

// ------------ START ------------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Health: /health  Status: /api/status  Company status: /c/:slug/api/status  Peek: /c/:slug/api/peek  Archives: /c/:slug/api/archives  Download: /c/:slug/archive/:file  PDFs under /public/:slug/qa-today.pdf`);
});

// Graceful-ish error logs
process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION', err));
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION', err));
