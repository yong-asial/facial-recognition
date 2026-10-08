import { Api } from './api.js';
import { FaceService } from './face-service.js';
import { AttendanceService } from './attendance-service.js';
import { MatchingService, MatchConfirmer, euclidean } from './matching.js';

const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const safe = (fn) => { try { return fn(); } catch { return null; } }; // localStorage can throw (private mode)

// ---------- tunables ----------
const CONFIRM_FRAMES = 3;       // same student must match this many frames in a row
const MIN_FACE_RATIO = 0.12;    // scan: ignore faces narrower than this fraction of the frame (far background)
const ENROLL_MIN_FACE = 0.22;   // enrol: face must be this close
const BLUR_MIN = 25;            // enrol: min Laplacian variance of the face crop (see README to tune)
const ENROLL_SAMPLES = 5;
const ENROLL_PROMPTS = ['Look straight at the camera', 'Turn your head slightly to one side', 'Turn slightly to the other side', 'Look straight again', 'Straight again — relax your face'];
const RESULT_MS = 1500;         // how long the "recognised" card stays up
const UNKNOWN_MS = 5000;
const COOLDOWN_MS = 6000;       // ignore a just-handled student for a moment
const UNDO_COOLDOWN_MS = 15000;

const face = new FaceService(window.faceapi);
const matcher = new MatchingService({ threshold: 0.5, gap: 0.04 });
const attendance = new AttendanceService({
  send: (sessionId, studentId, scannedAt) => Api.markPresent(sessionId, studentId, scannedAt),
  storage: safe(() => localStorage) ?? undefined,
  onChange: (n) => renderQueue(n),
});

let stream = null, facing = 'user';
let students = [];                 // roster incl. decrypted descriptors (kept in memory only)
let session = null;                // active class session
let present = new Map();           // studentId -> {name, scannedAt, source}
let tab = null, loopRun = 0, paused = false, consented = false, enrollTarget = null;
let syncTimer = 0, pollTimer = 0, viewing = null;
const cooldown = new Map();       // studentId -> epoch ms until which the scanner ignores this student

function msg(text = '', ok = false) { const m = $('#msg'); m.textContent = text; m.className = 'msg' + (ok ? ' ok' : ''); }
function hint(sel, text, kind = '') { const el = $(sel); el.textContent = text; el.className = 'hint ' + kind; }
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

// ---------- camera / wake lock ----------
async function startCamera(video) {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } });
  video.srcObject = stream;
  video.classList.toggle('rear', facing !== 'user');
  await video.play();
}
function stopCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; }
const cameraError = (e) => (e?.name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access in the browser settings.' : 'Camera unavailable (needs HTTPS or localhost, and a camera).');

let wake = null;
async function holdWake() { try { wake = await navigator.wakeLock?.request('screen'); } catch { /* unsupported or denied */ } }
function releaseWake() { wake?.release().catch(() => {}); wake = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && tab === 'scan') holdWake(); });

// ---------- views / tabs ----------
const views = ['login', 'register', 'app'];
function show(name) {
  views.forEach((v) => ($('#v-' + v).hidden = v !== name));
  $('#card').classList.toggle('wide', name === 'app');
  msg();
  if (name !== 'app') leaveTab();
}
function leaveTab() {
  loopRun++; stopCamera(); releaseWake(); clearInterval(pollTimer); pollTimer = 0;
  consented = false; enrollTarget = null; tab = null;
  $('#result').hidden = true;
}
async function openTab(name) {
  leaveTab();
  tab = name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.dataset.pane !== name));
  msg();
  try {
    if (name === 'scan') await startScan();
    if (name === 'session') await openSessionTab();
    if (name === 'students') await openStudents();
  } catch (e) { msg(e.message); }
}

// ======================================================================
// SCAN (kiosk)
// ======================================================================
const presentRecent = () => [...present.entries()].sort((a, b) => b[1].scannedAt - a[1].scannedAt).slice(0, 10);
function renderCount() { $('#k-present').textContent = present.size; $('#k-total').textContent = students.length; renderRecent(); }
function renderRecent() {
  const ol = $('#k-recent'); ol.replaceChildren();
  for (const [id, p] of presentRecent()) {
    const undo = el('button', { textContent: 'Undo', title: 'Mark absent' });
    undo.onclick = () => undoMark(id, false);
    ol.append(el('li', {}, el('span', { textContent: p.name }), el('time', { textContent: fmtTime(p.scannedAt) }), undo));
  }
}
function renderQueue(n) {
  const q = $('#k-queue'); q.hidden = !n; q.textContent = n ? `⚠ ${n} scan${n > 1 ? 's' : ''} waiting to sync (offline)` : '';
}

