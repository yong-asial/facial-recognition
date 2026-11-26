// @ts-check
// Pure, DOM-free palm logic: ROI geometry from the 21 hand landmarks, quality gate, palmprint texture code
// (Competitive Code: a bank of oriented Gabor filters, keep the winning orientation per point), shift-tolerant
// Hamming matching, hand geometry, and a 1:N matcher with the same accept rules as the face MatchingService.
// Unit-tested in test/palm.test.js. No browser APIs, so it can move into the React Native app later.

/** @typedef {{x: number, y: number, z?: number}} Pt  pixel coordinates (z in the same scale as x) */
/** @typedef {'Left' | 'Right'} Hand  the student's own hand */

// MediaPipe hand landmark indices.
export const LM = { WRIST: 0, THUMB_MCP: 2, INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_TIP: 16, PINKY_MCP: 17, PINKY_PIP: 18, PINKY_TIP: 20 };

export const ROI_SIZE = 128;   // ROI side in pixels (the code is computed on this)
export const CODE_SIDE = 32;   // code grid side (ROI sampled every ROI_SIZE / CODE_SIDE pixels)
export const ORIENTATIONS = 6; // Gabor orientations (k * 30°)

const sub = (/** @type {Pt} */ a, /** @type {Pt} */ b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (/** @type {Pt} */ a, /** @type {Pt} */ b) => a.x * b.x + a.y * b.y;
const len = (/** @type {Pt} */ a) => Math.hypot(a.x, a.y);

// ---------- ROI ----------
/** Where on the palm the ROI sits, as fractions of the index-to-pinky knuckle distance (w).
 *  The square starts `top`·w below the knuckle line (towards the wrist) and is `side`·w wide. */
/** Default frame: the middle-finger axis (wrist 0 -> middle MCP 9), sizes in units of that length (~1.5x the knuckle
 *  width). Spreading the fingers moves the index/pinky knuckles sideways but hardly moves this axis. On the same 401
 *  11K Hands photos it beat the knuckle-line frame: EER 2.4% vs 3.3%, and same-person pairs whose finger spread differs
 *  by 35°+ matched 84% vs 48% of the time (scripts/palm-eval-11k.mjs [--roi-knuckles]). */
export const ROI_SHAPE = { anchor: /** @type {'knuckles' | 'axis'} */ ('axis'), side: 0.67, top: 0.1 };
/** Previous frame: x axis along the index-pinky knuckle line (template version 1). Kept for comparisons. */
export const ROI_KNUCKLES = { anchor: /** @type {'knuckles' | 'axis'} */ ('knuckles'), side: 1.0, top: 0.15 };
/** Bump when anything that changes the code for the same palm changes (ROI frame, filters): older templates are then
 *  ignored by the kiosk and the roster asks for a re-enrol. v1 = knuckle-line ROI, v2 = middle-finger-axis ROI. */
export const PALM_TEMPLATE_VERSION = 2;

/** @typedef {{center: Pt, u: Pt, n: Pt, side: number, corners: Pt[], transform: [number, number, number, number, number, number]}} Roi */

/** Palm ROI: y axis towards the wrist along the middle-finger axis (ROI_SHAPE), or x axis along the knuckle line
 *  (ROI_KNUCKLES, the usual contactless palmprint frame). The axis direction is picked so the crop is a rotation
 *  (never a mirror image), so the palm looks the way the camera sees it whichever hand it is.
 *  `transform` is a canvas setTransform() that draws the source frame into a ROI_SIZE square.
 *  @param {Pt[]} pts landmarks in pixels @param {number} [size] @returns {Roi} */
export function palmRoi(pts, size = ROI_SIZE, shape = ROI_SHAPE) {
  const p5 = pts[LM.INDEX_MCP], p17 = pts[LM.PINKY_MCP], p0 = pts[LM.WRIST];
  let u, n, mid, w;
  if (shape.anchor === 'axis') {
    const p9 = pts[LM.MIDDLE_MCP], axis = sub(p0, p9);
    w = len(axis) || 1; mid = p9;
    n = { x: axis.x / w, y: axis.y / w }; // towards the wrist
    u = { x: -n.y, y: n.x };
  } else {
    const knuckles = sub(p17, p5);
    w = len(knuckles) || 1;
    u = { x: knuckles.x / w, y: knuckles.y / w };
    mid = { x: (p5.x + p17.x) / 2, y: (p5.y + p17.y) / 2 };
    n = { x: -u.y, y: u.x };
    if (dot(n, sub(p0, mid)) < 0) n = { x: -n.x, y: -n.y }; // n points towards the wrist
  }
  if (u.x * n.y - u.y * n.x < 0) u = { x: -u.x, y: -u.y }; // det(u, n) = +1: a rotation, not a reflection
  const side = shape.side * w, off = (shape.top + shape.side / 2) * w;
  const center = { x: mid.x + n.x * off, y: mid.y + n.y * off };
  const k = size / side, h = size / 2;
  /** @type {[number, number, number, number, number, number]} */
  const transform = [k * u.x, k * n.x, k * u.y, k * n.y, h - k * dot(center, u), h - k * dot(center, n)];
  const corner = (/** @type {number} */ a, /** @type {number} */ b) => ({ x: center.x + (a * u.x + b * n.x) * side / 2, y: center.y + (a * u.y + b * n.y) * side / 2 });
  return { center, u, n, side, corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], transform };
}

