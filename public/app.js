import { Api } from './api.js';
import { FaceService } from './face-service.js';
import { AttendanceService } from './attendance-service.js';
import { MatchingService, FaceTracker, iou, faceQuality, SCAN_QUALITY, ENROLL_QUALITY, meanDescriptor, pruneOutliers, rosterReport, euclidean } from './matching.js';
import { PalmService } from './palm-service.js';
import { PalmMatcher, PalmTrack, palmQuality, SCAN_PALM, ENROLL_PALM, prunePalmOutliers, palmDuplicate, hamming, codeToBase64, codeFromBase64 } from './palm.js';

const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const safe = (fn) => { try { return fn(); } catch { return null; } }; // localStorage can throw (private mode)

// ---------- tunables ----------
const CONFIRM_FRAMES = 3;       // good-quality frames fused before deciding (2 if the match is very close)
const MIN_FACE_RATIO = 0.12;    // scan: ignore faces narrower than this fraction of the frame (far background)
const FAR_FACE_RATIO = 0.06;    // scan: faces between this and MIN_FACE_RATIO get a "come closer" box
// Quality limits (pose, size, blur, light) are SCAN_QUALITY / ENROLL_QUALITY in matching.js (see README to tune).
const ENROLL_SAMPLES = 6;       // captured; outliers are pruned before saving
const ENROLL_PROMPTS = ['Look straight at the camera', 'Turn your head slightly to one side', 'Turn slightly to the other side', 'Tilt your chin slightly up', 'Look straight again', 'Straight again — relax your face'];
const PICK_LEARN_MS = 20000;    // teacher picks a student this soon after a miss -> that face may be learned
const SPOT_RATE = 0.2;          // liveness "spot": share of check-ins that also get a turn-on-cue challenge
const CHALLENGE_TRIES = 2;      // failed/timed-out cues before "Not verified"
const PALM_CONFIRM_FRAMES = 2;  // palm: good frames before deciding (guarded vote, see fuseDecide; 1 if very close)
const PALM_ENROLL_SAMPLES = 6;  // palm: captured per hand through the strict gate; outliers pruned before saving
const PALM_PROMPTS = ['Hold still', 'Spread your fingers a little', 'Move a little closer', 'Tilt your hand slightly', 'Back to flat', 'Relax your hand'];

