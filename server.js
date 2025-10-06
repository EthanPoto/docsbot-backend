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
  process.env.RENDER_EXTERNAL_URL || // Render sets this
  `http://localhost:${PORT}`;
const INBOUND_SECRET = process.env.INBOUND_SECRET || ''; // must be in header x-inbound-secret

// ensure root dirs
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();

// CORS (optional – safe defaults)
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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

// Accepts either "Q: ...\nA: ..." or just "Q: ..." (A optional)
function parseQARelaxed(text = '') {
  const s = String(text);
  const m = s.match(/Q:\s*([\s\S]*?)(?:\nA:\s*([\s\S]*))?$/i);
  if (!m) return null;
  const q = (m[1] || '').trim();
  const a = (m[2] || '').trim();
  if (!q) return null;
  return { q, a, hasA: Boolean(a) };
}

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

// ------------ STATIC & BASIC ROUTES ------------
app.use('/public', express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Fallback health for Render (some templates check /api/status)
app.get('/api/status', (_req, res) => {
  res.json({ ok: true, note: 'prefer /health', time: new Date().toISOString() });
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

// ------------ INBOUND (SendGrid Inbound Parse) ------------
app.post('/inbound', upload.any(), (req, res) => {
  try {
    // Header-only shared secret
    if (INBOUND_SECRET) {
      const sent = (req.headers['x-inbound-secret'] || '').toString();
      if (sent !== INBOUND_SECRET) return res.status(403).send('forbidden');
    }

    const fields = Object.fromEntries(Object.entries(req.body || {}));

    // Derive "to" from envelope JSON (preferred) or fallback to raw "to"
    let toAddr = '';
    try {
      const env = JSON.parse(fields.envelope || '{}');
      // Some providers send "to" as array
      toAddr = (Array.isArray(env.to) ? env.to[0] : env.to) || fields.to || '';
    } catch {
      toAddr = fields.to || '';
    }

    const derivedSlug = deriveSlugFromAddress(toAddr);

    // Prefer plain text; otherwise convert HTML to text
    const bodyText = (fields.text && fields.text.trim())
      ? fields.text
      : htmlToText(fields.html || '');

    function parseQA(text = '') {
  const t = String(text || '');

  // Find first Q: and first A: anywhere (case-insensitive)
  const qMatch = t.match(/^\s*Q:\s*(.+)$/im);
  const aMatch = t.match(/^\s*A:\s*([\s\S]+)$/im);
  if (!qMatch || !aMatch) return null;

  let q = (qMatch[1] || '').trim();
  let a = (aMatch[1] || '');

  // Stop A: at common reply/quote markers or another Q:
  const cutAt = a.search(/^\s*(Q:|On .* wrote:|From:|Sent:|-----|>)/im);
  if (cutAt > -1) a = a.slice(0, cutAt);

  a = a.trim();
  if (!q || !a) return null;

  return { q, a };
}

    // Save to per-company store and regenerate PDF
    const { storePath, todayPdf, slug } = slugDirs(derivedSlug);
    const store = loadStore(storePath);
    store.items.push({
      q: qa.q,
      a: qa.hasA ? qa.a : '',
      status: qa.hasA ? 'answered' : 'pending',
      ts: Date.now(),
      source: 'email'
    });
    saveStore(storePath, store);
    writeTodayPdf(todayPdf, slug, store.items);

    // (Optional) persist raw inbound for debugging
    try {
      const dbg = {
        to: toAddr,
        subject: fields.subject || '',
        receivedAt: new Date().toISOString(),
        parsed: { q: qa.q, a: qa.a, hasA: qa.hasA }
      };
      fs.writeFileSync(
        path.join(DATA_DIR, slug, `inbound_${Date.now()}.json`),
        JSON.stringify(dbg, null, 2)
      );
    } catch {}

    return res.status(200).json({ ok: true, slug, added: 1, pending: !qa.hasA });
  } catch (err) {
    console.error('Inbound error:', err);
    // Return 200 so SendGrid doesn’t retry endlessly
    return res.status(200).json({ ok: false, error: 'inbound exception' });
  }
});

// ------------ NIGHTLY ARCHIVE/RESET (per company) ------------
cron.schedule('5 0 * * *', () => {
  try {
    const zone = TIMEZONE;
    const day = DateTime.now().setZone(zone).toFormat('yyyy-LL-dd');
    const slugs = listSlugs();
    slugs.forEach(slug => {
      const { storePath, archive, todayPdf } = slugDirs(slug);
      // copy today PDF to archive
      if (fs.existsSync(todayPdf)) {
        const out = path.join(archive, `qa-${day}.pdf`);
        fs.copyFileSync(todayPdf, out);
        console.log('Archived PDF', { slug, out });
      }
      // reset today's store and PDF
      saveStore(storePath, { items: [] });
      writeTodayPdf(todayPdf, slug, []);
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
  console.log(`Health: /health  Status: /api/status  Company status: /c/:slug/api/status  PDFs under /public/:slug/qa-today.pdf`);
});

// Graceful-ish error logs
process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION', err));
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION', err));
