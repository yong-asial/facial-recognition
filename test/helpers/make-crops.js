// One-off: crop each detected face out of the group sample photos.
import sharp from 'sharp';
import { detectAll } from './faceapi-node.js';
for (const n of [1, 2, 3, 4, 5, 6]) {
  const src = `test/faces/sample${n}.jpg`;
  const faces = await detectAll(src);
  const meta = await sharp(src).metadata();
  let k = 0;
  for (const { box } of faces.sort((a, b) => a.box.x - b.box.x)) {
    const m = box.width * 0.5;
    const left = Math.max(0, Math.round(box.x - m)), top = Math.max(0, Math.round(box.y - m));
    const width = Math.min(meta.width - left, Math.round(box.width + 2 * m));
    const height = Math.min(meta.height - top, Math.round(box.height + 2 * m));
    await sharp(src).extract({ left, top, width, height }).resize({ width: 480, withoutEnlargement: true })
      .jpeg({ quality: 90 }).toFile(`test/faces/crops/s${n}_${k++}.jpg`);
  }
  console.log(src, faces.length, 'faces');
}