let resultTimer = 0;
function showResult(kind, { name, sub = '', thumbnail = '', undoId = null, picker = false, ms = RESULT_MS }) {
  const r = $('#result'); r.className = 'result ' + kind; r.hidden = false;
  $('#result-name').textContent = name; $('#result-sub').textContent = sub;
  const img = $('#result-img'); img.hidden = !thumbnail; if (thumbnail) img.src = thumbnail;
  $('#result-undo').hidden = undoId == null; $('#result-undo').onclick = () => undoMark(undoId, true);
  $('#result-pick').hidden = !picker; $('#result-pick').onclick = () => { r.hidden = true; openPicker('Who is this?'); };
  clearTimeout(resultTimer); resultTimer = setTimeout(() => (r.hidden = true), ms);
}

async function startScan() {
  const run = ++loopRun, alive = () => run === loopRun;
  const video = $('#kiosk-video');
  hint('#kiosk-hint', 'Starting camera…');
  let sessions;
  try {
    [students, sessions] = await Promise.all([Api.students(), Api.sessions(), face.load()]);
  } catch (e) { return hint('#kiosk-hint', 'Could not load: ' + e.message + ' (reload to retry)', 'bad'); }
  session = sessions.find((s) => s.active) ?? null;
  $('#scan-empty').hidden = !!session; $('#scan-main').hidden = !session;
  if (!session) return;
  $('#k-class').textContent = `${session.name} · ${session.day}`;
  const detail = await Api.session(session.id);
  present = new Map(detail.records.filter((r) => r.present).map((r) => [r.id, { name: r.name, scannedAt: r.scannedAt, source: r.source }]));
  renderCount(); renderQueue(attendance.pending());
  const withFace = students.filter((s) => s.hasFace);
  if (!students.length) return hint('#kiosk-hint', 'No students yet — add them in the Students tab.', 'warn');
  if (!withFace.length) return hint('#kiosk-hint', 'No enrolled faces yet. Use "Mark manually" or enrol faces.', 'warn');
  try { await startCamera(video); } catch (e) { return hint('#kiosk-hint', cameraError(e), 'bad'); }
  if (!alive()) return;
  holdWake();
  paused = false; $('#b-kiosk').textContent = 'Pause';
  scanLoop(alive, video).catch((e) => alive() && hint('#kiosk-hint', 'Scanner stopped: ' + e.message, 'bad'));
}

async function scanLoop(alive, video) {
  const confirmers = new Map(); // studentId -> MatchConfirmer
  cooldown.clear();
  const guide = $('#guide');
  let unknownStreak = 0, unknownUntil = 0, fps = 0, last = performance.now();

  while (alive()) {
    if (paused || document.hidden) { await sleep(300); continue; }
    if (!video.videoWidth) { await sleep(100); continue; }
    const now = Date.now();
    const gate = await face.gate(video);
    if (!alive()) return;
    if (!gate.some((b) => b.width / video.videoWidth >= MIN_FACE_RATIO)) {
      for (const c of confirmers.values()) c.miss(now);
      unknownStreak = 0; guide.className = 'guide';
      hint('#kiosk-hint', 'Ready — walk up and look at the camera');
      drawDebug(video, null, null, fps); await sleep(120); continue;
    }

    const faces = (await face.analyze(face.snapshot(video))).filter((f) => f.box.width / video.videoWidth >= MIN_FACE_RATIO);
    if (!alive()) return;
    const t = Date.now();
    const seen = new Set();
    let anyUnknown = false, status = null, dbg = null;

    for (const f of faces.sort((a, b) => b.box.width - a.box.width)) {
      const m = matcher.match(f.descriptor, students);
      dbg ??= { f, m };
      if (!m.student) { anyUnknown = true; continue; }
      const id = m.student.id;
      seen.add(id);
      if ((cooldown.get(id) ?? 0) > t) continue;
      let c = confirmers.get(id);
      if (!c) confirmers.set(id, (c = new MatchConfirmer({ frames: CONFIRM_FRAMES, requireLiveness: $('#dbg-live').checked })));
      c.requireLiveness = $('#dbg-live').checked;
      const r = c.observe(t, f);
      if (dbg.f === f) dbg.conf = r;
      if (r.waitingForLiveness) status = ['Please blink or turn your head slightly', 'warn'];
      else status ??= [`Hello ${m.student.name}… hold still`, 'ok'];
      if (r.confirmed) {
        c.reset(); cooldown.set(id, t + COOLDOWN_MS);
        await handleConfirmed(students.find((s) => s.id === id), alive);
        if (!alive()) return;
      }
    }
    for (const [id, c] of confirmers) { if (!seen.has(id)) { c.miss(t); if (c.idle(t)) confirmers.delete(id); } }

    if (anyUnknown && !seen.size) {
      status = ['Face not recognised', 'bad'];
      if (++unknownStreak >= 3 && t > unknownUntil) {
        showResult('unknown', { name: 'Not recognised', sub: 'Ask the student to face the camera, or pick them manually.', picker: true, ms: UNKNOWN_MS });
        unknownUntil = t + UNKNOWN_MS + 1500;
      }
    } else unknownStreak = 0;
    guide.className = 'guide ' + (status?.[1] ?? '');
    if (status) hint('#kiosk-hint', status[0], status[1]);

    const nowP = performance.now(); fps = fps * 0.8 + (1000 / (nowP - last)) * 0.2; last = nowP;
    drawDebug(video, dbg, faces, fps);
    await sleep(30); // yield to the UI; the inference itself is the real rate limiter
  }
}

