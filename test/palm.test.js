import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LM, palmRoi, palmSide, palmFacing, palmFlatness, fingersOpen, palmQuality, SCAN_PALM, ENROLL_PALM, insideFrame, grayStats, toGray,
  gaborBank, GABOR, filterResponses, encodeCompCode, hammingAt, hamming, handGeometry, geometryDistance, PalmMatcher, palmReport, simulate1N, fuseScores, fuseDecide, PalmTrack, PalmLiveness, palmFrameTips, prunePalmOutliers, palmDuplicate,
  codeToBase64, codeFromBase64, ROI_SIZE, CODE_SIDE, CODE_WORDS, ORIENTATIONS, ROI_SHAPE, ROI_KNUCKLES, fingerSpread,
} from '../public/palm.js';
import { FaceTracker } from '../public/matching.js';

const close = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

// A right hand, palm towards the camera, fingers up (raw, un-mirrored frame: its thumb is on the image's right).
function rightPalm({ dx = 0, dy = 0, scale = 1, curl = false } = {}) {
  const p = [
    [500, 600], [560, 560], [600, 520], [630, 480], [650, 450], // wrist, thumb
    [560, 400], [565, 330], [568, 290], [570, 255], // index
    [510, 390], [510, 310], [510, 265], [510, 225], // middle
    [465, 400], [460, 325], [457, 285], [455, 250], // ring
    [420, 420], [410, 365], [405, 335], [400, 305], // pinky
  ].map(([x, y]) => ({ x: 500 + (x - 500) * scale + dx, y: 600 + (y - 600) * scale + dy, z: 0 }));
  if (curl) for (const [pip, tip] of [[6, 8], [10, 12], [14, 16], [18, 20]]) p[tip] = { ...p[pip], y: p[pip].y + 40 };
  return p;
}
const mirrorX = (pts) => pts.map((p) => ({ ...p, x: 1000 - p.x }));

test('palmRoi: both frames point towards the wrist and are a rotation, not a mirror', () => {
  for (const shape of [ROI_SHAPE, ROI_KNUCKLES]) for (const pts of [rightPalm(), mirrorX(rightPalm())]) {
    const r = palmRoi(pts, ROI_SIZE, shape);
    close(r.u.x * r.n.y - r.u.y * r.n.x, 1); // det = +1
    const toWrist = { x: pts[LM.WRIST].x - r.center.x, y: pts[LM.WRIST].y - r.center.y };
    assert.ok(toWrist.x * r.n.x + toWrist.y * r.n.y > 0, 'n points at the wrist');
    const w = shape.anchor === 'axis' ? Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) : Math.hypot(pts[5].x - pts[17].x, pts[5].y - pts[17].y);
    close(r.side, shape.side * w);
    // The canvas transform maps the ROI centre to the middle of the output and the corners to the output corners.
    const [a, b, c, d, e, f] = r.transform, map = (p) => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f });
    const m = map(r.center); close(m.x, ROI_SIZE / 2); close(m.y, ROI_SIZE / 2);
    const want = [[0, 0], [ROI_SIZE, 0], [ROI_SIZE, ROI_SIZE], [0, ROI_SIZE]];
    r.corners.forEach((p, i) => { const o = map(p); close(o.x, want[i][0], 1e-6); close(o.y, want[i][1], 1e-6); });
  }
});

test('palmRoi: moves and scales with the hand', () => {
  const a = palmRoi(rightPalm()), b = palmRoi(rightPalm({ dx: 30, dy: -10, scale: 1.5 }));
  close(b.side, a.side * 1.5);
  close(b.u.x, a.u.x); close(b.u.y, a.u.y);
});

