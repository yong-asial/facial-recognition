import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  euclidean, cosineSimilarity, l2Normalize, distance, MatchingService, eyeAspectRatio, yawRatio,
  laplacianVariance, LivenessTracker, MatchConfirmer,
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
  const d = Math.min(...students[0].descriptors.map((x) => euclidean(probe, x))); // best of the student's samples
  assert.equal(new MatchingService({ threshold: d + 0.1, gap: 0 }).match(probe, students).student?.id, 1);
  assert.equal(new MatchingService({ threshold: d - 0.1, gap: 0 }).match(probe, students).reason, 'too-far');
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

// ----- confirmation -----
const still = { ear: 0.3, yaw: 0 };
test('confirmer: needs 3 consecutive matches', () => {
  const c = new MatchConfirmer({ requireLiveness: false });
  assert.equal(c.observe(0, still).confirmed, false);
  assert.equal(c.observe(100, still).confirmed, false);
  assert.equal(c.observe(200, still).confirmed, true);
});

test('confirmer: a missed frame breaks the streak', () => {
  const c = new MatchConfirmer({ requireLiveness: false });
  c.observe(0, still); c.observe(100, still); c.miss(200);
  assert.equal(c.observe(300, still).confirmed, false);
  c.observe(400, still);
  assert.equal(c.observe(500, still).confirmed, true);
});

test('confirmer: with liveness required, 3 matches of a still face are not enough; a blink completes it', () => {
  const c = new MatchConfirmer();
  c.observe(0, still); c.observe(100, still);
  const r = c.observe(200, still);
  assert.equal(r.confirmed, false);
  assert.equal(r.waitingForLiveness, true);
  c.observe(300, { ear: 0.1, yaw: 0 });
  assert.equal(c.observe(400, still).confirmed, true);
});

test('confirmer: state resets after the grace period (person walked away)', () => {
  const c = new MatchConfirmer({ requireLiveness: false, graceMs: 500 });
  c.observe(0, still); c.observe(100, still);
  assert.equal(c.observe(5000, still).hits, 1);
});