async function handleConfirmed(student, alive) {
  if (!student) return;
  const base = { name: student.name, thumbnail: student.thumbnail ?? '' };
  if (present.has(student.id)) return showResult('already', { ...base, sub: 'Already checked in' });
  try {
    const r = await attendance.mark(session.id, student.id);
    if (!alive()) return;
    present.set(student.id, { name: student.name, scannedAt: r.scannedAt, source: 'face' });
    renderCount();
    if (r.status === 'saved' && r.already) showResult('already', { ...base, sub: 'Already checked in' });
    else showResult('ok', { ...base, sub: r.status === 'queued' ? '✓ Saved offline — will sync' : '✓ Present', undoId: student.id });
  } catch (e) {
    showResult('error', { name: 'Could not save', sub: e.message, ms: 3000 });
  }
}

/** "Wrong person" / Undo: take the mark back, and (from the card) offer the manual picker. */
async function undoMark(id, thenPick) {
  if (!session) return;
  try {
    if (!attendance.cancel(session.id, id)) await Api.setPresent(session.id, id, false);
    present.delete(id); renderCount();
    cooldown.set(id, Date.now() + UNDO_COOLDOWN_MS); // don't instantly re-mark the same face
    $('#result').hidden = true;
    if (thenPick) openPicker('Who is this?');
  } catch (e) { msg(e.message); }
}

// ----- debug overlay -----
function drawDebug(video, dbg, faces, fps) {
  const on = $('#dbg-toggle').checked;
  $('#dbg-canvas').hidden = !on; $('#dbg-text').hidden = !on;
  if (!on) return;
  const cv = $('#dbg-canvas');
  cv.width = video.videoWidth; cv.height = video.videoHeight;
  cv.classList.toggle('rear', facing !== 'user');
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.lineWidth = 3;
  for (const f of faces ?? []) { ctx.strokeStyle = dbg?.f === f ? '#4ade80' : '#fbbf24'; ctx.strokeRect(f.box.x, f.box.y, f.box.width, f.box.height); }
  const lines = [`fps ${fps.toFixed(1)}  faces ${faces?.length ?? 0}  threshold ${matcher.threshold.toFixed(2)}`];
  if (dbg) {
    const { f, m, conf } = dbg;
    lines.push(`best ${m.student?.name ?? '—'}  dist ${Number.isFinite(m.distance) ? m.distance.toFixed(3) : '—'}  next ${Number.isFinite(m.runnerUp) ? m.runnerUp.toFixed(3) : '—'}  (${m.reason})`);
    lines.push(`face ${(f.box.width / video.videoWidth * 100) | 0}% of frame  EAR ${f.ear.toFixed(2)}  yaw ${f.yaw.toFixed(2)}`);
    if (conf) lines.push(`hits ${conf.hits}/${CONFIRM_FRAMES}  blink ${conf.liveness.blink ? 'Y' : 'n'}  turn ${conf.liveness.turn ? 'Y' : 'n'}  live ${conf.liveness.passed ? 'OK' : '…'}`);
  }
  $('#dbg-text').textContent = lines.join('\n');
}
$('#dbg-toggle').onchange = (e) => { $('#dbg-panel').hidden = !e.target.checked; if (!e.target.checked) { $('#dbg-canvas').hidden = true; $('#dbg-text').hidden = true; } };
$('#dbg-thr').oninput = (e) => { matcher.threshold = Number(e.target.value); $('#dbg-thr-val').textContent = matcher.threshold.toFixed(2); safe(() => localStorage.setItem('faceThreshold', String(matcher.threshold))); };