test('palmRoi (default, middle-finger axis): spreading the fingers barely moves the square; the knuckle frame moves', () => {
  // Spread: index and pinky (with their knuckles) swing outwards around the middle finger.
  const spread = rightPalm().map((p, i) => ([5, 6, 7, 8].includes(i) ? { ...p, x: p.x + 0.25 * (600 - p.y) } : [17, 18, 19, 20].includes(i) ? { ...p, x: p.x - 0.35 * (600 - p.y), y: p.y + 12 } : p));
  assert.ok(fingerSpread(spread) - fingerSpread(rightPalm()) > 25, `spread ${fingerSpread(rightPalm()).toFixed(0)} -> ${fingerSpread(spread).toFixed(0)}°`);
  const moved = (shape) => { const a = palmRoi(rightPalm(), ROI_SIZE, shape), b = palmRoi(spread, ROI_SIZE, shape); return Math.max(...a.corners.map((c, i) => Math.hypot(c.x - b.corners[i].x, c.y - b.corners[i].y))) / a.side; };
  assert.equal(moved(ROI_SHAPE), 0, 'axis frame does not depend on index/pinky');
  assert.ok(moved(ROI_KNUCKLES) > 0.1, `knuckle frame corners move ${moved(ROI_KNUCKLES).toFixed(2)} of a side`);
});

test('palm side: palm vs back of the hand, per hand', () => {
  const right = rightPalm();
  assert.ok(palmSide(right) < 0);
  assert.equal(palmFacing(right, 'Right'), true);
  assert.equal(palmFacing(right, 'Left'), false, 'same 2D shape labelled Left = the back of a left hand');
  assert.equal(palmFacing(mirrorX(right), 'Left'), true);
});

test('palmFlatness: 1 when flat, lower when tilted', () => {
  close(palmFlatness(rightPalm()), 1);
  const tilted = rightPalm().map((p, i) => (i === LM.PINKY_MCP ? { ...p, z: 120 } : p));
  assert.ok(palmFlatness(tilted) < 0.8);
});

test('fingersOpen: open hand vs curled fingers', () => {
  assert.equal(fingersOpen(rightPalm()), 4);
  assert.equal(fingersOpen(rightPalm({ curl: true })), 0);
});

test('palmQuality: sharpness limits follow the blur measurement (4 scan / 5 enrol), not the old 8 / 15', () => {
  const good = { facing: true, flatness: 0.95, open: 4, side: 180, inFrame: true, brightness: 120, score: 0.95 };
  assert.equal(palmQuality({ ...good, sharpness: 6 }, ENROLL_PALM).ok, true, 'a soft webcam frame can enrol');
  assert.equal(palmQuality({ ...good, sharpness: 4.5 }, ENROLL_PALM).reason, 'blur');
  assert.equal(palmQuality({ ...good, sharpness: 4.5 }, SCAN_PALM).ok, true);
  assert.equal(palmQuality({ ...good, sharpness: 3 }, SCAN_PALM).reason, 'blur', 'below ~3 unenrolled palms start to match');
});

test('palmQuality: first problem wins, scan is more lenient than enrolment', () => {
  const good = { facing: true, flatness: 0.95, open: 4, side: 180, inFrame: true, sharpness: 40, brightness: 120, score: 0.95 };
  assert.deepEqual(palmQuality(good, ENROLL_PALM), { ok: true });
  assert.equal(palmQuality({ ...good, facing: false }, SCAN_PALM).reason, 'back');
  assert.equal(palmQuality({ ...good, side: 50 }, SCAN_PALM).reason, 'small');
  assert.equal(palmQuality({ ...good, open: 2 }, SCAN_PALM).reason, 'closed');
  assert.equal(palmQuality({ ...good, flatness: 0.5 }, SCAN_PALM).reason, 'tilt');
  assert.equal(palmQuality({ ...good, brightness: 10 }, SCAN_PALM).reason, 'dark');
  assert.equal(palmQuality({ ...good, sharpness: 1 }, SCAN_PALM).reason, 'blur');
  const meh = { ...good, side: 110, flatness: 0.85 };
  assert.equal(palmQuality(meh, SCAN_PALM).ok, true);
  assert.equal(palmQuality(meh, ENROLL_PALM).ok, false);
  assert.equal(insideFrame(palmRoi(rightPalm()).corners, 1000, 1000), true);
  assert.equal(insideFrame(palmRoi(rightPalm({ dx: 700 })).corners, 1000, 1000), false);
});

