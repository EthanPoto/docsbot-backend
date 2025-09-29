// server.js
console.log('BOOT', { cwd: process.cwd(), node: process.version });

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const { DateTime } = require('luxon');
const crypto = require('crypto'); // ➕ for content hashing
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
const TIMEZONE = 'America/Indiana/Indianapolis';

// ➕ allow persistent disk via env
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const STORE_PATH = path.join(DATA_DIR, 'qa_store.json');
const TODAY_PDF = path.join(PUBLIC_DIR, 'qa-today.pdf');

const INBOUND_SECRET = process.env.INBOUND_SECRET || '';
const API_KEY = process.env.API_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // ➕ bearer for admin endpoints

// make sure dirs exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();
// ➕ limit inbound form body to 1MB
const upload = multer({ limits: { fieldSize: 1 * 1024 * 1024 } });

// configure email transport (SendGrid SMTP)
const transporter = nodemailer.createTransport({
  host: "smtp.sendgrid.net",
  port: 587,
  auth: {
    user: "apikey", // this literal string is required
    pass: process.env.SENDGRID_API_KEY
  }
});

const COMPANY_REP_EMAIL = process.env.REP_EMAIL || "support@1stanswerbot.com";

// simple API key middleware
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ➕ tiny HTML→text fallback if email comes as HTML-only
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

// ➕ robust Q/A parser (first Q: ... then A: ...; supports multiline A)
function parseQAFromText(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  const qa = [];
  let q = null;
  let aBuf = [];
  const flush = () => {
    if (q && aBuf.length) {
      const a = aBuf.join('\n').trim();
      if (a) qa.push({ q: q.trim(), a });
    }
    q = null; aBuf = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    const qm = line.match(/^Q[:\-]\s*(.+)$/i);
    const am = line.match(/^A[:\-]\s*(.*)$/i);
    if (qm) { flush(); q = qm[1]; continue; }
    if (am) { aBuf.push(am[1]); continue; }
    if (q && aBuf.length) aBuf.push(raw); // allow multiline answers
  }
  flush();
  return qa;
}

// ➕ hash helper for dedupe
function entryHash(q, a) {
  return crypto.createHash('sha256').update(q + '\n' + a).digest('hex');
}

// inbound email handler
app.post('/inbound', upload.any(), (req, res) => {
  try {
    // secret check for SendGrid webhook
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

    console.log("Inbound email received:", { from: payload.from, to: payload.to, subject: payload.subject });
    console.log("Saving inbound email to:", DATA_DIR);

    // save raw email to file
    fs.writeFileSync(
      path.join(DATA_DIR, `inbound_${Date.now()}.json`),
      JSON.stringify(payload, null, 2)
    );

    // ➕ parse with HTML fallback
    const textBody = payload.text && payload.text.trim() ? payload.text : htmlToText(payload.html);
    const parsed = parseQAFromText(textBody);

    if (!parsed.length) {
      console.warn('Inbound parse failed (no Q:/A:). subject=', payload.subject);
      return res.status(400).json({ ok: false, error: 'Bad format. Use "Q: ...\\nA: ..."' });
    }

    // load existing store (object of q -> a)
    let store = {};
    if (fs.existsSync(STORE_PATH)) {
      try { store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); } catch {}
    }

    let added = 0, skipped = 0;
    for (const { q, a } of parsed) {
      const existing = store[q];
      if (typeof existing === 'string' && existing.trim() === a.trim()) {
        skipped++;
        continue; // ➕ dedupe: same Q and A already present
      }
      store[q] = a;
      added++;
    }

    if (added > 0) {
      fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
      regeneratePdfFromStore();
      console.log(`Saved ${added} Q/A to`, STORE_PATH, 'skipped duplicates:', skipped);
      console.log('Regenerated PDF at', TODAY_PDF);
    } else {
      console.log('No new entries added (all duplicates).');
    }

    res.status(200).json({ ok: true, added, skipped, entries: Object.keys(store).length });
  } catch (err) {
    console.error("Inbound error:", err);
    // keep 200 for SendGrid to avoid retries; include ok:false for our visibility
    res.status(200).json({ ok: false, error: 'inbound exception' });
  }
});

// disable cache + log requests
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  console.log(req.method, req.url);
  next();
});

// serve static
app.use('/public', express.static(PUBLIC_DIR));
app.use(express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'test.html'));
});
app.get('/raw-test', (_req, res) => {
  res.type('html').send('<h1>RAW OK</h1><p>No cache</p>');
});

app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: '1mb' })); // ➕ general parsers