$('#b-kiosk').onclick = (e) => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; hint('#kiosk-hint', paused ? 'Paused' : 'Ready'); };
$('#b-flip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; openTab('scan'); };
$('#b-manual').onclick = () => openPicker('Mark student present');
document.addEventListener('click', (e) => { const o = e.target.closest('[data-open]'); if (o) openTab(o.dataset.open); });

// ----- manual picker -----
function openPicker(title) {
  if (!session) return msg('Start a session first.');
  $('#picker-title').textContent = title; $('#picker-q').value = ''; $('#picker').hidden = false;
  renderPicker(); $('#picker-q').focus();
}
function renderPicker() {
  const q = $('#picker-q').value.trim().toLowerCase();
  const ul = $('#picker-list'); ul.replaceChildren();
  const rows = students.filter((s) => s.name.toLowerCase().includes(q)).sort((a, b) => present.has(a.id) - present.has(b.id));
  for (const s of rows) {
    const isPresent = present.has(s.id);
    const b = el('button', { textContent: isPresent ? 'Present' : 'Mark present', disabled: isPresent });
    b.onclick = async () => {
      try {
        await Api.setPresent(session.id, s.id, true);
        present.set(s.id, { name: s.name, scannedAt: Date.now(), source: 'manual' }); renderCount();
        $('#picker').hidden = true;
        showResult('ok', { name: s.name, sub: '✓ Marked manually', thumbnail: s.thumbnail ?? '' });
      } catch (err) { msg(err.message); }
    };
    ul.append(el('li', {}, el('span', { className: 'who', textContent: s.name }), b));
  }
  if (!rows.length) ul.append(el('li', { textContent: 'No matching students' }));
}
$('#picker-q').oninput = renderPicker;
$('#picker-close').onclick = () => ($('#picker').hidden = true);

// ======================================================================
// SESSION
// ======================================================================
async function openSessionTab() {
  const sessions = await Api.sessions();
  const active = sessions.find((s) => s.active);
  if (active) return viewSession(active.id);
  viewing = null;
  $('#sess-start').hidden = false; $('#sess-view').hidden = true;
  const ul = $('#sess-history'); ul.replaceChildren();
  for (const s of sessions) {
    const view = el('button', { textContent: 'View' }); view.onclick = () => viewSession(s.id);
    const csv = el('button', { textContent: 'CSV' }); csv.onclick = () => downloadCsv(s);
    ul.append(el('li', {}, el('span', { textContent: `${s.name} · ${s.day} · ${s.present} present` }), el('span', { className: 'actions' }, view, csv)));
  }
  if (!sessions.length) ul.append(el('li', { textContent: 'No sessions yet' }));
}

async function viewSession(id) {
  const { session: s, records } = await Api.session(id);
  viewing = s;
  $('#sess-start').hidden = true; $('#sess-view').hidden = false;
  $('#sv-title').textContent = `${s.name} — ${s.day}`;
  $('#sv-sub').textContent = `${records.filter((r) => r.present).length} of ${records.length} present` + (s.active ? ' · live' : ' · ended');
  $('#sv-end').hidden = !s.active;
  const body = $('#sv-body'); body.replaceChildren();
  for (const r of records) {
    const toggle = el('button', { textContent: r.present ? 'Mark absent' : 'Mark present' });
    toggle.onclick = async () => { try { await Api.setPresent(s.id, r.id, !r.present); await viewSession(s.id); } catch (e) { msg(e.message); } };
    body.append(el('tr', {},
      el('td', { textContent: r.name }),
      el('td', { textContent: r.present ? 'Present' : 'Absent', className: r.present ? 'yes' : 'no' }),
      el('td', { textContent: r.present ? fmtTime(r.scannedAt) + (r.source === 'manual' ? ' (manual)' : '') : '' }),
      el('td', {}, toggle)));
  }
  clearInterval(pollTimer);
  if (s.active) pollTimer = setInterval(() => viewSession(s.id).catch(() => {}), 5000); // live list
}

async function downloadCsv(s) {
  try {
    const url = URL.createObjectURL(await Api.csv(s.id));
    const a = el('a', { href: url, download: `attendance-${s.name.replace(/\W+/g, '_')}-${s.day}.csv` });
    a.click(); URL.revokeObjectURL(url);
  } catch (e) { msg(e.message); }
}
$('#sv-csv').onclick = () => viewing && downloadCsv(viewing);
$('#sv-back').onclick = () => openTab('session');
$('#sv-end').onclick = async () => {
  if (!viewing || !confirm('End this session? Face scans will stop being accepted.')) return;
  try {
    if (attendance.pending()) await attendance.flush();
    await Api.endSession(viewing.id); await openTab('session');
  } catch (e) { msg(e.message); }
};
$('#f-session').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await Api.startSession(new FormData(e.target).get('name').trim()); e.target.reset(); await openTab('scan'); } catch (err) { msg(err.message); }
});

