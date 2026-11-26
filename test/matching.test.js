import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  euclidean, cosineSimilarity, l2Normalize, distance, MatchingService, eyeAspectRatio, yawRatio,
  laplacianVariance, LivenessTracker, meanDescriptor, pruneOutliers, rollDegrees, faceQuality, SCAN_QUALITY, ENROLL_QUALITY,
  iou, FaceTrack, FaceTracker, rosterReport, TurnChallenge,
} from '../public/matching.js';

const vec = (seed, n = 128) => Array.from({ length: n }, (_, i) => Math.sin(seed * 31 + i) * 0.2);
const near = (v, eps) => v.map((x, i) => x + (i % 2 ? eps : -eps));
const close = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

test('similarity math: euclidean, cosine, l2 normalize', () => {
  close(euclidean([0, 0], [3, 4]), 5);
  close(euclidean(vec(1), vec(1)), 0);
  close(cosineSimilarity([1, 0], [1, 0]), 1);
  close(cosineSimilarity([1, 0], [0, 1]), 0);
  close(cosineSimilarity([1, 2], [-1, -2]), -1);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, 'zero vector does not produce NaN');
  close(Math.hypot(...l2Normalize([3, 4])), 1);
  assert.deepEqual(l2Normalize([0, 0]), [0, 0]);
  close(distance([1, 0], [1, 0], 'cosine'), 0);
  close(distance([1, 0], [0, 1], 'cosine'), 1);
});

const students = [
  { id: 1, name: 'A', descriptors: [vec(1), near(vec(1), 0.01)] },
  { id: 2, name: 'B', descriptors: [vec(2)] },
  { id: 3, name: 'NoFace', descriptors: [] },
];

test('MatchingService: matches the right student using any of their samples', () => {
  const m = new MatchingService({ threshold: 0.5 });
  const r = m.match(near(vec(1), 0.02), students);
  assert.equal(r.reason, 'ok');
  assert.equal(r.student.id, 1);
  assert.ok(r.distance < r.runnerUp);
});

test('MatchingService: stranger is rejected (too far)', () => {
  const r = new MatchingService({ threshold: 0.5 }).match(vec(99), students);
  assert.equal(r.student, null);
  assert.equal(r.reason, 'too-far');
});

test('MatchingService: threshold is configurable and strict is stricter', () => {
  const probe = near(vec(1), 0.1); // distance ~1.13 from student 1
  const d = new MatchingService().score(probe, students[0]); // mean of the student's 2 nearest samples
  assert.equal(new MatchingService({ threshold: d + 0.1, gap: 0, ratio: 1 }).match(probe, students).student?.id, 1);
  assert.equal(new MatchingService({ threshold: d - 0.1, gap: 0, ratio: 1 }).match(probe, students).reason, 'too-far');
});

test('MatchingService: look-alikes are "ambiguous", not guessed', () => {
  const twins = [{ id: 1, name: 'T1', descriptors: [vec(5)] }, { id: 2, name: 'T2', descriptors: [near(vec(5), 0.002)] }];
  const r = new MatchingService({ threshold: 0.9, gap: 0.04 }).match(near(vec(5), 0.001), twins);
  assert.equal(r.student, null);
  assert.equal(r.reason, 'ambiguous');
});

test('MatchingService: one student alone has no runner-up; empty roster and face-less students are skipped', () => {
  const m = new MatchingService();
  assert.equal(m.match(vec(2), [students[1]]).student?.id, 2);
  assert.equal(m.match(vec(2), []).reason, 'no-students');
  assert.equal(m.match(vec(2), [students[2]]).reason, 'no-students');
});

test('MatchingService: cosine metric works with the same API', () => {
  const m = new MatchingService({ metric: 'cosine', threshold: 0.1 });
  assert.equal(m.match(vec(2), students).student?.id, 2);
  assert.equal(m.match(vec(77), students).student, null);
});

// ----- geometry -----
const eye = (open) => [{ x: 0, y: 0 }, { x: 1, y: -open }, { x: 2, y: -open }, { x: 3, y: 0 }, { x: 2, y: open }, { x: 1, y: open }];
test('eye aspect ratio drops when the eye closes', () => {
  assert.ok(eyeAspectRatio(eye(0.5)) > 0.3);
  assert.ok(eyeAspectRatio(eye(0.05)) < 0.1);
});

