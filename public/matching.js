// @ts-check
// Pure, DOM-free logic: matching, liveness and quality math. Unit-tested in test/matching.test.js.
// Kept free of browser APIs so it can move unchanged into the React Native app later.

/** @typedef {{x: number, y: number}} Point */
/** @typedef {{id: number, name: string, descriptors: number[][]}} Enrolled */
/** @typedef {'euclidean' | 'cosine'} Metric */

/** @param {number[] | Float32Array} a @param {number[] | Float32Array} b */
export function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** @param {number[]} v */
export function l2Normalize(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v.slice() : v.map((x) => x / n);
}

/** Lower is always "more similar", whatever the metric, so one threshold semantic fits both.
 *  @param {number[] | Float32Array} a @param {number[] | Float32Array} b @param {Metric} [metric] */
export const distance = (a, b, metric = 'euclidean') => (metric === 'cosine' ? 1 - cosineSimilarity(a, b) : euclidean(a, b));

/**
 * @typedef {{student: Enrolled | null, distance: number, runnerUp: number, reason: 'ok' | 'no-students' | 'too-far' | 'ambiguous'}} MatchResult
 */
export class MatchingService {
  /** @param {{threshold?: number, gap?: number, metric?: Metric}} [opts]
   *  threshold: max distance to accept (lower = stricter). gap: how much the best student must beat the next-best student. */
  constructor({ threshold = 0.5, gap = 0.04, metric = 'euclidean' } = {}) {
    this.threshold = threshold; this.gap = gap; this.metric = metric;
  }

  /** Favours "no match, ask the teacher" over a wrong match.
   *  @param {number[] | Float32Array} descriptor @param {Enrolled[]} students @returns {MatchResult} */
  match(descriptor, students) {
    /** @type {{student: Enrolled, d: number} | null} */
    let best = null;
    let runnerUp = Infinity;
    for (const student of students) {
      if (!student.descriptors.length) continue;
      const d = Math.min(...student.descriptors.map((x) => distance(descriptor, x, this.metric)));
      if (!best || d < best.d) { if (best) runnerUp = Math.min(runnerUp, best.d); best = { student, d }; }
      else runnerUp = Math.min(runnerUp, d);
    }
    if (!best) return { student: null, distance: Infinity, runnerUp, reason: 'no-students' };
    if (best.d > this.threshold) return { student: null, distance: best.d, runnerUp, reason: 'too-far' };
    if (runnerUp - best.d < this.gap) return { student: null, distance: best.d, runnerUp, reason: 'ambiguous' };
    return { student: best.student, distance: best.d, runnerUp, reason: 'ok' };
  }
}

// ---------- face geometry from the 68-point landmark model ----------
const d2 = (/** @type {Point} */ a, /** @type {Point} */ b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Eye aspect ratio from the 6 eye points: ~0.3 open, ~0.1 closed. @param {Point[]} p */
export const eyeAspectRatio = (p) => (d2(p[1], p[5]) + d2(p[2], p[4])) / (2 * d2(p[0], p[3]));

/** Head yaw proxy from the 68 landmarks: 0 = frontal, grows with turn (sign = direction).
 *  Compares nose-tip distance to the left and right jaw ends. @param {Point[]} pts */
export function yawRatio(pts) {
  const l = d2(pts[30], pts[0]), r = d2(pts[30], pts[16]);
  return (l - r) / (l + r);
}

/** Variance of the Laplacian of a grayscale image: low = blurry. @param {ArrayLike<number>} gray @param {number} w @param {number} h */
export function laplacianVariance(gray, w, h) {
  const vals = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    vals.push(gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i]);
  }
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
}

// ---------- liveness: a blink or a head turn ----------
/** Evidence is collected over a sliding window. A still photo gives neither a blink nor a yaw swing.
 *  NOTE: this stops a held-up photo, not a video replay. See README. */
export class LivenessTracker {
  /** @param {{windowMs?: number, closeRatio?: number, openRatio?: number, turnRange?: number}} [opts] */
  constructor({ windowMs = 4000, closeRatio = 0.7, openRatio = 0.85, turnRange = 0.12 } = {}) {
    this.windowMs = windowMs; this.closeRatio = closeRatio; this.openRatio = openRatio; this.turnRange = turnRange;
    /** @type {{ear: number, yaw: number, t: number}[]} */ this.samples = [];
    this.passed = false;
  }

  reset() { this.samples = []; this.passed = false; }

  /** @param {number} ear @param {number} yaw @param {number} now */
  observe(ear, yaw, now) {
    this.samples.push({ ear, yaw, t: now });
    while (this.samples.length && now - this.samples[0].t > this.windowMs) this.samples.shift();
    const open = Math.max(...this.samples.map((s) => s.ear));
    let closed = false, blink = false;
    for (const s of this.samples) {
      if (s.ear < open * this.closeRatio) closed = true;
      else if (closed && s.ear > open * this.openRatio) blink = true;
    }
    const yaws = this.samples.map((s) => s.yaw);
    const turn = Math.max(...yaws) - Math.min(...yaws) >= this.turnRange;
    if (blink || turn) this.passed = true;
    return { blink, turn, passed: this.passed };
  }
}

// ---------- confirmation: N consecutive matches of one student (+ liveness) ----------
export class MatchConfirmer {
  /** @param {{frames?: number, requireLiveness?: boolean, graceMs?: number, liveness?: LivenessTracker}} [opts] */
  constructor({ frames = 3, requireLiveness = true, graceMs = 1500, liveness = new LivenessTracker() } = {}) {
    this.frames = frames; this.requireLiveness = requireLiveness; this.graceMs = graceMs; this.liveness = liveness;
    this.hits = 0; this.lastSeen = -Infinity;
  }

  reset() { this.hits = 0; this.lastSeen = -Infinity; this.liveness.reset(); }

  /** Call for each frame in which this student was the matched one.
   *  @param {number} now @param {{ear: number, yaw: number}} sig */
  observe(now, { ear, yaw }) {
    if (now - this.lastSeen > this.graceMs) this.reset();
    this.hits++; this.lastSeen = now;
    const live = this.liveness.observe(ear, yaw, now);
    const confirmed = this.hits >= this.frames && (!this.requireLiveness || live.passed);
    return { hits: this.hits, liveness: live, confirmed, waitingForLiveness: this.hits >= this.frames && !live.passed && this.requireLiveness };
  }

  /** Call for each frame in which this student was NOT matched: breaks the consecutive streak. @param {number} now */
  miss(now) {
    this.hits = 0;
    if (now - this.lastSeen > this.graceMs) this.liveness.reset();
  }

  /** @param {number} now */
  idle(now) { return now - this.lastSeen > this.graceMs * 2; }
}
