// Builds test fixtures from the sample group photo: 3 distinct people (A,B,C, all frontal,
// same photo) and "live capture" variants of A (rotation / brightness / crop / compression).
import sharp from 'sharp';
const src = 'test/faces/crops';
const out = 'test/fixtures';
const people = { A: 's3_1', B: 's3_0', C: 's3_2' };
for (const [k, f] of Object.entries(people)) await sharp(`${src}/${f}.jpg`).jpeg({ quality: 90 }).toFile(`${out}/${k}.jpg`);
const a = `${src}/${people.A}.jpg`;
await sharp(a).rotate(6, { background: '#444' }).modulate({ brightness: 0.85 }).jpeg({ quality: 70 }).toFile(`${out}/A_live1.jpg`);
await sharp(a).rotate(-5, { background: '#444' }).modulate({ brightness: 1.15, saturation: 0.8 }).resize({ width: 360 }).jpeg({ quality: 60 }).toFile(`${out}/A_live2.jpg`);
await sharp(a).extract({ left: 20, top: 20, width: 380, height: 450 }).blur(0.8).jpeg({ quality: 75 }).toFile(`${out}/A_live3.jpg`);
// non-face
await sharp({ create: { width: 320, height: 240, channels: 3, background: '#789' } }).jpeg().toFile(`${out}/noface.jpg`);
