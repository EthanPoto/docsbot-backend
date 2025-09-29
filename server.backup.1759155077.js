// Minimal 1st Answer Bot backend
const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(process.cwd(), 'data');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const STORE = path.join(DATA_DIR, 'qa_store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(PUBLIC_DIR));

function loadQA() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')).QA || []; }
  catch { return []; }
}
function saveQA(arr) { fs.writeFileSync(STORE, JSON.stringify({ QA: arr }, null, 2)); }

let QA = loadQA();

// Health check
app.get('/api/status', (req, res) => res.json({ ok: true, ts: Date.now(), qaCount: QA.length }));

// Get all Q&A
app.get('/api/qa', (req, res) => res.json({ ok: true, total: QA.length, QA }));

// Add new Q&A
app.post('/api/qa', (req, res) => {
  const { q, a, sourceId = null } = req.body || {};
  if (!q || !a) return res.status(400).json({ ok: false, error: 'q and a required' });
  QA.push({ q, a, sourceId, ts: Date.now() });
  saveQA(QA);
  res.json({ ok: true, total: QA.length });
});

// Ask
app.get('/api/ask', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.status(400).json({ ok: false, error: 'q required' });
  let best = null, score = 0;
  for (const item of QA) {
    const s = (item.q||'').toLowerCase().includes(q) ? 2 : (item.a||'').toLowerCase().includes(q) ? 1 : 0;
    if (s > score) { best = item; score = s; }
  }
  if (!best) return res.json({ ok: true, answer: null, note: 'no match' });
  res.json({ ok: true, answer: best.a, sourceId: best.sourceId || null });
});

// Start
app.listen(PORT, () => console.log('Server listening on port', PORT));
