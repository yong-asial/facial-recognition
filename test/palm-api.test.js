// Palm data API: enrolment (separate encrypted column + consent), per-hand re-enrol / delete, attendance method.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, fakeDescriptor } from './helpers/harness.js';
import { createApp } from '../app.js';
import { createCipher } from '../crypto-store.js';
import { CODE_WORDS, codeToBase64, codeFromBase64 } from '../public/palm.js';

let s, t, other;
before(async () => {
  s = await start();
  t = (await s.call('/register', { id: 'teacher_p', password: 'password123' })).body.token;
  other = (await s.call('/register', { id: 'teacher_q', password: 'password123' })).body.token;
});
after(() => s.close());

const code = (seed) => codeToBase64(Uint32Array.from({ length: CODE_WORDS }, (_, i) => (Math.imul(seed * 2654435761 + i, 2246822519) >>> 0)));
const palm = (hand, ...seeds) => seeds.map((n) => ({ hand, code: code(n) }));
const req = async (method, p, body, token = t) => {
  const res = await fetch(`http://127.0.0.1:${s.port}/api${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('palm-only student: created with consent, listed with codes, no face', async () => {
  const r = await s.call('/students', { name: 'Palm Pat', consent: true, palm: palm('Right', 1, 2, 3) }, t);
  assert.equal(r.status, 200);
  assert.equal(r.body.student.hasPalm, true); assert.equal(r.body.student.hasFace, false);
  assert.deepEqual(r.body.student.descriptors, []);
  const listed = (await s.call('/students', undefined, t)).body.students.find((x) => x.name === 'Palm Pat');
  assert.equal(listed.palms.length, 3);
  assert.deepEqual(codeFromBase64(listed.palms[0].code), codeFromBase64(code(1)), 'code round-trips');
  assert.deepEqual(Object.keys(listed.palms[0]).sort(), ['code', 'hand', 'v']);
});

test('student creation: face, palm or both; each needs consent and valid data', async () => {
  assert.equal((await s.call('/students', { name: 'Nobody', consent: true }, t)).status, 400, 'no biometric data at all');
  assert.equal((await s.call('/students', { name: 'X', palm: palm('Right', 1) }, t)).status, 400, 'no consent');
  const bad = [
    [{ hand: 'Middle', code: code(1) }],
    [{ hand: 'Right', code: code(1).slice(0, -8) }],
    [{ hand: 'Right', code: '!!!not base64!!!' }],
    [{ hand: 'Right' }],
    [],
    palm('Right', ...Array.from({ length: 11 }, (_, i) => i)),
  ];
  for (const p of bad) assert.equal((await s.call('/students', { name: 'X', consent: true, palm: p }, t)).status, 400, JSON.stringify(p).slice(0, 60));
  const both = await s.call('/students', { name: 'Both Bo', consent: true, descriptors: [fakeDescriptor(4)], palm: palm('Left', 5) }, t);
  assert.equal(both.status, 200);
  assert.equal(both.body.student.hasFace, true); assert.equal(both.body.student.hasPalm, true);
  assert.equal((await s.call('/students', { name: 'X', consent: true, descriptors: [[1]], palm: palm('Left', 5) }, t)).status, 400, 'bad face fails the whole request');
  assert.equal((await s.call('/students', { name: 'X', consent: true, palm: palm('Left', ...Array.from({ length: 10 }, (_, i) => i)).concat(palm('Right', ...Array.from({ length: 10 }, (_, i) => i))) }, t)).status, 200, '10 per hand is fine');
});

test('palm template version: stored and returned (missing = 1), invalid values refused', async () => {
  const r = await s.call('/students', { name: 'Ver Vi', consent: true, palm: [{ hand: 'Right', code: code(1), v: 2 }, { hand: 'Left', code: code(2) }] }, t);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.student.palms.map((p) => [p.hand, p.v]), [['Right', 2], ['Left', 1]]);
  for (const v of [0, 1.5, '2', 100]) assert.equal((await s.call('/students', { name: 'X', consent: true, palm: [{ hand: 'Right', code: code(1), v }] }, t)).status, 400, `v=${v}`);
});

test('PUT palm: enrols a face-only student; re-enrolling one hand keeps the other', async () => {
  const st = (await s.call('/students', { name: 'Face Fay', consent: true, descriptors: [fakeDescriptor(7)] }, t)).body.student;
  assert.equal(st.hasPalm, false);
  assert.equal((await req('PUT', `/students/${st.id}/palm`, { palm: palm('Right', 1) })).status, 400, 'consent required');
  let r = await req('PUT', `/students/${st.id}/palm`, { consent: true, palm: palm('Right', 1, 2) });
  assert.equal(r.status, 200); assert.equal(r.body.student.hasFace, true, 'face untouched');
  r = await req('PUT', `/students/${st.id}/palm`, { consent: true, palm: palm('Left', 3) });
  assert.deepEqual(r.body.student.palms.map((p) => p.hand).sort(), ['Left', 'Right', 'Right']);
  r = await req('PUT', `/students/${st.id}/palm`, { consent: true, palm: palm('Right', 9) });
  assert.deepEqual(r.body.student.palms.map((p) => `${p.hand}:${p.code === code(9) ? 9 : p.code === code(3) ? 3 : '?'}`).sort(), ['Left:3', 'Right:9']);
  assert.equal((await req('PUT', `/students/${st.id}/palm`, { consent: true, palm: palm('Right', 1) }, other)).status, 404, "another teacher's student");
  assert.equal((await req('PUT', '/students/99999/palm', { consent: true, palm: palm('Right', 1) })).status, 404);
});

test('DELETE palm: one hand, or all palm data; face and student stay', async () => {
  const st = (await s.call('/students', { name: 'Del Dee', consent: true, descriptors: [fakeDescriptor(8)], palm: [...palm('Right', 1), ...palm('Left', 2)] }, t)).body.student;
  assert.equal((await req('DELETE', `/students/${st.id}/palm?hand=Middle`)).status, 400);
  let r = await req('DELETE', `/students/${st.id}/palm?hand=Left`);
  assert.deepEqual(r.body.student.palms.map((p) => p.hand), ['Right']);
  r = await req('DELETE', `/students/${st.id}/palm`);
  assert.equal(r.body.student.hasPalm, false); assert.deepEqual(r.body.student.palms, []);
  assert.equal(r.body.student.hasFace, true);
  assert.equal((await req('DELETE', `/students/${st.id}/palm`, undefined, other)).status, 404);
  // Deleting the only remaining hand clears the consent too.
  const st2 = (await s.call('/students', { name: 'Del Two', consent: true, palm: palm('Left', 2) }, t)).body.student;
  assert.equal((await req('DELETE', `/students/${st2.id}/palm?hand=Left`)).body.student.hasPalm, false);
});

test('attendance method: palm scans are recorded as palm (and shown in the CSV); default stays face', async () => {
  const p = (await s.call('/students', { name: 'Scan Sam', consent: true, palm: palm('Right', 1) }, t)).body.student;
  const f = (await s.call('/students', { name: 'Scan Fio', consent: true, descriptors: [fakeDescriptor(3)] }, t)).body.student;
  const sess = (await s.call('/sessions', { name: 'Palm Class' }, t)).body.session;
  assert.equal((await s.call(`/sessions/${sess.id}/attendance`, { studentId: p.id, method: 'retina' }, t)).status, 400);
  assert.equal((await s.call(`/sessions/${sess.id}/attendance`, { studentId: p.id, method: 'palm' }, t)).status, 200);
  assert.equal((await s.call(`/sessions/${sess.id}/attendance`, { studentId: f.id }, t)).status, 200);
  const again = await s.call(`/sessions/${sess.id}/attendance`, { studentId: p.id, method: 'face' }, t);
  assert.equal(again.body.already, true);
  const recs = (await s.call(`/sessions/${sess.id}`, undefined, t)).body.records;
  assert.equal(recs.find((r) => r.id === p.id).source, 'palm', 'first method kept');
  assert.equal(recs.find((r) => r.id === f.id).source, 'face');
  const csv = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions/${sess.id}/csv`, { headers: { Authorization: `Bearer ${t}` } })).text();
  assert.match(csv, /"Scan Sam","Present","palm"/);
  await s.call(`/sessions/${sess.id}/end`, {}, t);
});

