// Palm feasibility spike: live landmarks + ROI + code, labelled capture, and the genuine/impostor report that decides
// whether training-free palmprint matching is good enough on this camera. Not part of the kiosk.
import { PalmService } from './palm-service.js';
import { FaceTracker } from './matching.js';
import {
  PalmMatcher, PalmTrack, palmQuality, SCAN_PALM, ENROLL_PALM, palmReport, simulate1N, geometryDistance, hamming, codeToBase64, codeFromBase64,
  CODE_SIDE, PLANES, ORIENTATIONS, ROI_SIZE,
} from './palm.js';

const $ = (s) => document.querySelector(s);
const KEY = 'palmSpike.samples';
// Same tracking + fusion the kiosk will use: hands followed by box overlap, decision over 2-3 frames (fuseDecide).
const tracker = new FaceTracker({ create: (id, box, now) => new PalmTrack(id, box, now) });
const CONFIRM_FRAMES = 2, HOLD_MS = 2500;
let shown = null; // last confirmed result, held on screen for HOLD_MS
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '—');
const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- samples (localStorage; export/import JSON for the offline report: scripts/palm-report.mjs) ----------
/** @type {{person: string, hand: 'Left'|'Right', session: string, gate: string, code: string, geom: number[], roi: string, at: number}[]} */
let saved = [];
try { saved = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { saved = []; }
let decoded = []; // saved + decoded Uint32Array code
let people = []; // decoded, grouped by person: the live roster
const redecode = () => { decoded = saved.map((s) => ({ ...s, code: codeFromBase64(s.code) })); people = groupPeople(decoded); tracker.clear(); };
redecode();
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { $('#cap-state').textContent = 'Storage full — export and clear. ' + e.message; }
  redecode(); renderSamples();
}

const today = () => new Date().toISOString().slice(0, 10);
$('#session').value = localStorage.getItem('palmSpike.session') || today();
$('#person').value = localStorage.getItem('palmSpike.person') || '';
$('#session').onchange = () => localStorage.setItem('palmSpike.session', $('#session').value.trim());
$('#person').onchange = () => localStorage.setItem('palmSpike.person', $('#person').value.trim());

function renderSamples() {
  if (!saved.length) { $('#samples').textContent = 'None.'; return; }
  const by = new Map();
  for (const s of saved) {
    const k = s.person; if (!by.has(k)) by.set(k, new Map());
    const m = by.get(k), sk = `${s.session} ${s.hand[0]}`; m.set(sk, (m.get(sk) ?? 0) + 1);
  }
  $('#samples').innerHTML = `<table><tr><th>Person</th><th>Session / hand: count</th><th></th></tr>${[...by].map(([p, m]) =>
    `<tr><td>${esc(p)}</td><td>${[...m].map(([k, n]) => `${esc(k)}: ${n}`).join(', ')}</td><td><button data-del="${esc(p)}">×</button></td></tr>`).join('')}</table>
    <div class="dim">${saved.length} samples, ${by.size} people</div>`;
}
$('#samples').onclick = (e) => {
  const p = e.target.dataset?.del;
  if (p && confirm(`Delete all samples of ${p}?`)) { saved = saved.filter((s) => s.person !== p); persist(); }
};
$('#b-clear').onclick = () => { if (confirm('Delete all samples?')) { saved = []; persist(); } };
$('#b-export').onclick = () => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify({ version: 1, samples: saved })], { type: 'application/json' })), download: `palm-samples-${today()}.json` });
  a.click(); URL.revokeObjectURL(a.href);
};
$('#b-import-btn').onclick = () => $('#b-import').click();
$('#b-import').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const data = JSON.parse(await file.text());
  saved = [...saved, ...(data.samples ?? [])]; persist(); e.target.value = '';
};
renderSamples();

