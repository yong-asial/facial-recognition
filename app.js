import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as defaultOllama from './ollama.js';
import { createCipher } from './crypto-store.js';
import { CODE_WORDS } from './public/palm.js';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const FACE_THRESHOLD = Number(process.env.FACE_THRESHOLD || 0.5); // euclidean distance, lower = stricter
// Matches closer than this skip the (slow) Ollama check; borderline matches still get it. 0 = always verify.
export const FAST_ACCEPT = Number(process.env.FAST_ACCEPT_DISTANCE ?? 0.35);

/** @param {{dbPath?: string, ollama?: typeof defaultOllama, threshold?: number, fastAccept?: number, cipher?: ReturnType<typeof createCipher>}} opts */
export function createApp({ dbPath = 'data/app.db', ollama = defaultOllama, threshold = FACE_THRESHOLD, fastAccept = FAST_ACCEPT, cipher: defaultCipher } = {}) {
  const { checkEnrollment, checkSamePerson, ollamaInfo } = ollama;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL,
      face_descriptor TEXT, face_image TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
  `);

  const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
  const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  function newSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, userId, Date.now() + SESSION_TTL_MS);
    return token;
  }
  const publicUser = (u) => ({ id: u.id, hasFace: !!u.face_descriptor });

  // Naive in-memory throttle: 10 failures / 5 min per key.
  const fails = new Map();
  const throttled = (k) => (fails.get(k) || []).filter((t) => Date.now() - t < 300_000).length >= 10;
  const recordFail = (k) => fails.set(k, [...(fails.get(k) || []), Date.now()]);

  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const row = token && db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(token, Date.now());
    if (!row) return res.status(401).json({ error: 'Not logged in' });
    req.token = token;
    req.user = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
    next();
  }

  const validDescriptor = (d) => Array.isArray(d) && d.length === 128 && d.every((n) => typeof n === 'number');
  const validImage = (i) => typeof i === 'string' && /^data:image\/jpeg;base64,/.test(i) && i.length < 3_000_000;
  const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static('public'));
  // Serve the face-api bundle + models locally: no CDN round trip, works offline in the classroom.
  const faceApiDir = path.resolve('node_modules/@vladmandic/face-api');
  app.get('/vendor/face-api.js', (_req, res) => res.sendFile(path.join(faceApiDir, 'dist/face-api.js')));
  app.use('/vendor/models', express.static(path.join(faceApiDir, 'model'), { maxAge: '7d' }));
  // Palm: MediaPipe Hand Landmarker (JS bundle + WASM from npm, model from `node scripts/fetch-models.mjs`).
  const mpDir = path.resolve('node_modules/@mediapipe/tasks-vision');
  app.get('/vendor/mediapipe/vision_bundle.mjs', (_req, res) => res.sendFile(path.join(mpDir, 'vision_bundle.mjs')));
  app.use('/vendor/mediapipe/wasm', express.static(path.join(mpDir, 'wasm'), { maxAge: '7d' }));
  app.use('/vendor/mediapipe/models', express.static(path.resolve('models'), { maxAge: '7d' }));

  app.get('/api/config', (_req, res) => res.json({ faceThreshold: threshold, ollama: ollamaInfo }));

  app.post('/api/register', (req, res) => {
    const { id, password } = req.body || {};
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(id))
      return res.status(400).json({ error: 'ID must be 3-32 chars (letters, numbers, _ . -).' });
    if (typeof password !== 'string' || password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) return res.status(409).json({ error: 'ID already taken.' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (id,salt,hash,created_at) VALUES (?,?,?,?)').run(id, salt, hashPw(password, salt), Date.now());
    res.json({ token: newSession(id), user: { id, hasFace: false } });
  });

  app.post('/api/login', (req, res) => {
    const { id, password } = req.body || {};
    const key = `pw:${id}`;
    if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const u = typeof id === 'string' && typeof password === 'string' && db.prepare('SELECT * FROM users WHERE id=?').get(id);
    // Always hash to keep timing similar for unknown ids.
    const h = hashPw(String(password ?? ''), u ? u.salt : 'x'.repeat(32));
    if (!u || !safeEq(h, u.hash)) {
      recordFail(key);
      return res.status(401).json({ error: 'Invalid ID or password.' });
    }
    res.json({ token: newSession(u.id), user: publicUser(u) });
  });

  app.post('/api/face/enroll', auth, async (req, res) => {
    const { descriptor, image } = req.body || {};
    if (!validDescriptor(descriptor) || !validImage(image)) return res.status(400).json({ error: 'Invalid face data.' });
    const check = await checkEnrollment(image);
    if (!check.ok) return res.status(422).json({ error: check.reason });
    db.prepare('UPDATE users SET face_descriptor=?, face_image=? WHERE id=?').run(JSON.stringify(descriptor), image, req.user.id);
    res.json({ user: { id: req.user.id, hasFace: true } });
  });

  app.post('/api/login/face', async (req, res) => {
    const { descriptor, image } = req.body || {};
    if (!validDescriptor(descriptor) || !validImage(image)) return res.status(400).json({ error: 'Invalid face data.' });
    const key = `face:${req.ip}`;
    if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

    // 1:N match on the descriptor, then confirm the best candidate with Ollama.
    let best = null;
    for (const u of db.prepare('SELECT * FROM users WHERE face_descriptor IS NOT NULL').all()) {
      const d = dist(descriptor, JSON.parse(u.face_descriptor));
      if (!best || d < best.d) best = { u, d };
    }
    if (!best || best.d > threshold) {
      recordFail(key);
      return res.status(401).json({ error: 'Face not recognized.' });
    }
    const check = fastAccept > 0 && best.d <= fastAccept ? { ok: true } : await checkSamePerson(best.u.face_image, image);
    if (!check.ok) {
      recordFail(key);
      return res.status(401).json({ error: check.reason });
    }
    res.json({ token: newSession(best.u.id), user: publicUser(best.u) });
  });

  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  app.post('/api/logout', auth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token=?').run(req.token);
    res.json({ ok: true });
  });

  // ---------- attendance ----------
  // Teachers own students. The browser matches faces locally against /api/students (decrypted descriptors)
  // and only reports the matched student id. Face data (descriptors + thumbnail) and palm templates are encrypted at rest.
  const cipher = defaultCipher ?? createCipher({ keyFile: dbPath === ':memory:' ? undefined : path.join(path.dirname(dbPath), 'face.key') });
  const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
  // Older PoC schema (plaintext descriptors, per-day attendance): keep the data under a *_legacy name.
  if (hasCol('students', 'descriptors') && !hasCol('students', 'face_data')) {
    db.exec('ALTER TABLE students RENAME TO students_legacy; ALTER TABLE attendance RENAME TO attendance_legacy;');
    console.warn('[db] old students/attendance tables renamed to *_legacy (schema changed)');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id TEXT NOT NULL, name TEXT NOT NULL,
      face_data TEXT, consent_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS class_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id TEXT NOT NULL, name TEXT NOT NULL,
      day TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS attendance (
      session_id INTEGER NOT NULL, student_id INTEGER NOT NULL, source TEXT NOT NULL, scanned_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, student_id)
    );
  `);
  // Palm templates: own encrypted column + consent time, so face and palm can be withdrawn independently.
  if (!hasCol('students', 'palm_data')) db.exec('ALTER TABLE students ADD COLUMN palm_data TEXT; ALTER TABLE students ADD COLUMN palm_consent_at INTEGER;');
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const validThumb = (t) => typeof t === 'string' && /^data:image\/jpeg;base64,/.test(t) && t.length < 40_000;
  const faceOf = (row) => (row.face_data ? cipher.decrypt(row.face_data) : { descriptors: [], thumbnail: null });
  // descriptors = enrolment samples + samples learned from confident scans (kept apart, capped, never replace the enrolment).
  const palmOf = (row) => (row.palm_data ? cipher.decrypt(row.palm_data) : { templates: [] });
  // palms: Competitive Code templates (base64, see public/palm.js) the browser matches against, like descriptors.
  const publicStudent = (row) => {
    const f = faceOf(row), p = palmOf(row);
    return { id: row.id, name: row.name, hasFace: f.descriptors.length > 0, descriptors: [...f.descriptors, ...(f.learned ?? []).map((l) => l.descriptor)], thumbnail: f.thumbnail,
      hasPalm: p.templates.length > 0, palms: p.templates.map(({ hand, code }) => ({ hand, code })) };
  };

  app.get('/api/students', auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM students WHERE teacher_id=? ORDER BY name COLLATE NOCASE').all(req.user.id);
    res.json({ students: rows.map(publicStudent) });
  });

  // Enrollment stores biometric data, so explicit consent is mandatory (APPI: purpose-limited, revocable).
  function parseFace(body) {
    const { descriptors, thumbnail, consent } = body || {};
    if (consent !== true) return { error: 'Consent is required before storing face data.' };
    if (!Array.isArray(descriptors) || descriptors.length < 1 || descriptors.length > 10 || !descriptors.every(validDescriptor))
      return { error: 'Invalid face data.' };
    if (thumbnail != null && !validThumb(thumbnail)) return { error: 'Invalid thumbnail.' };
    return { face: { descriptors, thumbnail: thumbnail ?? null } };
  }

  // Palm: only the hand and the 512-byte code are kept (no palm image, no hand geometry). Up to 10 templates per hand.
  const PALM_CODE_BYTES = CODE_WORDS * 4, PALM_PER_HAND = 10;
  const validPalm = (t) => t && (t.hand === 'Left' || t.hand === 'Right') && typeof t.code === 'string'
    && /^[A-Za-z0-9+/]+={0,2}$/.test(t.code) && Buffer.from(t.code, 'base64').length === PALM_CODE_BYTES;
  function parsePalm(body) {
    const { palm, consent } = body || {};
    if (consent !== true) return { error: 'Consent is required before storing palm data.' };
    if (!Array.isArray(palm) || palm.length < 1 || !palm.every(validPalm)) return { error: 'Invalid palm data.' };
    for (const hand of ['Left', 'Right']) if (palm.filter((t) => t.hand === hand).length > PALM_PER_HAND) return { error: `At most ${PALM_PER_HAND} palm templates per hand.` };
    return { templates: palm.map(({ hand, code }) => ({ hand, code })) };
  }

  // A student is created with face data, palm data, or both (each needs consent).
  app.post('/api/students', auth, (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 60) return res.status(400).json({ error: 'Name must be 1-60 characters.' });
    const wantsFace = req.body?.descriptors !== undefined, wantsPalm = req.body?.palm !== undefined;
    if (!wantsFace && !wantsPalm) return res.status(400).json({ error: 'Face or palm data is required.' });
    const f = wantsFace ? parseFace(req.body) : null, p = wantsPalm ? parsePalm(req.body) : null;
    const error = f?.error ?? p?.error;
    if (error) return res.status(400).json({ error });
    const now = Date.now();
    const r = db.prepare('INSERT INTO students (teacher_id,name,face_data,consent_at,palm_data,palm_consent_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(req.user.id, name, f ? cipher.encrypt(f.face) : null, f ? now : null, p ? cipher.encrypt({ templates: p.templates }) : null, p ? now : null, now);
    res.json({ student: publicStudent(db.prepare('SELECT * FROM students WHERE id=?').get(r.lastInsertRowid)) });
  });

  const ownStudent = (req) => db.prepare('SELECT * FROM students WHERE id=? AND teacher_id=?').get(req.params.id, req.user.id);

  // Re-enroll: replaces the stored face data of an existing student.
  app.put('/api/students/:id/face', auth, (req, res) => {
    if (!ownStudent(req)) return res.status(404).json({ error: 'Student not found.' });
    const { face, error } = parseFace(req.body);
    if (error) return res.status(400).json({ error });
    db.prepare('UPDATE students SET face_data=?, consent_at=? WHERE id=?').run(cipher.encrypt(face), Date.now(), req.params.id);
    res.json({ student: publicStudent(ownStudent(req)) });
  });

  // Template update (Face ID-style): the kiosk adds one fused descriptor per student per session after a confident match
  // or a teacher-confirmed near miss. Capped FIFO pool; must stay near the original enrolment so it can't drift to someone else.
  const LEARNED_MAX = 5, LEARNED_MAX_DIST = 0.6;
  app.post('/api/students/:id/face/learned', auth, (req, res) => {
    const row = ownStudent(req);
    if (!row) return res.status(404).json({ error: 'Student not found.' });
    const f = faceOf(row), { descriptor, sessionId } = req.body || {};
    if (!f.descriptors.length) return res.status(409).json({ error: 'Student has no face data.' });
    if (!validDescriptor(descriptor)) return res.status(400).json({ error: 'Invalid face data.' });
    const s = db.prepare('SELECT * FROM class_sessions WHERE id=? AND teacher_id=? AND ended_at IS NULL').get(sessionId, req.user.id);
    if (!s) return res.status(409).json({ error: 'No active session.' });
    if (Math.min(...f.descriptors.map((d) => dist(descriptor, d))) > LEARNED_MAX_DIST) return res.status(422).json({ error: 'Too far from the enrolled face.' });
    const learned = [...(f.learned ?? []).filter((l) => l.sessionId !== s.id), { descriptor, sessionId: s.id, at: Date.now() }].slice(-LEARNED_MAX);
    db.prepare('UPDATE students SET face_data=? WHERE id=?').run(cipher.encrypt({ ...f, learned }), row.id);
    res.json({ learned: learned.length });
  });
  app.delete('/api/students/:id/face/learned/:sessionId', auth, (req, res) => {
    const row = ownStudent(req);
    if (!row) return res.status(404).json({ error: 'Student not found.' });
    const f = faceOf(row);
    if (f.learned?.length) {
      const learned = f.learned.filter((l) => String(l.sessionId) !== req.params.sessionId);
      db.prepare('UPDATE students SET face_data=? WHERE id=?').run(cipher.encrypt({ ...f, learned }), row.id);
    }
    res.json({ ok: true });
  });

  // Enrol / re-enrol palms. Replaces the templates of the hands in the request and keeps the other hand
  // (re-enrolling the right hand does not wipe the left).
  app.put('/api/students/:id/palm', auth, (req, res) => {
    const row = ownStudent(req);
    if (!row) return res.status(404).json({ error: 'Student not found.' });
    const { templates, error } = parsePalm(req.body);
    if (error) return res.status(400).json({ error });
    const hands = new Set(templates.map((t) => t.hand));
    const merged = [...palmOf(row).templates.filter((t) => !hands.has(t.hand)), ...templates];
    db.prepare('UPDATE students SET palm_data=?, palm_consent_at=? WHERE id=?').run(cipher.encrypt({ templates: merged }), Date.now(), row.id);
    res.json({ student: publicStudent(ownStudent(req)) });
  });

  // Withdraw palm consent: erase one hand (?hand=Left|Right) or all palm data. Face data and the student stay.
  app.delete('/api/students/:id/palm', auth, (req, res) => {
    const row = ownStudent(req);
    if (!row) return res.status(404).json({ error: 'Student not found.' });
    const hand = req.query.hand;
    if (hand !== undefined && hand !== 'Left' && hand !== 'Right') return res.status(400).json({ error: 'hand must be Left or Right.' });
    const rest = hand ? palmOf(row).templates.filter((t) => t.hand !== hand) : [];
    if (rest.length) db.prepare('UPDATE students SET palm_data=? WHERE id=?').run(cipher.encrypt({ templates: rest }), row.id);
    else db.prepare('UPDATE students SET palm_data=NULL, palm_consent_at=NULL WHERE id=?').run(row.id);
    res.json({ student: publicStudent(ownStudent(req)) });
  });

  // Withdraw biometric consent: erase face data but keep the student on the roster (manual attendance only).
  app.delete('/api/students/:id/face', auth, (req, res) => {
    if (!ownStudent(req)) return res.status(404).json({ error: 'Student not found.' });
    db.prepare('UPDATE students SET face_data=NULL, consent_at=NULL WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  app.delete('/api/students/:id', auth, (req, res) => {
    if (!ownStudent(req)) return res.status(404).json({ error: 'Student not found.' });
    db.prepare('DELETE FROM students WHERE id=?').run(req.params.id);
    db.prepare('DELETE FROM attendance WHERE student_id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // ----- sessions (one class meeting) -----
  const ownSession = (req) => db.prepare('SELECT * FROM class_sessions WHERE id=? AND teacher_id=?').get(req.params.id, req.user.id);
  const sessionOut = (s) => ({ id: s.id, name: s.name, day: s.day, startedAt: s.started_at, endedAt: s.ended_at, active: s.ended_at == null });
  const records = (s) =>
    db.prepare(`SELECT st.id, st.name, a.source, a.scanned_at AS scannedAt FROM students st
                LEFT JOIN attendance a ON a.student_id = st.id AND a.session_id = ?
                WHERE st.teacher_id = ? ORDER BY st.name COLLATE NOCASE`).all(s.id, s.teacher_id)
      .map((r) => ({ id: r.id, name: r.name, present: r.scannedAt != null, source: r.source, scannedAt: r.scannedAt }));

  app.post('/api/sessions', auth, (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 60) return res.status(400).json({ error: 'Class name must be 1-60 characters.' });
    if (db.prepare('SELECT 1 FROM class_sessions WHERE teacher_id=? AND ended_at IS NULL').get(req.user.id))
      return res.status(409).json({ error: 'End the current session first.' });
    const r = db.prepare('INSERT INTO class_sessions (teacher_id,name,day,started_at) VALUES (?,?,?,?)').run(req.user.id, name, today(), Date.now());
    res.json({ session: sessionOut(db.prepare('SELECT * FROM class_sessions WHERE id=?').get(r.lastInsertRowid)) });
  });

  app.get('/api/sessions', auth, (req, res) => {
    const rows = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS present
                             FROM class_sessions s WHERE teacher_id=? ORDER BY id DESC LIMIT 50`).all(req.user.id);
    res.json({ sessions: rows.map((s) => ({ ...sessionOut(s), present: s.present })) });
  });

  app.get('/api/sessions/:id', auth, (req, res) => {
    const s = ownSession(req);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    res.json({ session: sessionOut(s), records: records(s) });
  });

  app.post('/api/sessions/:id/end', auth, (req, res) => {
    const s = ownSession(req);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.ended_at == null) db.prepare('UPDATE class_sessions SET ended_at=? WHERE id=?').run(Date.now(), s.id);
    res.json({ session: sessionOut(ownSession(req)) });
  });

  // Face or palm scan result (method, default face; the CSV "Method" column shows it). Idempotent: a second scan of the
  // same student reports already=true and keeps the first method.
  // scannedAt lets an offline kiosk replay queued scans with their real time.
  app.post('/api/sessions/:id/attendance', auth, (req, res) => {
    const s = ownSession(req);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.ended_at != null) return res.status(409).json({ error: 'Session has ended.' });
    const st = db.prepare('SELECT id, name FROM students WHERE id=? AND teacher_id=?').get(req.body?.studentId, req.user.id);
    if (!st) return res.status(404).json({ error: 'Student not found.' });
    const method = req.body?.method ?? 'face';
    if (method !== 'face' && method !== 'palm') return res.status(400).json({ error: 'method must be face or palm.' });
    const t = Number(req.body?.scannedAt);
    const at = Number.isFinite(t) && t > s.started_at - 1000 && t <= Date.now() + 60_000 ? t : Date.now();
    const r = db.prepare('INSERT OR IGNORE INTO attendance VALUES (?,?,?,?)').run(s.id, st.id, method, at);
    const row = db.prepare('SELECT scanned_at AS at FROM attendance WHERE session_id=? AND student_id=?').get(s.id, st.id);
    res.json({ student: st, already: !r.changes, scannedAt: row.at });
  });

  // Manual toggle (also used for "Wrong person" undo). Allowed after the session ends, to correct mistakes.
  app.put('/api/sessions/:id/attendance/:studentId', auth, (req, res) => {
    const s = ownSession(req);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    const st = db.prepare('SELECT id, name FROM students WHERE id=? AND teacher_id=?').get(req.params.studentId, req.user.id);
    if (!st) return res.status(404).json({ error: 'Student not found.' });
    if (typeof req.body?.present !== 'boolean') return res.status(400).json({ error: 'present must be true or false.' });
    if (req.body.present) db.prepare("INSERT INTO attendance VALUES (?,?,'manual',?) ON CONFLICT(session_id, student_id) DO UPDATE SET source='manual'").run(s.id, st.id, Date.now());
    else db.prepare('DELETE FROM attendance WHERE session_id=? AND student_id=?').run(s.id, st.id);
    res.json({ ok: true });
  });

  app.get('/api/sessions/:id/csv', auth, (req, res) => {
    const s = ownSession(req);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    // Prefix risky leading chars so spreadsheets don't evaluate names as formulas.
    const cell = (v) => `"${String(v).replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
    const rows = records(s).map((r) =>
      [s.name, s.day, r.name, r.present ? 'Present' : 'Absent', r.present ? r.source : '', r.present ? new Date(r.scannedAt).toISOString() : ''].map(cell).join(','));
    res.type('text/csv').send(['Class,Date,Name,Status,Method,Checked in at', ...rows].join('\n') + '\n');
  });

  return app;
}
