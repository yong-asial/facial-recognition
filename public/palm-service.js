// PalmService: MediaPipe Hand Landmarker + palm ROI warp + Competitive Code (the only palm code that touches the DOM/GPU).
// Pure maths is in palm.js. MediaPipe is imported lazily so a face-only kiosk never downloads it.
import {
  palmRoi, palmFacing, palmFlatness, fingersOpen, insideFrame, grayStats, toGray, gaborBank, GABOR, filterResponses, encodeCompCode,
  handGeometry, ROI_SIZE, CODE_SIDE, ORIENTATIONS,
} from './palm.js';

/** @typedef {import('./palm.js').Hand} Hand */
/** @typedef {import('./palm.js').PalmSignals} PalmSignals */
/** @typedef {{box: {x: number, y: number, width: number, height: number}, pts: {x: number, y: number, z: number}[], hand: Hand,
 *   roi: import('./palm.js').Roi, signals: PalmSignals, code: Uint32Array, geom: number[], gray: Float32Array}} PalmFrame */

const now = () => performance.now();
/** @param {HTMLVideoElement | HTMLCanvasElement} s */
const size = (s) => ('videoWidth' in s ? { W: s.videoWidth, H: s.videoHeight } : { W: s.width, H: s.height });

export class PalmService {
  /** @param {{tf?: any, base?: string, mode?: 'VIDEO' | 'IMAGE'}} [opts] tf: the TensorFlow.js instance from face-api (faceapi.tf)
   *  for the GPU filter bank. mode: VIDEO for the camera (tracks between frames), IMAGE for unrelated still photos. */
  constructor({ tf = null, base = '/vendor/mediapipe', mode = 'VIDEO', roiShape = undefined } = {}) {
    this.tf = tf; this.base = base; this.mode = mode; this.roiShape = roiShape; this._ready = null;
    /** @type {any} */ this.landmarker = null;
    this.bank = gaborBank();
    this.roiCanvas = Object.assign(document.createElement('canvas'), { width: ROI_SIZE, height: ROI_SIZE });
    this.roiCtx = /** @type {CanvasRenderingContext2D} */ (this.roiCanvas.getContext('2d', { willReadFrequently: true }));
    this.useGpu = !!tf;
    this.timing = { detect: 0, warp: 0, code: 0 };
    this.lastTs = 0;
  }

