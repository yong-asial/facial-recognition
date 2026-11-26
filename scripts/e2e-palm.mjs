// Browser E2E for palm check-in: real Chrome + MediaPipe + fake webcam.
// Usage: node scripts/e2e-palm.mjs palmA.y4m [palmB.y4m]
//   palmA: a still photo of an open right palm (enrolled, then scanned). palmB (optional): another person's palm (stranger).
// Make one from any palm photo (keep the whole palm, wrist included, inside the frame):
//   ffmpeg -loop 1 -framerate 15 -t 30 -i palm.jpg -vf "scale=720:540,pad=1280:720:280:150:white" -pix_fmt yuv420p palmA.y4m
// Needs the hand model: npm run models.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [VIDEO_A, VIDEO_B] = process.argv.slice(2);
if (!VIDEO_A) { console.error('usage: node scripts/e2e-palm.mjs palmA.y4m [palmB.y4m]'); process.exit(1); }
const PORT = 3021, URL = `http://localhost:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palm-e2e-'));
const server = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_PATH: path.join(dir, 'app.db') }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1500));

const launch = (video) => puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`, '--autoplay-policy=no-user-gesture-required'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, timeout = 60000) => {
  const t = Date.now();
  while (Date.now() - t < timeout) { const v = await fn().catch(() => null); if (v) return v; await sleep(100); }
  throw new Error('timed out: ' + label);
};
// Headless Chrome stops delivering CDP input once the fake camera runs, so drive the DOM directly (as in e2e-scan.mjs).
const click = (page, sel) => page.$eval(sel, (e) => e.click());
const setVal = (page, sel, v) => page.$eval(sel, (e, v) => { e.value = v; }, v);
const setOpt = (page, sel, v) => page.$eval(sel, (e, v) => { if (e.type === 'checkbox') e.checked = v; else e.value = v; e.dispatchEvent(new Event('change')); }, v);
const text = (page, sel) => page.$eval(sel, (e) => e.textContent).catch(() => '');
const visible = (page, sel) => page.$eval(sel, (e) => !e.hidden).catch(() => false);
const present = (page) => text(page, '#k-present');
const check = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); console.log('  ✓', msg); };
const withHint = async (page, p) => p.catch(async (e) => { throw new Error(`${e.message} (kiosk: "${await text(page, '#kiosk-hint')}", enrol: "${await text(page, '#enroll-hint')}", msg: "${await text(page, '#msg')}")`); });

