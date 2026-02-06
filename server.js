// server.js — 1st Answer Bot inbound Q/A store (multi-tenant) + per-tenant PDFs
// Goals:
// - Route updates by qa+<slug>@replies.<domain> in To/CC, with subject fallback: [1st Answer Bot][slug] ...
// - Save Q/A pairs per slug
// - Rebuild a single rolling PDF per slug: /public/<slug>/qa-today.pdf
// - Optional private daily archives under /data/<slug>/archive
// - Keep behavior stable even when reps forget "Q:" or users edit drafts
// - Keep PDFs clean by stripping signatures + quoted email thread content

'use strict';

console.log('BOOT', { cwd: process.cwd(), node: process.version });

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const { DateTime } = require('luxon');
const cors = require('cors');
const crypto = require('crypto');

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'America/Indiana/Indianapolis';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(process.cwd(), 'public');
const BASE_URL =
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`;

const INBOUND_SECRET = process.env.INBOUND_SECRET || ''; // header x-inbound-secret OR ?secret=...
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';     // for admin-only endpoints

const DEBUG_INBOUND_ENV = /^(1|true|yes)$/i.test(String(process.env.DEBUG_INBOUND || ''));
const BUILD = process.env.RENDER_GIT_COMMIT || process.env.BUILD || 'dev';

const ARCHIVE_RETENTION_DAYS = parseInt(process.env.ARCHIVE_RETENTION_DAYS || '90', 10);

// Keep only qa-today.pdf public. Daily public archives disabled by default.
const ENABLE_PUBLIC_ARCHIVES = /^(1|true|yes)$/i.test(String(process.env.ENABLE_PUBLIC_ARCHIVES || ''));

// Hard cap on private archives per tenant (newest kept). 0 disables.
const ARCHIVE_CAP = parseInt(process.env.ARCHIVE_CAP || '120', 10);

// Treat repeated SendGrid posts as idempotent based on computed inbound signature.
const ENABLE_IDEMPOTENCY = !/^(0|false|no)$/i.test(String(process.env.ENABLE_IDEMPOTENCY || '1'));

// Store-level dedupe for repeated questions.
const ENABLE_DEDUPE = !/^(0|false|no)$/i.test(String(process.env.ENABLE_DEDUPE || '1'));

// ---------------- BOOTSTRAP DIRS ----------------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// ---------------- APP ----------------
const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Serve /public with no-cache for PDFs so latest always shows
app.use('/public', express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (String(filePath).toLowerCase().endsWith('.pdf')) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// SendGrid inbound uses multipart/form-data
const upload = multer({ limits: { fieldSize: 2 * 1024 * 1024 } });

// ---------------- HELPERS ----------------
function safeSlug(slug) {
  return String(slug || 'default').toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'default';
}

function slugDirs(slugRaw) {
  const slug = safeSlug(slugRaw);

  const dataBase = path.join(DATA_DIR, slug);
  const dataArchive = path.join(dataBase, 'archive');

  const publicBase = path.join(PUBLIC_DIR, slug);
  const publicArchive = path.join(publicBase, 'archive');

  const storePath = path.join(dataBase, 'qa_store.json');
  const todayPdf = path.join(publicBase, 'qa-today.pdf');

  [dataBase, dataArchive, publicBase, publicArchive].forEach(p => {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });

  return { slug, dataBase, dataArchive, publicBase, publicArchive, storePath, todayPdf };
}

function loadStore(storePath) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) return parsed;
  } catch {}
  return { items: [], meta: { lastInboundSig: '' } };
}

function saveStore(storePath, store) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function displayNameFromSlug(slug = '') {
  const cleaned = String(slug).replace(/[-_]+/g, ' ').trim();
  return cleaned.replace(/\b\w/g, c => c.toUpperCase());
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function nowTs() {
  return Date.now();
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------- HTML → text ----------
function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#10;|&#x0A;/gi, '\n')
    .replace(/\u00A0/g, ' ');
}

function htmlToText(html) {
  if (!html) return '';
  let out = String(html);

  out = out.replace(/<(\/p|br|\/li|\/div)>/gi, '$&\n');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '')
           .replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<[^>]+>/g, '');
  out = decodeEntities(out);
  out = out.replace(/\r/g, '').trim();

  return out;
}

// ---------- Tenant routing helpers ----------
function splitList(s) {
  return String(s || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

function extractAddress(addr) {
  let a = String(addr || '').trim();
  const m = a.match(/<([^>]+)>/);
  if (m) a = m[1].trim();
  return a;
}

function findQaRecipients(fields, debug) {
  const headerAll = [...splitList(fields.to), ...splitList(fields.cc)].map(extractAddress);

  const headerCandidates = headerAll.filter(a => /^qa\+/i.test((a.split('@')[0] || '')) && /@.*replies\./i.test(a));

  let envTo = [];
  try {
    const env = JSON.parse(fields.envelope || '{}');
    envTo = Array.isArray(env.to) ? env.to : (env.to ? [env.to] : []);
  } catch {}

  const envCandidates = envTo.map(extractAddress).filter(a => /^qa\+/i.test((a.split('@')[0] || '')) && /@.*replies\./i.test(a));

  const picked = headerCandidates.length ? headerCandidates : envCandidates;

  if (debug) {
    console.log('QA ROUTE CANDIDATES', {
      to: fields.to || '',
      cc: fields.cc || '',
      headerCandidates,
      envCandidates,
      pickedFrom: headerCandidates.length ? 'header' : 'envelope'
    });
  }

  return picked;
}

function deriveSlugFromAddress(addr) {
  const a = extractAddress(addr);
  const [local, host] = String(a).split('@');

  // qa+slug@replies....
  const plus = (local || '').match(/^[^+]+?\+([a-z0-9][a-z0-9-_]{0,63})$/i);
  if (plus) return safeSlug(plus[1]);

  // qa@slug.replies....
  const mHost = (host || '').toLowerCase().match(/^([a-z0-9][a-z0-9-_]{0,63})\.replies\./i);
  if (mHost) return safeSlug(mHost[1]);

  return 'default';
}

function deriveSlugFromSubject(subject) {
  // [1st Answer Bot][slug] ...
  const s = String(subject || '');
  const m = s.match(/^\s*\[1st\s*Answer\s*Bot\]\s*\[([a-z0-9][a-z0-9-_]{0,63})\]/i);
  return m ? safeSlug(m[1]) : '';
}

// ---------- Email body parsing ----------
function stripQuotedThread(text) {
  const t = String(text || '').replace(/\r/g, '');

  const cutMarkers = [
    /^\s*On .* wrote:\s*$/im,
    /^\s*From:\s*.*$/im,
    /^\s*Sent:\s*.*$/im,
    /^\s*To:\s*.*$/im,
    /^\s*Subject:\s*.*$/im,
    /^\s*-----Original Message-----\s*$/im,
    /^\s*________________________________\s*$/im,
    /^\s*>/m
  ];

  let cutAt = -1;
  for (const re of cutMarkers) {
    const idx = t.search(re);
    if (idx !== -1) cutAt = cutAt === -1 ? idx : Math.min(cutAt, idx);
  }
  return (cutAt === -1 ? t : t.slice(0, cutAt)).trim();
}

function stripSignature(text) {
  let t = String(text || '').replace(/\r/g, '').trim();

  const sigMarkers = [
    /^\s*--\s*$/m,
    /^\s*thanks[,\s]*$/im,
    /^\s*thank you[,\s]*$/im,
    /^\s*best[,\s]*$/im,
    /^\s*regards[,\s]*$/im,
    /^\s*sincerely[,\s]*$/im,
    /^\s*sent from my/i
  ];

  let cutAt = -1;
  for (const re of sigMarkers) {
    const idx = t.search(re);
    if (idx !== -1) cutAt = cutAt === -1 ? idx : Math.min(cutAt, idx);
  }
  if (cutAt !== -1) t = t.slice(0, cutAt).trim();

  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

function parseQA(rawText) {
  const original = String(rawText || '').replace(/\r/g, '').trim();
  const cleaned = stripQuotedThread(original);

  const qMatch = cleaned.match(/^\s*Q\s*[:\-–]\s*(.+)$/im);
  const aMatch = cleaned.match(/^\s*A\s*:\s*([\s\S]+)$/im);

  let q = qMatch ? qMatch[1].trim() : '';
  let a = '';

  if (aMatch) {
    a = aMatch[1];
    const cutAt = a.search(/^\s*(Q\s*[:\-–]|On .* wrote:|From:|Sent:|To:|Subject:|-----|>)/im);
    if (cutAt > -1) a = a.slice(0, cutAt);
    a = stripSignature(a.trim());
  }

  if (q && a) return { mode: 'QA', q, a };
  if (q && !a) return { mode: 'Q', q };
  if (!q && a) return { mode: 'A', a };

  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { mode: 'NONE' };

  const questionLine = lines.find(l => /\?\s*$/.test(l));
  if (questionLine) {
    q = questionLine;
    const qIndex = lines.indexOf(questionLine);
    const rest = lines.slice(qIndex + 1).join('\n').trim();
    if (rest) {
      a = stripSignature(rest);
      return { mode: 'QA', q, a };
    }
    return { mode: 'Q', q };
  }

  q = lines[0];
  const rest = lines.slice(1).join('\n').trim();
  if (rest) {
    a = stripSignature(rest);
    return { mode: 'QA', q, a };
  }

  return { mode: 'Q', q };
}

// ---------- PDF generation ----------
function writeTodayPdfAtomic(pdfPath, slug, items) {
  return new Promise((resolve, reject) => {
    try {
      const tmp = pdfPath + '.tmp';
      fs.mkdirSync(path.dirname(pdfPath), { recursive: true });

      const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
      const stream = fs.createWriteStream(tmp);
      doc.pipe(stream);

      const ts = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd HH:mm');
      const company = displayNameFromSlug(slug);

      doc.fontSize(18).text(`Q/A — ${company} (Today)`, { underline: true });
      doc.moveDown(0.25);
      doc.fontSize(10).text(`Generated: ${ts} ${TIMEZONE}`);
      doc.moveDown();

      if (!items.length) {
        doc.fontSize(12).text('No entries yet for today.');
      } else {
        items.forEach((entry, i) => {
          const ans = (entry.a && String(entry.a).trim()) ? entry.a : '(pending)';
          doc.moveDown(0.5);
          doc.fontSize(13).text(`${i + 1}. Q: ${entry.q}`);
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
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      stream.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

// ---------- Per-slug serialization ----------
const slugQueues = new Map();

function withSlugLock(slug, fn) {
  const key = safeSlug(slug);
  const prev = slugQueues.get(key) || Promise.resolve();

  const next = prev
    .catch(() => {})
    .then(fn);

  slugQueues.set(key, next.finally(() => {
    if (slugQueues.get(key) === next) slugQueues.delete(key);
  }));

  return next;
}

// ---------------- ROUTES ----------------
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), build: BUILD, timezone: TIMEZONE });
});

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, note: 'prefer /health', time: new Date().toISOString(), build: BUILD });
});

app.get('/', (_req, res) => {
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.type('html').send('<h1>1st Answer Bot backend</h1><p>OK</p>');
});

app.get('/c/:slug/api/status', (req, res) => {
  const { slug, storePath } = slugDirs(req.params.slug);
  const store = loadStore(storePath);
  const todayPdfUrl = `${BASE_URL}/public/${encodeURIComponent(slug)}/qa-today.pdf`;
  const pending = (store.items || []).filter(x => !x.a || !String(x.a).trim()).length;
  res.json({ slug, count: store.items.length, pending, todayPdfUrl });
});

app.get('/c/:slug/api/peek', (req, res) => {
  const { slug, storePath } = slugDirs(req.params.slug);
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '5', 10)));
  const store = loadStore(storePath);
  res.json({ slug, count: store.items.length, last: store.items.slice(-limit) });
});

// Manual rollover (archive now + reset)
app.post('/c/:slug/api/archive-now', async (req, res) => {
  const { slug, storePath, todayPdf, dataArchive, publicArchive } = slugDirs(req.params.slug);

  const sec = (req.query.secret || req.headers['x-admin-secret'] || req.headers['x-inbound-secret'] || '').toString();
  const okSecret = (ADMIN_SECRET && sec === ADMIN_SECRET) || (INBOUND_SECRET && sec === INBOUND_SECRET);
  if (!okSecret) return res.status(403).send('forbidden');

  const now = DateTime.now().setZone(TIMEZONE);
  const day = now.toFormat('yyyy-LL-dd');
  const filename = `${day}-${slug}.pdf`;

  await withSlugLock(slug, async () => {
    const store = loadStore(storePath);
    await writeTodayPdfAtomic(todayPdf, slug, store.items || []);

    try { fs.copyFileSync(todayPdf, path.join(dataArchive, filename)); } catch {}

    if (ENABLE_PUBLIC_ARCHIVES) {
      try { fs.copyFileSync(todayPdf, path.join(publicArchive, filename)); } catch {}
    }

    saveStore(storePath, { items: [], meta: { lastInboundSig: '' } });
  });

  await writeTodayPdfAtomic(todayPdf, slug, []);
  res.json({ ok: true, slug, archived: filename, publicArchived: ENABLE_PUBLIC_ARCHIVES });
});

// ---------------- INBOUND ----------------
app.post('/inbound', upload.any(), (req, res) => {
  const debug = DEBUG_INBOUND_ENV || /^(1|true|yes)$/i.test(String(req.query.debug || ''));

  if (INBOUND_SECRET) {
    const h = (req.headers['x-inbound-secret'] || '').toString();
    const q = (req.query.secret || '').toString();
    if (h !== INBOUND_SECRET && q !== INBOUND_SECRET) {
      if (debug) console.warn('Inbound forbidden: bad secret', { hasHeader: Boolean(h), hasQuery: Boolean(q) });
      return res.status(403).send('forbidden');
    }
  }

  const forceSlug = safeSlug((req.query.forceSlug || '').toString().trim());
  const fields = Object.fromEntries(Object.entries(req.body || {}));

  const bodyText =
    (fields.text && String(fields.text).trim())
      ? String(fields.text)
      : htmlToText(fields.html || '');

  let slug = '';
  let routeSource = '';

  if (forceSlug && forceSlug !== 'default') {
    slug = forceSlug;
    routeSource = 'forceSlug';
  } else {
    const candidates = findQaRecipients(fields, debug);

    if (candidates.length > 1) {
      if (debug) console.warn('Multiple tenant recipients found. Rejecting.', { candidates });
      return res.status(200).json({ ok: false, error: 'multiple_tenant_recipients', candidates });
    }

    if (candidates.length === 1) {
      slug = deriveSlugFromAddress(candidates[0]);
      routeSource = 'to/cc';
    } else {
      const sSlug = deriveSlugFromSubject(fields.subject || '');
      if (sSlug) {
        slug = sSlug;
        routeSource = 'subject';
      }
    }
  }

  if (!slug) {
    if (debug) console.warn('No tenant slug detected', { to: fields.to, cc: fields.cc, subject: fields.subject });
    return res.status(200).json({ ok: false, error: 'no_tenant_slug' });
  }

  const parsed = parseQA(bodyText);
  if (parsed.mode === 'NONE') {
    if (debug) console.warn('Inbound parse failed', { slug, sample: String(bodyText).slice(0, 250) });
    return res.status(200).json({ ok: false, slug, error: 'parse_failed' });
  }

  withSlugLock(slug, async () => {
    const { storePath, todayPdf } = slugDirs(slug);
    const store = loadStore(storePath);

    const inboundSig = ENABLE_IDEMPOTENCY
      ? sha256(JSON.stringify({
          slug,
          subject: fields.subject || '',
          from: fields.from || '',
          mode: parsed.mode,
          q: parsed.q || '',
          a: parsed.a || ''
        }))
      : '';

    if (ENABLE_IDEMPOTENCY && store.meta && store.meta.lastInboundSig === inboundSig) {
      if (debug) console.log('Idempotent inbound skip', { slug });
      return;
    }

    const items = Array.isArray(store.items) ? store.items : [];
    store.items = items;
    store.meta = store.meta || {};

    const upsertAnswered = (qText, aText) => {
      const qn = norm(qText);

      if (ENABLE_DEDUPE) {
        for (let i = items.length - 1; i >= 0; i--) {
          const entry = items[i];
          if (!entry || !entry.q) continue;
          if (norm(entry.q) !== qn) continue;

          entry.a = aText;
          entry.status = 'answered';
          entry.answeredAt = nowTs();
          entry.updatedAt = nowTs();
          return { deduped: true, id: entry.id };
        }
      }

      const id = newId();
      items.push({
        id,
        q: qText,
        a: aText,
        status: 'answered',
        createdAt: nowTs(),
        answeredAt: nowTs(),
        updatedAt: nowTs(),
        source: 'email'
      });
      return { deduped: false, id };
    };

    const addPending = (qText) => {
      if (ENABLE_DEDUPE) {
        const qn = norm(qText);
        for (let i = items.length - 1; i >= 0; i--) {
          const entry = items[i];
          if (!entry || !entry.q) continue;
          if (norm(entry.q) === qn && (!entry.a || !String(entry.a).trim())) {
            entry.updatedAt = nowTs();
            return { deduped: true, id: entry.id };
          }
        }
      }

      const id = newId();
      items.push({
        id,
        q: qText,
        a: '',
        status: 'pending',
        createdAt: nowTs(),
        updatedAt: nowTs(),
        source: 'email'
      });
      return { deduped: false, id };
    };

    const fillMostRecentPending = (aText) => {
      for (let i = items.length - 1; i >= 0; i--) {
        const entry = items[i];
        if (!entry) continue;
        if (!entry.a || !String(entry.a).trim() || entry.status === 'pending') {
          entry.a = aText;
          entry.status = 'answered';
          entry.answeredAt = nowTs();
          entry.updatedAt = nowTs();
          return { filled: true, id: entry.id };
        }
      }
      return { filled: false, id: '' };
    };

    let modeResult = parsed.mode;

    if (parsed.mode === 'QA') {
      const resUp = upsertAnswered(parsed.q, parsed.a);
      modeResult = resUp.deduped ? 'QA->deduped_update' : 'QA->created_new';
    } else if (parsed.mode === 'Q') {
      const resPend = addPending(parsed.q);
      modeResult = resPend.deduped ? 'Q->deduped' : 'Q->created_pending';
    } else if (parsed.mode === 'A') {
      const filled = fillMostRecentPending(parsed.a);
      if (filled.filled) {
        modeResult = 'A->filled_pending';
      } else {
        upsertAnswered('(unspecified question)', parsed.a);
        modeResult = 'A->stored_without_question';
      }
    }

    store.meta.lastInboundSig = inboundSig;

    saveStore(storePath, store);
    await writeTodayPdfAtomic(todayPdf, slug, store.items || []);

    if (debug) {
      console.log('INBOUND OK', { slug, routeSource, mode: parsed.mode, modeResult, total: store.items.length });
    }
  })
    .then(() => res.status(200).json({ ok: true, slug, routeSource, mode: parsed.mode }))
    .catch((e) => {
      console.error('Inbound error', e);
      res.status(200).json({ ok: false, slug, error: 'inbound_exception' });
    });
});

// ---------------- NIGHTLY ARCHIVE / RESET ----------------
cron.schedule('59 23 * * *', async () => {
  try {
    const day = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd');
    const cutoff = DateTime.now().setZone(TIMEZONE).minus({ days: ARCHIVE_RETENTION_DAYS });

    const slugs = fs.readdirSync(DATA_DIR).filter(name => {
      const p = path.join(DATA_DIR, name);
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });

    for (const raw of slugs) {
      const slug = safeSlug(raw);

      await withSlugLock(slug, async () => {
        const { storePath, todayPdf, dataArchive, publicArchive } = slugDirs(slug);
        const store = loadStore(storePath);

        if (!fs.existsSync(todayPdf)) {
          await writeTodayPdfAtomic(todayPdf, slug, store.items || []);
        }

        const filename = `${day}-${slug}.pdf`;
        try { fs.copyFileSync(todayPdf, path.join(dataArchive, filename)); } catch (e) {
          console.error('Archive copy failed (private)', { slug, e: String(e) });
        }

        if (ENABLE_PUBLIC_ARCHIVES) {
          try { fs.copyFileSync(todayPdf, path.join(publicArchive, filename)); } catch (e) {
            console.error('Archive copy failed (public)', { slug, e: String(e) });
          }
        }

        saveStore(storePath, { items: [], meta: { lastInboundSig: '' } });
        await writeTodayPdfAtomic(todayPdf, slug, []);
      });

      // Purge old private archives
      try {
        const { dataArchive } = slugDirs(slug);
        const files = fs.readdirSync(dataArchive)
          .filter(f => /^\d{4}-\d{2}-\d{2}-[a-z0-9-_]+\.pdf$/i.test(f))
          .sort();

        for (const f of files) {
          const d = f.slice(0, 10);
          const dt = DateTime.fromFormat(d, 'yyyy-LL-dd').setZone(TIMEZONE);
          if (dt.isValid && dt < cutoff) {
            try { fs.unlinkSync(path.join(dataArchive, f)); } catch {}
          }
        }

        if (ARCHIVE_CAP > 0) {
          const remaining = fs.readdirSync(dataArchive)
            .filter(f => /^\d{4}-\d{2}-\d{2}-[a-z0-9-_]+\.pdf$/i.test(f))
            .sort();
          const extra = remaining.length - ARCHIVE_CAP;
          if (extra > 0) {
            for (let i = 0; i < extra; i++) {
              try { fs.unlinkSync(path.join(dataArchive, remaining[i])); } catch {}
            }
          }
        }
      } catch (e) {
        console.error('Archive purge failed (private)', { slug, e: String(e) });
      }

      // Purge public archives only when enabled
      if (ENABLE_PUBLIC_ARCHIVES) {
        try {
          const { publicArchive } = slugDirs(slug);
          const files = fs.readdirSync(publicArchive)
            .filter(f => /^\d{4}-\d{2}-\d{2}-[a-z0-9-_]+\.pdf$/i.test(f));

          for (const f of files) {
            const d = f.slice(0, 10);
            const dt = DateTime.fromFormat(d, 'yyyy-LL-dd').setZone(TIMEZONE);
            if (dt.isValid && dt < cutoff) {
              try { fs.unlinkSync(path.join(publicArchive, f)); } catch {}
            }
          }
        } catch (e) {
          console.error('Archive purge failed (public)', { slug, e: String(e) });
        }
      }
    }
  } catch (e) {
    console.error('Archive job failed', e);
  }
}, { timezone: TIMEZONE });

// ---------------- BOOT PDF SEED ----------------
(function ensureBootPdfs() {
  try {
    const slugs = fs.readdirSync(DATA_DIR).filter(name => {
      const p = path.join(DATA_DIR, name);
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });

    slugs.forEach(async (raw) => {
      const slug = safeSlug(raw);
      const { storePath, todayPdf } = slugDirs(slug);
      const store = loadStore(storePath);
      try { await writeTodayPdfAtomic(todayPdf, slug, store.items || []); } catch {}
    });
  } catch {}
})();

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log(`Server listening on ${BASE_URL}`);
  console.log('Endpoints:', {
    health: '/health',
    inbound: '/inbound',
    status: '/c/:slug/api/status',
    peek: '/c/:slug/api/peek',
    pdf: '/public/:slug/qa-today.pdf',
    archiveNow: '/c/:slug/api/archive-now'
  });
});

process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION', err));
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION', err));
