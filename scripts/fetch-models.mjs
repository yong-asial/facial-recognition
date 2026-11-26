// Downloads model files that are not shipped in npm packages, into ./models (gitignored, served from /vendor/mediapipe/).
// Run once after `npm install`:  node scripts/fetch-models.mjs
import fs from 'node:fs';
import path from 'node:path';

const MODELS = [
  // MediaPipe Hand Landmarker (palm detector + 21 landmarks), float16, ~7.5 MB. Apache-2.0.
  { url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', file: 'hand_landmarker.task' },
];

const dir = path.resolve('models');
fs.mkdirSync(dir, { recursive: true });
for (const m of MODELS) {
  const out = path.join(dir, m.file);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) { console.log('ok  ', m.file); continue; }
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log('got ', m.file, fs.statSync(out).size, 'bytes');
}
