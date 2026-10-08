import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers/harness.js';

let s;
before(async () => (s = await start()));
after(() => s.close());

test('register: validates id and password', async () => {
  assert.equal((await s.call('/register', { id: 'ab', password: 'password123' })).status, 400);
  assert.equal((await s.call('/register', { id: 'bad id!', password: 'password123' })).status, 400);
  assert.equal((await s.call('/register', { id: 'validid', password: 'short' })).status, 400);
  assert.equal((await s.call('/register', {})).status, 400);
});

test('register: creates account, returns token, rejects duplicate id', async () => {
  const r = await s.call('/register', { id: 'alice', password: 'password123' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.user, { id: 'alice', hasFace: false });
  assert.match(r.body.token, /^[0-9a-f]{64}$/);
  assert.equal((await s.call('/register', { id: 'alice', password: 'otherpass123' })).status, 409);
});

test('login: correct password works, wrong/unknown fails with same message', async () => {
  await s.call('/register', { id: 'bob', password: 'password123' });
  const ok = await s.call('/login', { id: 'bob', password: 'password123' });
  assert.equal(ok.status, 200);
  const wrong = await s.call('/login', { id: 'bob', password: 'nope-nope' });
  const unknown = await s.call('/login', { id: 'ghost', password: 'password123' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error, unknown.body.error); // no user enumeration
});

test('session: /me needs a valid token; logout invalidates it', async () => {
  assert.equal((await s.call('/me')).status, 401);
  assert.equal((await s.call('/me', undefined, 'bogus')).status, 401);
  const { body } = await s.call('/register', { id: 'carol', password: 'password123' });
  assert.equal((await s.call('/me', undefined, body.token)).body.user.id, 'carol');
  assert.equal((await s.call('/logout', {}, body.token)).status, 200);
  assert.equal((await s.call('/me', undefined, body.token)).status, 401);
});

test('login: throttles after 10 failures', async () => {
  await s.call('/register', { id: 'dave', password: 'password123' });
  for (let i = 0; i < 10; i++) await s.call('/login', { id: 'dave', password: 'wrong-pass' });
  assert.equal((await s.call('/login', { id: 'dave', password: 'password123' })).status, 429);
});