test('yaw ratio is ~0 frontal and grows with a head turn', () => {
  const face = (noseX) => Array.from({ length: 68 }, (_, i) => (i === 0 ? { x: 0, y: 0 } : i === 16 ? { x: 100, y: 0 } : i === 30 ? { x: noseX, y: 40 } : { x: 50, y: 50 }));
  close(yawRatio(face(50)), 0, 1e-9);
  assert.ok(Math.abs(yawRatio(face(75))) > 0.2);
  assert.ok(Math.sign(yawRatio(face(25))) !== Math.sign(yawRatio(face(75))));
});

test('laplacian variance: sharp edges score high, flat/smooth images score low', () => {
  const n = 32;
  const checker = Float32Array.from({ length: n * n }, (_, i) => (((i % n) + Math.floor(i / n)) % 2 ? 255 : 0));
  const flat = new Float32Array(n * n).fill(120);
  const gradient = Float32Array.from({ length: n * n }, (_, i) => (i % n) * 4);
  assert.ok(laplacianVariance(checker, n, n) > 1000);
  assert.equal(laplacianVariance(flat, n, n), 0);
  assert.ok(laplacianVariance(gradient, n, n) < 1);
});

// ----- liveness -----
test('liveness: a still face (a held-up photo) never passes', () => {
  const l = new LivenessTracker();
  let r;
  for (let t = 0; t < 4000; t += 100) r = l.observe(0.3 + (t % 200 ? 0.003 : -0.003), 0.01, t);
  assert.equal(r.passed, false);
});

test('liveness: a blink passes', () => {
  const l = new LivenessTracker();
  let r;
  [0.3, 0.3, 0.3, 0.1, 0.1, 0.3, 0.3].forEach((ear, i) => { r = l.observe(ear, 0, i * 100); });
  assert.deepEqual([r.blink, r.passed], [true, true]);
});

test('liveness: a head turn passes', () => {
  const l = new LivenessTracker();
  let r;
  [0, 0.05, 0.12, 0.2, 0.25].forEach((yaw, i) => { r = l.observe(0.3, yaw, i * 100); });
  assert.deepEqual([r.turn, r.passed], [true, true]);
});

test('liveness: evidence expires outside the window and passed latches until reset', () => {
  const l = new LivenessTracker({ windowMs: 1000 });
  l.observe(0.3, -0.15, 0); l.observe(0.3, 0.15, 100);
  assert.equal(l.passed, true);
  const r = l.observe(0.3, 0, 5000);
  assert.equal(r.turn, false, 'old samples dropped');
  assert.equal(r.passed, true, 'latched');
  l.reset();
  assert.equal(l.passed, false);
});

test('MatchingService: score is the mean of the k nearest samples, so one stray sample cannot attract a stranger', () => {
  const stray = vec(42);
  const s = { id: 1, name: 'A', descriptors: [vec(1), near(vec(1), 0.005), stray] };
  const m = new MatchingService({ threshold: 0.5, k: 2 });
  assert.equal(m.match(near(stray, 0.001), [s]).reason, 'too-far', 'k=2: matching only the stray sample is not enough');
  assert.equal(new MatchingService({ threshold: 0.5, k: 1 }).match(near(stray, 0.001), [s]).reason, 'ok', 'k=1 (old min rule) would accept');
  assert.equal(m.match(near(vec(1), 0.002), [s]).student?.id, 1);
});

test('MatchingService: ratio test refuses a best match that is not clearly better than the runner-up', () => {
  const a = { id: 1, name: 'A', descriptors: [vec(1)] }, b = { id: 2, name: 'B', descriptors: [near(vec(1), 0.04)] };
  const probe = near(vec(1), 0.015); // ~0.17 from A, ~0.28 from B: gap 0.11 passes, ratio 0.6 passes
  assert.equal(new MatchingService({ threshold: 0.5, ratio: 0.8 }).match(probe, [a, b]).student?.id, 1);
  assert.equal(new MatchingService({ threshold: 0.5, ratio: 0.5 }).match(probe, [a, b]).reason, 'ambiguous');
});

test('shouldAdapt: learn only clear, non-duplicate matches', () => {
  const m = new MatchingService();
  assert.equal(m.shouldAdapt({ student: students[0], reason: 'ok', distance: 0.25, runnerUp: 0.7 }), true);
  assert.equal(m.shouldAdapt({ student: students[0], reason: 'ok', distance: 0.05, runnerUp: 0.7 }), false, 'already covered');
  assert.equal(m.shouldAdapt({ student: students[0], reason: 'ok', distance: 0.42, runnerUp: 0.9 }), false, 'too far');
  assert.equal(m.shouldAdapt({ student: students[0], reason: 'ok', distance: 0.25, runnerUp: 0.33 }), false, 'runner-up too close');
  assert.equal(m.shouldAdapt({ student: null, reason: 'ambiguous', distance: 0.25, runnerUp: 0.7 }), false);
});

