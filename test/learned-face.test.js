// Template update (Face ID-style): learned samples are a separate, capped, per-session pool next to the enrolment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, fakeDescriptor } from './helpers/harness.js';

let s, t, other;
before(async () => {
  s = await start();
  t = (await s.call('/register', { id: 'teacher_l', password: 'password123' })).body.token;
  other = (await s.call('/register', { id: 'teacher_o', password: 'password123' })).body.token;
});
after(() => s.close());

const del = (path, token) => fetch(`http://127.0.0.1:${s.port}/api${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
const near = (seed, eps) => fakeDescriptor(seed).map((x, i) => x + (i % 2 ? eps : -eps));
const roster = async () => (await s.call('/students', undefined, t)).body.students;

test('learned samples: added per session, capped, removable, and they never replace the enrolment', async () => {
  const st = (await s.call('/students', { name: 'Ann', consent: true, descriptors: [fakeDescriptor(1)] }, t)).body.student;
  assert.equal((await s.call(`/students/${st.id}/face/learned`, { sessionId: 1, descriptor: near(1, 0.01) }, t)).status, 409, 'no active session');

  const sess = (await s.call('/sessions', { name: 'Math' }, t)).body.session;
  const learn = (descriptor, sessionId = sess.id, token = t) => s.call(`/students/${st.id}/face/learned`, { sessionId, descriptor }, token);
  assert.equal((await learn(near(1, 0.01))).status, 200);
  assert.equal((await learn(near(1, 0.012))).status, 200, 'same session replaces, not appends');
  assert.equal((await roster())[0].descriptors.length, 2);

  assert.equal((await learn(fakeDescriptor(50))).status, 422, 'far from the enrolled face: refused');
  assert.equal((await learn([1, 2])).status, 400);
  assert.equal((await learn(near(1, 0.01), sess.id, other)).status, 404, "another teacher's student");

  assert.equal((await del(`/students/${st.id}/face/learned/${sess.id}`, t)).status, 200);
  assert.equal((await roster())[0].descriptors.length, 1, '"Wrong person" removes what this session learned');
});

test('learned samples: at most 5 are kept (oldest dropped); re-enrol clears them', async () => {
  const st = (await s.call('/students', { name: 'Ben', consent: true, descriptors: [fakeDescriptor(2)] }, t)).body.student;
  await s.call(`/sessions/${(await s.call('/sessions', undefined, t)).body.sessions[0].id}/end`, {}, t);
  for (let i = 0; i < 7; i++) {
    const sess = (await s.call('/sessions', { name: `C${i}` }, t)).body.session;
    assert.equal((await s.call(`/students/${st.id}/face/learned`, { sessionId: sess.id, descriptor: near(2, 0.001 * (i + 1)) }, t)).status, 200);
    await s.call(`/sessions/${sess.id}/end`, {}, t);
  }
  const ben = (await roster()).find((x) => x.name === 'Ben');
  assert.equal(ben.descriptors.length, 1 + 5);
  const putFace = await fetch(`http://127.0.0.1:${s.port}/api/students/${st.id}/face`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ consent: true, descriptors: [fakeDescriptor(2)] }),
  });
  assert.equal(putFace.status, 200);
  assert.equal((await roster()).find((x) => x.name === 'Ben').descriptors.length, 1);
});