// ---------- texture ----------
/** Deterministic PRNG. */
const rng = (seed) => () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
/** Synthetic "palm": skin-grey background with random dark creases (principal lines + wrinkles), plus sensor noise. */
function palmImage(seed, { shift = 0, noise = 0, w = ROI_SIZE } = {}) {
  const r = rng(seed), lines = [];
  for (let i = 0; i < 14; i++) lines.push({ x: r() * w, y: r() * w, a: r() * Math.PI, width: 1.5 + r() * 2.5, depth: 30 + r() * 50 });
  const n = rng(seed * 7 + 1), g = new Float32Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    let v = 160;
    for (const l of lines) {
      const d = Math.abs(-(x - shift - l.x) * Math.sin(l.a) + (y - l.y) * Math.cos(l.a));
      v -= l.depth * Math.exp(-0.5 * (d / l.width) ** 2);
    }
    g[y * w + x] = v + (n() - 0.5) * 2 * noise;
  }
  return g;
}
const bank = gaborBank();
const codeOf = (g) => encodeCompCode(filterResponses(g, ROI_SIZE, ROI_SIZE, bank, GABOR.size));

test('gaborBank: zero-mean kernels (flat skin and lighting offsets give no response)', () => {
  assert.equal(bank.length, ORIENTATIONS);
  for (const k of bank) close(k.reduce((s, v) => s + v, 0), 0, 1e-5);
  const flat = new Float32Array(ROI_SIZE * ROI_SIZE).fill(200);
  for (const v of filterResponses(flat, ROI_SIZE, ROI_SIZE, bank, GABOR.size)) close(v, 0, 1e-3);
});

test('competitive code: a dark line at angle k*30° wins orientation k', () => {
  for (let k = 0; k < ORIENTATIONS; k++) {
    const t = (k * Math.PI) / ORIENTATIONS, g = new Float32Array(ROI_SIZE * ROI_SIZE);
    for (let y = 0; y < ROI_SIZE; y++) for (let x = 0; x < ROI_SIZE; x++) {
      const d = -(x - 64) * Math.sin(t) + (y - 64) * Math.cos(t); // distance from a line through the centre at angle t
      g[y * ROI_SIZE + x] = 160 - 60 * Math.exp(-0.5 * (d / 2.5) ** 2);
    }
    const resp = filterResponses(g, ROI_SIZE, ROI_SIZE, bank, GABOR.size), c = (16 * CODE_SIDE + 16) * ORIENTATIONS;
    const cell = Array.from(resp.slice(c, c + ORIENTATIONS));
    assert.equal(cell.indexOf(Math.min(...cell)), k, `line at ${k * 30}°`);
  }
});

test('hamming: same palm ~0, noisy same palm low, different palms ~0.5', () => {
  const a = codeOf(palmImage(1));
  assert.equal(a.length, CODE_WORDS);
  assert.equal(hamming(a, a), 0);
  const same = hamming(a, codeOf(palmImage(1, { noise: 12 })));
  const other = [2, 3, 4, 5].map((s) => hamming(a, codeOf(palmImage(s))));
  assert.ok(same < 0.15, `same palm + noise: ${same}`);
  for (const d of other) assert.ok(d > 0.3, `different palm: ${d}`);
});

test('hamming: a few pixels of ROI jitter is absorbed by the shift search', () => {
  const a = codeOf(palmImage(1)), b = codeOf(palmImage(1, { shift: 4 })); // 4 px = one code cell
  assert.ok(hammingAt(a, b) > 0.15, 'unshifted comparison sees the offset');
  assert.ok(hamming(a, b, 2) < 0.08, `shift search finds it: ${hamming(a, b, 2)}`);
  close(hammingAt(a, b, -1, 0), hamming(a, b, 2), 1e-9); // b moved right one cell: a[c] lines up with b[c + 1]
});

