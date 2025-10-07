// server.js — multi-tenant by QA+<Company> plus addressing
console.log('BOOT', { cwd: process.cwd(), node: process.version });

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const { DateTime } = require('luxon');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const TIMEZONE = 'America/Indiana/Indianapolis';

// persistent data + public
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PUBLIC_DIR = path.join(process.cwd(), 'public');

// legacy single-tenant fallbacks (kept for compatibility)
const STORE_PATH = path.join(DATA_DIR, 'qa_store.json');
const TODAY_PDF = path.join(PUBLIC_DIR, 'qa-today.pdf');

const INBOUND_SECRET = process.env.INBOUND_SECRET || '';
const API_KEY = process.env.API_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();
app.get('/healthz', (_req, res) => res.status(200).type('text').send('ok'));

// CORS (allow your sites)
app.use(cors({
  origin: [
    'https://1stanswerbot.com',
    'https://www.1stanswerbot.com',
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type','x-api-key','X-API-KEY'],
}));
app.options('*', cors());

// manual CORS fallback (preflight)
app.use((req, res, next) => {
  const allowList = new Set(['https://1stanswerbot.com','https://www.1stanswerbot.com']);
  const origin = req.headers.origin;
  if (origin && allowList.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, X-API-KEY');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// body parsers & uploads
const upload = multer({ limits: { fieldSize: 1 * 1024 * 1024 } });
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// email (for /api/unknown flow)
const transporter = nodemailer.createTransport({
  host: "smtp.sendgrid.net",
  port: 587,
  auth: { user: "apikey", pass: process.env.SENDGRID_API_KEY }
});
const COMPANY_REP_EMAIL = process.env.REP_EMAIL || "support@1stanswerbot.com";

// utils
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
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
function parseQAFromText(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  const qa = []; let q = null; let aBuf = [];
  const flush = () => { if (q && aBuf.length) { const a = aBuf.join('\n').trim(); if (a) qa.push({ q: q.trim(), a }); } q = null; aBuf = []; };
  for (const raw of lines) {
    const line = raw.trim();
    const qm = line.match(/^Q[:\-]\s*(.+)$/i);
    const am = line.match(/^A[:\-]\s*(.*)$/i);
    if (qm) { flush(); q = qm[1]; continue; }
    if (am) { aBuf.push(am[1]); continue; }
    if (q && aBuf.length) aBuf.push(raw);
  }
  flush();
  return qa;
}
function entryHash(q, a) { return crypto.createHash('sha256').update(q+'\n'+a).digest('hex'); }

// --- Multi-tenant helpers --------------------------------------------------

// Extract slug/company from recipient using plus addressing first:  qa+<slug>@...
// Fallback: subdomain addressing like <slug>.replies.domain.tld (qa@<slug>.replies...)
// Fallback to 'default'
function getSlugFromInbound(to, envelope) {
  // 1) Try envelope JSON first (SendGrid posts it)
  try {
    const env = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
    const rcpt = (env && env.to) || to || '';
    const addr = Array.isArray(rcpt) ? rcpt[0] : rcpt;
    const { local, host } = splitAddress(addr);
    const plusSlug = plusTag(local, 'qa');
    if (plusSlug) return sanitizeSlug(plusSlug);
    const subSlug = subdomainSlug(host);
    if (subSlug) return sanitizeSlug(subSlug);
  } catch {}
  // 2) Try plain "to"
  if (to) {
    const first = Array.isArray(to) ? to[0] : String(to);
    const { local, host } = splitAddress(first);
    const plusSlug = plusTag(local, 'qa');
    if (plusSlug) return sanitizeSlug(plusSlug);
    const subSlug = subdomainSlug(host);
    if (subSlug) return sanitizeSlug(subSlug);
  }
  return 'default';
}
function splitAddress(addr) {
  const s = String(addr||'').trim().replace(/^.*<|>.*$/g,''); // strip "Name <addr>"
  const [local, host] = s.split('@');
  return { local: local||'', host: host||'' };
}
function plusTag(local, prefix) {
  // matches qa+Company or qa+server-partners
  const m = String(local||'').match(new RegExp(`^${prefix}\\+(.+)$`, 'i'));
  return m ? m[1] : null;
}
function subdomainSlug(host) {
  // acme.replies.yourdomain.com -> 'acme'
  const parts = String(host||'').split('.');
  if (parts.length >= 4 && parts[1].toLowerCase() === 'replies') return parts[0];
  return null;
}
function sanitizeSlug(s) {
  return String(s).trim().replace(/[^a-z0-9\-_.]+/gi, '-').replace(/^-+|-+$/g,'');
}
function prettyName(slug) {
  if (!slug) return 'Default';
  // if MixedCase, add spaces: FirstAnswerBot -> First Answer Bot
  if (/[A-Z][a-z]/.test(slug) && /[A-Z]/.test(slug) && /[a-z]/.test(slug) && !slug.includes('-') && !slug.includes('_')) {
    return slug.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  // kebab/underscore to Title Case
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function safeFileBase(name) {
  // For filenames like "<Company>-today.pdf" / "<Company>-YYYY-MM-DD.pdf"
  return String(name).replace(/[^a-z0-9\-_. ]/gi, '').replace(/\s+/g,' ').trim();
}
function pathsFor(slug) {
  const company = prettyName(slug);
  const base = safeFileBase(company);
  const dir = path.join(DATA_DIR, slug);
  const pub = path.join(PUBLIC_DIR, slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(pub)) fs.mkdirSync(pub, { recursive: true });
  return {
    slug,
    company,
    store: path.join(dir, 'qa_store.json'),
    todayPdf: path.join(pub, `${base}-today.pdf`),
    todayHref: `/public/${slug}/${encodeURIComponent(base)}-today.pdf`,
    archiveDir: path.join(dir, 'archive'),
    archiveNameFor(dateStr) { return path.join(this.archiveDir, `${base}-${dateStr}.pdf`); }
  };
}

// Load/save per-tenant
function loadStore(storePath) {
  if (!fs.existsSync(storePath)) return {};
  try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { return {}; }
}
function saveStore(storePath, data) {
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
}

// Create/update a PDF for a tenant
function regeneratePdfFromStore(storePath, pdfPath, companyLabel) {
  const store = loadStore(storePath);
  const doc = new PDFDocument({ margin: 40 });
  const tmp = pdfPath + '.tmp';
  const stream = fs.createWriteStream(tmp);
  doc.pipe(stream);

  const zoneNow = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd HH:mm');
  doc.fontSize(18).text(`Q&A — ${companyLabel}`, { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(10).text(`Generated: ${zoneNow} ${TIMEZONE}`);
  doc.moveDown();

  const entries = Object.entries(store);
  if (entries.length === 0) {
    doc.fontSize(12).text('No entries yet.');
  } else {
    for (const [q, a] of entries) {
      doc.moveDown(0.5);
      doc.fontSize(14).text('Q: ' + q);
      doc.moveDown(0.25);
      doc.fontSize(12).text('A: ' + (typeof a === 'string' ? a : JSON.stringify(a)));
      doc.moveDown(0.75);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    }
  }

  doc.end();
  stream.on('finish', () => fs.renameSync(tmp, pdfPath));
}

// --- Inbound email webhook --------------------------------------------------
// Accepts SendGrid Inbound. Determine company by qa+<slug>@... (or <slug>.replies...)
app.post('/inbound', upload.any(), (req, res) => {
  try {
    if (INBOUND_SECRET) {
      const sent = (req.query.secret || req.headers['x-inbound-secret'] || '').toString();
      if (sent !== INBOUND_SECRET) return res.status(403).send('forbidden');
    }

    const payload = {
      from: req.body.from,
      to: req.body.to,
      subject: req.body.subject,
      text: req.body.text,
      html: req.body.html,
      envelope: req.body.envelope
    };

    // persist raw for debugging
    try {
      const rawName = `inbound_${Date.now()}.json`;
      const rawPath = path.join(DATA_DIR, rawName);
      fs.writeFileSync(rawPath, JSON.stringify(payload, null, 2));
    } catch {}

    const slug = getSlugFromInbound(payload.to, payload.envelope);
    const P = pathsFor(slug);

    const textBody = payload.text && payload.text.trim() ? payload.text : htmlToText(payload.html);
    const parsed = parseQAFromText(textBody);

    if (!parsed.length) {
      console.warn('Inbound parse failed (no Q:/A:). subject=', payload.subject);
      return res.status(400).json({ ok: false, error: 'Bad format. Use "Q: ...\\nA: ..."' });
    }

    let store = loadStore(P.store);
    let added = 0, skipped = 0;

    for (const { q, a } of parsed) {
      if (store[q] && String(store[q]).trim() === String(a).trim()) { skipped++; continue; }
      store[q] = a; added++;
    }

    if (added > 0) {
      saveStore(P.store, store);
      regeneratePdfFromStore(P.store, P.todayPdf, P.company);
      console.log(`Inbound saved for [${slug}] -> +${added} (skipped ${skipped}) → ${P.todayHref}`);
    } else {
      console.log(`Inbound duplicate for [${slug}] (no changes)`);
    }

    res.status(200).json({ ok: true, slug, parsed: added, skipped, entries: Object.keys(store).length, pdf: P.todayHref });
  } catch (err) {
    console.error("Inbound error:", err);
    // Keep 200 so SendGrid doesn't retry forever
    res.status(200).json({ ok: false, error: 'inbound exception' });
  }
});

// --- Static files & root ----------------------------------------------------
app.use('/public', express.static(PUBLIC_DIR));
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => {
  res.type('html').send(`<h1>Backend OK</h1>
  <ul>
    <li><a href="/api/status">/api/status</a> (add ?slug=FirstAnswerBot or ?slug=server-partners)</li>
  </ul>`);
});

// --- API: status (per-tenant via ?slug=) -----------------------------------
app.get('/api/status', (req, res) => {
  const slug = sanitizeSlug(req.query.slug || 'default');
  const P = pathsFor(slug);
  const entries = Object.keys(loadStore(P.store)).length;
  res.json({ ok: true, slug, company: P.company, entries, pdf: P.todayHref });
});

// --- API: add Q/A (optional, accepts slug in body) --------------------------
app.post('/api/qa', upload.none(), (req, res) => {
  const slug = sanitizeSlug(req.body.slug || 'default');
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'Missing question or answer' });

  const P = pathsFor(slug);
  const store = loadStore(P.store);

  if (store[question] && String(store[question]).trim() === String(answer).trim()) {
    return res.json({ success: true, dedup: true, slug, pdf: P.todayHref });
  }
  store[question] = answer;
  saveStore(P.store, store);
  regeneratePdfFromStore(P.store, P.todayPdf, P.company);

  const payload = { question, answer, slug, pdf: P.todayHref };
  broadcast('qa:new', payload);
  res.json({ success: true, ...payload });
});

// --- API: fetch one (per-tenant via ?slug=) ---------------------------------
app.get('/api/qa/:question', (req, res) => {
  const slug = sanitizeSlug(req.query.slug || 'default');
  const P = pathsFor(slug);
  const store = loadStore(P.store);
  const ans = store[req.params.question];
  if (!ans) return res.status(404).json({ error: 'Not found' });
  res.json({ answer: typeof ans === 'string' ? ans : JSON.stringify(ans), pdf: P.todayHref, slug });
});

// --- SSE --------------------------------------------------------------------
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// --- Unknown-question email (kept; optional) --------------------------------
async function handleUnknownQuestion(question) {
  const mailOptions = {
    from: process.env.REPLY_FROM || 'hello@1stanswerbot.com',
    to: COMPANY_REP_EMAIL,
    replyTo: 'qa@replies.1stanswerbot.com', // generic inbound; multi-tenant users should prefer mailto with qa+<slug> on CC
    subject: `New unanswered question: "${question}"`,
    text: `We received this question:\n\nQ: ${question}\n\nPlease reply inline using:\n\nQ: ${question}\nA: [type your answer here]\n`
  };
  try {
    await transporter.sendMail(mailOptions);
    console.log("Sent unknown-question email to rep");
  } catch (err) {
    console.error("Failed to send email", err);
  }
}
app.post('/api/unknown', requireApiKey, async (req, res) => {
  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Missing question' });
  try {
    await handleUnknownQuestion(question);
    // Broadcast a pending ticket (optional)
    const qid = crypto.randomBytes(6).toString('hex');
    const expiresAt = Date.now() + 2 * 60 * 1000;
    res.json({ success: true, qid, expiresAt, waitMs: expiresAt - Date.now(), message: "Question sent to a human." });
  } catch {
    res.status(500).json({ error: 'unknown flow failed' });
  }
});

// --- Admin (hash delete) ----------------------------------------------------
app.get('/api/entries', (req, res) => {
  if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return res.sendStatus(401);
  // default tenant listing
  const out = [];
  for (const slug of listSlugs()) {
    const P = pathsFor(slug);
    const store = loadStore(P.store);
    for (const [q, a] of Object.entries(store)) out.push({ slug, q, a, hash: entryHash(q, a) });
  }
  res.json({ entries: out.length, items: out });
});
app.post('/api/delete', express.json(), (req, res) => {
  if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return res.sendStatus(401);
  const { hash, slug = 'default' } = req.body || {};
  if (!hash) return res.status(400).json({ ok: false, error: 'hash required' });

  const P = pathsFor(sanitizeSlug(slug));
  const store = loadStore(P.store);
  let found = false;
  for (const [q, a] of Object.entries(store)) {
    if (entryHash(q, a) === hash) { delete store[q]; found = true; break; }
  }
  if (!found) return res.status(404).json({ ok: false, error: 'not found' });
  saveStore(P.store, store);
  regeneratePdfFromStore(P.store, P.todayPdf, P.company);
  res.json({ ok: true, entries: Object.keys(store).length, slug: P.slug, pdf: P.todayHref });
});

function listSlugs() {
  // list subdirectories in DATA_DIR; if none, include 'default' for legacy
  try {
    const items = fs.readdirSync(DATA_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    return items.length ? items : ['default'];
  } catch { return ['default']; }
}

// --- Nightly archive per tenant --------------------------------------------
cron.schedule('59 23 * * *', () => {
  try {
    const now = DateTime.now().setZone(TIMEZONE);
    const dateStr = now.toFormat('yyyy-LL-dd');

    for (const slug of listSlugs()) {
      const P = pathsFor(slug);
      if (!fs.existsSync(P.archiveDir)) fs.mkdirSync(P.archiveDir, { recursive: true });
      if (fs.existsSync(P.todayPdf)) {
        const dst = P.archiveNameFor(dateStr);
        fs.copyFileSync(P.todayPdf, dst);
        console.log('Archived PDF', { slug, dst });
      }
      // reset store and regenerate empty today
      saveStore(P.store, {});
      regeneratePdfFromStore(P.store, P.todayPdf, P.company);
      broadcast('qa:rollover', { slug, pdf: P.todayHref, date: dateStr });
    }
  } catch (e) {
    console.error('Archive job failed', e);
  }
}, { timezone: TIMEZONE });

// Ensure legacy "today" exists for default tenant (so old links keep working)
if (!fs.existsSync(TODAY_PDF)) {
  const P = pathsFor('default');
  regeneratePdfFromStore(P.store, P.todayPdf, P.company);
  // also symlink/copy to legacy path for compatibility
  try { fs.copyFileSync(P.todayPdf, TODAY_PDF); } catch {}
}

// start
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Try per-tenant status: /api/status?slug=FirstAnswerBot  or  /api/status?slug=server-partners`);
});
