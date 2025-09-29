// 2) server.js — REPLACE content with this exact file (your logic kept, debug added)
console.log('BOOT server.js', { cwd: process.cwd(), file: __filename, node: process.version });

const express = require('express');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ESCALATE_TO = process.env.ESCALATE_TO || 'hello@1stanswerbot.com';
const ESCALATE_CC = process.env.ESCALATE_CC || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

const SOURCES = []; // {id, title, url}
const QA = [];      // {q, a, sourceId}

function simpleMatchScore(q, text) {
  if (!q || !text) return 0;
  const words = q.toLowerCase().split(/\W+/).filter(Boolean);
  const t = text.toLowerCase();
  let hits = 0;
  for (const w of words) if (t.includes(w)) hits++;
  return words.length ? hits / words.length : 0;
}

async function sendEscalationEmail({ question, siteId, ctx }) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('Escalation skipped. Missing SMTP env.');
    return;
  }
  const tx = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const subject = `[Escalation] Unanswered question (${siteId || 'no-site'})`;
  const html = `
    <p>Unknown question from site: <b>${siteId || 'N/A'}</b></p>
    <p><b>Question:</b> ${question}</p>
    <p><b>Context:</b> ${ctx || 'N/A'}</p>
    <p>Please reply-all. Once answered, paste the Q&A into the PDF and re-upload.</p>
  `;

  await tx.sendMail({
    from: SMTP_USER,
    to: ESCALATE_TO,
    cc: ESCALATE_CC || undefined,
    subject,
    html
  });
}

// health and root
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/', (_req, res) => res.send('Hello from Docsbot Backend'));

// whoami debug (ADDED)
app.get('/whoami', (_req, res) => {
  res.json({
    cwd: process.cwd(),
    file: __filename,
    node: process.version,
    envPort: process.env.PORT || null
  });
});

// add a source
app.post('/api/sources/add', (req, res) => {
  const { title, url } = req.body || {};
  if (!title || !url) return res.status(400).json({ error: 'title and url required' });
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  SOURCES.push({ id, title, url });
  return res.json({ ok: true, id });
});

// seed Q&A
app.post('/api/qa/add', (req, res) => {
  const { q, a, sourceId } = req.body || {};
  if (!q || !a) return res.status(400).json({ error: 'q and a required' });
  QA.push({ q, a, sourceId: sourceId || null });
  return res.json({ ok: true, total: QA.length });
});

// chat endpoint
app.post('/api/chat', async (req, res) => {
  const { question, siteId } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question required' });

  let best = null;
  let bestScore = 0;
  for (const qa of QA) {
    const s1 = simpleMatchScore(question, qa.q);
    const s2 = simpleMatchScore(question, qa.a);
    const score = Math.max(s1, s2);
    if (score > bestScore) { bestScore = score; best = qa; }
  }

  if (best && bestScore >= 0.6) {
    return res.json({
      answer: best.a,
      confidence: Number(bestScore.toFixed(2)),
      sourceId: best.sourceId || null,
      sources: SOURCES
    });
  }

  const ctx = `Known QA count: ${QA.length}. Sources count: ${SOURCES.length}. BestScore: ${bestScore.toFixed(2)}`;
  try { await sendEscalationEmail({ question, siteId, ctx }); }
  catch (e) { console.error('Escalation email failed:', e.message); }

  return res.json({
    answer: "I don't have that answer yet. I sent your question to a human. We'll add it to the docs.",
    confidence: Number(bestScore.toFixed(2)),
    escalated: true
  });
});

// status
app.get('/api/status', (_req, res) => {
  res.json({ ok: true, qaCount: QA.length, sourceCount: SOURCES.length });
});

// __routes debug (ADDED)
function collectRoutes(appRef){
  const out = [];
  appRef._router.stack.forEach((m) => {
    if (m.route) {
      const methods = Object.keys(m.route.methods).map(x => x.toUpperCase()).join(',');
      out.push({ methods, path: m.route.path });
    }
  });
  return out;
}
app.get('/__routes', (_req, res) => {
  res.json({ routes: collectRoutes(app) });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