// ---------- kiosk options (per browser) ----------
const OPTS = { 'opt-method': 'value', 'opt-box': 'checked', 'opt-guide': 'checked', 'opt-live': 'value' };
// Liveness menu wording per scan method (same four levels: passive / spot checks / every student / off).
const LIVE_LABELS = {
  face: { passive: 'Blink or head turn (fast)', spot: '+ random "turn on cue" spot checks', challenge: '"Turn on cue" for every student (strongest, slower)', off: 'Off (fastest, photos can pass)' },
  palm: { passive: 'Finger movement (fast; not tuned yet)', spot: '+ random "close & open hand" spot checks', challenge: '"Close & open hand" for every student (strongest, slower)', off: 'Off (fastest, photos can pass)' },
};
const scanMethod = () => /** @type {'face' | 'palm'} */ (document.getElementById('opt-method').value);
for (const [id, prop] of Object.entries(OPTS)) {
  const input = document.getElementById(id);
  const saved = safe(() => localStorage.getItem(id));
  if (saved != null) input[prop] = prop === 'checked' ? saved === '1' : saved;
  input.addEventListener('change', () => { safe(() => localStorage.setItem(id, prop === 'checked' ? (input.checked ? '1' : '0') : input.value)); applyOpts(); });
}
function applyOpts() {
  document.getElementById('guide').hidden = !document.getElementById('opt-guide').checked;
  for (const o of document.getElementById('opt-live').options) o.textContent = LIVE_LABELS[scanMethod()][o.value];
  if (!document.getElementById('opt-box').checked) { const c = document.getElementById('face-canvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height); }
}
applyOpts();
const RESULT_MS = 1500;         // how long the "recognised" card stays up
const UNKNOWN_MS = 5000;
const COOLDOWN_MS = 6000;       // ignore a just-handled student for a moment
const UNDO_COOLDOWN_MS = 15000;

const face = new FaceService(window.faceapi);
const matcher = new MatchingService({ threshold: 0.5, gap: 0.04, ratio: 0.8, k: 2 });
// Palm: MediaPipe is only downloaded when palm scanning or palm enrolment is first used.
const palm = new PalmService({ tf: window.faceapi?.tf });
const palmMatcher = new PalmMatcher();
let palmRoster = [];               // students with palm data, codes decoded: [{id, name, palms: [{hand, code, geom}]}]
const toPalmEnrolled = (s) => ({ id: s.id, name: s.name, palms: (s.palms ?? []).map((p) => ({ hand: p.hand, code: codeFromBase64(p.code), geom: [] })) });
const attendance = new AttendanceService({
  send: (sessionId, studentId, scannedAt, method) => Api.markPresent(sessionId, studentId, scannedAt, method),
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
const learned = new Map();        // studentId -> descriptor learned this session (removed again on "Wrong person")
let verifier = Promise.resolve(false); // resolves true once the enrolment verifier (SSD) is loaded
let lastFace = null;              // {descriptor, at}: last fused face that was not recognised or was undone

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
  $('#result-pick').hidden = !picker; $('#result-pick').onclick = () => { r.hidden = true; openPicker('Who is this?', true); };
  clearTimeout(resultTimer); resultTimer = setTimeout(() => (r.hidden = true), ms);
}

async function startScan() {
  const run = ++loopRun, alive = () => run === loopRun;
  const video = $('#kiosk-video');
  const palmMode = scanMethod() === 'palm';
  hint('#kiosk-hint', palmMode ? 'Loading the hand model…' : 'Starting camera…');
  configureSlider();
  let sessions;
  try {
    [students, sessions] = await Promise.all([Api.students(), Api.sessions(), palmMode ? palm.load() : face.load()]);
  } catch (e) { return hint('#kiosk-hint', 'Could not load: ' + e.message + ' (reload to retry)', 'bad'); }
  if (!alive()) return;
  session = sessions.find((s) => s.active) ?? null;
  $('#scan-empty').hidden = !!session; $('#scan-main').hidden = !session;
  if (!session) return;
  $('#k-class').textContent = `${session.name} · ${session.day}`;
  const detail = await Api.session(session.id);
  present = new Map(detail.records.filter((r) => r.present).map((r) => [r.id, { name: r.name, scannedAt: r.scannedAt, source: r.source }]));
  renderCount(); renderQueue(attendance.pending());
  if (!students.length) return hint('#kiosk-hint', 'No students yet — add them in the Students tab.', 'warn');
  if (palmMode) {
    palmRoster = students.filter((s) => s.hasPalm).map(toPalmEnrolled);
    if (!palmRoster.length) return hint('#kiosk-hint', 'No enrolled palms yet. Enrol palms in the Students tab, switch "Scan with" to Face, or use "Mark manually".', 'warn');
  } else if (!students.some((s) => s.hasFace)) return hint('#kiosk-hint', 'No enrolled faces yet. Use "Mark manually" or enrol faces.', 'warn');
  try { await startCamera(video); } catch (e) { return hint('#kiosk-hint', cameraError(e), 'bad'); }
  if (!alive()) return;
  holdWake();
  paused = false; $('#b-kiosk').textContent = 'Pause';
  (palmMode ? palmScanLoop : scanLoop)(alive, video).catch((e) => alive() && hint('#kiosk-hint', 'Scanner stopped: ' + e.message, 'bad'));
}

async function scanLoop(alive, video) {
  const tracker = new FaceTracker();
  cooldown.clear();
  const guide = $('#guide');
  let unknownStreak = 0, unknownUntil = 0, fps = 0, last = performance.now();

  while (alive()) {
    if (paused || document.hidden) { await sleep(300); continue; }
    if (!video.videoWidth) { await sleep(100); continue; }
    const W = video.videoWidth;
    // Cheap 160px presence gate only while nobody is being followed; mid check-in, go straight to the full pipeline.
    if (!tracker.active(Date.now())) {
      const gate = (await face.gate(video)).filter((b) => b.width / W >= FAR_FACE_RATIO);
      if (!alive()) return;
      const close = gate.filter((b) => b.width / W >= MIN_FACE_RATIO);
      if (!close.length) {
        unknownStreak = 0; guide.className = 'guide';
        hint('#kiosk-hint', gate.length ? 'Come closer to the camera' : 'Ready — walk up and look at the camera', gate.length ? 'warn' : '');
        drawOverlay(video, gate.map((box) => ({ box, kind: 'far' })));
        drawDebug(video, null, 0, fps); await sleep(gate.length ? 60 : 120); continue;
      }
      drawOverlay(video, close.map((box) => ({ box, kind: 'detect' }))); // instant box while the heavy step runs
    }

    const canvas = face.snapshot(video);
    const faces = (await face.analyze(canvas)).filter((f) => f.box.width / W >= MIN_FACE_RATIO).sort((a, b) => b.box.width - a.box.width);
    if (!alive()) return;
    const t = Date.now();
    const mode = $('#opt-live').value; // off | passive | spot | challenge
    let anyUnknown = false, anyKnown = false, status = null, dbg = null;
    const boxes = [];

    for (const { face: f, track } of tracker.assign(faces, t)) {
      const q = faceQuality({ ...f, faceRatio: f.box.width / W, ...face.quality(canvas, f.box) }, SCAN_QUALITY);
      track.observe(f, q.ok, t);
      if (mode === 'spot') track.spot ??= Math.random() < SPOT_RATE;
      const requireChallenge = mode === 'challenge' || (mode === 'spot' && !!track.spot);
      const r = track.decide(matcher, students, { frames: CONFIRM_FRAMES, requireLiveness: mode !== 'off', requireChallenge });
      const m = r.match;
      dbg ??= { f, q, r, track };
      const box = { box: f.box, kind: 'detect', label: '' };
      boxes.push(box);

      if (m?.student) {
        const id = m.student.id;
        anyKnown = true;
        Object.assign(box, { kind: 'ok', label: m.student.name });
        if ((cooldown.get(id) ?? 0) > t || track.handled === id) continue;
        if (r.waitingForChallenge) {
          if (track.challengeFails >= CHALLENGE_TRIES) {
            track.handled = id; cooldown.set(id, t + COOLDOWN_MS);
            Object.assign(box, { kind: 'bad', label: 'Not verified' });
            showResult('unknown', { name: 'Not verified', sub: 'Ask the teacher to mark you manually.', picker: true, ms: UNKNOWN_MS });
            continue;
          }
          if (!track.challenge) track.startChallenge(Math.random() < 0.5 ? 'left' : 'right', f.yaw, t);
          const arrow = screenArrow(track.challenge.dir);
          Object.assign(box, { kind: 'warn', label: arrow });
          status ??= [`Turn your head ${arrow}`, 'warn'];
        } else if (r.waitingForLiveness) { box.kind = 'warn'; status ??= ['Please blink or turn your head slightly', 'warn']; }
        else status ??= [`Hello ${m.student.name}… hold still`, 'ok'];
        if (r.confirmed) {
          track.handled = id; cooldown.set(id, t + COOLDOWN_MS);
          const learn = q.ok && matcher.shouldAdapt(m) ? track.fused() : null;
          await handleConfirmed(students.find((s) => s.id === id), alive, learn, track.fused());
          if (!alive()) return;
        }
      } else if (m && r.frames >= CONFIRM_FRAMES) {
        anyUnknown = true; Object.assign(box, { kind: 'bad', label: 'Not recognised' });
        lastFace = { descriptor: track.fused(), at: t };
      } else if (!q.ok) { box.kind = 'warn'; status ??= [q.hint, 'warn']; }
      else status ??= ['Hold still…', ''];
    }

    if (anyUnknown && !anyKnown) {
      status = ['Face not recognised', 'bad'];
      if (++unknownStreak >= 2 && t > unknownUntil) {
        showResult('unknown', { name: 'Not recognised', sub: 'Ask the student to face the camera, or pick them manually.', picker: true, ms: UNKNOWN_MS });
        unknownUntil = t + UNKNOWN_MS + 1500;
      }
    } else unknownStreak = 0;
    guide.className = 'guide ' + (status?.[1] ?? (faces.length ? 'ok' : ''));
    if (status) hint('#kiosk-hint', status[0], status[1]);

    const nowP = performance.now(); fps = fps * 0.8 + (1000 / (nowP - last)) * 0.2; last = nowP;
    drawOverlay(video, boxes);
    drawDebug(video, dbg, faces.length, fps);
    await sleep(15); // yield to the UI; the inference itself is the real rate limiter
  }
}

/** Palm kiosk loop: same flow as scanLoop (track -> quality -> fuse -> decide -> mark), on MediaPipe hands.
 *  No cheap pre-check pass: the landmarker tracks between frames itself (~11 ms). Idle frames are throttled. */
async function palmScanLoop(alive, video) {
  const tracker = new FaceTracker({ create: (id, box, now) => new PalmTrack(id, box, now) });
  cooldown.clear(); lastFace = null;
  const guide = $('#guide');
  const hands = new Set(palmRoster.flatMap((s) => s.palms.map((p) => p.hand))); // hands anyone has enrolled
  let unknownStreak = 0, unknownUntil = 0, fps = 0, last = performance.now(), lastTime = -1;

  while (alive()) {
    if (paused || document.hidden) { await sleep(300); continue; }
    if (!video.videoWidth || video.currentTime === lastTime) { await sleep(8); continue; } // wait for a new camera frame
    lastTime = video.currentTime;
    const frames = palm.analyze(video).sort((a, b) => b.roi.side - a.roi.side);
    const t = Date.now();
    const mode = $('#opt-live').value; // off | passive (finger movement) | spot | challenge (close & open hand)
    let anyUnknown = false, anyKnown = false, status = null, dbg = null;
    const boxes = [];

    for (const { face: f, track } of tracker.assign(frames, t)) {
      const q = palmQuality(f.signals, SCAN_PALM);
      const wrongHand = q.ok && !hands.has(f.hand);
      const l = track.observe(f, q.ok && !wrongHand, t, palmMatcher, palmRoster);
      if (mode === 'spot') track.spot ??= Math.random() < SPOT_RATE;
      const grip = mode === 'challenge' || (mode === 'spot' && !!track.spot);
      const r = track.decide(palmMatcher, { frames: PALM_CONFIRM_FRAMES, requireLiveness: mode === 'passive' });
      const m = r.match;
      dbg ??= { f, q, r, l };
      const box = { box: f.box, kind: 'detect', label: '' };
      boxes.push(box);

      if (wrongHand) { box.kind = 'warn'; status ??= [`Use your ${f.hand === 'Right' ? 'left' : 'right'} hand`, 'warn']; continue; }
      if (m?.student) {
        const id = m.student.id;
        anyKnown = true;
        Object.assign(box, { kind: 'ok', label: m.student.name });
        if ((cooldown.get(id) ?? 0) > t || track.handled === id) { status ??= [`✓ ${m.student.name} — checked in`, 'ok']; continue; }
        let confirmed = r.confirmed;
        if (r.waitingForLiveness) { box.kind = 'warn'; status ??= ['Move your fingers a little', 'warn']; }
        else if (confirmed && grip && !track.liveness.gripPassed) {
          confirmed = false;
          if (l.grip === 'failed') track.gripFails = (track.gripFails ?? 0) + 1;
          if ((track.gripFails ?? 0) >= CHALLENGE_TRIES) {
            track.handled = id; cooldown.set(id, t + COOLDOWN_MS);
            Object.assign(box, { kind: 'bad', label: 'Not verified' });
            showResult('unknown', { name: 'Not verified', sub: 'Ask the teacher to mark you manually.', picker: true, ms: UNKNOWN_MS });
            continue;
          }
          if (!track.liveness.grip) track.liveness.startGrip(t);
          Object.assign(box, { kind: 'warn', label: '✊ → ✋' });
          status ??= ['Close your hand, then open it', 'warn'];
        } else if (!confirmed) status ??= [`Hello ${m.student.name}… hold still`, 'ok'];
        if (confirmed) {
          track.handled = id; cooldown.set(id, t + COOLDOWN_MS);
          await handleConfirmed(students.find((s) => s.id === id), alive, null, null, 'palm');
          if (!alive()) return;
        }
      } else if (m && r.frames >= PALM_CONFIRM_FRAMES) {
        anyUnknown = true; Object.assign(box, { kind: 'bad', label: 'Not recognised' });
      } else if (!q.ok) { box.kind = 'warn'; status ??= [q.hint, 'warn']; }
      else status ??= ['Hold still…', ''];
    }

    if (anyUnknown && !anyKnown) {
      status = ['Palm not recognised', 'bad'];
      if (++unknownStreak >= 2 && t > unknownUntil) {
        showResult('unknown', { name: 'Not recognised', sub: 'Open your hand flat to the camera, or ask the teacher to pick you.', picker: true, ms: UNKNOWN_MS });
        unknownUntil = t + UNKNOWN_MS + 1500;
      }
    } else unknownStreak = 0;
    if (!frames.length) status = ['Ready — show your open palm to the camera', ''];
    guide.className = 'guide ' + (status?.[1] ?? (frames.length ? 'ok' : ''));
    if (status) hint('#kiosk-hint', status[0], status[1]);

    const nowP = performance.now(); fps = fps * 0.8 + (1000 / (nowP - last)) * 0.2; last = nowP;
    drawOverlay(video, boxes);
    drawPalmDebug(dbg, frames.length, fps);
    if (!frames.length) await sleep(60); // nobody there: ~15 checks a second is plenty
  }
}

function drawPalmDebug(dbg, nHands, fps) {
  const on = $('#dbg-toggle').checked;
  $('#dbg-text').hidden = !on;
  if (!on) return;
  const n = (x) => (Number.isFinite(x) ? x.toFixed(3) : '—');
  const lines = [`fps ${fps.toFixed(1)}  hands ${nHands}  threshold ${palmMatcher.threshold.toFixed(3)}  detect ${palm.timing.detect.toFixed(0)}ms (${palm.delegate})`];
  if (dbg) {
    const { f, q, r, l } = dbg, m = r.match, sg = f.signals;
    if (m) lines.push(`best ${m.student?.name ?? '—'}  dist ${n(m.distance)}  next ${n(m.runnerUp)}  (${m.reason})`);
    lines.push(`${f.hand} ${sg.facing ? 'palm' : 'BACK'}  side ${sg.side.toFixed(0)}px  flat ${sg.flatness.toFixed(2)}  open ${sg.open}  sharp ${sg.sharpness.toFixed(0)}  light ${sg.brightness.toFixed(0)}`);
    lines.push(`quality ${q.ok ? 'OK' : q.reason}  frames ${r.frames}/${PALM_CONFIRM_FRAMES}  finger travel ${n(l.travel)}${l.passed ? ' ✓' : ''}${l.grip !== 'none' ? '  grip ' + l.grip : ''}`);
  }
  $('#dbg-text').textContent = lines.join('\n');
}

/** @param learn fused descriptor to add to the student's template (Face ID-style), or null */
async function handleConfirmed(student, alive, learn = null, fused = null, method = 'face') {
  if (!student) return;
  lastFace = fused ? { descriptor: fused, at: Date.now(), studentId: student.id } : null;
  const base = { name: student.name, thumbnail: student.thumbnail ?? '' };
  if (present.has(student.id)) return showResult('already', { ...base, sub: 'Already checked in' });
  try {
    const r = await attendance.mark(session.id, student.id, method);
    if (!alive()) return;
    present.set(student.id, { name: student.name, scannedAt: r.scannedAt, source: method });
    renderCount();
    if (r.status === 'saved' && r.already) showResult('already', { ...base, sub: 'Already checked in' });
    else {
      showResult('ok', { ...base, sub: r.status === 'queued' ? '✓ Saved offline — will sync' : '✓ Present', undoId: student.id });
      if (learn && r.status === 'saved') learnFace(student, learn);
    }
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
    forgetFace(id);
    if (lastFace?.studentId === id) lastFace = { descriptor: lastFace.descriptor, at: Date.now() }; // "who is this?" can learn it
    $('#result').hidden = true;
    if (thenPick) openPicker('Who is this?', true);
  } catch (e) { msg(e.message); }
}

// ----- template update (like Face ID: learn from confident matches, never touch the original enrolment) -----
function learnFace(student, descriptor) {
  if (!session || learned.has(student.id)) return;
  learned.set(student.id, descriptor);
  student.descriptors = [...student.descriptors, descriptor];
  Api.learnFace(student.id, session.id, descriptor).catch(() => {}); // best effort
}
function forgetFace(id) {
  const d = learned.get(id); if (!d) return;
  learned.delete(id);
  const s = students.find((x) => x.id === id);
  if (s) s.descriptors = s.descriptors.filter((x) => x !== d);
  Api.forgetFace(id, session.id).catch(() => {});
}

/** Arrow for "turn to your left/right" as the student sees it: the front camera preview is mirrored. */
const screenArrow = (dir) => ((dir === 'left') === (facing === 'user') ? '←' : '→');

// ----- face box overlay (toggle: Show face box) + debug text -----
const BOX_COLORS = { far: '#ffffff88', detect: '#ffffff', warn: '#fbbf24', ok: '#4ade80', bad: '#f87171' };
function drawOverlay(video, boxes) {
  const cv = $('#face-canvas');
  if (cv.width !== video.videoWidth) { cv.width = video.videoWidth; cv.height = video.videoHeight; }
  const mirrored = facing === 'user';
  cv.classList.toggle('rear', !mirrored);
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
  if (!$('#opt-box').checked) return;
  const lw = Math.max(3, cv.width / 250);
  for (const { box, kind, label } of boxes) {
    const c = BOX_COLORS[kind] ?? '#fff', r = box.width * 0.12;
    ctx.strokeStyle = c; ctx.lineWidth = kind === 'far' ? lw / 2 : lw;
    // corner brackets: reads as "I see you" without hiding the face
    ctx.beginPath();
    for (const [x, y, dx, dy] of [[box.x, box.y, 1, 1], [box.x + box.width, box.y, -1, 1], [box.x, box.y + box.height, 1, -1], [box.x + box.width, box.y + box.height, -1, -1]]) {
      ctx.moveTo(x, y + dy * r); ctx.lineTo(x, y); ctx.lineTo(x + dx * r, y);
    }
    ctx.stroke();
    if (!label) continue;
    // the canvas is mirrored by CSS like the video; un-mirror the text
    ctx.save();
    const fs = Math.max(18, box.width / 7);
    ctx.font = `600 ${fs}px system-ui, sans-serif`; ctx.textBaseline = 'bottom';
    const tw = ctx.measureText(label).width, cx = box.x + box.width / 2, y = box.y - lw * 2;
    if (mirrored) { ctx.translate(cv.width, 0); ctx.scale(-1, 1); }
    const x = (mirrored ? cv.width - cx : cx) - tw / 2;
    ctx.fillStyle = '#000a'; ctx.fillRect(x - 6, y - fs - 4, tw + 12, fs + 8);
    ctx.fillStyle = c; ctx.fillText(label, x, y);
    ctx.restore();
  }
}

// ----- debug overlay -----
function drawDebug(video, dbg, nFaces, fps) {
  const on = $('#dbg-toggle').checked;
  $('#dbg-text').hidden = !on;
  if (!on) return;
  const lines = [`fps ${fps.toFixed(1)}  faces ${nFaces}  threshold ${matcher.threshold.toFixed(2)}`];
  if (dbg) {
    const { f, q, r, track } = dbg, m = r.match;
    const n = (x) => (Number.isFinite(x) ? x.toFixed(3) : '—');
    if (m) lines.push(`best ${m.student?.name ?? '—'}  dist ${n(m.distance)}  next ${n(m.runnerUp)}  (${m.reason})`);
    lines.push(`face ${(f.box.width / video.videoWidth * 100) | 0}%  score ${f.score.toFixed(2)}  roll ${f.roll.toFixed(0)}°  yaw ${f.yaw.toFixed(2)}  EAR ${f.ear.toFixed(2)}`);
    lines.push(`quality ${q.ok ? 'OK' : q.reason}  fused ${r.frames}/${CONFIRM_FRAMES}  live ${track.liveness.passed ? 'OK' : '…'}`);
  }
  $('#dbg-text').textContent = lines.join('\n');
}
$('#dbg-toggle').onchange = (e) => { $('#dbg-panel').hidden = !e.target.checked; if (!e.target.checked) $('#dbg-text').hidden = true; };
$('#dbg-thr').oninput = (e) => {
  const palmMode = scanMethod() === 'palm', m = palmMode ? palmMatcher : matcher;
  m.threshold = Number(e.target.value); $('#dbg-thr-val').textContent = m.threshold.toFixed(palmMode ? 3 : 2);
  safe(() => localStorage.setItem(palmMode ? 'palmThreshold' : 'faceThreshold', String(m.threshold)));
};
/** The debug threshold slider follows the scan method (face: euclidean 0.30-0.70; palm: Hamming 0.30-0.45). */
function configureSlider() {
  const palmMode = scanMethod() === 'palm', sl = $('#dbg-thr');
  if (palmMode) {
    const saved = Number(safe(() => localStorage.getItem('palmThreshold')));
    if (saved >= 0.3 && saved <= 0.45) palmMatcher.threshold = saved;
  }
  Object.assign(sl, palmMode ? { min: '0.30', max: '0.45', step: '0.005' } : { min: '0.30', max: '0.70', step: '0.01' });
  sl.value = String(palmMode ? palmMatcher.threshold : matcher.threshold);
  $('#dbg-thr-val').textContent = (palmMode ? palmMatcher.threshold : matcher.threshold).toFixed(palmMode ? 3 : 2);
}
$('#opt-method').addEventListener('change', () => { if (tab === 'scan') openTab('scan'); });

$('#b-kiosk').onclick = (e) => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; hint('#kiosk-hint', paused ? 'Paused' : 'Ready'); };
$('#b-flip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; openTab('scan'); };
$('#b-manual').onclick = () => openPicker('Mark student present');
document.addEventListener('click', (e) => { const o = e.target.closest('[data-open]'); if (o) openTab(o.dataset.open); });

// ----- manual picker -----
let pickerLearn = false; // picker answers "who is this?" for the face just seen -> the template may learn it
function openPicker(title, learn = false) {
  if (!session) return msg('Start a session first.');
  pickerLearn = learn;
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
        // Like Face ID after a passcode: a near-miss the teacher identifies becomes part of the template.
        if (pickerLearn && lastFace && Date.now() - lastFace.at < PICK_LEARN_MS && s.descriptors?.length
            && matcher.score(lastFace.descriptor, s) <= matcher.threshold + 0.12) learnFace(s, lastFace.descriptor);
        lastFace = null;
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
      el('td', { textContent: r.present ? fmtTime(r.scannedAt) + (r.source === 'manual' ? ' (manual)' : r.source === 'palm' ? ' (palm)' : '') : '' }),
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
    const enrol = el('button', { textContent: s.hasFace ? 'Re-enrol face' : 'Enrol face' });
    enrol.onclick = () => startReenroll(s, 'face');
    const enrolPalm = el('button', { textContent: s.hasPalm ? 'Re-enrol palm' : 'Enrol palm' });
    enrolPalm.onclick = () => startReenroll(s, 'palm');
    actions.append(enrol, enrolPalm);
    if (s.hasFace) {
      const df = el('button', { textContent: 'Delete face data' });
      df.onclick = async () => {
        if (!confirm(`Delete ${s.name}'s face data? They stay on the roster (manual attendance only).`)) return;
        try { await Api.deleteFace(s.id); await loadRoster(); } catch (e) { msg(e.message); }
      };
      actions.append(df);
    }
    if (s.hasPalm) {
      const dp = el('button', { textContent: 'Delete palm data' });
      dp.onclick = async () => {
        if (!confirm(`Delete ${s.name}'s palm data (both hands)? Their face data and roster entry stay.`)) return;
        try { await Api.deletePalm(s.id); await loadRoster(); } catch (e) { msg(e.message); }
      };
      actions.append(dp);
    }
    const rm = el('button', { textContent: 'Remove' });
    rm.onclick = async () => {
      if (!confirm(`Remove ${s.name}, their face and palm data and attendance records?`)) return;
      try { await Api.deleteStudent(s.id); await loadRoster(); } catch (e) { msg(e.message); }
    };
    actions.append(rm);
    const who = el('span', { className: 'who' });
    if (s.thumbnail) who.append(el('img', { src: s.thumbnail, alt: '' }));
    who.append(el('span', { textContent: s.name }));
    if (!s.hasFace) who.append(el('span', { className: 'tag', textContent: '  no face data' }));
    if (s.hasPalm) who.append(el('span', { className: 'tag palm', textContent: `  palm: ${[...new Set(s.palms.map((p) => p.hand.toLowerCase()))].join(' + ')}` }));
    ul.append(el('li', {}, who, actions));
  }
}

$('#b-roster-check').onclick = () => {
  const r = rosterReport(students, matcher), out = $('#roster-report');
  const f = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
  const lines = [
    `Own samples vs own template (95% of them under): ${f(r.genuineP95)}`,
    `Closest two different students: ${f(r.impostorMin)}`,
    `Current threshold: ${matcher.threshold.toFixed(2)}   Suggested: ${r.suggested.toFixed(2)}`,
  ];
  if (r.overlap) lines.push('⚠ Some students are about as close to each other as to themselves: re-enrol them in better light, or mark them manually.');
  for (const p of r.lookAlikes) lines.push(`⚠ Look-alikes: ${p.a.name} ↔ ${p.b.name} (${f(p.d)}) — scan both and check for wrong marks`);
  if (!r.lookAlikes.length && Number.isFinite(r.impostorMin)) lines.push('✓ No look-alike pairs near the threshold.');
  out.textContent = lines.join('\n'); out.hidden = false;
};

async function openStudents() {
  $('#roster-report').hidden = true;
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
  verifier = face.loadVerifier().then(() => true, () => false); // enrolment-only detector; scanning never waits for it
  try { await startCamera($('#enroll-video')); } catch (e) { return hint('#enroll-hint', cameraError(e), 'bad'); }
  if (run === loopRun) hint('#enroll-hint', 'Type a name, then press Capture');
};

/** @param {'face' | 'palm'} kind which capture button to point the teacher at */
function startReenroll(s, kind = 'face') {
  if (!consented) return msg('Please read and accept the consent notice first (scroll up, then Continue).');
  enrollTarget = s;
  const input = $('#f-student [name=name]'); input.value = s.name; input.readOnly = true;
  $('#b-capture').textContent = `Capture face for ${s.name}`; $('#b-capture-palm').textContent = `Capture palm for ${s.name}`;
  $('#b-cancel-re').hidden = false;
  if (kind === 'palm') {
    const enrolled = new Set((s.palms ?? []).map((p) => p.hand));
    if (enrolled.size === 1) $('#palm-hands').value = [...enrolled][0]; // re-enrol the hand they have
    $('#b-capture-palm').focus();
    hint('#enroll-hint', `Tick the consent box, choose the hand, then press "Capture palm for ${s.name}"`);
  } else $('#b-capture').focus();
}
$('#b-cancel-re').onclick = () => {
  enrollTarget = null; const input = $('#f-student [name=name]'); input.value = ''; input.readOnly = false;
  $('#b-capture').textContent = 'Capture face & add student'; $('#b-capture-palm').textContent = 'Capture palm & add student';
  $('#b-cancel-re').hidden = true;
};

// ----- palm enrolment (strict, slower is fine): N samples per hand through ENROLL_PALM, outliers pruned, duplicate check -----
$('#b-capture-palm').onclick = async () => {
  const form = $('#f-student'), btn = $('#b-capture-palm'), video = $('#enroll-video'), run = loopRun;
  if (!form.reportValidity()) return; // name + guardian consent checkbox
  const name = new FormData(form).get('name').trim();
  if (!stream) return msg('Camera is not running.');
  btn.disabled = true; $('#b-capture').disabled = true; msg();
  try {
    hint('#enroll-hint', 'Loading the hand model…');
    await palm.load();
    const choice = $('#palm-hands').value, hands = choice === 'Both' ? ['Right', 'Left'] : [choice];
    const others = students.filter((s) => s.id !== enrollTarget?.id && s.hasPalm).map(toPalmEnrolled);
    const templates = [];
    for (const hand of hands) {
      const kept = await capturePalm(video, hand, run);
      if (!kept) return; // left the tab
      // Is this palm already enrolled under another name? (Two templates for one palm = wrong marks.)
      const dup = palmDuplicate(kept, others, palmMatcher);
      if (dup && !confirm(`This ${hand.toLowerCase()} palm looks like ${dup.student.name}'s, who is already enrolled. Save anyway? (Only if you are sure it is a different person.)`)) {
        return hint('#enroll-hint', 'Not saved (possible duplicate).', 'warn');
      }
      templates.push(...kept.map((k) => ({ hand, code: codeToBase64(k.code) })));
    }
    if (enrollTarget) await Api.enrollPalm(enrollTarget.id, templates); else await Api.addPalmStudent(name, templates);
    const done = enrollTarget?.name ?? name;
    $('#b-cancel-re').onclick(); form.reset();
    await loadRoster();
    hint('#enroll-hint', `Saved ${done}'s palm (${hands.join(' + ').toLowerCase()}). Next student?`, 'ok');
  } catch (err) { msg(err.message); } finally { btn.disabled = false; $('#b-capture').disabled = false; }
};

/** Collect PALM_ENROLL_SAMPLES good frames of one hand, spread over time, then drop outliers. Null if the tab was left.
 *  @param {HTMLVideoElement} video @param {'Left' | 'Right'} hand @param {number} run */
async function capturePalm(video, hand, run) {
  const samples = [], deadline = Date.now() + 40000, rejects = {}, side = hand.toLowerCase(), other = hand === 'Right' ? 'left' : 'right';
  let lastAt = 0, lastTime = -1;
  hint('#enroll-hint', `Show your ${side} palm, fingers apart, about 30 cm from the camera`);
  while (samples.length < PALM_ENROLL_SAMPLES && Date.now() < deadline) {
    if (run !== loopRun) return null;
    await sleep(15);
    if (video.currentTime === lastTime) continue;
    lastTime = video.currentTime;
    const frames = palm.analyze(video), f = frames.find((x) => x.hand === hand);
    if (!frames.length) { hint('#enroll-hint', `Show your ${side} palm, fingers apart`, 'warn'); continue; }
    if (frames.length > 1) { hint('#enroll-hint', 'One hand at a time', 'warn'); continue; }
    if (!f) { hint('#enroll-hint', `That is the ${other} hand — show your ${side} palm`, 'warn'); continue; }
    const q = palmQuality(f.signals, ENROLL_PALM);
    if (!q.ok) { rejects[q.reason] = (rejects[q.reason] ?? 0) + 1; hint('#enroll-hint', q.hint, 'warn'); continue; }
    if (samples.length && hamming(f.code, samples[0].code, palmMatcher.maxShift) > 0.42) { hint('#enroll-hint', 'Hand changed — keep the same hand in view', 'warn'); continue; }
    if (Date.now() - lastAt < 400) continue; // a little variety between samples
    samples.push({ hand, code: f.code, geom: [] }); lastAt = Date.now();
    hint('#enroll-hint', `Captured ${samples.length}/${PALM_ENROLL_SAMPLES} — ${PALM_PROMPTS[samples.length % PALM_PROMPTS.length]}`, 'ok');
  }
  if (samples.length < PALM_ENROLL_SAMPLES) {
    const worst = Object.entries(rejects).sort((a, b) => b[1] - a[1])[0]?.[0];
    const why = { blur: 'The image was too blurry (hold still)', dark: 'It was too dark', bright: 'It was too bright', small: 'The hand was too far away', tilt: 'The palm was not flat to the camera', closed: 'The fingers were not open', back: 'The back of the hand was shown', frame: 'The hand was partly out of view' }[worst];
    throw new Error((why ? why + '. ' : `Could not capture a clear ${side} palm. `) + 'Improve lighting / position and try again.');
  }
  return prunePalmOutliers(samples, palmMatcher, { keep: 4 });
}

$('#f-student').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, btn = $('#b-capture'), video = $('#enroll-video'), run = loopRun;
  const name = new FormData(form).get('name').trim();
  if (!stream) return msg('Camera is not running.');
  btn.disabled = true; msg();
  try {
    const samples = [], deadline = Date.now() + 45000, rejects = {};
    let thumb = null;
    while (samples.length < ENROLL_SAMPLES && Date.now() < deadline && run === loopRun) {
      const canvas = face.snapshot(video);
      const faces = await face.analyze(canvas);
      const f = faces[0];
      // Second opinion from the accurate detector: exactly one face, at the same place, with a confident score.
      const ssd = f && faces.length === 1 && (await verifier) ? await face.verify(canvas) : null;
      const same = ssd?.find((d) => iou(d.box, f.box) >= 0.4);
      const limits = ssd ? ENROLL_QUALITY : { ...ENROLL_QUALITY, minScore: 0.6 }; // Tiny scores run lower
      const q = f && faceQuality({ ...f, score: ssd ? same?.score ?? 0 : f.score, faceRatio: f.box.width / video.videoWidth, ...face.quality(canvas, f.box) }, limits);
      if (faces.length === 0) hint('#enroll-hint', 'No face detected — look at the camera', 'warn');
      else if (faces.length > 1 || ssd?.filter((d) => d.score >= 0.5).length > 1) hint('#enroll-hint', 'Multiple faces — one student only', 'warn');
      else if (!q.ok) { rejects[q.reason] = (rejects[q.reason] ?? 0) + 1; hint('#enroll-hint', q.hint, 'warn'); }
      else if (samples.length && euclidean(f.descriptor, meanDescriptor(samples)) > 0.5) hint('#enroll-hint', 'Face changed — keep the same student in view', 'warn');
      else {
        samples.push(f.descriptor);
        thumb ??= face.thumbnail(canvas, f.box);
        hint('#enroll-hint', `Captured ${samples.length}/${ENROLL_SAMPLES} — next: ${ENROLL_PROMPTS[samples.length % ENROLL_PROMPTS.length]}`, 'ok');
        await sleep(1000); // time to change pose
        continue;
      }
      await sleep(200);
    }
    if (run !== loopRun) return;
    if (samples.length < ENROLL_SAMPLES) {
      const worst = Object.entries(rejects).sort((a, b) => b[1] - a[1])[0]?.[0];
      const why = { blur: 'Images were too blurry', dark: 'It was too dark', bright: 'It was too bright', roll: 'The head was tilted', yaw: 'The face was turned away', small: 'The face was too far away' }[worst];
      throw new Error((why ? why + '. ' : 'Could not capture a clear face. ') + 'Improve lighting / position and try again.');
    }
    const kept = pruneOutliers(samples, { maxDist: 0.4, keep: 4 });
    // Duplicate check: is this face already enrolled under another name? (two templates for one face = wrong marks)
    const others = students.filter((s) => s.id !== enrollTarget?.id && s.descriptors?.length);
    const c = meanDescriptor(kept);
    const dup = others.map((s) => ({ s, d: matcher.score(c, s) })).sort((a, b) => a.d - b.d)[0];
    if (dup && dup.d <= matcher.threshold && !confirm(`This face looks like ${dup.s.name}, who is already enrolled. Save anyway? (Only for twins/siblings — otherwise use Re-enrol on ${dup.s.name}.)`)) {
      return hint('#enroll-hint', 'Not saved (possible duplicate).', 'warn');
    }
    if (enrollTarget) await Api.reenroll(enrollTarget.id, kept, thumb); else await Api.addStudent(name, kept, thumb);
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