// helpers
function loadQA() {
  if (!fs.existsSync(STORE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return {}; }
}
function saveQA(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}
function cleanAnswer(a) {
  if (typeof a === 'string') return a;
  if (a == null) return '';
  return JSON.stringify(a);
}
function regeneratePdfFromStore() {
  const store = loadQA();
  const doc = new PDFDocument({ margin: 40 });
  const tmp = TODAY_PDF + '.tmp';

  const stream = fs.createWriteStream(tmp);
  doc.pipe(stream);

  const zoneNow = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd HH:mm');
  doc.fontSize(18).text('Q&A – Today', { underline: true });
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
      doc.fontSize(12).text('A: ' + cleanAnswer(a));
      doc.moveDown(0.75);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    }
  }

  doc.end();
  stream.on('finish', () => fs.renameSync(tmp, TODAY_PDF));
}

// SSE
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

// health
app.get('/api/status', (_req, res) => {
  const store = loadQA();
  res.json({ ok: true, entries: Object.keys(store).length, pdf: '/public/qa-today.pdf' });
});

// add Q&A
app.post('/api/qa', upload.none(), (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'Missing question or answer' });

  const store = loadQA();
  if (store[question] && String(store[question]).trim() === String(answer).trim()) {
    return res.json({ success: true, dedup: true, pdf: '/public/qa-today.pdf' }); // ➕ dedupe on API too
  }

  store[question] = answer;
  saveQA(store);
  regeneratePdfFromStore();

  const payload = { question, answer, pdf: '/public/qa-today.pdf' };
  broadcast('qa:new', payload);
  res.json({ success: true, ...payload });
});

// fetch one
app.get('/api/qa/:question', (req, res) => {
  const store = loadQA();
  const ans = store[req.params.question];
  if (!ans) return res.status(404).json({ error: 'Not found' });
  res.json({ answer: cleanAnswer(ans), pdf: '/public/qa-today.pdf' });
});

// SSE
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// unknown question → send email to rep
async function handleUnknownQuestion(question) {
  const mailOptions = {
    from: 'hello@1stanswerbot.com',
    to: COMPANY_REP_EMAIL,
    subject: `New unanswered question: "${question}"`,
    text: `
We received this question: 

Q: ${question}

Please reply to this email in the following format so the bot can learn:

Q: ${question}
A: [type your answer here]
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("Sent unknown-question email to rep");
  } catch (err) {
    console.error("Failed to send email", err);
  }
}

// API endpoint to trigger unknown question email (guarded)
app.post('/api/unknown', requireApiKey, express.json(), async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Missing question' });

  await handleUnknownQuestion(question);
  res.json({ success: true, sent: true });
});

// ➕ ADMIN: list entries (Bearer ADMIN_TOKEN)
app.get('/api/entries', (req, res) => {
  if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
    return res.sendStatus(401);
  }
  const store = loadQA();
  const items = Object.entries(store).map(([q, a]) => ({
    q, a, hash: entryHash(q, a)
  }));
  res.json({ entries: items.length, items });
});

// ➕ ADMIN: delete one by hash (Bear er ADMIN_TOKEN)
app.post('/api/delete', express.json(), (req, res) => {
  if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
    return res.sendStatus(401);
  }
  const { hash } = req.body || {};
  if (!hash) return res.status(400).json({ ok: false, error: 'hash required' });

  const store = loadQA();
  let found = false;
  for (const [q, a] of Object.entries(store)) {
    if (entryHash(q, a) === hash) {
      delete store[q];
      found = true;
      break;
    }
  }
  if (!found) return res.status(404).json({ ok: false, error: 'not found' });

  saveQA(store);
  regeneratePdfFromStore();
  res.json({ ok: true, entries: Object.keys(store).length });
});

// daily archive
cron.schedule('59 23 * * *', () => {
  try {
    const now = DateTime.now().setZone(TIMEZONE);
    const dateStr = now.toFormat('yyyy-LL-dd');

    const archiveDir = path.join(DATA_DIR, 'archive');
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

    if (fs.existsSync(TODAY_PDF)) {
      const dst = path.join(archiveDir, `qa-${dateStr}.pdf`);
      fs.copyFileSync(TODAY_PDF, dst);
      console.log('Archived PDF', { dst });
    }

    saveQA({});
    regeneratePdfFromStore();
    broadcast('qa:rollover', { pdf: '/public/qa-today.pdf', date: dateStr });
  } catch (e) {
    console.error('Archive job failed', e);
  }
}, { timezone: TIMEZONE });

// first boot
if (!fs.existsSync(TODAY_PDF)) regeneratePdfFromStore();

// start
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Check: /api/status /public/test.html /test.html /raw-test`);
});