// ---------- quality ----------
/** z of the cross product (wrist->index MCP) x (wrist->pinky MCP) in image coords (y down).
 *  Negative for a right palm facing the camera, positive for a left palm (and the other way round for the back of the hand).
 *  @param {Pt[]} pts */
export function palmSide(pts) {
  const a = sub(pts[LM.INDEX_MCP], pts[LM.WRIST]), b = sub(pts[LM.PINKY_MCP], pts[LM.WRIST]);
  return a.x * b.y - a.y * b.x;
}

/** Is the palm (not the back of the hand) towards the camera? @param {Pt[]} pts @param {Hand} hand */
export const palmFacing = (pts, hand) => (hand === 'Right' ? palmSide(pts) < 0 : palmSide(pts) > 0);

/** How flat the palm is to the camera: |z| of the palm-plane normal, 1 = facing it squarely.
 *  Uses the landmarks' relative depth (MediaPipe z, same scale as x). @param {Pt[]} pts */
export function palmFlatness(pts) {
  const o = pts[LM.WRIST], a = pts[LM.INDEX_MCP], b = pts[LM.PINKY_MCP];
  const ax = a.x - o.x, ay = a.y - o.y, az = (a.z ?? 0) - (o.z ?? 0);
  const bx = b.x - o.x, by = b.y - o.y, bz = (b.z ?? 0) - (o.z ?? 0);
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const m = Math.hypot(nx, ny, nz);
  return m === 0 ? 0 : Math.abs(nz) / m;
}

/** Fingers (index..pinky) stretched out: tip farther from the wrist than the PIP joint, by a margin. @param {Pt[]} pts */
export function fingersOpen(pts) {
  const w = pts[LM.WRIST];
  const pairs = [[LM.INDEX_PIP, LM.INDEX_TIP], [LM.MIDDLE_PIP, LM.MIDDLE_TIP], [LM.RING_PIP, LM.RING_TIP], [LM.PINKY_PIP, LM.PINKY_TIP]];
  return pairs.filter(([pip, tip]) => len(sub(pts[tip], w)) > len(sub(pts[pip], w)) * 1.1).length;
}

/** How far the fingers are spread: angle in degrees between the index (5->8) and pinky (17->20) directions.
 *  ~5-15 = fingers together, ~30-50 = relaxed gaps, 60+ = spread wide. Informational: no gate uses it.
 *  @param {Pt[]} pts */