test('meanDescriptor and pruneOutliers drop a bad enrolment sample but keep the minimum', () => {
  assert.deepEqual(meanDescriptor([[0, 2], [2, 4]]), [1, 3]);
  const good = [vec(1), near(vec(1), 0.004), near(vec(1), -0.004), near(vec(1), 0.002)];
  const kept = pruneOutliers([...good, vec(9)], { maxDist: 0.4, keep: 3 });
  assert.equal(kept.length, 4);
  assert.ok(kept.every((k) => good.includes(k)), 'the outlier is the one dropped');
  assert.equal(pruneOutliers([vec(1), vec(2), vec(3), vec(4)], { maxDist: 0.01, keep: 3 }).length, 3);
});

test('rosterReport: flags look-alike students and suggests a threshold below them', () => {
  const r = rosterReport([
    { id: 1, name: 'A', descriptors: [vec(1), near(vec(1), 0.005), near(vec(1), -0.005)] },
    { id: 2, name: 'A-twin', descriptors: [near(vec(1), 0.04), near(vec(1), 0.042)] },
    { id: 3, name: 'C', descriptors: [vec(3), near(vec(3), 0.005)] },
  ], new MatchingService({ threshold: 0.5 }));
  assert.equal(r.lookAlikes[0].a.name, 'A'); assert.equal(r.lookAlikes[0].b.name, 'A-twin');
  assert.ok(r.suggested < r.impostorMin);
  assert.ok(r.genuineP95 < 0.1);
});

// ----- quality -----
test('roll angle from eye centres', () => {
  const pts = (dy) => Array.from({ length: 68 }, (_, i) => (i >= 36 && i < 42 ? { x: 30, y: 50 } : i >= 42 && i < 48 ? { x: 70, y: 50 + dy } : { x: 0, y: 0 }));
  close(rollDegrees(pts(0)), 0);
  close(rollDegrees(pts(40)), 45);
});

test('faceQuality: scan is lenient, enrolment is strict, and the hint says what to fix', () => {
  const ok = { score: 0.8, roll: 3, yaw: 0.05, faceRatio: 0.3, sharpness: 60, brightness: 120 };
  assert.equal(faceQuality(ok, SCAN_QUALITY).ok, true);
  assert.equal(faceQuality(ok, ENROLL_QUALITY).ok, true);
  const tilted = { ...ok, roll: 15 };
  assert.equal(faceQuality(tilted, SCAN_QUALITY).ok, true);
  assert.deepEqual(faceQuality(tilted, ENROLL_QUALITY), { ok: false, reason: 'roll', hint: 'Keep your head straight' });
  assert.equal(faceQuality({ ...ok, brightness: 20 }, SCAN_QUALITY).reason, 'dark');
  assert.equal(faceQuality({ ...ok, sharpness: 5 }, SCAN_QUALITY).reason, 'blur');
  assert.equal(faceQuality({ ...ok, faceRatio: 0.15 }, ENROLL_QUALITY).reason, 'small');
});

// ----- tracking + fusion -----
const box = (x, w = 100) => ({ x, y: 0, width: w, height: w });
const fface = (x, d, ear = 0.3, yaw = 0) => ({ box: box(x), descriptor: d, ear, yaw });
const roster = [{ id: 1, name: 'A', descriptors: [vec(1)] }, { id: 2, name: 'B', descriptors: [vec(2)] }];

test('iou', () => {
  close(iou(box(0), box(0)), 1);
  assert.equal(iou(box(0), box(200)), 0);
  close(iou(box(0), box(50)), 5000 / 15000);
});

test('tracker: the same face keeps its track as it moves; two faces get two tracks; old tracks expire', () => {
  const tr = new FaceTracker({ maxAgeMs: 1000 });
  const [a1] = tr.assign([fface(0, vec(1))], 0);
  const [a2] = tr.assign([fface(10, vec(1))], 100);
  assert.equal(a1.track, a2.track);
  const both = tr.assign([fface(400, vec(2)), fface(20, vec(1))], 200);
  assert.equal(both[1].track, a1.track);
  assert.notEqual(both[0].track, a1.track);
  assert.equal(tr.active(1100), true);
  assert.equal(tr.active(1300), false);
  assert.notEqual(tr.assign([fface(20, vec(1))], 1300)[0].track, a1.track, 'expired -> new track');
});

