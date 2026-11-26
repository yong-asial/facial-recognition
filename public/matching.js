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

/** Element-wise mean (template fusion). dlib descriptors all have a similar norm (~1.45), so a plain mean keeps the scale.
 *  @param {ArrayLike<number>[]} vs @returns {number[]} */
export function meanDescriptor(vs) {
  const out = new Array(vs[0].length).fill(0);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] += v[i] / vs.length;
  return out;
}

/** Drop enrolment samples far from the others (a blink, a half-turned face, someone walking past).
 *  Distances are measured from the medoid (the sample closest to all others), which an outlier can't drag
 *  the way it drags a mean. Keeps at least `keep` samples, the most central ones. @param {number[][]} samples */
export function pruneOutliers(samples, { maxDist = 0.4, keep = 3, metric = /** @type {Metric} */ ('euclidean') } = {}) {
  if (samples.length <= keep) return samples.slice();
  const total = samples.map((a) => samples.reduce((sum, b) => sum + distance(a, b, metric), 0));
  const medoid = samples[total.indexOf(Math.min(...total))];
  const ranked = samples.map((s) => ({ s, d: distance(s, medoid, metric) })).sort((a, b) => a.d - b.d);
  return ranked.filter((r, i) => i < keep || r.d <= maxDist).map((r) => r.s);
}

/**
 * @typedef {{student: Enrolled | null, distance: number, runnerUp: number, reason: 'ok' | 'no-students' | 'too-far' | 'ambiguous'}} MatchResult
 */
export class MatchingService {
  /** @param {{threshold?: number, gap?: number, ratio?: number, k?: number, metric?: Metric}} [opts]
   *  threshold: max distance to accept (lower = stricter).
   *  gap / ratio: the best student must beat the next-best by `gap` absolute AND best/next <= `ratio`
   *  (a fixed gap alone is too loose near the threshold).
   *  k: a student's score is the mean of their k nearest samples, so one stray sample can't attract strangers
   *  (face-api's own FaceMatcher uses the mean of all samples). */
  constructor({ threshold = 0.5, gap = 0.04, ratio = 0.8, k = 2, metric = 'euclidean' } = {}) {
    this.threshold = threshold; this.gap = gap; this.ratio = ratio; this.k = k; this.metric = metric;
  }

  /** @param {number[] | Float32Array} descriptor @param {Enrolled} student */
  score(descriptor, student) {
    const ds = student.descriptors.map((x) => distance(descriptor, x, this.metric)).sort((a, b) => a - b).slice(0, this.k);
    return ds.reduce((s, d) => s + d, 0) / ds.length;
  }

  /** Favours "no match, ask the teacher" over a wrong match.
   *  @param {number[] | Float32Array} descriptor @param {Enrolled[]} students @returns {MatchResult} */
  match(descriptor, students) {
    /** @type {{student: Enrolled, d: number} | null} */
    let best = null;
    let runnerUp = Infinity;
    for (const student of students) {
      if (!student.descriptors.length) continue;
      const d = this.score(descriptor, student);
      if (!best || d < best.d) { if (best) runnerUp = Math.min(runnerUp, best.d); best = { student, d }; }
      else runnerUp = Math.min(runnerUp, d);
    }
    if (!best) return { student: null, distance: Infinity, runnerUp, reason: 'no-students' };
    if (best.d > this.threshold) return { student: null, distance: best.d, runnerUp, reason: 'too-far' };
    if (runnerUp - best.d < this.gap || best.d / runnerUp > this.ratio) return { student: null, distance: best.d, runnerUp, reason: 'ambiguous' };
    return { student: best.student, distance: best.d, runnerUp, reason: 'ok' };
  }

  /** Face ID-style template update: only learn from a match that is clearly right but not already a duplicate.
   *  @param {MatchResult} m */
  shouldAdapt(m, { maxDist = 0.35, minDist = 0.15, margin = 0.15 } = {}) {
    return m.reason === 'ok' && m.distance <= Math.min(maxDist, this.threshold) && m.distance >= minDist && m.runnerUp - m.distance >= margin;
  }
}

