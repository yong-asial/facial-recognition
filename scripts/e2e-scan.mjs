// Browser E2E for the attendance kiosk: real Chrome + fake webcam video.
// Usage: node scripts/e2e-scan.mjs camA.y4m camLive.y4m camC.y4m
//   camA: one still photo (enrolled, then scanned: a "photo spoof" while liveness is on)
//   camLive: the same person with natural variation between frames (passes liveness)   camC: a stranger
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [VIDEO_A, VIDEO_LIVE, VIDEO_C] = process.argv.slice(2);
const PORT = 3019, URL = `http://localhost:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync('/tmp/e2e', { recursive: true });
fs.rmSync('/tmp/e2e/app.db', { force: true });
fs.rmSync('/tmp/e2e/face.key', { force: true });

const server = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_PATH: '/tmp/e2e/app.db' }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1500));

const launch = (video) => puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`, '--autoplay-policy=no-user-gesture-required'],
});
const until = async (fn, label, timeout = 60000) => {
  const t = Date.now();
  while (Date.now() - t < timeout) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('timed out: ' + label);
};
// Headless Chrome stops delivering CDP mouse/key events once the fake camera is running, so drive the DOM directly.
const click = (page, sel) => page.$eval(sel, (e) => e.click());
const setVal = (page, sel, v) => page.$eval(sel, (e, v) => { e.value = v; }, v);
const text = (page, sel) => page.$eval(sel, (e) => e.textContent).catch(() => '');
const visible = (page, sel) => page.$eval(sel, (e) => !e.hidden).catch(() => false);
const present = (page) => text(page, '#k-present');
const submit = (page, sel) => page.$eval(sel, (f) => f.requestSubmit());
const check = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); console.log('  ✓', msg); };

async function open(video, { login = true } = {}) {
  const browser = await launch(video);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(URL);
  if (login) {
    await page.type('#f-login [name=id]', 'teacher1');
    await page.type('#f-login [name=password]', 'password123');
    await page.click('#f-login button');
    await page.waitForSelector('#v-app:not([hidden])');
  }
  return { browser, page };
}
const startSession = async (page, name) => {
  await click(page, '#tabs [data-tab=session]');
  await until(() => visible(page, '#sess-start'), 'session form');
  await setVal(page, '#f-session [name=name]', name);
  await submit(page, '#f-session');
  await until(() => visible(page, '#scan-main'), 'scan screen after starting session');
};