test('hammingAt: masked-out points are not compared; all-different bits give 1', () => {
  const a = new Uint32Array(CODE_WORDS), b = new Uint32Array(CODE_WORDS);
  for (let r = 0; r < CODE_SIDE; r++) { a[3 * CODE_SIDE + r] = b[3 * CODE_SIDE + r] = 0xffffffff; for (let p = 0; p < 3; p++) b[p * CODE_SIDE + r] = 0xffffffff; }
  close(hammingAt(a, b), 1);
  for (let r = 0; r < CODE_SIDE; r++) b[3 * CODE_SIDE + r] = 0; // nothing valid
  close(hammingAt(a, b), 1);
  for (let r = 0; r < CODE_SIDE; r++) { b[3 * CODE_SIDE + r] = 0xffffffff; for (let p = 0; p < 3; p++) b[p * CODE_SIDE + r] = 0; }
  close(hammingAt(a, b), 0);
});

test('grayStats / toGray: brightness and blur measure', () => {
  const g = toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]));
  close(g[0], 255, 1e-3); close(g[1], 0);
  const sharp = grayStats(palmImage(1), ROI_SIZE, ROI_SIZE), flat = grayStats(new Float32Array(ROI_SIZE * ROI_SIZE).fill(90), ROI_SIZE, ROI_SIZE);
  assert.ok(sharp.sharpness > flat.sharpness);
  close(flat.brightness, 90);
});

// ---------- geometry + matcher ----------
const world = (k = 1) => rightPalm().map((p) => ({ x: (p.x / 5000) * k, y: (p.y / 5000) * k, z: 0 }));

test('handGeometry: scale-free; geometryDistance 0 for the same hand', () => {
  const a = handGeometry(world()), b = handGeometry(world(1.3));
  close(geometryDistance(a, b), 0, 1e-9);
  close(a.reduce((s, v) => s + v, 0), 1);
  const longFingers = world().map((p, i) => ([8, 12, 16, 20].includes(i) ? { ...p, y: p.y - 0.01 } : p));
  assert.ok(geometryDistance(a, handGeometry(longFingers)) > 0.01);
});

const sample = (seed, hand = 'Right', opts) => ({ hand, code: codeOf(palmImage(seed, opts)), geom: handGeometry(world()) });

test('PalmMatcher: right student, stranger rejected, other hand never compared', () => {
  const students = [
    { id: 1, name: 'A', palms: [sample(1), sample(1, 'Right', { noise: 10 })] },
    { id: 2, name: 'B', palms: [sample(2)] },
    { id: 3, name: 'C', palms: [sample(9, 'Left')] },
    { id: 4, name: 'NoPalm', palms: [] },
  ];
  const m = new PalmMatcher();
  const r = m.match(sample(1, 'Right', { noise: 8, shift: 2 }), students);
  assert.equal(r.reason, 'ok'); assert.equal(r.student.id, 1);
  assert.equal(m.match(sample(7), students).reason, 'too-far');
  assert.equal(m.match(sample(9, 'Right'), students).student, null, 'a left template does not match a right palm');
  assert.equal(m.match(sample(1, 'Left'), [students[0]]).reason, 'no-students');
});

test('PalmMatcher: ambiguous when two students score about the same', () => {
  const s = sample(1);
  const m = new PalmMatcher({ threshold: 0.6 });
  const r = m.match(s, [{ id: 1, name: 'A', palms: [sample(1, 'Right', { noise: 30 })] }, { id: 2, name: 'Twin', palms: [sample(1, 'Right', { noise: 31 })] }]);
  assert.equal(r.reason, 'ambiguous');
});

test('palmReport: separates genuine and impostor pairs, finds a zero-false-accept threshold', () => {
  const samples = [];
  for (const person of [1, 2, 3, 4]) for (const [session, noise] of [['d1', 6], ['d1', 10], ['d2', 14]])
    samples.push({ person: String(person), hand: 'Right', session, code: codeOf(palmImage(person, { noise: noise + person })), geom: [] });
  samples.push({ person: '1', hand: 'Left', session: 'd1', code: codeOf(palmImage(50)), geom: [] }); // other hand: ignored
  const m = new PalmMatcher();
  const rep = palmReport(samples, (a, b) => m.distance(a, b));
  assert.equal(rep.genuine, 4 * 3); assert.equal(rep.impostor, 6 * 9);
  assert.ok(rep.genuineP95 < rep.impostorMin);
  assert.equal(rep.garAtZeroFar, 1); assert.equal(rep.eer, 0);
  assert.equal(palmReport(samples, (a, b) => m.distance(a, b), { crossSession: true }).genuine, 4 * 2);
});