export function fingerSpread(pts) {
  const a = sub(pts[LM.INDEX_TIP], pts[LM.INDEX_MCP]), b = sub(pts[LM.PINKY_TIP], pts[LM.PINKY_MCP]);
  const c = dot(a, b) / ((len(a) * len(b)) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** @typedef {{facing: boolean, flatness: number, open: number, side: number, inFrame: boolean, sharpness: number, brightness: number, score: number}} PalmSignals */
/** @typedef {{minFlatness: number, minOpen: number, minSide: number, minSharpness: number, minBrightness: number, maxBrightness: number, minScore: number}} PalmLimits */

// Sharpness (Laplacian variance of the 128 px ROI) mostly measures fine wrinkles, which the wavelength-14 code ignores.
// Measured on 11K Hands at 640x480 with added blur (palm-eval-11k --blur, --keep-blurry): accuracy is unchanged down to
// sharpness ~3 (blur sigma 3: 98.9% right with 3 frames, 0 wrong, 0 unenrolled named), but below ~3 (sigma 4-6) palms
// start to look alike and unenrolled people get names (3-5 of ~100). So the limit guards against false accepts, with a
// margin: 4 at scan, 5 at enrolment. The old limits (8 / 15) rejected most frames of a soft webcam for no gain.
/** Scan: lenient, a bad frame is just skipped (the next is ~30 ms away). */
export const SCAN_PALM = /** @type {PalmLimits} */ ({ minFlatness: 0.8, minOpen: 3, minSide: 96, minSharpness: 4, minBrightness: 40, maxBrightness: 235, minScore: 0.6 });
/** Enrolment: strict. A bad template hurts every later scan. */
export const ENROLL_PALM = /** @type {PalmLimits} */ ({ minFlatness: 0.9, minOpen: 4, minSide: 140, minSharpness: 5, minBrightness: 60, maxBrightness: 215, minScore: 0.8 });

/** First problem with a short instruction, like faceQuality(). @param {PalmSignals} s @param {PalmLimits} q
 *  @returns {{ok: true} | {ok: false, reason: string, hint: string}} */
export function palmQuality(s, q) {
  if (!s.facing) return { ok: false, reason: 'back', hint: 'Show the palm of your hand' };
  if (!s.inFrame) return { ok: false, reason: 'frame', hint: 'Move your hand to the middle' };
  if (s.side < q.minSide) return { ok: false, reason: 'small', hint: 'Bring your hand closer' };
  if (s.open < q.minOpen) return { ok: false, reason: 'closed', hint: 'Open your hand, fingers straight' };
  if (s.flatness < q.minFlatness) return { ok: false, reason: 'tilt', hint: 'Hold your palm flat to the camera' };
  if (s.brightness < q.minBrightness) return { ok: false, reason: 'dark', hint: 'Too dark — face the light' };
  if (s.brightness > q.maxBrightness) return { ok: false, reason: 'bright', hint: 'Too bright — avoid direct light' };
  if (s.sharpness < q.minSharpness) return { ok: false, reason: 'blur', hint: 'Not sharp — hold still, with more light on your hand' };
  if (s.score < q.minScore) return { ok: false, reason: 'score', hint: 'Show your open palm' };
  return { ok: true };
}

/** @param {Pt[]} corners @param {number} W @param {number} H */
export const insideFrame = (corners, W, H) => corners.every((c) => c.x >= 0 && c.y >= 0 && c.x <= W && c.y <= H);

/** Mean and Laplacian variance of a grayscale image (same measure as the face blur check). @param {ArrayLike<number>} g @param {number} w @param {number} h */
export function grayStats(g, w, h) {
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, v = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
    s += v; s2 += v * v; n++;
  }
  return { brightness: sum / g.length, sharpness: n ? s2 / n - (s / n) ** 2 : 0 };
}

/** RGBA pixels -> grayscale floats. @param {ArrayLike<number>} rgba */
export function toGray(rgba) {
  const g = new Float32Array(rgba.length / 4);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return g;
}

// ---------- texture: Competitive Code ----------
/** Gabor parameters for a ROI_SIZE ROI. sigmaAlong > sigmaAcross: elongated along the line to integrate along creases.
 *  Wavelength 14 (principal lines and big creases, not fine wrinkles) won the sweep on 11K Hands palm photos
 *  (60 people, scripts/palm-eval-11k.mjs): EER 2.7-4.1% vs 4.1-4.9% at 10, and better at 640x480 too, because fine
 *  wrinkles move with the hand pose while principal lines do not. */
export const GABOR = { wavelength: 14, sigmaAcross: 6.3, sigmaAlong: 9.8, size: 35 };

/** Even (cosine) Gabor kernels, zero-mean so flat skin and lighting offsets give 0. Kernel k responds most negatively
 *  to a dark line at angle k·180°/n (dark crease on lighter skin). Row-major size x size each. */
export function gaborBank(n = ORIENTATIONS, p = GABOR) {
  const r = (p.size - 1) / 2, out = [];
  for (let k = 0; k < n; k++) {
    const t = (k * Math.PI) / n, ct = Math.cos(t), st = Math.sin(t);
    const ker = new Float32Array(p.size * p.size);
    let mean = 0;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const along = x * ct + y * st, across = -x * st + y * ct; // line direction = t
      const v = Math.exp(-0.5 * ((along / p.sigmaAlong) ** 2 + (across / p.sigmaAcross) ** 2)) * Math.cos((2 * Math.PI * across) / p.wavelength);
      ker[(y + r) * p.size + (x + r)] = v; mean += v;
    }
    mean /= ker.length;
    let norm = 0;
    for (let i = 0; i < ker.length; i++) { ker[i] -= mean; norm += Math.abs(ker[i]); }
    for (let i = 0; i < ker.length; i++) ker[i] /= norm;
    out.push(ker);
  }
  return out;
}

/** Filter responses at every `stride`-th pixel (edges padded by symmetric reflection, like tf.mirrorPad 'symmetric'). Plain JS: ~10-20 ms for a 128 ROI.
 *  FaceService-style GPU path (tf.conv2d) must give the same numbers; see PalmService.
 *  @param {ArrayLike<number>} gray @param {number} w @param {number} h @param {Float32Array[]} bank @param {number} size kernel side
 *  @returns {Float32Array} responses, layout [row][col][orientation] */
export function filterResponses(gray, w, h, bank, size, stride = ROI_SIZE / CODE_SIDE) {
  const r = (size - 1) / 2, ow = Math.ceil(w / stride), oh = Math.ceil(h / stride), n = bank.length;
  const out = new Float32Array(ow * oh * n);
  const patch = new Float32Array(size * size);
  for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
    // Window centred on the middle of each stride x stride cell (PalmService pads the GPU input to match).
    const cx = ox * stride + (stride >> 1), cy = oy * stride + (stride >> 1);
    for (let y = -r; y <= r; y++) {
      const sy = reflect(cy + y, h);
      for (let x = -r; x <= r; x++) patch[(y + r) * size + (x + r)] = gray[sy * w + reflect(cx + x, w)];
    }
    for (let k = 0; k < n; k++) {
      const ker = bank[k];
      let s = 0;
      for (let i = 0; i < patch.length; i++) s += patch[i] * ker[i];
      out[(oy * ow + ox) * n + k] = s;
    }
  }
  return out;
}

