// server.js
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

// ------------ CONFIG ------------
const PORT = process.env.PORT || 3000;
const TIMEZONE = 'America/Indiana/Indianapolis';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const STORE_PATH = path.join(DATA_DIR, 'qa_store.json');
const TODAY_PDF = path.join(PUBLIC_DIR, 'qa-today.pdf');
const PENDING_PATH = path.join(DATA_DIR, 'pending.json');

const INBOUND_SECRET = process.env.INBOUND_SECRET || '';
const API_KEY = process.env.API_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const COMPANY_REP_EMAIL = process.env.REP_EMAIL || 'hello@1stanswerbot.com';
const REPLY_FROM = process.env.REPLY_FROM || 'hello@1stanswerbot.com';

const TWO_MIN_MS = 2 * 60 * 1000;

// ensure dirs
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();
const ALLOW_ORIGINS = [
  'https://1stanswerbot.com',
  'https://www.1stanswerbot.com',
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOW_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, X-API-KEY');
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});
// body parsers + uploads
app.use(cors({
  origin: [
    'https://1stanswerbot.com',
    'https://www.1stanswerbot.com',
  ],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','x-api-key'],
}));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
const upload = multer({ limits: { fieldSize: 1 * 1024 * 1024 } });

// email transport (SendGrid SMTP)
const transporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net',
  port: 587,
  auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY }
});

// ------------ UTILS ------------
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
  const qa = [];
  let q = null, aBuf = [];
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
    if (q && aBuf.length) aBuf.push(raw);
  }
  flush();
  return qa;
}

function entryHash(q, a) {
  return crypto.createHash('sha256').update(q + '\n' + a).digest('hex');
}

function genQID() {
  return crypto.randomBytes(6).toString('hex'); // 12 chars
}

// ------------ DATA LAYERS ------------
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function loadQA() { return loadJSON(STORE_PATH, {}); }
function saveQA(data) { saveJSON(STORE_PATH, data); }
function loadPending() { return loadJSON(PENDING_PATH, {}); }
function savePending(data) { saveJSON(PENDING_PATH, data); }

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

// ------------ SSE ------------
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

// ------------ LOGGER / STATIC ------------
app.use((req, _res, next) => { console.log(req.method, req.url); next(); });
app.use('/public', express.static(PUBLIC_DIR));
app.use(express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  // prefer index.html if it exists, fallback to a tiny page
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.type('html').send('<h1>DocsBot Backend</h1><p>OK</p>');
});