async function open(video) {
  const browser = await launch(video);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(URL);
  return { browser, page };
}
const startSession = async (page, name) => {
  await click(page, '#tabs [data-tab=session]');
  await until(() => visible(page, '#sess-start'), 'session form');
  await setVal(page, '#f-session [name=name]', name);
  await page.$eval('#f-session', (f) => f.requestSubmit());
  await until(() => visible(page, '#scan-main'), 'scan screen');
};
// The End button's confirm() dialog is unreliable under headless + fake camera: end it through the API instead.
const endSession = async (page) => {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const auth = { Authorization: `Bearer ${token}` };
  const active = (await (await fetch(`${URL}/api/sessions`, { headers: auth })).json()).sessions.find((x) => x.active);
  await fetch(`${URL}/api/sessions/${active.id}/end`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#v-app:not([hidden])');
};

let browser;
try {
  let page;
  ({ browser, page } = await open(VIDEO_A));
  await click(page, '[data-go=register]');
  await page.type('#f-register [name=id]', 'teacher_palm');
  await page.type('#f-register [name=password]', 'password123');
  await click(page, '#f-register button');
  await page.waitForSelector('#v-app:not([hidden])');

  console.log('1. ENROL A PALM (right hand, strict gate, palm-only student)');
  await click(page, '#tabs [data-tab=students]');
  await until(() => visible(page, '#consent'), 'consent');
  check((await text(page, '#consent')).includes('palm-line template'), 'consent notice mentions palm data');
  await click(page, '#consent-ok'); await click(page, '#b-consent');
  await until(() => page.$eval('#enroll-hint', (e) => /press Capture/.test(e.textContent)), 'enrol camera ready');
  await setVal(page, '#f-student [name=name]', 'Palm Pat');
  await click(page, '#f-student [name=guardian]');
  const te = Date.now();
  await click(page, '#b-capture-palm');
  await withHint(page, until(async () => /Saved Palm Pat/.test(await text(page, '#enroll-hint')), 'palm saved'));
  console.log(`  enrolled in ${((Date.now() - te) / 1000).toFixed(1)}s (incl. hand model load)`);
  check((await text(page, '#s-list')).includes('palm: right'), 'roster shows the palm tag');
  check((await text(page, '#s-list')).includes('no face data'), 'palm-only student (no face data)');
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/palm-enrol.png` });

  console.log('2. SCAN WITH PALM (liveness off): marked present, method palm');
  await startSession(page, 'Palm Class');
  await setOpt(page, '#opt-live', 'off');
  await setOpt(page, '#opt-method', 'palm');
  await click(page, '#dbg-toggle');
  const ts = Date.now();
  await withHint(page, until(async () => (await present(page)) === '1', 'palm check-in'));
  console.log(`  marked ${((Date.now() - ts) / 1000).toFixed(1)}s after switching to palm (model already loaded by enrolment; incl. camera restart)`);
  check((await text(page, '#result-name')) === 'Palm Pat', 'card shows the name');
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/palm-scan.png` });
  await until(async () => /checked in/.test(await text(page, '#kiosk-hint')), 'checked-in hint', 5000);
  check(true, 'hint says the student is checked in while the hand stays: "' + (await text(page, '#kiosk-hint')) + '"');
  check(/threshold 0\.3\d\d/.test(await text(page, '#dbg-text')), 'debug overlay shows palm metrics: ' + (await text(page, '#dbg-text')).split('\n')[0]);
  check((await page.$eval('#opt-live', (s) => s.options[0].textContent)).includes('Finger movement'), 'liveness menu reworded for palm');
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const sessions = await (await fetch(`${URL}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const rec = await (await fetch(`${URL}/api/sessions/${sessions.sessions[0].id}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  check(rec.records.find((r) => r.name === 'Palm Pat')?.source === 'palm', 'attendance recorded with method "palm"');

  console.log('3. SPOOF: a still photo of a palm is not accepted with passive liveness');
  await setOpt(page, '#opt-live', 'passive'); // before the new session starts the scanner (settings persist per browser)
  await endSession(page);
  await startSession(page, 'Palm Class 2');
  await withHint(page, until(async () => /fingers/.test(await text(page, '#kiosk-hint')), 'liveness prompt'));
  await sleep(5000);
  check((await present(page)) === '0', 'still palm photo NOT marked present');
  check(/Move your fingers/.test(await text(page, '#kiosk-hint')), 'asks to move the fingers: "' + (await text(page, '#kiosk-hint')) + '"');

  console.log('4. SETTINGS PERSIST, FACE MODE STILL WORKS');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#v-app:not([hidden])');
  check((await page.$eval('#opt-method', (s) => s.value)) === 'palm', '"Scan with" is remembered per browser');
  await setOpt(page, '#opt-method', 'face');
  await until(async () => /No enrolled faces/.test(await text(page, '#kiosk-hint')), 'face mode');
  check(true, 'face mode with a palm-only roster says there are no enrolled faces');
  await browser.close(); browser = null;

  if (VIDEO_B) {
    console.log('5. STRANGER: a different palm is not recognised');
    ({ browser, page } = await open(VIDEO_B));
    await page.waitForSelector('#v-app:not([hidden])').catch(async () => {
      await page.type('#f-login [name=id]', 'teacher_palm'); await page.type('#f-login [name=password]', 'password123');
      await click(page, '#f-login button'); await page.waitForSelector('#v-app:not([hidden])');
    });
    await setOpt(page, '#opt-method', 'palm');
    await setOpt(page, '#opt-live', 'off');
    await withHint(page, until(async () => /not recognised/i.test(await text(page, '#kiosk-hint')) || (await present(page)) !== '0', 'stranger verdict', 30000));
    await sleep(3000);
    check((await present(page)) === '0', 'stranger NOT marked present');
    check(/not recognised/i.test(await text(page, '#kiosk-hint')), 'says "Palm not recognised"');
  }
  console.log('\nALL PALM E2E CHECKS PASSED');
} catch (e) {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