// ======================================================================
// STUDENTS: consent -> enrol -> roster
// ======================================================================
async function loadRoster() {
  students = await Api.students();
  $('#s-count').textContent = students.length;
  const ul = $('#s-list'); ul.replaceChildren();
  for (const s of students) {
    const actions = el('span', { className: 'actions' });
    const enrol = el('button', { textContent: s.hasFace ? 'Re-enrol' : 'Enrol face' });
    enrol.onclick = () => startReenroll(s);
    actions.append(enrol);
    if (s.hasFace) {
      const df = el('button', { textContent: 'Delete face data' });
      df.onclick = async () => {
        if (!confirm(`Delete ${s.name}'s face data? They stay on the roster (manual attendance only).`)) return;
        try { await Api.deleteFace(s.id); await loadRoster(); } catch (e) { msg(e.message); }
      };
      actions.append(df);
    }
    const rm = el('button', { textContent: 'Remove' });
    rm.onclick = async () => {
      if (!confirm(`Remove ${s.name}, their face data and attendance records?`)) return;
      try { await Api.deleteStudent(s.id); await loadRoster(); } catch (e) { msg(e.message); }
    };
    actions.append(rm);
    const who = el('span', { className: 'who' });
    if (s.thumbnail) who.append(el('img', { src: s.thumbnail, alt: '' }));
    who.append(el('span', { textContent: s.name }));
    if (!s.hasFace) who.append(el('span', { className: 'tag', textContent: '  no face data' }));
    ul.append(el('li', {}, who, actions));
  }
}

async function openStudents() {
  $('#consent').hidden = false; $('#enroll-wrap').hidden = true;
  $('#consent-ok').checked = false; $('#b-consent').disabled = true;
  await loadRoster().catch((e) => msg(e.message));
}
$('#consent-ok').onchange = (e) => ($('#b-consent').disabled = !e.target.checked);
$('#b-consent').onclick = async () => {
  consented = true; $('#consent').hidden = true; $('#enroll-wrap').hidden = false;
  const run = loopRun;
  hint('#enroll-hint', 'Starting camera…');
  try { await face.load(); } catch { return hint('#enroll-hint', 'Could not load face models. Reload the page.', 'bad'); }
  try { await startCamera($('#enroll-video')); } catch (e) { return hint('#enroll-hint', cameraError(e), 'bad'); }
  if (run === loopRun) hint('#enroll-hint', 'Type a name, then press Capture');
};

function startReenroll(s) {
  if (!consented) return msg('Please read and accept the consent notice first (scroll up, then Continue).');
  enrollTarget = s;
  const input = $('#f-student [name=name]'); input.value = s.name; input.readOnly = true;
  $('#b-capture').textContent = `Capture face for ${s.name}`; $('#b-cancel-re').hidden = false;
}
$('#b-cancel-re').onclick = () => {
  enrollTarget = null; const input = $('#f-student [name=name]'); input.value = ''; input.readOnly = false;
  $('#b-capture').textContent = 'Capture face & add student'; $('#b-cancel-re').hidden = true;
};