test('simulate1N: kiosk replay counts right / wrong / rejected, cross-session keeps the probe session out', () => {
  const samples = [];
  for (const person of [1, 2, 3]) for (const [session, noise] of [['d1', 6], ['d2', 12]])
    samples.push({ person: String(person), hand: 'Right', session, code: codeOf(palmImage(person, { noise })), geom: [] });
  samples.push({ person: '9', hand: 'Right', session: 'd1', code: codeOf(palmImage(9)), geom: [] }); // only one sample: skipped as a probe
  const m = new PalmMatcher();
  const r = simulate1N(samples, m, { crossSession: true });
  assert.equal(r.probes, 6); assert.equal(r.correct, 6); assert.equal(r.wrong.length, 0);
  // A matcher that accepts anything shows up as wrong matches, not silently as correct.
  const loose = Object.assign(new PalmMatcher({ threshold: 1, gap: 0, ratio: 1 }), { distance: () => Math.random() });
  const bad = simulate1N(samples, loose);
  assert.equal(bad.correct + bad.rejected + bad.wrong.length, bad.probes);
  assert.ok(bad.wrong.length > 0);
});

test('code serialisation round-trips', () => {
  const c = codeOf(palmImage(3));
  assert.deepEqual(codeFromBase64(codeToBase64(c)), c);
});

// ---------- phase 1: fusion, tracking, liveness, enrolment ----------
const A = { id: 1, name: 'A', palms: [sample(1), sample(1, 'Right', { noise: 10 })] };
const B = { id: 2, name: 'B', palms: [sample(2), sample(2, 'Right', { noise: 10 })] };
const roster = [A, B];
const obs = (seed, { hand = 'Right', noise = 8, pts = rightPalm() } = {}) => ({ box: { x: 400, y: 250, width: 250, height: 350 }, pts, hand, roi: palmRoi(pts), code: codeOf(palmImage(seed, { noise })), geom: [] });

test('fuseScores: per-student mean over frames; a student missing from any frame is dropped', () => {
  const f = fuseScores([new Map([[A, 0.3], [B, 0.5]]), new Map([[A, 0.4]])]);
  assert.equal(f.size, 1); close(f.get(A), 0.35);
  assert.equal(fuseScores([]).size, 0);
});

test('PalmMatcher: match() = decide(scores()), students without that hand are not scored', () => {
  const m = new PalmMatcher(), s = sample(1, 'Right', { noise: 6 });
  const sc = m.scores(s, [...roster, { id: 3, name: 'LeftOnly', palms: [sample(5, 'Left')] }]);
  assert.equal(sc.size, 2);
  assert.deepEqual(m.decide(sc), m.match(s, roster));
});

test('PalmTrack: confirms after 2 fused frames, once per student', () => {
  const m = new PalmMatcher(), t = new PalmTrack(1, obs(1).box, 0);
  t.observe(obs(1, { noise: 9 }), true, 0, m, roster);
  const one = t.decide(m, { fastDist: 0 }); // fast path off
  assert.equal(one.match.student?.id, 1); assert.equal(one.confirmed, false, 'one frame is not enough');
  t.observe(obs(1, { noise: 11 }), true, 30, m, roster);
  const two = t.decide(m);
  assert.equal(two.confirmed, true); assert.equal(two.frames, 2);
  t.handled = 1;
  assert.equal(t.decide(m).confirmed, false, 'not confirmed twice while the hand stays');
});

test('PalmTrack: a very close single frame takes the fast path; bad frames are not fused', () => {
  const m = new PalmMatcher(), t = new PalmTrack(1, obs(1).box, 0);
  t.observe(obs(1, { noise: 0 }), false, 0, m, roster);
  assert.equal(t.decide(m).frames, 0);
  t.observe(obs(1, { noise: 0 }), true, 0, m, roster);
  const d = t.decide(m, { fastDist: 0.25 });
  assert.ok(d.match.distance <= 0.25, `distance ${d.match.distance}`);
  assert.equal(d.confirmed, true);
});