/** Symmetric reflection of an out-of-range index (-1 -> 0, n -> n-1). @param {number} i @param {number} n */
const reflect = (i, n) => (i < 0 ? -i - 1 : i >= n ? 2 * n - i - 1 : i);

// Bits per orientation so that Hamming distance = angular distance (0..3 steps of 30°) between two winners.
const ORI_BITS = [0b000, 0b001, 0b011, 0b111, 0b110, 0b100];
export const PLANES = 3;        // code bit-planes
export const CODE_WORDS = (PLANES + 1) * CODE_SIDE; // 3 bit-planes + 1 validity mask, one Uint32 per row

/** Competitive Code: per grid point, the orientation with the most negative response wins (3 bits), plus a mask bit that
 *  is cleared where the filters barely respond (flat, over-exposed or blurred skin), so those points are not compared.
 *  @param {Float32Array} resp layout [row][col][orientation] (CODE_SIDE x CODE_SIDE x ORIENTATIONS)
 *  @returns {Uint32Array} words: plane p, row r at p*CODE_SIDE + r; bit c = column c. Plane 3 = mask. */
export function encodeCompCode(resp, side = CODE_SIDE, n = ORIENTATIONS, maskRatio = 0.25) {
  const code = new Uint32Array((PLANES + 1) * side);
  const range = new Float32Array(side * side), win = new Uint8Array(side * side);
  for (let i = 0; i < side * side; i++) {
    let lo = Infinity, hi = -Infinity, arg = 0;
    for (let k = 0; k < n; k++) { const v = resp[i * n + k]; if (v < lo) { lo = v; arg = k; } if (v > hi) hi = v; }
    range[i] = hi - lo; win[i] = arg;
  }
  const sorted = Float32Array.from(range).sort(), med = sorted[sorted.length >> 1];
  for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) {
    const i = r * side + c, bits = ORI_BITS[win[i]];
    for (let p = 0; p < PLANES; p++) if ((bits >> p) & 1) code[p * side + r] |= 1 << c;
    if (range[i] >= med * maskRatio) code[PLANES * side + r] |= 1 << c;
  }
  return code;
}

const popcount = (/** @type {number} */ v) => {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24; // imul: a plain * loses bits past 2^53
};

/** Normalised Hamming distance of two codes at a pixel offset (dx, dy): differing bits / compared bits, 0..1.
 *  Same person ~0.2-0.35, different people ~0.45-0.5 on contact datasets (webcam: measure with the spike).
 *  @param {Uint32Array} a @param {Uint32Array} b */
export function hammingAt(a, b, dx = 0, dy = 0, side = CODE_SIDE) {
  let diff = 0, valid = 0;
  const full = side === 32 ? 0xffffffff : (1 << side) - 1;
  // Columns of b compared against a: b shifted by dx. Keep only columns that exist in both.
  const colMask = (dx >= 0 ? (full << dx) : (full >>> -dx)) & full;
  const M = PLANES * side;
  for (let r = Math.max(0, dy); r < Math.min(side, side + dy); r++) {
    const rb = r - dy;
    const sh = (/** @type {number} */ v) => (dx >= 0 ? v << dx : v >>> -dx);
    const m = a[M + r] & sh(b[M + rb]) & colMask;
    if (!m) continue;
    valid += popcount(m);
    for (let p = 0; p < PLANES; p++) diff += popcount((a[p * side + r] ^ sh(b[p * side + rb])) & m);
  }
  return valid ? diff / (PLANES * valid) : 1;
}

/** Best (smallest) distance over small translations: absorbs ROI jitter between frames.
 *  @param {Uint32Array} a @param {Uint32Array} b */
export function hamming(a, b, maxShift = 2) {
  let best = 1;
  for (let dy = -maxShift; dy <= maxShift; dy++) for (let dx = -maxShift; dx <= maxShift; dx++) {
    const d = hammingAt(a, b, dx, dy);
    if (d < best) best = d;
  }
  return best;
}

// ---------- hand geometry ----------
const SEGMENTS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20], [5, 9], [9, 13], [13, 17], [5, 17]];

/** Bone lengths from MediaPipe world landmarks (3D, metres), divided by their sum: pose- and scale-free hand shape.
 *  @param {{x: number, y: number, z: number}[]} world @returns {number[]} */
export function handGeometry(world) {
  const l = SEGMENTS.map(([a, b]) => Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y, world[a].z - world[b].z));
  const total = l.reduce((s, v) => s + v, 0) || 1;
  return l.map((v) => v / total);
}

/** Mean relative difference of two geometry vectors, ~0..0.3. @param {number[]} a @param {number[]} b */
export function geometryDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]) / ((a[i] + b[i]) / 2 || 1);
  return s / a.length;
}