$('#f-student').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, btn = $('#b-capture'), video = $('#enroll-video'), run = loopRun;
  const name = new FormData(form).get('name').trim();
  if (!stream) return msg('Camera is not running.');
  btn.disabled = true; msg();
  try {
    const samples = [], deadline = Date.now() + 45000;
    let thumb = null, rejects = 0;
    while (samples.length < ENROLL_SAMPLES && Date.now() < deadline && run === loopRun) {
      const canvas = face.snapshot(video);
      const faces = await face.analyze(canvas);
      const f = faces[0];
      if (faces.length === 0) hint('#enroll-hint', 'No face detected — look at the camera', 'warn');
      else if (faces.length > 1) hint('#enroll-hint', 'Multiple faces — one student only', 'warn');
      else if (f.box.width / video.videoWidth < ENROLL_MIN_FACE) hint('#enroll-hint', 'Move closer to the camera', 'warn');
      else if (face.sharpness(canvas, f.box) < BLUR_MIN) { rejects++; hint('#enroll-hint', 'Image is blurry — hold still / improve lighting', 'warn'); }
      else if (samples.length && Math.min(...samples.map((x) => euclidean(f.descriptor, x))) > 0.55) hint('#enroll-hint', 'Face changed — keep the same student in view', 'warn');
      else {
        samples.push(f.descriptor);
        thumb ??= face.thumbnail(canvas, f.box);
        hint('#enroll-hint', `Captured ${samples.length}/${ENROLL_SAMPLES} — next: ${ENROLL_PROMPTS[samples.length % ENROLL_PROMPTS.length]}`, 'ok');
        await sleep(1100); // time to change pose
        continue;
      }
      await sleep(250);
    }
    if (run !== loopRun) return;
    if (samples.length < ENROLL_SAMPLES) throw new Error(rejects > 3 ? 'Images were too blurry. Improve lighting and try again.' : 'Could not capture a clear face. Try again.');
    if (enrollTarget) await Api.reenroll(enrollTarget.id, samples, thumb); else await Api.addStudent(name, samples, thumb);
    const done = enrollTarget?.name ?? name;
    $('#b-cancel-re').onclick(); form.reset();
    await loadRoster();
    hint('#enroll-hint', `Saved ${done}. Next student?`, 'ok');
  } catch (err) { msg(err.message); } finally { btn.disabled = false; }
});

// ======================================================================
// auth / boot
// ======================================================================
const enter = async (user) => {
  $('#who').textContent = user.id;
  try { matcher.threshold = (await Api.config()).faceThreshold ?? matcher.threshold; } catch { /* keep default */ }
  const saved = Number(safe(() => localStorage.getItem('faceThreshold')));
  if (saved >= 0.3 && saved <= 0.7) matcher.threshold = saved;
  $('#dbg-thr').value = matcher.threshold; $('#dbg-thr-val').textContent = matcher.threshold.toFixed(2);
  clearInterval(syncTimer);
  syncTimer = setInterval(() => attendance.pending() && attendance.flush(), 10000);
  show('app'); renderQueue(attendance.pending());
  await openTab('scan');
};
window.addEventListener('online', () => attendance.pending() && attendance.flush());
document.addEventListener('click', (e) => { const go = e.target.closest('[data-go]'); if (go) { e.preventDefault(); show(go.dataset.go); } });
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) openTab(b.dataset.tab); });
for (const [formId, fn] of [['#f-login', Api.login], ['#f-register', Api.register]]) {
  $(formId).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), btn = $('button', e.target);
    btn.disabled = true;
    try { await enter(await fn(f.get('id'), f.get('password'))); } catch (err) { msg(err.message); } finally { btn.disabled = false; }
  });
}
$('#b-logout').onclick = async () => {
  if (attendance.pending() && !confirm(`${attendance.pending()} scans have not synced yet. Log out anyway?`)) return;
  clearInterval(syncTimer); await Api.logout(); show('login'); msg('Logged out.', true);
};
window.addEventListener('session-expired', () => { localStorage.removeItem('token'); show('login'); msg('Session expired. Please log in again.'); });

face.load().catch(() => {}); // preload so the first scan doesn't wait for the download
(async () => {
  if (!localStorage.getItem('token')) return show('login');
  try { await enter(await Api.me()); } catch { localStorage.removeItem('token'); show('login'); }
})();