// ---------- camera + models ----------
const video = $('#video'), overlay = $('#overlay'), octx = overlay.getContext('2d');
let facing = 'user', stream = null;
async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } });
  video.srcObject = stream; await video.play();
  for (const el of [video, overlay]) el.classList.toggle('mirror', facing === 'user');
}
$('#b-flip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCamera().catch((e) => hint(e.message, 'bad')); };
const hint = (t, kind = '') => { const h = $('#hint'); h.textContent = t; h.className = 'hint ' + kind; };

const tf = window.faceapi?.tf ?? null;
const palm = new PalmService({ tf });
window.palmSpike = { palm, tracker }; // console debugging
$('#gpu').checked = !!tf; $('#gpu').disabled = !tf;
$('#gpu').onchange = () => { palm.useGpu = $('#gpu').checked; };

const matcher = new PalmMatcher();
const thr = $('#thr');
const showThr = () => { matcher.threshold = Number(thr.value); $('#thr-val').textContent = matcher.threshold.toFixed(3); };
thr.oninput = showThr; showThr();

// ---------- capture ----------
let burst = 0, single = false, lastCap = 0;
$('#b-burst').onclick = () => { if (!$('#person').value.trim()) return alert('Enter a person label first'); burst = 10; };
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|SELECT|BUTTON/.test(document.activeElement?.tagName ?? '')) { e.preventDefault(); if ($('#person').value.trim()) single = true; }
});

// ---------- drawing ----------
function drawOverlay(frames, verdicts) {
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  frames.forEach((f, i) => {
    const color = verdicts[i].ok ? '#3ccf7a' : '#f0b429';
    octx.strokeStyle = 'rgba(255,255,255,.6)'; octx.lineWidth = 2;
    for (const [a, b] of BONES) { octx.beginPath(); octx.moveTo(f.pts[a].x, f.pts[a].y); octx.lineTo(f.pts[b].x, f.pts[b].y); octx.stroke(); }
    octx.strokeStyle = color; octx.lineWidth = 4; octx.beginPath();
    f.roi.corners.forEach((c, j) => (j ? octx.lineTo(c.x, c.y) : octx.moveTo(c.x, c.y))); octx.closePath(); octx.stroke();
    // Label, un-mirrored so it reads correctly over the mirrored preview.
    const x = f.roi.corners[0].x, y = Math.min(...f.roi.corners.map((c) => c.y)) - 10;
    octx.save(); octx.font = 'bold 28px system-ui'; octx.fillStyle = color;
    if (facing === 'user') { octx.scale(-1, 1); octx.fillText(verdicts[i].label, -x, y); } else octx.fillText(verdicts[i].label, x, y);
    octx.restore();
  });
}

function drawCode(code) {
  const c = $('#code').getContext('2d'), cell = 128 / CODE_SIDE;
  const winner = (bits) => [0b000, 0b001, 0b011, 0b111, 0b110, 0b100].indexOf(bits);
  for (let r = 0; r < CODE_SIDE; r++) for (let col = 0; col < CODE_SIDE; col++) {
    let bits = 0; for (let p = 0; p < PLANES; p++) bits |= ((code[p * CODE_SIDE + r] >>> col) & 1) << p;
    const valid = (code[PLANES * CODE_SIDE + r] >>> col) & 1;
    c.fillStyle = valid ? `hsl(${(winner(bits) * 360) / ORIENTATIONS} 70% 55%)` : '#111';
    c.fillRect(col * cell, r * cell, cell, cell);
  }
}