// ---------- 1:N matching ----------
/** @typedef {{hand: Hand, code: Uint32Array, geom: number[]}} PalmSample */
/** @typedef {{id: number, name: string, palms: PalmSample[]}} PalmEnrolled */
/** @typedef {{student: PalmEnrolled | null, distance: number, runnerUp: number, reason: 'ok' | 'no-students' | 'too-far' | 'ambiguous'}} PalmMatch */

export class PalmMatcher {
  /** Same accept rules as MatchingService: threshold, absolute gap AND ratio to the runner-up, mean of k nearest samples.
   *  Distance = texture Hamming (0..1) + geomWeight * geometry distance. geomWeight 0 until the spike shows geometry helps.
   *  @param {{threshold?: number, gap?: number, ratio?: number, k?: number, geomWeight?: number, maxShift?: number}} [opts] */
  // threshold 0.38 / maxShift 3, from 11K Hands at wavelength 14: the closest different-person pair is 0.381-0.389, but the
  // gap + ratio rules keep it safe: 0 wrong and 0 of 296 unenrolled scans accepted even at 0.40.
  constructor({ threshold = 0.38, gap = 0.03, ratio = 0.9, k = 2, geomWeight = 0, maxShift = 3 } = {}) {
    this.threshold = threshold; this.gap = gap; this.ratio = ratio; this.k = k; this.geomWeight = geomWeight; this.maxShift = maxShift;
  }

  /** @param {PalmSample} a @param {PalmSample} b */
  distance(a, b) {
    const t = hamming(a.code, b.code, this.maxShift);
    return this.geomWeight ? t + this.geomWeight * geometryDistance(a.geom, b.geom) : t;
  }

  /** Only templates of the same hand count (a left palm is a different print). @param {PalmSample} s @param {PalmEnrolled} student */
  score(s, student) {
    const ds = student.palms.filter((p) => p.hand === s.hand).map((p) => this.distance(s, p)).sort((a, b) => a - b).slice(0, this.k);
    return ds.length ? ds.reduce((x, d) => x + d, 0) / ds.length : Infinity;
  }

  /** Every student's score for one sample (students without a template of that hand are left out).
   *  @param {PalmSample} s @param {PalmEnrolled[]} students @returns {Map<PalmEnrolled, number>} */
  scores(s, students) {
    const out = new Map();
    for (const st of students) { const d = this.score(s, st); if (Number.isFinite(d)) out.set(st, d); }
    return out;
  }

  /** Accept rules on a set of scores: favours "not recognised, ask the teacher" over a wrong name.
   *  @param {Map<PalmEnrolled, number>} scores @returns {PalmMatch} */
  decide(scores) {
    /** @type {{student: PalmEnrolled, d: number} | null} */ let best = null;
    let runnerUp = Infinity;
    for (const [student, d] of scores) {
      if (!best || d < best.d) { if (best) runnerUp = Math.min(runnerUp, best.d); best = { student, d }; }
      else runnerUp = Math.min(runnerUp, d);
    }
    if (!best) return { student: null, distance: Infinity, runnerUp, reason: 'no-students' };
    if (best.d > this.threshold) return { student: null, distance: best.d, runnerUp, reason: 'too-far' };
    if (runnerUp - best.d < this.gap || best.d / runnerUp > this.ratio) return { student: null, distance: best.d, runnerUp, reason: 'ambiguous' };
    return { student: best.student, distance: best.d, runnerUp, reason: 'ok' };
  }

  /** @param {PalmSample} s @param {PalmEnrolled[]} students @returns {PalmMatch} */
  match(s, students) { return this.decide(this.scores(s, students)); }
}

/** Temporal fusion at score level: a student's fused score is the mean of their scores over the frames.
 *  Codes are not averaged (bits can't be, and frames are a few pixels apart, which the shift search absorbs per frame).
 *  Only students scored in every frame are kept, so one lucky frame can't make a candidate.
 *  @param {Map<PalmEnrolled, number>[]} frames @returns {Map<PalmEnrolled, number>} */
export function fuseScores(frames) {
  /** @type {Map<PalmEnrolled, number>} */ const out = new Map();
  if (!frames.length) return out;
  for (const [st] of frames[0]) {
    let sum = 0, ok = true;
    for (const f of frames) { const d = f.get(st); if (d === undefined) { ok = false; break; } sum += d; }
    if (ok) out.set(st, sum / frames.length);
  }
  return out;
}

/** The kiosk's multi-frame decision ("guarded vote"), measured best on 11K Hands (3 frames: 98.6% right vs 95.7% for the
 *  plain mean, 0 wrong, 0 unenrolled people accepted):
 *  - at least one frame must pass the accept rules on its own,
 *  - no frame may pass them for a different student,
 *  - and the student must also be best on the fused (mean) score, within `guard` of the threshold, so one lucky frame
 *    among clearly-far ones does not decide.
 *  @param {PalmMatcher} matcher @param {Map<PalmEnrolled, number>[]} frames @returns {PalmMatch} */