test('palm data is encrypted at rest, and an existing database gets the palm columns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palm-enc-'));
  const file = path.join(dir, 'x.db');
  // A database from before palm support (students without palm columns).
  new DatabaseSync(file).exec(`CREATE TABLE students (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id TEXT NOT NULL, name TEXT NOT NULL,
    face_data TEXT, consent_at INTEGER, created_at INTEGER NOT NULL); INSERT INTO students (teacher_id,name,created_at) VALUES ('enc_p','Old',1);`);
  const cipher = createCipher({ keyHex: 'ab'.repeat(32) });
  const server = createApp({ dbPath: file, cipher }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const j = async (p, body, token, method = 'POST') => (await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) })).json();
  const { token } = await j('/register', { id: 'enc_p', password: 'password123' });
  const old = (await (await fetch(base + '/students', { headers: { Authorization: `Bearer ${token}` } })).json()).students[0];
  assert.equal(old.name, 'Old'); assert.equal(old.hasPalm, false);
  await j(`/students/${old.id}/palm`, { consent: true, palm: palm('Right', 42) }, token, 'PUT');
  const row = new DatabaseSync(file).prepare('SELECT palm_data, palm_consent_at FROM students').get();
  assert.ok(row.palm_consent_at > 0);
  assert.ok(!row.palm_data.includes(code(42).slice(0, 24)), 'code not stored in the clear');
  assert.deepEqual(cipher.decrypt(row.palm_data).templates, palm('Right', 42).map((t) => ({ ...t, v: 1 })));
  await new Promise((r) => server.close(r));
});
