// server.js
console.log('BOOT', { cwd: process.cwd(), node: process.version });

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const PORT = process.env.PORT || 3000;
const TIMEZONE = 'America/Indiana/Indianapolis';

const DATA_DIR = path.join(process.cwd(), 'data');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const STORE_PATH = path.join(DATA_DIR, 'qa_store.json');
const TODAY_PDF = path.join(PUBLIC_DIR, 'qa-today.pdf');

// make sure dirs exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();
const upload = multer();

app.post('/inbound', upload.any(), (req, res) => {
  try {
    const payload = {
      from: req.body.from,
      to: req.body.to,
      subject: req.body.subject,
      text: req.body.text,
      html: req.body.html,
      envelope: req.body.envelope
    };

    console.log("Inbound email received:", payload);

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, `inbound_${Date.now()}.json`),
      JSON.stringify(payload, null, 2)
    );

    res.status(200).send("ok");
  } catch (err) {
    console.error("Inbound error:", err);
    res.status(200).send("ok");
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

// explicit routes
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