export function fuseDecide(matcher, frames, { guard = 0.03 } = {}) {
  const fused = matcher.decide(fuseScores(frames));
  const voted = frames.map((f) => matcher.decide(f)).filter((d) => d.student);
  if (!voted.length) return fused.student ? { ...fused, student: null, reason: 'too-far' } : fused;
  const who = voted[0].student;
  if (voted.some((d) => d.student !== who)) return { ...fused, student: null, reason: 'ambiguous' };
  const scores = fuseScores(frames), d = scores.get(/** @type {PalmEnrolled} */ (who)) ?? Infinity;
  let runnerUp = Infinity;
  for (const [st, v] of scores) if (st !== who) runnerUp = Math.min(runnerUp, v);
  if (d > matcher.threshold + guard || runnerUp < d) return { student: null, distance: d, runnerUp, reason: 'too-far' };
  return { student: who, distance: d, runnerUp, reason: 'ok' };
}

// ---------- tracking: one hand across frames ----------
/** @typedef {{box: {x: number, y: number, width: number, height: number}, pts: Pt[], hand: Hand, roi: Roi, code: Uint32Array, geom: number[]}} PalmObservation */

/** One hand followed across frames (assigned by box overlap with FaceTracker from matching.js, which is generic).
 *  Keeps the per-frame scores of its last `window` good frames and decides with fuseDecide (guarded vote).
 *  Scores are computed once per frame when it arrives, so a decision costs one 1:N match per frame, not per window. */
export class PalmTrack {
  /** @param {number} id @param {{x: number, y: number, width: number, height: number}} box @param {number} now
   *  @param {{window?: number, switchDist?: number, liveness?: PalmLiveness}} [opts] */
  constructor(id, box, now, { window = 3, switchDist = 0.42, liveness = new PalmLiveness() } = {}) {
    this.id = id; this.box = box; this.lastSeen = now; this.window = window; this.switchDist = switchDist; this.liveness = liveness;
    /** @type {{sample: PalmSample, scores: Map<PalmEnrolled, number>}[]} */ this.frames = [];
    /** @type {Hand | null} */ this.hand = null;
    /** @type {number | null} student already handled on this track */ this.handled = null;
  }

  reset() { this.frames = []; this.hand = null; this.handled = null; this.liveness.reset(); }

  /** @param {PalmObservation} obs @param {boolean} good passed the scan gate @param {number} now
   *  @param {PalmMatcher} matcher @param {PalmEnrolled[]} students */
  observe(obs, good, now, matcher, students) {
    if (good) {
      const last = this.frames[this.frames.length - 1]?.sample;
      // The other hand, or a different palm in the same spot (consecutive frames of one palm are ~0.1-0.25 apart): start over.
      if (last && (obs.hand !== last.hand || hamming(obs.code, last.code, matcher.maxShift) > this.switchDist)) this.reset();
      const sample = { hand: obs.hand, code: obs.code, geom: obs.geom };
      this.frames.push({ sample, scores: matcher.scores(sample, students) });
      if (this.frames.length > this.window) this.frames.shift();
      this.hand = obs.hand;
    }
    return this.liveness.observe(obs.pts, obs.roi, obs.hand, now);
  }

  /** Same contract as FaceTrack.decide. frames: good frames needed (2 = ~70 ms at 30 fps); a very close match may decide on fastFrames.
   *  @param {PalmMatcher} matcher
   *  @param {{frames?: number, fastFrames?: number, fastDist?: number, requireLiveness?: boolean}} [opts] */
  decide(matcher, { frames = 2, fastFrames = 1, fastDist = 0.25, requireLiveness = false } = {}) {
    const n = this.frames.length;
    if (!n) return { match: null, confirmed: false, waitingForLiveness: false, frames: 0 };
    const match = fuseDecide(matcher, this.frames.map((f) => f.scores));
    const enough = n >= frames || (n >= fastFrames && match.reason === 'ok' && match.distance <= fastDist);
    const ready = enough && match.reason === 'ok' && match.student?.id !== this.handled;
    const live = !requireLiveness || this.liveness.passed;
    return { match, confirmed: ready && live, waitingForLiveness: ready && !live, frames: n };
  }
}

// ---------- liveness ----------
/** Fingertip positions in the palm's own frame (ROI axes, in palm widths): invariant to moving, turning or zooming the hand.
 *  @param {Pt[]} pts @param {Roi} roi */
export function palmFrameTips(pts, roi) {
  return [4, 8, 12, 16, 20].map((i) => {
    const d = sub(pts[i], roi.center);
    return { x: dot(d, roi.u) / roi.side, y: dot(d, roi.n) / roi.side };
  });
}

/** Passive check: a live hand flexes - fingertips move relative to the palm frame - while a printed or on-screen palm is
 *  rigid, so its fingertips stay put in that frame however it is waved around. Also offers an active "close then open
 *  your hand" check (grip), which a photo can't do at all. Thresholds are first guesses: tune with the spike's readout.
 *  NOTE: like the face check, this stops a held-up photo, not a replayed video. */
