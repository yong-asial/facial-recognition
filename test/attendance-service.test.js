import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttendanceService } from '../public/attendance-service.js';

const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const netErr = () => new TypeError('Failed to fetch');
const httpErr = (status) => Object.assign(new Error('x'), { status });

function make(sendImpl) {
  const calls = [];
  const svc = new AttendanceService({ storage: memStorage(), now: () => 1000 + calls.length, send: async (...a) => { calls.push(a); return sendImpl(...a); } });
  return { svc, calls };
}

test('online: scan is saved immediately and nothing is queued', async () => {
  const { svc } = make((s, st, t) => ({ already: false, scannedAt: t }));
  const r = await svc.mark(1, 7);
  assert.equal(r.status, 'saved');
  assert.equal(svc.pending(), 0);
});

test('offline: scan is queued with its real time, then replayed by flush', async () => {
  let online = false;
  const { svc, calls } = make((s, st, t) => { if (!online) throw netErr(); return { scannedAt: t }; });
  const r = await svc.mark(1, 7);
  assert.equal(r.status, 'queued');
  assert.equal(svc.pending(), 1);
  assert.deepEqual((await svc.flush()), { sent: 0, dropped: 0, remaining: 1 }, 'still offline: keeps the item');
  online = true;
  assert.deepEqual(await svc.flush(), { sent: 1, dropped: 0, remaining: 0 });
  assert.equal(calls.at(-1)[2], r.scannedAt, 'replayed with original timestamp');
});

test('offline: the same student is not queued twice', async () => {
  const { svc } = make(() => { throw netErr(); });
  await svc.mark(1, 7); await svc.mark(1, 7); await svc.mark(1, 8);
  assert.equal(svc.pending(), 2);
});

test('HTTP errors are surfaced, not queued', async () => {
  const { svc } = make(() => { throw httpErr(409); });
  await assert.rejects(svc.mark(1, 7), (e) => e.status === 409);
  assert.equal(svc.pending(), 0);
});

test('flush: 4xx drops the item, 5xx keeps it and stops', async () => {
  let mode = 'offline';
  const { svc } = make((s, st) => { if (mode === 'offline') throw netErr(); if (st === 1) throw httpErr(409); if (mode === 'down') throw httpErr(503); return { scannedAt: 1 }; });
  await svc.mark(1, 1); await svc.mark(1, 2);
  mode = 'down';
  assert.deepEqual(await svc.flush(), { sent: 0, dropped: 1, remaining: 1 }, '409 for student 1 dropped; 503 for student 2 kept');
  mode = 'up';
  assert.deepEqual(await svc.flush(), { sent: 1, dropped: 0, remaining: 0 });
});

test('cancel removes a queued scan (undo before sync)', async () => {
  const { svc } = make(() => { throw netErr(); });
  await svc.mark(1, 7);
  assert.equal(svc.cancel(1, 7), true);
  assert.equal(svc.cancel(1, 7), false);
  assert.equal(svc.pending(), 0);
});