test('track: decides on the fused descriptor after 3 good frames; low-quality frames do not count', () => {
  const t = new FaceTrack(1, box(0), 0);
  const m = new MatchingService();
  const opts = { requireLiveness: false, fastFrames: 99 };
  t.observe(fface(0, near(vec(1), 0.02)), true, 0);
  t.observe(fface(0, vec(7)), false, 50); // blurry frame: ignored for identity
  t.observe(fface(0, near(vec(1), -0.02)), true, 100);
  assert.equal(t.decide(m, roster, opts).confirmed, false);
  t.observe(fface(0, near(vec(1), 0.01)), true, 200);
  const r = t.decide(m, roster, opts);
  assert.equal(r.confirmed, true); assert.equal(r.match.student.id, 1); assert.equal(r.frames, 3);
  assert.ok(r.match.distance < 0.1, 'noise of opposite frames cancels out in the mean');
});

test('track: a very close match confirms after 2 frames (fast path)', () => {
  const t = new FaceTrack(1, box(0), 0);
  t.observe(fface(0, near(vec(1), 0.005)), true, 0);
  t.observe(fface(0, near(vec(1), 0.005)), true, 100);
  assert.equal(t.decide(new MatchingService(), roster, { requireLiveness: false }).confirmed, true);
});

test('track: liveness required — a still face waits, a blink on the same track completes it', () => {
  const t = new FaceTrack(1, box(0), 0);
  const m = new MatchingService();
  for (let i = 0; i < 3; i++) t.observe(fface(0, vec(1)), true, i * 100);
  const r = t.decide(m, roster);
  assert.deepEqual([r.confirmed, r.waitingForLiveness], [false, true]);
  t.observe(fface(0, vec(1), 0.1), false, 300); // eyes closed: bad for identity, still counts for liveness
  t.observe(fface(0, vec(1)), true, 400);
  assert.equal(t.decide(m, roster).confirmed, true);
});

test('track: a different person in the same spot restarts the evidence; a handled student is not confirmed again', () => {
  const t = new FaceTrack(1, box(0), 0);
  const m = new MatchingService();
  for (let i = 0; i < 3; i++) t.observe(fface(0, vec(1)), true, i * 100);
  t.observe(fface(0, vec(2)), true, 300);
  assert.equal(t.samples.length, 1, 'no blending of two faces');
  for (let i = 4; i < 6; i++) t.observe(fface(0, vec(2)), true, i * 100);
  t.handled = 2;
  assert.equal(t.decide(m, roster, { requireLiveness: false }).confirmed, false);
});

// ----- active liveness: turn on cue -----
test('turn challenge: the cued direction passes, the wrong way fails at once, no movement times out', () => {
  // yaw > 0 = the student turned to their left
  const left = new TurnChallenge('left', 0.3, 0); // baseline need not be 0 (the yaw proxy has a per-face bias)
  assert.equal(left.observe(0.35, 100), 'pending');
  assert.equal(left.observe(0.43, 200), 'passed');
  assert.equal(new TurnChallenge('left', 0.3, 0).observe(0.15, 100), 'failed', 'turned right instead');
  assert.equal(new TurnChallenge('right', 0, 0).observe(-0.13, 100), 'passed');
  const still = new TurnChallenge('right', 0, 0, { timeoutMs: 1000 });
  assert.equal(still.observe(0.01, 900), 'pending');
  assert.equal(still.observe(0.01, 1100), 'failed');
});

test('track: with a challenge required, passive liveness is not enough; the cued turn on the same face confirms', () => {
  const t = new FaceTrack(1, box(0), 0);
  const m = new MatchingService();
  const opts = { requireChallenge: true };
  for (let i = 0; i < 3; i++) t.observe(fface(0, vec(1), i === 1 ? 0.1 : 0.3), true, i * 100); // includes a blink
  let r = t.decide(m, roster, opts);
  assert.deepEqual([r.confirmed, r.waitingForChallenge], [false, true]);
  t.startChallenge('right', 0, 300);
  t.observe(fface(0, vec(1), 0.3, 0.15), false, 400); // turned left: wrong way
  assert.deepEqual([t.challenge, t.challengeFails], [null, 1]);
  t.startChallenge('right', 0, 500);
  t.observe(fface(0, vec(1), 0.3, -0.15), false, 600);
  r = t.decide(m, roster, opts);
  assert.equal(r.confirmed, true);
});
