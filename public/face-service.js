// FaceService: thin wrapper over face-api.js (detector gate, landmarks, 128-d embedding, quality).
// All the DOM/GPU-touching face code lives here; pure maths is in matching.js.
import { eyeAspectRatio, yawRatio, laplacianVariance } from './matching.js';

/** @typedef {{x: number, y: number, width: number, height: number}} Box */
/** @typedef {{box: Box, descriptor: number[], ear: number, yaw: number}} Face */

export class FaceService {
  /** @param {any} faceapi the global from /vendor/face-api.js */
  constructor(faceapi, modelUrl = '/vendor/models') {
    this.faceapi = faceapi; this.modelUrl = modelUrl; this._ready = null;
    this.gateOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.5 });
    // 224 (not 320): TinyFaceDetector at 320 missed large close-up faces in testing.
    this.fullOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
    this.snap = document.createElement('canvas');
  }

  /** Loads models once; a failure clears the cache so the next call retries. */
  load() {
    const n = this.faceapi.nets;
    return (this._ready ??= Promise.all([
      n.tinyFaceDetector.loadFromUri(this.modelUrl), n.faceLandmark68Net.loadFromUri(this.modelUrl), n.faceRecognitionNet.loadFromUri(this.modelUrl),
    ]).catch((e) => { this._ready = null; throw e; }));
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

  /** Detect -> landmarks -> embedding for every face in the (frozen) frame. @param {HTMLCanvasElement} canvas @returns {Promise<Face[]>} */
  async analyze(canvas) {
    const dets = await this.faceapi.detectAllFaces(canvas, this.fullOpts).withFaceLandmarks().withFaceDescriptors();
    return dets.map((d) => {
      const lm = d.landmarks;
      return {
        box: d.detection.box,
        descriptor: Array.from(d.descriptor),
        ear: (eyeAspectRatio(lm.getLeftEye()) + eyeAspectRatio(lm.getRightEye())) / 2,
        yaw: yawRatio(lm.positions),
      };
    });
  }

  /** @param {HTMLCanvasElement} src @param {Box} box @param {number} size @param {number} [margin] */
  crop(src, box, size, margin = 0) {
    const side = Math.max(box.width, box.height) * (1 + margin);
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const c = document.createElement('canvas'); c.width = c.height = size;
    c.getContext('2d')?.drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
    return c;
  }

  /** Laplacian variance of the face crop (low = blurry). @param {HTMLCanvasElement} src @param {Box} box */
  sharpness(src, box) {
    const n = 96, ctx = this.crop(src, box, n).getContext('2d');
    const px = ctx?.getImageData(0, 0, n, n).data;
    if (!px) return 0;
    const gray = new Float32Array(n * n);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    return laplacianVariance(gray, n, n);
  }

  /** Small JPEG for the confirmation card. @param {HTMLCanvasElement} src @param {Box} box */
  thumbnail(src, box) { return this.crop(src, box, 96, 0.3).toDataURL('image/jpeg', 0.6); }
}