// ---------- main loop ----------
let fps = 0, lastT = performance.now(), lastVideoTime = -1, matchMs = 0, current = null;
function loop() {
  requestAnimationFrame(loop);
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const t0 = performance.now();
  const allowLeft = $('#left').checked;
  const frames = palm.analyze(video).filter((f) => allowLeft || f.hand === 'Right').sort((a, b) => b.roi.side - a.roi.side);
  const limits = $('#gate').value === 'strict' ? ENROLL_PALM : SCAN_PALM;
  const verdicts = frames.map((f) => {
    const scanQ = palmQuality(f.signals, SCAN_PALM), capQ = palmQuality(f.signals, limits);
    return { scanQ, capQ, ok: scanQ.ok, label: scanQ.ok ? `${f.hand} palm` : scanQ.hint };
  });

  // Live 1:N, tracked and fused like the kiosk, on the biggest hand that passes the scan gate.
  const iBest = verdicts.findIndex((v) => v.scanQ.ok);
  current = iBest >= 0 ? frames[iBest] : frames[0] ?? null;
  const tNow = performance.now(), live = $('#live-mode').value;
  const tm = performance.now();
  const assigned = tracker.assign(frames, tNow);
  let bestTrack = null, liveState = null;
  assigned.forEach(({ face: f, track }, i) => {
    const good = verdicts[i].scanQ.ok;
    const l = track.observe(f, good && people.length > 0, tNow, matcher, people);
    if (good) track.firstGood ??= tNow;
    if (i === iBest) { bestTrack = track; liveState = l; }
  });
  matchMs = performance.now() - tm;
  let matchHtml = people.length ? 'Show an open palm.' : 'No samples yet.';
  if (bestTrack && people.length) {
    const t = bestTrack, r = t.decide(matcher, { frames: CONFIRM_FRAMES, requireLiveness: live === 'flex' });
    const latest = t.frames[t.frames.length - 1]?.scores ?? new Map();
    const top = [...latest].sort((a, b) => a[1] - b[1]).slice(0, 3);
    let state = r.match?.student ? `hold still… (${r.frames}/${CONFIRM_FRAMES})` : r.match?.reason ?? '';
    if (r.waitingForLiveness) state = 'waiting for liveness: move your fingers a little';
    if (r.match?.student && t.handled === r.match.student.id) state = 'checked in (once per hand in view)';
    let confirmed = r.confirmed;
    if (confirmed && live === 'grip') {
      if (!t.liveness.gripPassed) { confirmed = false; if (!t.liveness.grip) t.liveness.startGrip(tNow); state = 'close your hand, then open it'; }
    }
    if (confirmed) {
      t.handled = r.match.student.id;
      shown = { name: r.match.student.name, ms: tNow - t.firstGood, at: tNow, d: r.match.distance };
    }
    verdicts[iBest].label = r.match?.student ? r.match.student.name : r.match?.reason === 'ambiguous' ? 'ambiguous' : 'unknown';
    matchHtml = `<div class="${r.match?.student ? 'ok' : 'bad'}"><strong>${r.match?.student ? esc(r.match.student.name) : esc(r.match?.reason ?? '')}</strong>
      fused d=${f2(r.match?.distance)} runner-up=${f2(r.match?.runnerUp)} <span class="dim">${esc(state)}</span></div>
      <div class="dim">this frame: ${top.map(([st, d]) => `${esc(st.name)} ${f2(d)}`).join(', ')}</div>
      <div class="dim">liveness: fingertip travel ${f2(liveState?.travel)} (pass ≥ ${t.liveness.flex}) ${t.liveness.passed ? '✓' : ''}${t.liveness.grip ? ' · grip: waiting' : t.liveness.gripPassed ? ' · grip ✓' : ''}</div>`;
  }
  if (shown && tNow - shown.at < HOLD_MS) matchHtml = `<div class="ok" style="font-size:18px">✓ <strong>${esc(shown.name)}</strong> confirmed in ${shown.ms.toFixed(0)} ms <span class="dim">(first good frame → decision, d=${f2(shown.d)})</span></div>` + matchHtml;
  $('#match').innerHTML = matchHtml;

  // Capture.
  if ((burst > 0 || single) && iBest >= 0 && verdicts[iBest].capQ.ok && performance.now() - lastCap > 150) {
    const f = frames[iBest];
    saved.push({ person: $('#person').value.trim(), hand: f.hand, session: $('#session').value.trim() || today(), gate: $('#gate').value,
      code: codeToBase64(f.code), geom: f.geom, roi: grayToCanvas(f.gray).toDataURL('image/jpeg', 0.92), at: Date.now() });
    lastCap = performance.now(); single = false; if (burst > 0) burst--;
    persist();
  }
  $('#cap-state').textContent = burst > 0 ? `capturing… ${burst} left${iBest >= 0 && !verdicts[iBest].capQ.ok ? ' — ' + verdicts[iBest].capQ.hint : ''}` : '';

  // Live panel.
  const total = performance.now() - t0, now = performance.now();
  fps = fps * 0.9 + (1000 / (now - lastT)) * 0.1; lastT = now;
  const s = current?.signals;
  $('#live').innerHTML = [
    ['hands', frames.length], ['hand', current ? `${current.hand} ${s.facing ? 'palm' : 'BACK'}` : '—'],
    ['scan gate', current ? (verdicts[frames.indexOf(current)].scanQ.ok ? '<span class="ok">ok</span>' : `<span class="warn">${verdicts[frames.indexOf(current)].scanQ.reason}</span>`) : '—'],
    ['roi side', s ? `${s.side.toFixed(0)} px` : '—'], ['flatness', s ? f2(s.flatness) : '—'], ['fingers open', s ? s.open : '—'],
    ['sharpness', s ? s.sharpness.toFixed(1) : '—'], ['brightness', s ? s.brightness.toFixed(0) : '—'], ['score', s ? f2(s.score) : '—'],
    ['detect', `${palm.timing.detect.toFixed(1)} ms (${palm.delegate})`], ['warp', `${palm.timing.warp.toFixed(1)} ms`],
    ['code', `${palm.timing.code.toFixed(1)} ms (${palm.useGpu ? 'GPU' : 'JS'})`], ['match', `${matchMs.toFixed(1)} ms`],
    ['frame total', `${total.toFixed(1)} ms`], ['fps', fps.toFixed(1)],
  ].map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
  if (current) { $('#roi').getContext('2d').drawImage(grayToCanvas(current.gray), 0, 0); drawCode(current.code); }

  drawOverlay(frames, verdicts);
  if (!frames.length) hint('Show your open palm to the camera');
  else if (iBest < 0) hint(verdicts[0].scanQ.hint, 'warn');
  else hint(verdicts[iBest].label, 'ok');
}