export class PalmLiveness {
  /** @param {{windowMs?: number, flex?: number, gripTimeoutMs?: number, warmupMs?: number, minSamples?: number}} [opts]
   *  flex: fingertip travel (10th-90th percentile spread, worst of the 5 tips, in palm widths) that counts as a live hand.
   *  warmupMs: frames this soon after the track starts are ignored: when MediaPipe switches from detecting to tracking
   *  the hand, landmarks jump, and on a still photo that jump alone used to pass (caught by scripts/e2e-palm.mjs).
   *  Percentiles (not min-max) so one jumpy frame can't pass either; steady tracking of a still photo moves <= 0.02. */
  constructor({ windowMs = 2000, flex = 0.06, gripTimeoutMs = 4000, warmupMs = 300, minSamples = 8 } = {}) {
    this.windowMs = windowMs; this.flex = flex; this.gripTimeoutMs = gripTimeoutMs; this.warmupMs = warmupMs; this.minSamples = minSamples;
    /** @type {number | null} */ this.startedAt = null;
    /** @type {{t: number, tips: {x: number, y: number}[]}[]} */ this.samples = [];
    this.passed = false; this.travel = 0;
    /** @type {null | {startedAt: number, closed: boolean}} */ this.grip = null;
    this.gripPassed = false;
  }

  reset() { this.startedAt = null; this.samples = []; this.passed = false; this.travel = 0; this.grip = null; this.gripPassed = false; }

  /** Ask for "close your hand, then open it". @param {number} now */
  startGrip(now) { this.grip = { startedAt: now, closed: false }; this.gripPassed = false; }

  /** @param {Pt[]} pts @param {Roi} roi @param {Hand} _hand @param {number} now */
  observe(pts, roi, _hand, now) {
    this.startedAt ??= now;
    if (now - this.startedAt >= this.warmupMs) this.samples.push({ t: now, tips: palmFrameTips(pts, roi) });
    while (this.samples.length && now - this.samples[0].t > this.windowMs) this.samples.shift();
    let travel = 0;
    if (this.samples.length >= this.minSamples) {
      const spread = (/** @type {number[]} */ v) => { v.sort((a, b) => a - b); return v[Math.floor((v.length - 1) * 0.9)] - v[Math.floor((v.length - 1) * 0.1)]; };
      for (let i = 0; i < 5; i++) travel = Math.max(travel, Math.hypot(spread(this.samples.map((s) => s.tips[i].x)), spread(this.samples.map((s) => s.tips[i].y))));
    }
    this.travel = travel;
    if (travel >= this.flex) this.passed = true;
    /** @type {'none' | 'pending' | 'passed' | 'failed'} */ let grip = 'none';
    if (this.grip) {
      const open = fingersOpen(pts);
      if (!this.grip.closed && open <= 1) this.grip.closed = true;
      if (this.grip.closed && open >= 3) { this.gripPassed = true; this.grip = null; grip = 'passed'; }
      else if (now - this.grip.startedAt > this.gripTimeoutMs) { this.grip = null; grip = 'failed'; }
      else grip = 'pending';
    }
    return { passed: this.passed, travel, grip, gripPassed: this.gripPassed };
  }
}

// ---------- enrolment ----------
/** Drop enrolment samples far from the others (a half-closed hand, motion blur, a misplaced ROI). Distances from the medoid
 *  (the sample closest to all others), like pruneOutliers() for faces. Keeps at least `keep`, the most central ones.
 *  @template {PalmSample} S @param {S[]} samples @param {PalmMatcher} matcher */
export function prunePalmOutliers(samples, matcher, { maxDist = 0.4, keep = 3 } = {}) {
  if (samples.length <= keep) return samples.slice();
  const d = samples.map((a) => samples.map((b) => (a === b ? 0 : matcher.distance(a, b))));
  const total = d.map((row) => row.reduce((x, y) => x + y, 0));
  const m = total.indexOf(Math.min(...total));
  const ranked = samples.map((s, i) => ({ s, d: d[m][i] })).sort((a, b) => a.d - b.d);
  return ranked.filter((r, i) => i < keep || r.d <= maxDist).map((r) => r.s);
}

/** Is this palm already enrolled under another student? (Two templates for one palm = wrong marks.)
 *  Returns the closest other student whose score is within the accept threshold, or null.
 *  @param {PalmSample[]} samples new enrolment (one hand) @param {PalmEnrolled[]} others @param {PalmMatcher} matcher */
export function palmDuplicate(samples, others, matcher) {
  let best = null;
  for (const st of others) {
    const d = Math.min(...samples.map((s) => matcher.score(s, st)));
    if (Number.isFinite(d) && d <= matcher.threshold && (!best || d < best.d)) best = { student: st, d };
  }
  return best;
}

