// Thin API client + EnrollmentRepository. Token auth (Bearer) so a future iOS/Android client can reuse the same backend.
const call = async (path, body, method = body !== undefined ? 'POST' : 'GET') => {
  const token = localStorage.getItem('token');
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token && !path.startsWith('/login')) window.dispatchEvent(new Event('session-expired'));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  }
  return res;
};
const json = async (...a) => (await call(...a)).json();
const session = (r) => (localStorage.setItem('token', r.token), r.user);

export const Api = {
  register: async (id, password) => session(await json('/register', { id, password })),
  login: async (id, password) => session(await json('/login', { id, password })),
  me: async () => (await json('/me')).user,
  logout: async () => { try { await call('/logout', {}); } finally { localStorage.removeItem('token'); } },
  config: () => json('/config'),
  // students / face data
  students: async () => (await json('/students')).students,
  addStudent: async (name, descriptors, thumbnail) => (await json('/students', { name, descriptors, thumbnail, consent: true })).student,
  reenroll: async (id, descriptors, thumbnail) => (await json(`/students/${id}/face`, { descriptors, thumbnail, consent: true }, 'PUT')).student,
  deleteFace: (id) => call(`/students/${id}/face`, undefined, 'DELETE'),
  deleteStudent: (id) => call(`/students/${id}`, undefined, 'DELETE'),
  // sessions / attendance
  sessions: async () => (await json('/sessions')).sessions,
  startSession: async (name) => (await json('/sessions', { name })).session,
  session: (id) => json(`/sessions/${id}`),
  endSession: async (id) => (await json(`/sessions/${id}/end`, {})).session,
  markPresent: (sessionId, studentId, scannedAt) => json(`/sessions/${sessionId}/attendance`, { studentId, scannedAt }),
  setPresent: (sessionId, studentId, present) => json(`/sessions/${sessionId}/attendance/${studentId}`, { present }, 'PUT'),
  csv: async (id) => (await call(`/sessions/${id}/csv`)).blob(),
};
