// FaceService: thin wrapper over face-api.js (detector gate, landmarks, 128-d embedding, quality).
// All the DOM/GPU-touching face code lives here; pure maths is in matching.js.
import { eyeAspectRatio, yawRatio, rollDegrees, laplacianVariance } from './matching.js';

/** @typedef {{x: number, y: number, width: number, height: number}} Box */

const ROLL_FIX = 6; // degrees of head tilt above which the face is straightened before the embedding
/** @typedef {{box: Box, score: number, descriptor: number[], ear: number, yaw: number, roll: number}} Face */

export class FaceService {
  /** @param {any} faceapi the global from /vendor/face-api.js */
  constructor(faceapi, modelUrl = '/vendor/models') {
    this.faceapi = faceapi; this.modelUrl = modelUrl; this._ready = null;
    this.gateOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.5 });
    // 224 (not 320): TinyFaceDetector at 320 missed large close-up faces in testing.
    this.fullOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
    this.snap = document.createElement('canvas');
    this.rot = document.createElement('canvas');
  }

  /** Loads models once; a failure clears the cache so the next call retries. */
  load() {
    const n = this.faceapi.nets;
    return (this._ready ??= Promise.all([
      n.tinyFaceDetector.loadFromUri(this.modelUrl), n.faceLandmark68Net.loadFromUri(this.modelUrl), n.faceRecognitionNet.loadFromUri(this.modelUrl),
    ]).catch((e) => { this._ready = null; throw e; }));
  }

  /** Enrolment only: SsdMobilenetv1 (5.4 MB, slower, far better calibrated scores: 0.93-1.00 on clear faces vs Tiny's 0.67-0.98).
   *  Used to double-check the frame, not to compute the stored descriptor: SSD crops the face ~0.1 apart from Tiny,
   *  and the scanner uses Tiny, so enrolment descriptors stay on the Tiny pipeline. Never loaded by the scanner. */
  loadVerifier() {
    return (this._ssd ??= this.faceapi.nets.ssdMobilenetv1.loadFromUri(this.modelUrl).catch((/** @type {any} */ e) => { this._ssd = null; throw e; }));
  }

  /** @param {HTMLCanvasElement} canvas @returns {Promise<{box: Box, score: number}[]>} */
  async verify(canvas) {
    const dets = await this.faceapi.detectAllFaces(canvas, new this.faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }));
    return dets.map((/** @type {any} */ d) => ({ box: d.box, score: d.score }));
  }

  /** Freeze one frame: heavy steps are async and the live video keeps moving under them. @param {HTMLVideoElement} video */
  snapshot(video) {
    this.snap.width = video.videoWidth; this.snap.height = video.videoHeight;
    this.snap.getContext('2d')?.drawImage(video, 0, 0);
    return this.snap;
  }

  /** Cheap face-present check (low-res detector only). @param {HTMLVideoElement} video @returns {Promise<Box[]>} */
  async gate(video) {
    return (await this.faceapi.detectAllFaces(video, this.gateOpts)).map((d) => d.box);
  }

  /** Detect -> landmarks -> embedding for every face in the (frozen) frame.
   *  Tilted heads are straightened first: face-api feeds the 128-d net an unrotated crop (dlib rotates it upright),
   *  and on our fixtures levelling the eyes halved same-person distances (0.21 -> 0.09) without bringing strangers closer.
   *  @param {HTMLCanvasElement} canvas @returns {Promise<Face[]>} */
  async analyze(canvas) {
    const dets = await this.faceapi.detectAllFaces(canvas, this.fullOpts).withFaceLandmarks().withFaceDescriptors();
    const faces = [];
    for (const d of dets) {
      const lm = d.landmarks, roll = rollDegrees(lm.positions);
      /** @type {Face} */
      const f = {
        box: d.detection.box,
        score: d.detection.score,
        descriptor: Array.from(d.descriptor),
        ear: (eyeAspectRatio(lm.getLeftEye()) + eyeAspectRatio(lm.getRightEye())) / 2,
        yaw: yawRatio(lm.positions),
        roll,
      };
      if (Math.abs(roll) > ROLL_FIX) {
        const fixed = await this.levelled(canvas, f.box, roll);
        if (fixed) { f.descriptor = fixed.descriptor; f.roll = fixed.roll; } // roll = what is left after levelling
      }
      faces.push(f);
    }
    return faces;
  }

  /** Rotate a crop around the face so the eyes are level, then re-run the face pipeline on it (small, so fast).
   *  @param {HTMLCanvasElement} src @param {Box} box @param {number} roll */
  async levelled(src, box, roll) {
    const side = Math.round(Math.max(box.width, box.height) * 2), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const c = this.rot; c.width = c.height = side;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, side, side);
    ctx.translate(side / 2, side / 2); ctx.rotate((-roll * Math.PI) / 180); ctx.drawImage(src, -cx, -cy);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const d = await this.faceapi.detectSingleFace(c, this.fullOpts).withFaceLandmarks().withFaceDescriptor();
    return d ? { descriptor: Array.from(d.descriptor), roll: rollDegrees(d.landmarks.positions) } : null;
  }

  /** @param {HTMLCanvasElement} src @param {Box} box @param {number} size @param {number} [margin] */
  crop(src, box, size, margin = 0) {
    const side = Math.max(box.width, box.height) * (1 + margin);
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const c = document.createElement('canvas'); c.width = c.height = size;
    c.getContext('2d')?.drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
    return c;
  }

  /** Sharpness (Laplacian variance, low = blurry) and mean brightness (0-255) of the face crop. 96px crop (BLUR thresholds are tuned at this size).
   *  @param {HTMLCanvasElement} src @param {Box} box */
  quality(src, box) {
    const n = 96, ctx = this.crop(src, box, n).getContext('2d', { willReadFrequently: true });
    const px = /** @type {CanvasRenderingContext2D | null} */ (ctx)?.getImageData(0, 0, n, n).data;
    if (!px) return { sharpness: 0, brightness: 0 };
    const gray = new Float32Array(n * n);
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    return { sharpness: laplacianVariance(gray, n, n), brightness: sum / gray.length };
  }

  /** Small JPEG for the confirmation card. @param {HTMLCanvasElement} src @param {Box} box */
  thumbnail(src, box) { return this.crop(src, box, 96, 0.3).toDataURL('image/jpeg', 0.6); }
}
