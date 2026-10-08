import { createApp } from '../../app.js';

export const okOllama = {
  checkEnrollment: async () => ({ ok: true }),
  checkSamePerson: async () => ({ ok: true }),
  ollamaInfo: { MODE: 'test', MODEL: 'mock' },
};

export async function start(ollama = okOllama, opts = {}) {
  const server = createApp({ dbPath: ':memory:', ollama, fastAccept: 0, ...opts }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

export const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
export const fakeDescriptor = (seed) => Array.from({ length: 128 }, (_, i) => Math.sin(seed * 31 + i) * 0.2);
