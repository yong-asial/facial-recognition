// Node-side face descriptors (same nets as the browser) for tests and fixture prep.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import util from 'node:util';

// tfjs-node still calls util helpers that were removed in Node 23+.
util.isNullOrUndefined ??= (v) => v === null || v === undefined;
util.isArray ??= Array.isArray;
const require = createRequire(import.meta.url);
const tf = require('@tensorflow/tfjs-node');
const faceapi = require('@vladmandic/face-api/dist/face-api.node.js');

const MODEL_DIR = path.resolve('node_modules/@vladmandic/face-api/model');
let ready;
export const init = () => (ready ??= (async () => {
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR),
    faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR),
    faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR),
  ]);
})());

export async function detectAll(file) {
  await init();
  const t = tf.node.decodeImage(fs.readFileSync(file), 3);
  try {
    const dets = await faceapi
      .detectAllFaces(t, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
    return dets.map((d) => ({ box: d.detection.box, descriptor: Array.from(d.descriptor) }));
  } finally { t.dispose(); }
}
export const dataUrl = (file) => 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64');
