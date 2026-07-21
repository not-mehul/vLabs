/**
 * Thin fetch wrapper around the vLabs REST API.
 *
 * Tokens live in memory (module-scope) by default. The instructor token is
 * additionally persisted to sessionStorage so a portal refresh doesn't force a
 * re-login. Participant tokens are deliberately NOT persisted to storage — they
 * live only in React state, reinforcing the "zero data footprint" requirement
 * (nothing is written to disk that could outlive the tab).
 */

const INSTRUCTOR_KEY = 'vlabs.instructor.token';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Network error — is the server reachable?', 0);
  }

  if (res.status === 204) return null;

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    throw new ApiError(
      (data && data.error) || `Request failed (${res.status})`,
      res.status,
      data && data.code,
    );
  }
  return data;
}

/* ------------------------------ Instructor ------------------------------ */

export const instructorToken = {
  get: () => sessionStorage.getItem(INSTRUCTOR_KEY),
  set: (t) => sessionStorage.setItem(INSTRUCTOR_KEY, t),
  clear: () => sessionStorage.removeItem(INSTRUCTOR_KEY),
};

export const api = {
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password } }),
  me: (token) => request('/auth/me', { token }),

  listTemplates: (token) => request('/templates', { token }),
  getTemplate: (token, id) => request(`/templates/${id}`, { token }),
  createTemplate: (token, payload) =>
    request('/templates', { method: 'POST', body: payload, token }),
  updateTemplate: (token, id, payload) =>
    request(`/templates/${id}`, { method: 'PUT', body: payload, token }),
  deleteTemplate: (token, id) =>
    request(`/templates/${id}`, { method: 'DELETE', token }),
  previewTemplate: (token, id, seatId, draft) =>
    request(`/templates/${id}/preview`, {
      method: 'POST',
      body: { seat_id: seatId, draft },
      token,
    }),

  listSessions: (token) => request('/sessions', { token }),
  getSession: (token, id) => request(`/sessions/${id}`, { token }),
  createSession: (token, payload) =>
    request('/sessions', { method: 'POST', body: payload, token }),
  terminateSession: (token, id) =>
    request(`/sessions/${id}/terminate`, { method: 'POST', token }),
  extendSession: (token, id, minutes) =>
    request(`/sessions/${id}/extend`, { method: 'POST', body: { minutes }, token }),

  /* ------------------------------ Participant --------------------------- */

  join: (roomCode, seatId) =>
    request('/participant/join', {
      method: 'POST',
      body: { room_code: roomCode, seat_id: seatId },
    }),
  steps: (token) => request('/participant/steps', { token }),
  submitCheckpoint: (token, stepIndex, answer) =>
    request('/participant/checkpoint', {
      method: 'POST',
      body: { step_index: stepIndex, answer },
      token,
    }),
  reportProgress: (token, stepIndex) =>
    request('/participant/progress', {
      method: 'POST',
      body: { step_index: stepIndex },
      token,
    }),
  heartbeat: (token) => request('/participant/heartbeat', { method: 'POST', token }),
};