  /** Loads the landmarker once (GPU delegate, falls back to CPU); a failure clears the cache so the next call retries. */
  load() {
    return (this._ready ??= (async () => {
      const { FilesetResolver, HandLandmarker } = await import(/* webpackIgnore: true */ `${this.base}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${this.base}/wasm`);
      const make = (/** @type {'GPU' | 'CPU'} */ delegate) => HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: `${this.base}/models/hand_landmarker.task`, delegate },
        runningMode: this.mode, numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      try { this.landmarker = await make('GPU'); this.delegate = 'GPU'; } catch { this.landmarker = await make('CPU'); this.delegate = 'CPU'; }
      if (this.tf) {
        await this.tf.ready();
        const k = GABOR.size, w = new Float32Array(k * k * ORIENTATIONS);
        this.bank.forEach((ker, o) => ker.forEach((v, i) => { w[i * ORIENTATIONS + o] = v; })); // [h][w][in=1][out]
        this.kernel = this.tf.tensor4d(w, [k, k, 1, ORIENTATIONS]);
      }
    })().catch((e) => { this._ready = null; throw e; }));
  }

  /** Landmarks for every hand in the current video frame (raw, un-mirrored frame for enrolment and scanning alike).
   *  Handedness is used as MediaPipe reports it: measured on its own right_hands.jpg (backs of two right hands, a plain
   *  photo) it says "Right", and "Left" for the mirrored photo, despite the docs saying it assumes a mirrored selfie.
   *  @param {HTMLVideoElement | HTMLCanvasElement} src */
  detect(src) {
    const { W, H } = size(src), t0 = now();
    let r;
    if (this.mode === 'IMAGE') r = this.landmarker.detect(src);
    else {
      const ts = Math.max(this.lastTs + 1, t0); this.lastTs = ts; // VIDEO mode needs strictly increasing timestamps
      r = this.landmarker.detectForVideo(src, ts);
    }
    this.timing.detect = now() - t0;
    return (r.landmarks ?? []).map((/** @type {any[]} */ lm, /** @type {number} */ i) => {
      const pts = lm.map((p) => ({ x: p.x * W, y: p.y * H, z: p.z * W }));
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const cat = r.handedness?.[i]?.[0] ?? r.handednesses?.[i]?.[0];
      /** @type {Hand} */ const hand = cat?.categoryName === 'Left' ? 'Left' : 'Right';
      const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      return { pts, world: r.worldLandmarks?.[i] ?? [], hand, score: cat?.score ?? 0, box };
    });
  }

  /** Detect -> ROI -> quality signals -> code, for every hand. @param {HTMLVideoElement | HTMLCanvasElement} video @returns {PalmFrame[]} */
  analyze(video) {
    const { W, H } = size(video);
    const out = [];
    let warp = 0, code = 0;
    for (const h of this.detect(video)) {
      const t0 = now();
      const roi = palmRoi(h.pts, undefined, this.roiShape);
      const gray = this.warp(video, roi);
      const { brightness, sharpness } = grayStats(gray, ROI_SIZE, ROI_SIZE);
      const t1 = now();
      /** @type {PalmSignals} */
      const signals = { facing: palmFacing(h.pts, h.hand), flatness: palmFlatness(h.pts), open: fingersOpen(h.pts), side: roi.side,
        inFrame: insideFrame(roi.corners, W, H), sharpness, brightness, score: h.score };
      out.push({ box: h.box, pts: h.pts, hand: h.hand, roi, signals, code: this.encode(gray), geom: h.world.length ? handGeometry(h.world) : [], gray });
      warp += t1 - t0; code += now() - t1;
    }
    this.timing.warp = warp; this.timing.code = code;
    return out;
  }

  /** Draw the palm square, upright, into the ROI canvas (GPU resample) and read it back as grayscale.
   *  @param {CanvasImageSource} src @param {import('./palm.js').Roi} roi */
  warp(src, roi) {
    const c = this.roiCtx;
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#000'; c.fillRect(0, 0, ROI_SIZE, ROI_SIZE);
    c.imageSmoothingQuality = 'high';
    c.setTransform(...roi.transform); c.drawImage(src, 0, 0); c.setTransform(1, 0, 0, 1, 0, 0);
    return toGray(c.getImageData(0, 0, ROI_SIZE, ROI_SIZE).data);
  }

  /** Competitive Code of a ROI_SIZE grayscale ROI: GPU conv when tf is available, else plain JS (same numbers).
   *  @param {Float32Array} gray */
  encode(gray) { return encodeCompCode(this.useGpu && this.kernel ? this.responsesGpu(gray) : this.responsesJs(gray)); }

  /** @param {Float32Array} gray */
  responsesJs(gray) { return filterResponses(gray, ROI_SIZE, ROI_SIZE, this.bank, GABOR.size); }

  /** One strided conv2d for all 6 orientations. Padding matches filterResponses: symmetric reflection, windows centred
   *  on the middle of each 4x4 cell (pad 10 before, 14 after). @param {Float32Array} gray */
  responsesGpu(gray) {
    const tf = this.tf, stride = ROI_SIZE / CODE_SIDE, r = (GABOR.size - 1) / 2, before = r - (stride >> 1), after = GABOR.size - 1 - before;
    const t = tf.tidy(() => tf.conv2d(tf.mirrorPad(tf.tensor4d(gray, [1, ROI_SIZE, ROI_SIZE, 1]), [[0, 0], [before, after], [before, after], [0, 0]], 'symmetric'), this.kernel, stride, 'valid'));
    const data = /** @type {Float32Array} */ (t.dataSync());
    t.dispose();
    return data;
  }

  /** Small JPEG of the current ROI (spike / enrolment card). */
  roiJpeg(q = 0.92) { return this.roiCanvas.toDataURL('image/jpeg', q); }
}