/** The ROI of one specific hand (the service's ROI canvas holds whichever hand was warped last). */
const grayCanvas = Object.assign(document.createElement('canvas'), { width: ROI_SIZE, height: ROI_SIZE });
function grayToCanvas(gray) {
  const ctx = grayCanvas.getContext('2d'), img = ctx.createImageData(ROI_SIZE, ROI_SIZE);
  for (let i = 0; i < gray.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = gray[i]; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return grayCanvas;
}

/** @returns {import('./palm.js').PalmEnrolled[]} */
function groupPeople(samples) {
  const m = new Map();
  for (const s of samples) { if (!m.has(s.person)) m.set(s.person, { id: m.size, name: s.person, palms: [] }); m.get(s.person).palms.push(s); }
  return [...m.values()];
}

// ---------- GPU vs JS check ----------
$('#b-check').onclick = () => {
  if (!current) return ($('#check').textContent = 'Show a palm first.');
  if (!tf) return ($('#check').textContent = 'tf not available — JS path only.');
  const g = current.gray, N = 20;
  let t = performance.now(); for (let i = 0; i < N; i++) palm.responsesJs(g); const js = (performance.now() - t) / N;
  t = performance.now(); for (let i = 0; i < N; i++) palm.responsesGpu(g); const gpu = (performance.now() - t) / N;
  const a = palm.responsesJs(g), b = palm.responsesGpu(g);
  let maxDiff = 0, maxAbs = 0; for (let i = 0; i < a.length; i++) { maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i])); maxAbs = Math.max(maxAbs, Math.abs(a[i])); }
  const useGpu = palm.useGpu;
  palm.useGpu = false; const cj = palm.encode(g); palm.useGpu = true; const cg = palm.encode(g); palm.useGpu = useGpu;
  $('#check').textContent = `filter bank: JS ${js.toFixed(1)} ms, GPU ${gpu.toFixed(1)} ms\nmax |JS-GPU| = ${maxDiff.toExponential(2)} (responses up to ${maxAbs.toFixed(2)})\ncode distance JS vs GPU = ${hamming(cj, cg, 0).toFixed(4)} (should be ~0)`;
};

