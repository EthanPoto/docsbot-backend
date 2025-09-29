// server.js
console.log('BOOT server.js', { cwd: process.cwd(), file: __filename, node: process.version });

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const app = express();
const upload = multer();

// config
const PORT = process.env.PORT || 3000;
const TIMEZONE = 'America/Indiana/Indianapolis';

const DATA_DIR = path.join(process.cwd(), 'data');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const STORE_PATH = path.join(DATA_DIR, 'qa_store.json');
const TODAY_PDF = path.join(PUBLIC_DIR, 'qa-today.pdf');

// helpers
function loadQA() {
  if (!fs.existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveQA(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
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
      doc.fontSize(12).text('A: ' + a);
      doc.moveDown(0.75);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    }
  }

  doc.end();
  stream.on('finish', () => {
    fs.renameSync(tmp, TODAY_PDF);
  });
}

// SSE
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

// middleware
app.use(express.json());
app.use('/public', express.static(PUBLIC_DIR));

// health
app.get('/api/status', (req, res) => {
  const store = loadQA();
  res.json({
    ok: true,
    entries: Object.keys(store).length,
    pdf: '/public/qa-today.pdf',
  });
});

// add Q&A + rebuild PDF + notify clients
app.post('/api/qa', upload.none(), (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) {
    return res.status(400).json({ error: 'Missing question or answer' });
  }
  const store = loadQA();
  store[question] = answer;
  saveQA(store);
  regeneratePdfFromStore();

  const payload = { question, answer, pdf: '/public/qa-today.pdf' };
  broadcast('qa:new', payload);
  res.json({ success: true, ...payload });
});

// fetch single answer
app.get('/api/qa/:question', (req, res) => {
  const store = loadQA();
  const ans = store[req.params.question];
  if (!ans) return res.status(404).json({ error: 'Not found' });
  res.json({ answer: ans, pdf: '/public/qa-today.pdf' });
});

// SSE stream for realtime updates
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// daily archive at 23:59 local time
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

    // reset for new day
    saveQA({});
    regeneratePdfFromStore();
    broadcast('qa:rollover', { pdf: '/public/qa-today.pdf', date: dateStr });
  } catch (e) {
    console.error('Archive job failed', e);
  }
}, { timezone: TIMEZONE });

// first boot ensure PDF exists
if (!fs.existsSync(TODAY_PDF)) {
  regeneratePdfFromStore();
}

// start
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Status: http://localhost:${PORT}/api/status`);
  console.log(`PDF:    http://localhost:${PORT}/public/qa-today.pdf`);
});

