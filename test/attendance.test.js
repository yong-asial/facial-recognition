import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, fakeDescriptor } from './helpers/harness.js';
import { createApp } from '../app.js';
import { createCipher } from '../crypto-store.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let s, t1, t2;
before(async () => {
  s = await start();
  t1 = (await s.call('/register', { id: 'teacher1', password: 'password123' })).body.token;
  t2 = (await s.call('/register', { id: 'teacher2', password: 'password123' })).body.token;
});
after(() => s.close());

const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const enroll = (name, seed, token = t1, extra = {}) =>
  s.call('/students', { name, consent: true, thumbnail: THUMB, descriptors: [fakeDescriptor(seed), fakeDescriptor(seed + 0.01)], ...extra }, token);
const del = (path, token) => fetch(`http://127.0.0.1:${s.port}/api${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
const put = (path, body, token) => fetch(`http://127.0.0.1:${s.port}/api${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test('students: need auth, valid data and explicit consent', async () => {
  assert.equal((await s.call('/students')).status, 401);
  assert.equal((await enroll('', 1)).status, 400);
  assert.equal((await s.call('/students', { name: 'X', consent: true, descriptors: [] }, t1)).status, 400);
  assert.equal((await s.call('/students', { name: 'X', consent: true, descriptors: [[1, 2, 3]] }, t1)).status, 400);
  assert.equal((await s.call('/students', { name: 'X', descriptors: [fakeDescriptor(1)] }, t1)).status, 400, 'no consent flag');
  assert.equal((await enroll('X', 1, t1, { thumbnail: 'http://evil' })).status, 400);
});

test('students: listed only for the owning teacher, with face data', async () => {
  await enroll('Alice', 1);
  await enroll('Bob', 2, t2);
  const mine = (await s.call('/students', undefined, t1)).body.students;
  assert.deepEqual(mine.map((x) => x.name), ['Alice']);
  assert.equal(mine[0].hasFace, true);
  assert.equal(mine[0].descriptors[0].length, 128);
  assert.equal(mine[0].thumbnail, THUMB);
});

test('face data is encrypted at rest: the DB file holds no readable descriptors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'face-enc-'));
  const cipher = createCipher({ keyHex: 'ab'.repeat(32) });
  const server = createApp({ dbPath: path.join(dir, 'x.db'), cipher }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const j = async (p, body, token) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) })).json();
  const { token } = await j('/register', { id: 'enc_teacher', password: 'password123' });
  await j('/students', { name: 'Z', consent: true, descriptors: [fakeDescriptor(9)], thumbnail: THUMB }, token);
  const raw = new DatabaseSync(path.join(dir, 'x.db')).prepare('SELECT face_data FROM students').get().face_data;
  assert.ok(!raw.includes('['), 'not JSON');
  assert.ok(!Buffer.from(raw, 'base64').toString('latin1').includes(THUMB.slice(0, 20)), 'thumbnail not readable');
  assert.deepEqual(cipher.decrypt(raw).descriptors[0], fakeDescriptor(9));
  assert.throws(() => createCipher({ keyHex: 'cd'.repeat(32) }).decrypt(raw), 'wrong key must fail');
  await new Promise((r) => server.close(r));
});

test('sessions: one active at a time; start, scan, already, end', async () => {
  const { body: { student } } = await enroll('Carol', 3);
  assert.equal((await s.call('/sessions', { name: '' }, t1)).status, 400);
  const start1 = await s.call('/sessions', { name: 'Math 1A' }, t1);
  assert.equal(start1.status, 200);
  assert.equal(start1.body.session.active, true);
  assert.equal((await s.call('/sessions', { name: 'Other' }, t1)).status, 409);
  const id = start1.body.session.id;

  const a = await s.call(`/sessions/${id}/attendance`, { studentId: student.id }, t1);
  assert.equal(a.body.already, false);
  const b = await s.call(`/sessions/${id}/attendance`, { studentId: student.id }, t1);
  assert.equal(b.body.already, true);
  assert.equal(b.body.scannedAt, a.body.scannedAt);

  const detail = (await s.call(`/sessions/${id}`, undefined, t1)).body;
  assert.equal(detail.records.find((r) => r.id === student.id).present, true);
  assert.ok(detail.records.some((r) => r.name === 'Alice' && !r.present), 'absent students are listed');

  assert.equal((await s.call(`/sessions/${id}/end`, {}, t1)).body.session.active, false);
  assert.equal((await s.call(`/sessions/${id}/attendance`, { studentId: student.id }, t1)).status, 409, 'face scan blocked after end');
  assert.equal((await s.call('/sessions', { name: 'Math 1B' }, t1)).status, 200, 'can start a new one after ending');
});