test('PalmTrack: starts over when the other hand or a different palm shows up in the same spot', () => {
  const m = new PalmMatcher(), t = new PalmTrack(1, obs(1).box, 0);
  t.observe(obs(1), true, 0, m, roster); t.observe(obs(1, { noise: 12 }), true, 30, m, roster);
  assert.equal(t.frames.length, 2);
  t.observe(obs(2), true, 60, m, roster);
  assert.equal(t.frames.length, 1, 'different palm: reset');
  const d = t.decide(m, { fastDist: 0 });
  assert.equal(d.match.student?.id, 2, 'scored on B alone, not blended with the A frames');
  assert.equal(d.confirmed, false, 'one frame is not enough');
  t.observe(obs(2, { hand: 'Left', pts: mirrorX(rightPalm()) }), true, 90, m, roster);
  assert.equal(t.frames.length, 1); assert.equal(t.hand, 'Left');
  assert.equal(t.decide(m).match.reason, 'no-students', 'nobody has a left template');
});

test('PalmTrack: liveness gate when required', () => {
  const m = new PalmMatcher(), t = new PalmTrack(1, obs(1).box, 0);
  for (let i = 0; i < 3; i++) t.observe(obs(1, { noise: 8 + i }), true, i * 30, m, roster);
  const d = t.decide(m, { requireLiveness: true });
  assert.equal(d.confirmed, false); assert.equal(d.waitingForLiveness, true);
});

test('FaceTracker is generic: follows hands as PalmTracks by box overlap', () => {
  const tr = new FaceTracker({ create: (id, box, now) => new PalmTrack(id, box, now) });
  const a = tr.assign([{ box: { x: 0, y: 0, width: 100, height: 100 } }], 0)[0].track;
  const b = tr.assign([{ box: { x: 5, y: 5, width: 100, height: 100 } }], 30)[0].track;
  assert.ok(a instanceof PalmTrack); assert.equal(a, b);
  const c = tr.assign([{ box: { x: 500, y: 500, width: 100, height: 100 } }], 60)[0].track;
  assert.notEqual(c, a);
});

/** Rigid move of the whole hand (what a waved photo does): rotate, scale and shift every landmark together. */
const rigid = (pts, a, k, dx) => pts.map((p) => ({ x: 500 + ((p.x - 500) * Math.cos(a) - (p.y - 600) * Math.sin(a)) * k + dx, y: 600 + ((p.x - 500) * Math.sin(a) + (p.y - 600) * Math.cos(a)) * k, z: 0 }));

test('PalmLiveness: a rigid (photo-like) hand never passes; flexing fingers passes', () => {
  const photo = new PalmLiveness();
  for (let i = 0; i < 30; i++) { const p = rigid(rightPalm(), Math.sin(i / 3) * 0.4, 1 + 0.2 * Math.sin(i / 5), 40 * Math.sin(i / 4)); photo.observe(p, palmRoi(p), 'Right', i * 33); }
  assert.equal(photo.passed, false, `travel ${photo.travel}`);
  const live = new PalmLiveness();
  for (let i = 0; i < 30; i++) {
    const p = rightPalm().map((q, j) => ([8, 12].includes(j) ? { ...q, x: q.x + 18 * Math.sin(i / 4) } : q));
    live.observe(p, palmRoi(p), 'Right', i * 33);
  }
  assert.equal(live.passed, true, `travel ${live.travel}`);
  const tips = palmFrameTips(rightPalm(), palmRoi(rightPalm())), tips2 = palmFrameTips(rigid(rightPalm(), 0.5, 1.4, 90), palmRoi(rigid(rightPalm(), 0.5, 1.4, 90)));
  tips.forEach((t, i) => { close(t.x, tips2[i].x, 1e-9); close(t.y, tips2[i].y, 1e-9); });
});