/** Roster self-check (leave-one-out): how far each student's samples are from their own template,
 *  and how close different students are to each other. Used to pick a threshold for this class.
 *  @param {Enrolled[]} students @param {MatchingService} matcher */
export function rosterReport(students, matcher) {
  const enrolled = students.filter((s) => s.descriptors.length);
  /** @type {number[]} */ const genuine = [];
  for (const s of enrolled) {
    if (s.descriptors.length < 2) continue;
    s.descriptors.forEach((d, i) => genuine.push(matcher.score(d, { ...s, descriptors: s.descriptors.filter((_, j) => j !== i) })));
  }
  /** @type {{a: Enrolled, b: Enrolled, d: number}[]} */ const pairs = [];
  for (let i = 0; i < enrolled.length; i++) for (let j = i + 1; j < enrolled.length; j++) {
    const a = enrolled[i], b = enrolled[j];
    pairs.push({ a, b, d: Math.min(...a.descriptors.map((x) => matcher.score(x, b))) });
  }
  pairs.sort((x, y) => x.d - y.d);
  genuine.sort((x, y) => x - y);
  const genuineP95 = genuine.length ? genuine[Math.min(genuine.length - 1, Math.floor(genuine.length * 0.95))] : NaN;
  const impostorMin = pairs.length ? pairs[0].d : NaN;
  // Stay below the closest pair of different students with a safety margin, but above most genuine scores.
  let suggested = Number.isFinite(impostorMin) ? Math.min(0.55, impostorMin - 0.08) : 0.5;
  if (Number.isFinite(genuineP95)) suggested = Math.max(suggested, Math.min(genuineP95 + 0.05, 0.55));
  return {
    genuineP95, impostorMin, suggested: Math.round(suggested * 100) / 100,
    lookAlikes: pairs.filter((p) => p.d < matcher.threshold + 0.1).slice(0, 5),
    overlap: Number.isFinite(genuineP95) && Number.isFinite(impostorMin) && genuineP95 >= impostorMin - 0.05,
  };
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

/** Head tilt (roll) in degrees from the eye centres; 0 = level. face-api does not rotate the face upright
 *  before the embedding (dlib does), so a tilted head gives a worse descriptor. @param {Point[]} pts */
export function rollDegrees(pts) {
  const c = (/** @type {number} */ from) => {
    const e = pts.slice(from, from + 6);
    return { x: e.reduce((s, p) => s + p.x, 0) / 6, y: e.reduce((s, p) => s + p.y, 0) / 6 };
  };
  const l = c(36), r = c(42);
  return (Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI;
}

/** @typedef {{score: number, roll: number, yaw: number, faceRatio: number, sharpness: number, brightness: number}} FaceSignals */
/** @typedef {{minScore: number, maxRoll: number, maxYaw: number, minFaceRatio: number, minSharpness: number, minBrightness: number, maxBrightness: number}} QualityLimits */

/** Scan: lenient. Only throw away frames that would give a clearly bad descriptor; the next frame is ~100 ms away. */
// roll here is what is left after FaceService straightens the head, so it only trips when levelling failed.
// TinyFaceDetector scores are low even for clear faces (0.55-0.9 on our fixtures) and the yaw proxy reads ~0.3 on
// near-frontal photos, so those limits are loose.
export const SCAN_QUALITY = /** @type {QualityLimits} */ ({ minScore: 0.5, maxRoll: 15, maxYaw: 0.5, minFaceRatio: 0.12, minSharpness: 12, minBrightness: 35, maxBrightness: 235 });
/** Enrolment: strict (ISO/IEC 29794-5 style: pose, size, sharpness, illumination). A bad template hurts every later scan. */
/** Enrolment score is from the SSD verifier (FaceService.verify), which scores clear faces 0.93-1.00. */
export const ENROLL_QUALITY = /** @type {QualityLimits} */ ({ minScore: 0.8, maxRoll: 8, maxYaw: 0.4, minFaceRatio: 0.22, minSharpness: 25, minBrightness: 60, maxBrightness: 210 });

/** Face image quality gate. Returns the first problem with a short instruction for the student.
 *  @param {FaceSignals} f @param {QualityLimits} q @returns {{ok: true} | {ok: false, reason: string, hint: string}} */
export function faceQuality(f, q) {
  if (f.faceRatio < q.minFaceRatio) return { ok: false, reason: 'small', hint: 'Move closer to the camera' };
  if (Math.abs(f.roll) > q.maxRoll) return { ok: false, reason: 'roll', hint: 'Keep your head straight' };
  if (Math.abs(f.yaw) > q.maxYaw) return { ok: false, reason: 'yaw', hint: 'Look at the camera' };
  if (f.brightness < q.minBrightness) return { ok: false, reason: 'dark', hint: 'Too dark — face the light' };
  if (f.brightness > q.maxBrightness) return { ok: false, reason: 'bright', hint: 'Too bright — avoid direct light' };
  if (f.sharpness < q.minSharpness) return { ok: false, reason: 'blur', hint: 'Hold still for a moment' };
  if (f.score < q.minScore) return { ok: false, reason: 'score', hint: 'Look at the camera' };
  return { ok: true };
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

// ---------- active liveness: turn on cue ----------
/** Challenge-response: turn the head in a random direction, on cue. A replayed video turns whichever way it was
 *  recorded, so it fails half the time per attempt, and turning the wrong way fails at once (no "wiggle both ways").
 *  yaw > 0 means the student turned to THEIR left (raw, un-mirrored frame). */
export class TurnChallenge {
  /** @param {'left' | 'right'} dir @param {number} baseline yaw when the cue was shown @param {number} now
   *  @param {{timeoutMs?: number, turn?: number}} [opts] */
  constructor(dir, baseline, now, { timeoutMs = 4000, turn = 0.12 } = {}) {
    this.dir = dir; this.baseline = baseline; this.startedAt = now; this.timeoutMs = timeoutMs; this.turn = turn;
  }

  /** @param {number} yaw @param {number} now @returns {'pending' | 'passed' | 'failed'} */
  observe(yaw, now) {
    const moved = (yaw - this.baseline) * (this.dir === 'left' ? 1 : -1);
    if (moved >= this.turn) return 'passed';
    if (moved <= -this.turn || now - this.startedAt > this.timeoutMs) return 'failed';
    return 'pending';
  }
}

// ---------- tracking + temporal fusion ----------
/** @typedef {{x: number, y: number, width: number, height: number}} Box */
/** @typedef {{box: Box, descriptor: number[], ear: number, yaw: number}} TrackedFace */

/** Intersection over union of two boxes. @param {Box} a @param {Box} b */
export function iou(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h;
  return i / (a.width * a.height + b.width * b.height - i);
}

/** One face followed across frames. Good-quality descriptors are averaged (temporal fusion: less noise than any
 *  single frame), liveness is judged on every frame of this same face, and the decision is made on the fused vector. */
export class FaceTrack {
  /** @param {number} id @param {Box} box @param {number} now
   *  @param {{window?: number, switchDist?: number, liveness?: LivenessTracker}} [opts] */
  constructor(id, box, now, { window = 5, switchDist = 0.55, liveness = new LivenessTracker() } = {}) {
    this.id = id; this.box = box; this.lastSeen = now;
    this.window = window; this.switchDist = switchDist; this.liveness = liveness;
    /** @type {number[][]} */ this.samples = [];
    /** @type {number | null} student already handled on this track (no second confirm while they stand there) */ this.handled = null;
    /** @type {TurnChallenge | null} */ this.challenge = null;
    this.challengePassed = false; this.challengeFails = 0;
    /** @type {boolean | null} picked for a spot-check (decided once per track) */ this.spot = null;
  }

  resetChallenge() { this.challenge = null; this.challengePassed = false; this.challengeFails = 0; this.spot = null; }

  reset() { this.samples = []; this.liveness.reset(); this.handled = null; this.resetChallenge(); }

  /** Show a new turn cue. @param {'left' | 'right'} dir @param {number} yaw @param {number} now */
  startChallenge(dir, yaw, now) { this.challenge = new TurnChallenge(dir, yaw, now); }

  /** @param {TrackedFace} face @param {boolean} good passed the scan quality gate @param {number} now */
  observe(face, good, now) {
    if (good) {
      // A different person stepped into the same spot: start over rather than blend two faces.
      if (this.samples.length && euclidean(face.descriptor, meanDescriptor(this.samples)) > this.switchDist) this.reset();
      this.samples.push(face.descriptor);
      if (this.samples.length > this.window) this.samples.shift();
    }
    if (this.challenge && !this.challengePassed) {
      const c = this.challenge.observe(face.yaw, now);
      if (c === 'passed') this.challengePassed = true;
      else if (c === 'failed') { this.challengeFails++; this.challenge = null; }
    }
    return this.liveness.observe(face.ear, face.yaw, now);
  }

  fused() { return this.samples.length ? meanDescriptor(this.samples) : null; }

  /** @param {MatchingService} matcher @param {Enrolled[]} students
   *  @param {{frames?: number, fastFrames?: number, fastDist?: number, requireLiveness?: boolean, requireChallenge?: boolean}} [opts]
   *  frames: good frames needed. fastFrames/fastDist: a very close match may decide earlier (throughput).
   *  requireLiveness: passive blink/turn. requireChallenge: turn on cue instead (see TurnChallenge). */
  decide(matcher, students, { frames = 3, fastFrames = 2, fastDist = 0.35, requireLiveness = true, requireChallenge = false } = {}) {
    const fused = this.fused();
    if (!fused) return { match: null, confirmed: false, waitingForLiveness: false, waitingForChallenge: false, frames: 0 };
    const match = matcher.match(fused, students);
    const n = this.samples.length;
    const enough = n >= frames || (n >= fastFrames && match.reason === 'ok' && match.distance <= fastDist);
    const ready = enough && match.reason === 'ok' && match.student?.id !== this.handled;
    if (requireChallenge) return { match, confirmed: ready && this.challengePassed, waitingForLiveness: false, waitingForChallenge: ready && !this.challengePassed, frames: n };
    const live = !requireLiveness || this.liveness.passed;
    return { match, confirmed: ready && live, waitingForLiveness: ready && !live, waitingForChallenge: false, frames: n };
  }
}

/** Assigns detections to tracks by box overlap (greedy, best IoU first); unseen tracks expire.
 *  Generic: faces by default, or anything with a box (PalmTrack in palm.js) through `create`.
 *  @template {{box: Box, lastSeen: number}} [T=FaceTrack] */
export class FaceTracker {
  /** @param {{iouMin?: number, maxAgeMs?: number, track?: () => {window?: number, switchDist?: number, liveness?: LivenessTracker},
   *   create?: (id: number, box: Box, now: number, opts: any) => T}} [opts] */
  constructor({ iouMin = 0.3, maxAgeMs = 1200, track = () => ({}), create = (id, box, now, opts) => /** @type {any} */ (new FaceTrack(id, box, now, opts)) } = {}) {
    this.iouMin = iouMin; this.maxAgeMs = maxAgeMs; this.trackOpts = track; this.create = create;
    /** @type {T[]} */ this.tracks = []; this.nextId = 1;
  }

  /** @template {{box: Box}} F @param {F[]} faces @param {number} now @returns {{face: F, track: T}[]} */
  assign(faces, now) {
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= this.maxAgeMs);
    const cand = [];
    for (let i = 0; i < faces.length; i++) for (const t of this.tracks) {
      const o = iou(faces[i].box, t.box);
      if (o >= this.iouMin) cand.push({ i, t, o });
    }
    cand.sort((a, b) => b.o - a.o);
    /** @type {Map<number, T>} */ const byFace = new Map();
    const used = new Set();
    for (const { i, t } of cand) if (!byFace.has(i) && !used.has(t)) { byFace.set(i, t); used.add(t); }
    return faces.map((face, i) => {
      let track = byFace.get(i);
      if (!track) this.tracks.push((track = this.create(this.nextId++, face.box, now, this.trackOpts())));
      track.box = face.box; track.lastSeen = now;
      return { face, track };
    });
  }

  /** Any face being followed right now (lets the scanner skip the cheap presence gate). @param {number} now */
  active(now) { return this.tracks.some((t) => now - t.lastSeen <= this.maxAgeMs); }

  clear() { this.tracks = []; }
}