// ---------- evaluation (feasibility spike) ----------
/** @typedef {{person: string, hand: Hand, session: string, code: Uint32Array, geom: number[]}} LabelledSample */

/** All-pairs genuine vs impostor distances for one metric, and the operating points that matter for a kiosk:
 *  EER, and the genuine accept rate at the strictest threshold that lets no impostor pair through.
 *  crossSession: only count genuine pairs captured in different sessions (the realistic case: enrol Monday, scan Friday).
 *  @param {LabelledSample[]} samples @param {(a: LabelledSample, b: LabelledSample) => number} metric */
export function palmReport(samples, metric, { crossSession = false } = {}) {
  /** @type {number[]} */ const genuine = [], impostor = [];
  for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) {
    const a = samples[i], b = samples[j];
    if (a.hand !== b.hand) continue; // never compared at scan time
    if (a.person === b.person) { if (!crossSession || a.session !== b.session) genuine.push(metric(a, b)); }
    else impostor.push(metric(a, b));
  }
  genuine.sort((x, y) => x - y); impostor.sort((x, y) => x - y);
  const q = (/** @type {number[]} */ v, /** @type {number} */ p) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : NaN);
  const below = (/** @type {number[]} */ v, /** @type {number} */ t) => { let lo = 0, hi = v.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] <= t) lo = m + 1; else hi = m; } return lo; };
  let eer = NaN, eerThr = NaN;
  if (genuine.length && impostor.length) {
    let bestGap = Infinity;
    for (const t of [...genuine, ...impostor]) {
      const frr = 1 - below(genuine, t) / genuine.length, far = below(impostor, t) / impostor.length;
      if (Math.abs(frr - far) < bestGap) { bestGap = Math.abs(frr - far); eer = (frr + far) / 2; eerThr = t; }
    }
  }
  const zeroFarThr = impostor.length ? impostor[0] - 1e-9 : NaN;
  return {
    genuine: genuine.length, impostor: impostor.length,
    genuineMedian: q(genuine, 0.5), genuineP95: q(genuine, 0.95), impostorMin: impostor[0] ?? NaN, impostorP01: q(impostor, 0.01), impostorMedian: q(impostor, 0.5),
    eer, eerThr,
    zeroFarThr, garAtZeroFar: genuine.length && impostor.length ? below(genuine, zeroFarThr) / genuine.length : NaN,
    genuineDist: genuine, impostorDist: impostor,
  };
}

/** Kiosk simulation: each probe is a scan, matched 1:N against everyone's other samples with the real accept rules.
 *  frames > 1: a probe is `frames` consecutive samples of one person/hand/session, decided like PalmTrack (fuseDecide).
 *  openSet: the probe's own person is removed from the roster (an unenrolled student walks up): any name is wrong.
 *  crossSession: the scanned person's templates come only from their other sessions (enrol one day, scan another);
 *  probes whose person has no other session are skipped. What matters for a kiosk: `wrong` must be 0.
 *  @param {LabelledSample[]} samples @param {PalmMatcher} matcher */
export function simulate1N(samples, matcher, { crossSession = false, frames = 1, openSet = false } = {}) {
  let probes = 0, correct = 0, rejected = 0;
  /** @type {{probe: LabelledSample, got: string, distance: number}[]} */ const wrong = [];
  /** @type {Map<string, LabelledSample[]>} */ const runs = new Map();
  for (const s of samples) { const k = `${s.person}|${s.hand}|${s.session}`; if (!runs.has(k)) runs.set(k, []); runs.get(k)?.push(s); }
  for (const run of runs.values()) {
    for (let i = 0; i + frames <= run.length; i += frames) {
      const probe = run.slice(i, i + frames), p0 = probe[0], inProbe = new Set(probe);
      /** @type {Map<string, PalmEnrolled>} */ const gallery = new Map();
      for (const g of samples) {
        if (inProbe.has(g) || (crossSession && g.person === p0.person && g.session === p0.session) || (openSet && g.person === p0.person)) continue;
        if (!gallery.has(g.person)) gallery.set(g.person, { id: gallery.size, name: g.person, palms: [] });
        gallery.get(g.person)?.palms.push(g);
      }
      if (!openSet && !gallery.get(p0.person)?.palms.some((p) => p.hand === p0.hand)) continue;
      probes++;
      const students = [...gallery.values()];
      const m = fuseDecide(matcher, probe.map((s) => matcher.scores(s, students)));
      if (!m.student) rejected++;
      else if (m.student.name === p0.person) correct++;
      else wrong.push({ probe: p0, got: m.student.name, distance: m.distance });
    }
  }
  return { probes, correct, rejected, wrong };
}

// ---------- serialisation ----------
/** @param {Uint32Array} code */
export const codeToBase64 = (code) => {
  const b = new Uint8Array(code.buffer, code.byteOffset, code.byteLength);
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
/** @param {string} s */
export const codeFromBase64 = (s) => {
  const bin = atob(s), b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new Uint32Array(b.buffer);
};
