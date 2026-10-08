// Face enroll/login endpoints with synthetic descriptors and a mocked Ollama.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { start, okOllama, JPEG, fakeDescriptor } from './helpers/harness.js';

let s;
afterEach(() => s?.close());

async function user(id) {
  return (await s.call('/register', { id, password: 'password123' })).body.token;
}

test('enroll: rejects malformed descriptor/image and requires auth', async () => {
  s = await start();
  const t = await user('erin');
  assert.equal((await s.call('/face/enroll', { descriptor: [1, 2], image: JPEG }, t)).status, 400);
  assert.equal((await s.call('/face/enroll', { descriptor: fakeDescriptor(1), image: 'nope' }, t)).status, 400);
  assert.equal((await s.call('/face/enroll', { descriptor: fakeDescriptor(1), image: JPEG })).status, 401);
});

test('enroll: Ollama rejection blocks enrollment', async () => {
  s = await start({ ...okOllama, checkEnrollment: async () => ({ ok: false, reason: 'Exactly one face must be visible.' }) });
  const t = await user('frank');
  const r = await s.call('/face/enroll', { descriptor: fakeDescriptor(1), image: JPEG }, t);
  assert.equal(r.status, 422);
  assert.match(r.body.error, /one face/);
  assert.equal((await s.call('/me', undefined, t)).body.user.hasFace, false);
});

test('enroll then face login with the same descriptor', async () => {
  s = await start();
  const t = await user('gina');
  assert.equal((await s.call('/face/enroll', { descriptor: fakeDescriptor(1), image: JPEG }, t)).body.user.hasFace, true);
  const r = await s.call('/login/face', { descriptor: fakeDescriptor(1), image: JPEG });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, 'gina');
  assert.equal((await s.call('/me', undefined, r.body.token)).body.user.id, 'gina');
});

test('face login: picks the right user among several, rejects strangers', async () => {
  s = await start();
  for (const [id, seed] of [['user1', 1], ['user2', 2], ['user3', 3]]) {
    const t = await user(id);
    await s.call('/face/enroll', { descriptor: fakeDescriptor(seed), image: JPEG }, t);
  }
  assert.equal((await s.call('/login/face', { descriptor: fakeDescriptor(2), image: JPEG })).body.user.id, 'user2');
  assert.equal((await s.call('/login/face', { descriptor: fakeDescriptor(99), image: JPEG })).status, 401);
});

test('face login: no enrolled users -> 401; bad payload -> 400', async () => {
  s = await start();
  assert.equal((await s.call('/login/face', { descriptor: fakeDescriptor(1), image: JPEG })).status, 401);
  assert.equal((await s.call('/login/face', { descriptor: 'x', image: JPEG })).status, 400);
});

test('face login: Ollama "not same person" / spoof blocks login even if descriptor matches', async () => {
  s = await start({ ...okOllama, checkSamePerson: async () => ({ ok: false, reason: 'Face did not match.' }) });
  const t = await user('hank');
  await s.call('/face/enroll', { descriptor: fakeDescriptor(1), image: JPEG }, t);
  const r = await s.call('/login/face', { descriptor: fakeDescriptor(1), image: JPEG });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Face did not match.');
});

test('face login: Ollama is not consulted when descriptor is too far', async () => {
  let called = false;
  s = await start({ ...okOllama, checkSamePerson: async () => ((called = true), { ok: true }) });
  const t = await user('ivy');
  await s.call('/face/enroll', { descriptor: fakeDescriptor(1), image: JPEG }, t);
  await s.call('/login/face', { descriptor: fakeDescriptor(50), image: JPEG });
  assert.equal(called, false);
});

test('face login: very close match skips Ollama (fast path); borderline match still uses it', async () => {
  let calls = 0;
  s = await start({ ...okOllama, checkSamePerson: async () => (calls++, { ok: true }) }, { fastAccept: 0.35 });
  const t = await user('jack');
  const d = fakeDescriptor(1);
  await s.call('/face/enroll', { descriptor: d, image: JPEG }, t);
  const near = d.map((v, i) => (i === 0 ? v + 0.1 : v));  // distance 0.1
  const mid = d.map((v, i) => (i === 0 ? v + 0.45 : v));   // distance 0.45
  assert.equal((await s.call('/login/face', { descriptor: near, image: JPEG })).status, 200);
  assert.equal(calls, 0);
  assert.equal((await s.call('/login/face', { descriptor: mid, image: JPEG })).status, 200);
  assert.equal(calls, 1);
});
