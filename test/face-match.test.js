// Real face descriptors (face-api in Node) computed from sample photos, mocked Ollama.
// Fixtures: A, B, C = three different people; A_live1..3 = "live captures" of A
// (rotated / relit / recropped / recompressed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { detectAll, dataUrl } from './helpers/faceapi-node.js';
import { start } from './helpers/harness.js';

const F = (n) => `test/fixtures/${n}.jpg`;
const faces = {};
let s;

before(async () => {
  for (const n of ['A', 'B', 'C', 'A_live1', 'A_live2', 'A_live3']) {
    const d = await detectAll(F(n));
    assert.equal(d.length, 1, `${n} should contain exactly one face`);
    faces[n] = { descriptor: d[0].descriptor, image: dataUrl(F(n)) };
  }
  s = await start();
});
after(() => s?.close());

test('no face is found in a blank image', async () => {
  assert.equal((await detectAll(F('noface'))).length, 0);
});

test('register A and B with their faces; A logs in with each live capture', async () => {
  const tA = (await s.call('/register', { id: 'person_a', password: 'password123' })).body.token;
  const tB = (await s.call('/register', { id: 'person_b', password: 'password123' })).body.token;
  assert.equal((await s.call('/face/enroll', faces.A, tA)).status, 200);
  assert.equal((await s.call('/face/enroll', faces.B, tB)).status, 200);

  for (const live of ['A_live1', 'A_live2', 'A_live3']) {
    const r = await s.call('/login/face', faces[live]);
    assert.equal(r.status, 200, `${live} should log in`);
    assert.equal(r.body.user.id, 'person_a', `${live} must resolve to A, not B`);
  }
  // B logs in as B
  assert.equal((await s.call('/login/face', faces.B)).body.user.id, 'person_b');
});

test('a different person (C) is rejected', async () => {
  const r = await s.call('/login/face', faces.C);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Face not recognized.');
});