let browser;
try {
  const t0 = Date.now();
  // ---------- run 1: still photo ----------
  ({ browser } = await open(VIDEO_A, { login: false }));
  let page = (await browser.pages()).at(-1);
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(URL);
  await page.click('[data-go=register]');
  await page.type('#f-register [name=id]', 'teacher1');
  await page.type('#f-register [name=password]', 'password123');
  await page.click('#f-register button');
  await page.waitForSelector('#v-app:not([hidden])');

  console.log('1. SCAN with no session');
  await until(() => visible(page, '#scan-empty'), 'empty state');
  check(true, 'scan screen asks to start a session first');

  console.log('2. START SESSION');
  await startSession(page, 'Math 1A');
  check((await text(page, '#k-class')).includes('Math 1A'), 'class name shown on scan screen');

  console.log('3. ENROL (consent gate)');
  await click(page, '#tabs [data-tab=students]');
  await until(() => visible(page, '#consent'), 'consent');
  check(!(await visible(page, '#enroll-wrap')), 'enrolment hidden until consent');
  check(await page.$eval('#b-consent', (b) => b.disabled), 'Continue disabled until consent ticked');
  await click(page, '#consent-ok');
  await click(page, '#b-consent');
  await until(() => page.$eval('#enroll-hint', (e) => /press Capture/.test(e.textContent)), 'enrol camera ready');
  await setVal(page, '#f-student [name=name]', 'Alice');
  await click(page, '#f-student [name=guardian]');
  await click(page, '#b-capture');
  await until(async () => (await text(page, '#s-count')) === '1', 'student added');
  check((await text(page, '#s-list')).includes('Alice'), 'Alice enrolled (5 samples, quality-checked)');
  check(await page.$eval('#s-list img', (i) => i.src.startsWith('data:image/jpeg')), 'thumbnail stored for the confirmation card');

  console.log('4. SPOOF: a still photo is not accepted while liveness is on');
  await click(page, '#tabs [data-tab=scan]');
  await until(async () => /blink|hold still/.test(await text(page, '#kiosk-hint')), 'liveness prompt');
  await new Promise((r) => setTimeout(r, 6000));
  check((await present(page)) === '0', 'still photo NOT marked present');
  check(/blink/i.test(await text(page, '#kiosk-hint')), 'asks to blink or turn: "' + (await text(page, '#kiosk-hint')) + '"');

  console.log('5. recognised + undo + manual picker (liveness off)');
  await click(page, '#dbg-toggle');
  await click(page, '#dbg-live');
  const t1 = Date.now();
  await until(async () => (await present(page)) === '1', 'Alice marked');
  console.log(`  marked ${((Date.now() - t1) / 1000).toFixed(1)}s after liveness off`);
  check((await text(page, '#result-name')) === 'Alice' && (await page.$eval('#result-img', (i) => !i.hidden)), 'card shows name + photo');
  const dbg = await text(page, '#dbg-text');
  check(/fps/.test(dbg) && /dist/.test(dbg), 'debug overlay shows fps and distance: ' + dbg.split('\n')[0]);
  await click(page, '#result-undo');
  await until(() => visible(page, '#picker'), 'picker after undo');
  check((await present(page)) === '0', '"Wrong person" removes the mark and opens the manual picker');
  await page.$eval('#picker-list button', (b) => b.click());
  await until(async () => (await present(page)) === '1', 'manual mark');
  check(true, 'manual picker marks Alice present');
  await click(page, '#dbg-toggle');

  console.log('6. SESSION screen: live list, toggle, end, CSV');
  await click(page, '#tabs [data-tab=session]');
  await until(async () => (await text(page, '#sv-body')).includes('Alice'), 'session view');
  check((await text(page, '#sv-body')).includes('(manual)'), 'list shows Alice present (manual)');
  await click(page, '#sv-body button');
  await until(async () => (await text(page, '#sv-body')).includes('Absent'), 'toggle to absent');
  check(true, 'teacher can toggle a student absent');
  await click(page, '#sv-body button');
  await until(async () => (await text(page, '#sv-body')).includes('Present'), 'toggle back');
  await page.evaluate(() => { window.confirm = () => true; }); // CDP dialog handling is also unreliable with the fake camera
  await click(page, '#sv-end');
  await until(() => visible(page, '#sess-start'), 'back to start screen after ending');
  check((await text(page, '#sess-history')).includes('Math 1A'), 'ended session appears in history');
  const csv = await page.evaluate(async () => {
    const list = await (await fetch('/api/sessions', { headers: { Authorization: 'Bearer ' + localStorage.token } })).json();
    return (await fetch(`/api/sessions/${list.sessions[0].id}/csv`, { headers: { Authorization: 'Bearer ' + localStorage.token } })).text();
  });
  check(/"Math 1A".*"Alice","Present"/.test(csv), 'CSV export has the attendance');
  await browser.close();

  // ---------- run 2: a live person (natural variation) ----------
  console.log('7. LIVE PERSON passes liveness automatically');
  ({ browser, page } = await open(VIDEO_LIVE));
  await startSession(page, 'Math 1B');
  const t2 = Date.now();
  await until(async () => (await present(page)) === '1', 'live person marked', 90000);
  console.log(`  marked in ${((Date.now() - t2) / 1000).toFixed(1)}s (incl. camera + model warm-up)`);
  check((await text(page, '#result-name')) === 'Alice', 'Alice recognised with liveness ON');
  await click(page, '#b-kiosk');
  await click(page, '#tabs [data-tab=session]');
  await until(() => visible(page, '#sv-end'), 'end button');
  await page.evaluate(() => { window.confirm = () => true; }); // CDP dialog handling is also unreliable with the fake camera
  await click(page, '#sv-end');
  await until(() => visible(page, '#sess-start'), 'ended');
  await browser.close();

  // ---------- run 3: stranger ----------
  console.log('8. STRANGER is rejected');
  ({ browser, page } = await open(VIDEO_C));
  await startSession(page, 'Math 1C');
  await until(async () => (await text(page, '#result-name')) === 'Not recognised', 'stranger rejected');
  check((await present(page)) === '0' && (await visible(page, '#result-pick')), '"Not recognised" with a manual-pick fallback');
  console.log('OK in', ((Date.now() - t0) / 1000).toFixed(1), 's');
} catch (e) {
  console.log('FAIL', e.message);
  const pg = (await browser?.pages())?.at(-1);
  await pg?.screenshot({ path: '/tmp/e2e/fail.png' });
  process.exitCode = 1;
} finally { await browser?.close(); server.kill(); }