app.get('/raw-test', (_req, res) => {
  res.type('html').send('<h1>RAW OK</h1><p>No cache</p>');
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ------------ CORE EMAIL FLOW ------------

// Email to rep for unknown question
async function emailRepAboutUnknown(question, qid) {
  const subject = `New unanswered question [QID:${qid}]`;
  const text = `
We received this question:

Q: ${question}

Please REPLY to this email with the following format so the bot can learn:

Q: ${question}
A: [type your answer here]

(Keep [QID:${qid}] in the subject)
  `.trim();

  const mailOptions = {
    from: REPLY_FROM,
    to: COMPANY_REP_EMAIL,
    replyTo: process.env.INBOUND_REPLY_TO || 'qa@replies.1stanswerbot.com',
    subject,
    text
  };

  await transporter.sendMail(mailOptions);
  console.log('Sent unknown-question email to rep', { to: COMPANY_REP_EMAIL, qid });
}

// Create pending ticket and email rep
async function createPendingAndNotify(question, userEmail = null) {
  const pending = loadPending();
  const qid = genQID();
  const now = Date.now();

  pending[qid] = {
    qid,
    question,
    createdAt: now,
    userEmail: userEmail || null,
    answeredAt: null
  };
  savePending(pending);

  await emailRepAboutUnknown(question, qid);

  return { qid, expiresAt: now + TWO_MIN_MS };
}

// On answer received (from inbound), decide realtime vs email
async function handleAnswerDelivery({ qid, question, answer }) {
  // Always save to store + PDF
  const store = loadQA();
  store[question] = answer;
  saveQA(store);
  regeneratePdfFromStore();

  const pending = loadPending();
  const ticket = pending[qid];

  if (!ticket) {
    console.log('Answer received for unknown QID; saved to store/PDF only', { qid });
    return { delivered: 'store_only' };
  }

  const now = Date.now();
  ticket.answeredAt = now;
  savePending(pending);

  const within2min = now - ticket.createdAt <= TWO_MIN_MS;

  if (within2min) {
    // realtime push to chat
    broadcast('qa:answer', { qid, question, answer, pdf: '/public/qa-today.pdf' });
    console.log('Pushed realtime answer to chat', { qid });
    return { delivered: 'chat' };
  }

  // outside 2 min: email user if we have their email
  if (ticket.userEmail) {
    try {
      await transporter.sendMail({
        from: REPLY_FROM,
        to: ticket.userEmail,
        subject: `Answer to your question`,
        text: `Q: ${question}\nA: ${answer}\n\nA PDF copy is available here: /public/qa-today.pdf`
      });
      console.log('Emailed user answer (outside 2min)', { qid, to: ticket.userEmail });
      return { delivered: 'email_user' };
    } catch (e) {
      console.error('Failed emailing user answer', e);
      return { delivered: 'email_user_failed' };
    }
  }

  console.log('No user email on file; saved to store/PDF only', { qid });
  return { delivered: 'store_only' };
}

// ------------ API: Unknown & Email capture ------------

// Trigger unknown flow (chatbot calls this)
app.post('/api/unknown', requireApiKey, async (req, res) => {
  try {
    const { question, userEmail } = req.body || {};
    if (!question) return res.status(400).json({ error: 'Missing question' });

    const { qid, expiresAt } = await createPendingAndNotify(question, userEmail || null);

    // Tell chat whether to wait or fall back
    res.json({
      success: true,
      qid,
      expiresAt,
      waitMs: TWO_MIN_MS,
      message: 'Question sent to a human. If they reply within 2 minutes, you’ll see the answer here. Otherwise we’ll email you when it’s ready.'
    });
  } catch (e) {
    console.error('unknown flow error', e);
    res.status(500).json({ error: 'unknown flow failed' });
  }
});

// If chat needs to attach an email later (after showing the “we’ll email you” prompt)
app.post('/api/pending/:qid/email', requireApiKey, (req, res) => {
  const { qid } = req.params;
  const { userEmail } = req.body || {};
  if (!userEmail) return res.status(400).json({ error: 'Missing userEmail' });

  const pending = loadPending();
  if (!pending[qid]) return res.status(404).json({ error: 'Unknown qid' });

  pending[qid].userEmail = userEmail;
  savePending(pending);
  res.json({ success: true });
});

// ------------ INBOUND (SendGrid) ------------

app.post('/inbound', upload.any(), async (req, res) => {
  try {
    // optional secret check
    if (INBOUND_SECRET) {
      const sent = (req.query.secret || req.headers['x-inbound-secret'] || '').toString();
      if (sent !== INBOUND_SECRET) return res.status(403).send('forbidden');
    }

    const payload = {
      from: req.body.from,
      to: req.body.to,
      subject: req.body.subject || '',
      text: req.body.text,
      html: req.body.html,
      envelope: req.body.envelope
    };

    console.log('Inbound email:', { from: payload.from, to: payload.to, subject: payload.subject });

    // persist inbound for debugging
    fs.writeFileSync(
      path.join(DATA_DIR, `inbound_${Date.now()}.json`),
      JSON.stringify(payload, null, 2)
    );

    const textBody = (payload.text && payload.text.trim()) ? payload.text : htmlToText(payload.html);
    const parsed = parseQAFromText(textBody);

    if (!parsed.length) {
      console.warn('Inbound parse failed (no Q:/A:)');
      return res.status(200).json({ ok: false, error: 'Bad format. Use "Q: ...\\nA: ..."' });
    }

    // Try to extract QID from subject like [QID:abcdef123456]
    const qidMatch = (payload.subject || '').match(/\[QID:([a-f0-9]{12})\]/i);
    const qidFromSubject = qidMatch ? qidMatch[1] : null;

    // handle each Q/A found (usually 1)
    for (const { q, a } of parsed) {
      let chosenQID = qidFromSubject;

      // If no QID in subject, try to match by exact question against pending
      if (!chosenQID) {
        const pending = loadPending();
        for (const t of Object.values(pending)) {
          if (t.question && t.question.trim() === q.trim()) {
            chosenQID = t.qid;
            break;
          }
        }
      }

      const result = await handleAnswerDelivery({
        qid: chosenQID || genQID(), // fall back: still save to store/PDF
        question: q,
        answer: a
      });

      console.log('Inbound handled', { qid: chosenQID, delivery: result.delivered });
    }

    res.status(200).json({ ok: true, parsed: parsed.length });
  } catch (err) {
    console.error('Inbound error:', err);
    // keep 200 for SendGrid; mark ok:false for logs
    res.status(200).json({ ok: false, error: 'inbound exception' });
  }
});

// ------------ Q/A CRUD & STATUS ------------
app.get('/api/status', (_req, res) => {
  const store = loadQA();
  res.json({ ok: true, entries: Object.keys(store).length, pdf: '/public/qa-today.pdf' });
});

app.post('/api/qa', upload.none(), (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'Missing question or answer' });

  const store = loadQA();
  if (store[question] && String(store[question]).trim() === String(answer).trim()) {
    return res.json({ success: true, dedup: true, pdf: '/public/qa-today.pdf' });
  }

  store[question] = answer;
  saveQA(store);
  regeneratePdfFromStore();

  const payload = { question, answer, pdf: '/public/qa-today.pdf' };
  broadcast('qa:new', payload);
  res.json({ success: true, ...payload });
});

app.get('/api/qa/:question', (req, res) => {
  const store = loadQA();
  const ans = store[req.params.question];
  if (!ans) return res.status(404).json({ error: 'Not found' });
  res.json({ answer: cleanAnswer(ans), pdf: '/public/qa-today.pdf' });
});

// ------------ ADMIN ------------
app.get('/api/entries', (req, res) => {
  if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
    return res.sendStatus(401);
  }
  const store = loadQA();
  const items = Object.entries(store).map(([q, a]) => ({ q, a, hash: entryHash(q, a) }));
  res.json({ entries: items.length, items });
});

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

// ------------ DAILY ARCHIVE ------------
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
if (!fs.existsSync(PENDING_PATH)) savePending({});

// start
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Check: /api/status  /public/qa-today.pdf  /api/stream`);
});