test('sessions: queued offline scans keep their real timestamp', async () => {
  const sess = (await s.call('/sessions', undefined, t1)).body.sessions[0];
  const { body: { student } } = await enroll('Frank', 6);
  const t = Date.now() - 1000;
  const r = await s.call(`/sessions/${sess.id}/attendance`, { studentId: student.id, scannedAt: t }, t1);
  assert.equal(r.body.scannedAt, t);
});

test('sessions: manual toggle and undo work, even after the session ended', async () => {
  const sessions = (await s.call('/sessions', undefined, t1)).body.sessions;
  const ended = sessions.find((x) => !x.active);
  const { body: { student } } = await enroll('Gina', 7);
  assert.equal((await put(`/sessions/${ended.id}/attendance/${student.id}`, { present: true }, t1)).status, 200);
  let rec = (await s.call(`/sessions/${ended.id}`, undefined, t1)).body.records.find((r) => r.id === student.id);
  assert.deepEqual([rec.present, rec.source], [true, 'manual']);
  await put(`/sessions/${ended.id}/attendance/${student.id}`, { present: false }, t1);
  rec = (await s.call(`/sessions/${ended.id}`, undefined, t1)).body.records.find((r) => r.id === student.id);
  assert.equal(rec.present, false);
  assert.equal((await put(`/sessions/${ended.id}/attendance/${student.id}`, { present: 'yes' }, t1)).status, 400);
});

test("isolation: teachers cannot touch each other's sessions or students", async () => {
  const { body: { student } } = await enroll('Dave', 4, t2);
  const sess = (await s.call('/sessions', undefined, t1)).body.sessions[0];
  assert.equal((await s.call(`/sessions/${sess.id}/attendance`, { studentId: student.id }, t1)).status, 404);
  assert.equal((await s.call(`/sessions/${sess.id}`, undefined, t2)).status, 404);
  assert.equal((await put(`/sessions/${sess.id}/attendance/${student.id}`, { present: true }, t2)).status, 404);
  assert.equal((await del(`/students/${student.id}`, t1)).status, 404);
  assert.equal((await del(`/students/${student.id}/face`, t1)).status, 404);
});

test('csv export lists class, date, status and method', async () => {
  const sess = (await s.call('/sessions', undefined, t1)).body.sessions.find((x) => x.name === 'Math 1A');
  const res = await fetch(`http://127.0.0.1:${s.port}/api/sessions/${sess.id}/csv`, { headers: { Authorization: `Bearer ${t1}` } });
  const csv = await res.text();
  assert.match(csv, /^Class,Date,Name,Status,Method,Checked in at\n/);
  assert.match(csv, /"Math 1A","\d{4}-\d{2}-\d{2}","Carol","Present","face"/);
  assert.match(csv, /"Alice","Absent","",""/);
});

test('delete face data keeps the student but erases the face; re-enroll needs consent; remove deletes all', async () => {
  const { body: { student } } = await enroll('Eve', 5);
  assert.equal((await del(`/students/${student.id}/face`, t1)).status, 200);
  let me = (await s.call('/students', undefined, t1)).body.students.find((x) => x.id === student.id);
  assert.deepEqual([me.hasFace, me.descriptors.length, me.thumbnail], [false, 0, null]);
  assert.equal((await put(`/students/${student.id}/face`, { descriptors: [fakeDescriptor(5)] }, t1)).status, 400, 'no consent');
  assert.equal((await put(`/students/${student.id}/face`, { consent: true, descriptors: [fakeDescriptor(5)] }, t1)).status, 200);
  me = (await s.call('/students', undefined, t1)).body.students.find((x) => x.id === student.id);
  assert.equal(me.hasFace, true);
  assert.equal((await del(`/students/${student.id}`, t1)).status, 200);
  assert.ok(!(await s.call('/students', undefined, t1)).body.students.some((x) => x.id === student.id));
});
