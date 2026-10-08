// Hits the real Ollama model (default qwen2.5vl:32b). Skipped if Ollama/model is unavailable.
// Run: npm run test:ollama   (override model with OLLAMA_MODEL=...)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkEnrollment, checkSamePerson, ollamaInfo } from '../ollama.js';

const img = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');
const F = (n) => img(`test/fixtures/${n}.jpg`);
let skip = false;

before(async () => {
  try {
    const r = await fetch(`${ollamaInfo.HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const names = (await r.json()).models.map((m) => m.name);
    if (!names.includes(ollamaInfo.MODEL)) skip = `model ${ollamaInfo.MODEL} not pulled`;
  } catch { skip = 'Ollama not reachable'; }
  if (!skip && ollamaInfo.MODE === 'off') skip = 'OLLAMA_MODE=off';
});

const t = (name, fn) => test(name, { timeout: 300_000 }, async (c) => (skip ? c.skip(skip) : fn()));

t('enrollment accepts a clear single face', async () => {
  const r = await checkEnrollment(F('A'));
  assert.equal(r.ok, true, r.reason);
});

t('enrollment rejects an image with no face', async () => {
  assert.equal((await checkEnrollment(F('noface'))).ok, false);
});

t('enrollment rejects a group photo (several faces)', async () => {
  assert.equal((await checkEnrollment(img('test/faces/sample3.jpg'))).ok, false);
});

for (const live of ['A_live1', 'A_live2', 'A_live3']) {
  t(`same person: A vs ${live} is accepted`, async () => {
    const r = await checkSamePerson(F('A'), F(live));
    assert.equal(r.ok, true, r.reason);
  });
}

for (const other of ['B', 'C']) {
  t(`different person: A vs ${other} is rejected`, async () => {
    assert.equal((await checkSamePerson(F('A'), F(other))).ok, false);
  });
}