test('PalmLiveness: the first frames of a track and a single jumpy frame do not pass', () => {
  const still = rightPalm(), jumped = rightPalm().map((q, j) => (j === 8 ? { ...q, x: q.x + 60 } : q));
  const warm = new PalmLiveness();
  warm.observe(jumped, palmRoi(jumped), 'Right', 0); // detector -> tracker switch: landmarks jump
  for (let i = 1; i < 40; i++) warm.observe(still, palmRoi(still), 'Right', i * 33);
  assert.equal(warm.passed, false, `warm-up jump ignored, travel ${warm.travel}`);
  const one = new PalmLiveness();
  for (let i = 0; i < 40; i++) { const p = i === 20 ? jumped : still; one.observe(p, palmRoi(p), 'Right', i * 33); }
  assert.equal(one.passed, false, `one outlier frame ignored, travel ${one.travel}`);
});

test('PalmLiveness: grip challenge = close then open within the time limit', () => {
  const l = new PalmLiveness({ gripTimeoutMs: 1000 }), open = rightPalm(), fist = rightPalm({ curl: true });
  l.startGrip(0);
  assert.equal(l.observe(open, palmRoi(open), 'Right', 10).grip, 'pending', 'open hand alone does not pass');
  l.observe(fist, palmRoi(fist), 'Right', 300);
  assert.equal(l.observe(open, palmRoi(open), 'Right', 600).grip, 'passed');
  assert.equal(l.gripPassed, true);
  l.startGrip(1000);
  assert.equal(l.observe(open, palmRoi(open), 'Right', 2100).grip, 'failed', 'timed out');
});

test('prunePalmOutliers / palmDuplicate: enrolment drops the odd sample and spots an already-enrolled palm', () => {
  const m = new PalmMatcher();
  const samples = [sample(1, 'Right', { noise: 4 }), sample(1, 'Right', { noise: 8 }), sample(1, 'Right', { noise: 12 }), sample(1, 'Right', { noise: 6, shift: 1 }), sample(42)];
  const kept = prunePalmOutliers(samples, m, { keep: 3 });
  assert.equal(kept.length, 4); assert.ok(!kept.includes(samples[4]));
  assert.equal(palmDuplicate(kept, roster, m)?.student.id, 1);
  assert.equal(palmDuplicate([sample(77)], roster, m), null);
});

test('simulate1N: fusing frames per probe', () => {
  const samples = [];
  for (const person of [1, 2, 3]) for (const [session, noises] of [['d1', [6, 8]], ['d2', [10, 12, 14, 16]]])
    for (const noise of noises) samples.push({ person: String(person), hand: 'Right', session, code: codeOf(palmImage(person, { noise })), geom: [] });
  const r = simulate1N(samples, new PalmMatcher(), { crossSession: true, frames: 2 });
  assert.equal(r.probes, 3 * (1 + 2)); // d1: one pair, d2: two pairs
  assert.equal(r.correct, r.probes); assert.equal(r.wrong.length, 0);
});

test('fuseDecide: guarded vote over frames', () => {
  const m = new PalmMatcher({ threshold: 0.38 });
  const f = (a, b) => new Map([[A, a], [B, b]]);
  assert.equal(fuseDecide(m, [f(0.30, 0.46), f(0.40, 0.47)]).student, A, 'one confident frame, the other near: ok');
  assert.equal(fuseDecide(m, [f(0.30, 0.46), f(0.47, 0.30)]).reason, 'ambiguous', 'frames confident about different students');
  assert.equal(fuseDecide(m, [f(0.33, 0.47), f(0.48, 0.49), f(0.48, 0.49)]).student, null, 'one lucky frame among far ones');
  assert.equal(fuseDecide(m, [f(0.41, 0.47), f(0.42, 0.47)]).reason, 'too-far', 'no frame confident on its own');
  assert.equal(fuseDecide(m, []).reason, 'no-students');
});

test('simulate1N openSet: an unenrolled person is never given a name', () => {
  const samples = [];
  for (const person of [1, 2, 3, 4]) for (const noise of [6, 9, 12]) samples.push({ person: String(person), hand: 'Right', session: 'd1', code: codeOf(palmImage(person, { noise })), geom: [] });
  const r = simulate1N(samples, new PalmMatcher(), { openSet: true });
  assert.equal(r.probes, 12); assert.equal(r.correct, 0); assert.equal(r.wrong.length, 0); assert.equal(r.rejected, 12);
});