// ---------- report ----------
$('#b-report').onclick = async () => {
  const btn = $('#b-report'); btn.disabled = true;
  try {
    const samples = decoded.map((s, idx) => ({ ...s, idx })), n = samples.length;
    if (n < 4) { $('#report').textContent = 'Capture at least 2 people first.'; return; }
    $('#report').textContent = `Computing ${n * (n - 1) / 2} pairs…`;
    const tex = new Float32Array(n * n), geo = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (samples[i].hand !== samples[j].hand) continue;
        tex[i * n + j] = tex[j * n + i] = hamming(samples[i].code, samples[j].code, matcher.maxShift);
        geo[i * n + j] = geo[j * n + i] = samples[i].geom.length && samples[j].geom.length ? geometryDistance(samples[i].geom, samples[j].geom) : 0;
      }
      if (i % 20 === 0) await new Promise((r) => setTimeout(r));
    }
    const gw = Number($('#gw').value) || 0, crossSession = $('#cross').checked;
    const metrics = { texture: (a, b) => tex[a.idx * n + b.idx], geometry: (a, b) => geo[a.idx * n + b.idx], [`fused (t + ${gw}·g)`]: (a, b) => tex[a.idx * n + b.idx] + gw * geo[a.idx * n + b.idx] };
    const reps = Object.entries(metrics).map(([name, fn]) => [name, palmReport(samples, fn, { crossSession })]);
    const fused = Object.assign(new PalmMatcher({ threshold: matcher.threshold, gap: matcher.gap, ratio: matcher.ratio, k: matcher.k }), { distance: metrics[Object.keys(metrics)[2]] });
    const nf = Number($('#frames').value) || 1;
    const sim = simulate1N(samples, fused, { crossSession, frames: nf }), open = simulate1N(samples, fused, { frames: nf, openSet: true });
    const rows = [['genuine pairs', 'genuine'], ['impostor pairs', 'impostor'], ['genuine median', 'genuineMedian', f2], ['genuine p95', 'genuineP95', f2],
      ['impostor min', 'impostorMin', f2], ['impostor p1', 'impostorP01', f2], ['impostor median', 'impostorMedian', f2],
      ['EER', 'eer', pct], ['EER threshold', 'eerThr', f2], ['thr @ 0 false accepts', 'zeroFarThr', f2], ['genuine accept @ 0 FA', 'garAtZeroFar', pct]];
    $('#report').innerHTML = `<table><tr><th></th>${reps.map(([k]) => `<th>${esc(k)}</th>`).join('')}</tr>${rows.map(([label, key, fmt = (v) => v]) =>
      `<tr><td>${label}</td>${reps.map(([, r]) => `<td>${fmt(r[key])}</td>`).join('')}</tr>`).join('')}</table>
      <p><strong>Kiosk replay</strong> (threshold ${matcher.threshold.toFixed(3)}, ${nf} frame${nf > 1 ? 's, guarded vote' : ''}): ${sim.probes} scans →
      <span class="ok">${sim.correct} right (${pct(sim.correct / sim.probes)})</span>, <span class="warn">${sim.rejected} not recognised</span>,
      <span class="${sim.wrong.length ? 'bad' : 'ok'}">${sim.wrong.length} WRONG person</span>.
      Unenrolled person: <span class="${open.wrong.length ? 'bad' : 'ok'}">${open.wrong.length} of ${open.probes} given a name</span></p>
      ${sim.wrong.slice(0, 5).map((w) => `<div class="bad">${esc(w.probe.person)} (${esc(w.probe.session)}) → ${esc(w.got)} d=${f2(w.distance)}</div>`).join('')}
      <p class="dim">Go/no-go: wrong = 0, unenrolled = 0, and ≥ 95% right with 2–3 frames (consecutive captures of one burst stand in for video frames).</p>`;
    drawHist(reps[2][1]);
  } finally { btn.disabled = false; }
};

function drawHist(r) {
  const c = $('#hist'); c.hidden = false;
  const ctx = c.getContext('2d'), W = c.width, H = c.height, bins = 60, lo = 0, hi = 0.6;
  ctx.clearRect(0, 0, W, H);
  const hist = (v) => { const h = new Array(bins).fill(0); for (const x of v) h[Math.min(bins - 1, Math.max(0, Math.floor(((x - lo) / (hi - lo)) * bins)))]++; const m = Math.max(1, ...h); return h.map((x) => x / m); };
  for (const [v, color] of [[r.impostorDist, 'rgba(239,83,80,.7)'], [r.genuineDist, 'rgba(60,207,122,.7)']]) {
    ctx.fillStyle = color; hist(v).forEach((x, i) => ctx.fillRect((i * W) / bins, H - x * (H - 14), W / bins - 1, x * (H - 14)));
  }
  const tx = ((matcher.threshold - lo) / (hi - lo)) * W;
  ctx.strokeStyle = '#5b9cff'; ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, H); ctx.stroke();
  ctx.fillStyle = '#9aa3b2'; ctx.font = '11px system-ui'; ctx.fillText('green = same person, red = different, blue = threshold (0 … 0.6)', 4, 11);
}

// ---------- boot ----------
(async () => {
  try {
    await Promise.all([palm.load(), startCamera()]);
    hint('Show your open palm to the camera');
    $('#roi').width = $('#roi').height = ROI_SIZE;
    loop();
  } catch (e) { hint('Could not start: ' + (e?.message ?? e), 'bad'); console.error(e); }
})();
