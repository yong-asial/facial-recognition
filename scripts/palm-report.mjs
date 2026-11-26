// Offline report for palm spike data (Export JSON on /palm-spike.html).
//   node scripts/palm-report.mjs palm-samples.json                    # stored codes, as captured live
//   node scripts/palm-report.mjs palm-samples.json --reencode         # recompute codes from the saved ROI JPEGs
//   node scripts/palm-report.mjs palm-samples.json --sweep            # try several Gabor settings (implies --reencode)
//   --wavelength 12 (with --reencode): one Gabor bank scaled to that wavelength
//   --frames 2: also replay scans as 2 fused frames (PalmTrack's mean-score fusion)
//   options: --same-session (count same-session genuine pairs too)  --threshold 0.38  --geom 0.5  --shift 3
import fs from 'node:fs';
import sharp from 'sharp';
import {
  PalmMatcher, palmReport, simulate1N, geometryDistance, hamming, codeFromBase64, gaborBank, GABOR, filterResponses, encodeCompCode, ROI_SIZE,
} from '../public/palm.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (n) => args.includes(`--${n}`);
const num = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
if (!file) { console.error('usage: node scripts/palm-report.mjs <export.json> [--reencode] [--sweep] [--same-session] [--threshold t] [--geom w] [--shift s]'); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(file, 'utf8')).samples;
const crossSession = !flag('same-session'), threshold = num('threshold', 0.38), frames = num('frames', 1), geomWeight = num('geom', 0), maxShift = num('shift', 3);
const people = new Set(raw.map((s) => s.person)), sessions = new Set(raw.map((s) => s.session));
console.log(`${raw.length} samples, ${people.size} people, ${sessions.size} sessions; genuine pairs: ${crossSession ? 'different sessions only' : 'all'}`);
if (crossSession && sessions.size < 2) console.log('  (only one session: use --same-session, or capture a second day for the realistic number)');

const grays = flag('reencode') || flag('sweep')
  ? await Promise.all(raw.map(async (s) => {
    if (!s.roi) return null;
    const { data, info } = await sharp(Buffer.from(s.roi.split(',')[1], 'base64')).greyscale().raw().toBuffer({ resolveWithObject: true });
    return info.width === ROI_SIZE && info.height === ROI_SIZE ? Float32Array.from(data) : null;
  }))
  : null;

const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '  —  ');
const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1).padStart(5) + '%' : '   —  ');

function run(label, codes) {
  const samples = raw.map((s, idx) => ({ ...s, idx, code: codes[idx] })).filter((s) => s.code);
  const n = samples.length, tex = new Float32Array(n * n), geo = new Float32Array(n * n);
  samples.forEach((s, i) => { s.idx = i; });
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (samples[i].hand !== samples[j].hand) continue;
    tex[i * n + j] = tex[j * n + i] = hamming(samples[i].code, samples[j].code, maxShift);
    geo[i * n + j] = geo[j * n + i] = samples[i].geom?.length && samples[j].geom?.length ? geometryDistance(samples[i].geom, samples[j].geom) : 0;
  }
  const d = (a, b) => tex[a.idx * n + b.idx] + geomWeight * geo[a.idx * n + b.idx];
  const r = palmReport(samples, d, { crossSession });
  const g = palmReport(samples, (a, b) => geo[a.idx * n + b.idx], { crossSession });
  const fused = Object.assign(new PalmMatcher({ threshold, maxShift }), { distance: d });
  const sims = [...new Set([1, frames])].map((f) => [f, simulate1N(samples, fused, { crossSession, frames: f })]);
  console.log(`\n== ${label}`);
  console.log(`  pairs: ${r.genuine} genuine, ${r.impostor} impostor`);
  console.log(`  genuine  median ${f3(r.genuineMedian)}  p95 ${f3(r.genuineP95)}`);
  console.log(`  impostor min    ${f3(r.impostorMin)}  p1  ${f3(r.impostorP01)}  median ${f3(r.impostorMedian)}`);
  console.log(`  EER ${pct(r.eer)} at ${f3(r.eerThr)}   genuine accept at 0 false accepts: ${pct(r.garAtZeroFar)} (thr ${f3(r.zeroFarThr)})`);
  console.log(`  geometry alone: EER ${pct(g.eer)}, genuine accept at 0 FA ${pct(g.garAtZeroFar)}`);
  const open = simulate1N(samples, fused, { frames, openSet: true });
  for (const [f, sim] of sims) {
    console.log(`  kiosk replay @ ${threshold}, ${f} frame${f > 1 ? 's fused' : ''}: ${sim.probes} scans, ${sim.correct} right (${pct(sim.correct / sim.probes).trim()}), ${sim.rejected} not recognised, ${sim.wrong.length} WRONG`);
    for (const w of sim.wrong.slice(0, 5)) console.log(`    WRONG ${w.probe.person} (${w.probe.session}) -> ${w.got} d=${f3(w.distance)}`);
  }
  console.log(`  unenrolled person (open set), ${frames} frame(s): ${open.wrong.length} of ${open.probes} given a name`);
}

if (!grays) run(`stored codes (texture + ${geomWeight}·geometry, shift ±${maxShift})`, raw.map((s) => codeFromBase64(s.code)));
else {
  const missing = grays.filter((g) => !g).length;
  if (missing) console.log(`  ${missing} samples have no ROI image and are skipped`);
  const settings = flag('sweep')
    ? [10, 12, 14, 16, 18].map((w) => ({ wavelength: w, sigmaAcross: w * 0.45, sigmaAlong: w * 0.7, size: 2 * Math.ceil(w * 1.2) + 1 }))
    : num('wavelength', 0) ? [{ wavelength: num('wavelength', 10), sigmaAcross: num('wavelength', 10) * 0.45, sigmaAlong: num('wavelength', 10) * 0.7, size: 2 * Math.ceil(num('wavelength', 10) * 1.2) + 1 }]
      : [GABOR];
  for (const p of settings) {
    const bank = gaborBank(6, p);
    run(`re-encoded λ=${p.wavelength} σ⊥=${p.sigmaAcross} σ∥=${p.sigmaAlong} k=${p.size}`, grays.map((g) => (g ? encodeCompCode(filterResponses(g, ROI_SIZE, ROI_SIZE, bank, p.size)) : null)));
  }
}
