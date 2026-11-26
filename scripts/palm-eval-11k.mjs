// Run the palm pipeline (real Chrome + MediaPipe + palm-service.js) over the public 11K Hands dataset
// (Afifi 2019, https://sites.google.com/view/11khands, academic use) and write a spike export for scripts/palm-report.mjs.
//   node scripts/palm-eval-11k.mjs <HandInfo.csv> <Hands dir> <out.json> [--subjects 60] [--per 6] [--webcam] [--blur 1.5] [--keep-blurry]
// --webcam: shrink each 1600x1200 photo to 640x480 and JPEG it at q70 first (palm ~200 px, like a kiosk camera).
// --blur s: Gaussian blur (sigma s, in output pixels) after shrinking: a soft webcam / slight motion.
// --keep-blurry: also keep frames that fail the scan gate only on sharpness (each sample stores `sharpness`), so
//   palm-report --min-sharpness can show how accuracy depends on it.
// Each subject's palm photos of one hand are split in half: first half "enrol", second half "scan" (report genuine pairs
// across the halves). All photos of a subject come from one sitting, so this is OPTIMISTIC versus a real kiosk.
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const [csvFile, dir, outFile] = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const num = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const webcam = args.includes('--webcam'), maxSubjects = num('subjects', 60), per = num('per', 6), blur = num('blur', 0), keepBlurry = args.includes('--keep-blurry');
if (!outFile) { console.error('usage: node scripts/palm-eval-11k.mjs <HandInfo.csv> <Hands dir> <out.json> [--subjects n] [--per n] [--webcam]'); process.exit(1); }

// ---- pick images: palmar only, subjects with >= 4 photos of a hand ----
const [header, ...lines] = fs.readFileSync(csvFile, 'utf8').trim().split(/\r?\n/);
const unq = (v) => v.replace(/^"|"$/g, '');
const cols = header.split(',').map(unq);
const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], unq(v)])));
const groups = new Map();
for (const r of rows) {
  const [side, hand] = r.aspectOfHand.split(' ');
  if (side !== 'palmar') continue;
  const k = `${r.id}|${hand}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const subjects = [...new Set([...groups].filter(([, g]) => g.length >= 4).map(([k]) => k.split('|')[0]))].slice(0, maxSubjects);
const jobs = [];
for (const id of subjects) for (const hand of ['right', 'left']) {
  const g = (groups.get(`${id}|${hand}`) ?? []).sort((a, b) => a.imageName.localeCompare(b.imageName)).slice(0, per);
  if (g.length < 4) continue;
  g.forEach((r, i) => jobs.push({ person: id, truthHand: hand === 'right' ? 'Right' : 'Left', session: i < g.length / 2 ? 'enrol' : 'scan', file: path.join(dir, r.imageName), accessories: r.accessories === '1' }));
}
console.log(`${subjects.length} subjects, ${jobs.length} palm photos, ${webcam ? 'webcam-like 640x480 q70' : 'full 1600x1200'}${blur ? `, blur σ=${blur}` : ''}`);

// ---- server + browser ----
const PORT = 3031;
const server = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_PATH: path.join(path.dirname(path.resolve(outFile)), 'eval.db') }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(async () => {
    const { PalmService } = await import('/palm-service.js');
    const palm = new PalmService({ tf: window.faceapi?.tf, mode: 'IMAGE' });
    await palm.load();
    const { codeToBase64, palmQuality, SCAN_PALM, ENROLL_PALM } = await import('/palm.js');
    const canvas = document.createElement('canvas'), out = document.createElement('canvas');
    out.width = out.height = 128;
    window.run = async (b64) => {
      const img = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
      canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d').drawImage(img, 0, 0);
      const t0 = performance.now();
      const f = palm.analyze(canvas).sort((a, b) => b.roi.side - a.roi.side)[0];
      const ms = performance.now() - t0;
      if (!f) return { found: false, ms };
      const ctx = out.getContext('2d'), id = ctx.createImageData(128, 128);
      f.gray.forEach((v, i) => id.data.set([v, v, v, 255], i * 4)); ctx.putImageData(id, 0, 0);
      return { found: true, ms, hand: f.hand, signals: f.signals, scan: palmQuality(f.signals, SCAN_PALM), enrol: palmQuality(f.signals, ENROLL_PALM),
        code: codeToBase64(f.code), geom: f.geom, roi: out.toDataURL('image/jpeg', 0.92) };
    };
  });

  const samples = [], stats = { found: 0, handOk: 0, facing: 0, scanOk: 0, enrolOk: 0, scanWhy: {}, ms: [] };
  for (const [i, j] of jobs.entries()) {
    let img = sharp(j.file);
    if (webcam) img = img.resize(640, 480, { fit: 'inside' });
    if (blur > 0) img = sharp(await img.toBuffer()).blur(blur);
    img = img.jpeg({ quality: webcam ? 70 : 92 });
    const r = await page.evaluate((b64) => window.run(b64), (await img.toBuffer()).toString('base64'));
    stats.ms.push(r.ms);
    if (!r.found) continue;
    stats.found++;
    if (r.hand === j.truthHand) stats.handOk++;
    if (r.signals.facing) stats.facing++;
    if (r.scan.ok) stats.scanOk++; else stats.scanWhy[r.scan.reason] = (stats.scanWhy[r.scan.reason] ?? 0) + 1;
    if (r.enrol.ok) stats.enrolOk++;
    // The kiosk only keeps frames that pass the scan gate, and only compares templates of the detected hand.
    if (r.scan.ok || (keepBlurry && r.scan.reason === 'blur'))
      samples.push({ person: j.person, hand: r.hand, session: j.session, gate: r.enrol.ok ? 'strict' : 'lenient', sharpness: r.signals.sharpness, code: r.code, geom: r.geom, roi: r.roi, at: 0 });
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${jobs.length}`);
  }
  const n = jobs.length, p = (x) => `${((x / n) * 100).toFixed(1)}%`;
  stats.ms.sort((a, b) => a - b);
  console.log(`hand found      ${stats.found}/${n} (${p(stats.found)})`);
  console.log(`handedness ok   ${stats.handOk}/${stats.found} vs dataset label`);
  console.log(`palm facing     ${stats.facing}/${stats.found}`);
  console.log(`scan gate ok    ${stats.scanOk} (${p(stats.scanOk)})  rejected: ${JSON.stringify(stats.scanWhy)}`);
  console.log(`enrol gate ok   ${stats.enrolOk} (${p(stats.enrolOk)})`);
  const sh = samples.map((x) => x.sharpness).filter(Number.isFinite).sort((a, b) => a - b);
  if (sh.length) console.log(`ROI sharpness   p10 ${sh[Math.floor(sh.length * 0.1)].toFixed(1)}, median ${sh[sh.length >> 1].toFixed(1)}, p90 ${sh[Math.floor(sh.length * 0.9)].toFixed(1)} (kept samples)`);
  console.log(`analyze ms      median ${stats.ms[stats.ms.length >> 1].toFixed(1)}, p95 ${stats.ms[Math.floor(stats.ms.length * 0.95)].toFixed(1)} (one still image, IMAGE mode)`);
  fs.writeFileSync(outFile, JSON.stringify({ version: 1, source: '11k-hands', webcam, samples }));
  console.log(`wrote ${samples.length} samples -> ${outFile}`);
} finally {
  await browser.close();
  server.kill();
}
