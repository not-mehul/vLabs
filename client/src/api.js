/**
 * Thin fetch wrapper around the vLabs REST API.
 *
 * The instructor token is persisted to sessionStorage so a portal refresh
 * doesn't force a re-login. The participant token is persisted to localStorage
 * so a participant who accidentally closes their browser can return and resume
 * their session and progress. Only the access token is stored — never any lab
 * content — and the server still gates every request against the live session,
 * so the stored token is worthless the moment the session ends or expires.
 */

const INSTRUCTOR_KEY = 'vlabs.instructor.token';
const PARTICIPANT_KEY = 'vlabs.participant.session';

export class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
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
      data && data.details,
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

/**
 * Persisted participant session (token + display metadata) enabling resume
 * after an accidental browser close. Stored in localStorage so it survives a
 * full browser restart; cleared automatically when the session ends.
 */
export const participantSession = {
  get() {
    try {
      const raw = localStorage.getItem(PARTICIPANT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(session) {
    try {
      localStorage.setItem(PARTICIPANT_KEY, JSON.stringify(session));
    } catch {
      /* storage may be unavailable (private mode / quota); resume just won't work */
    }
  },
  clear() {
    try {
      localStorage.removeItem(PARTICIPANT_KEY);
    } catch {
      /* ignore */
    }
  },
};

export const api = {
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password } }),
  me: (token) => request('/auth/me', { token }),
  changePassword: (token, currentPassword, newPassword) =>
    request('/auth/password', {
      method: 'PUT',
      body: { current_password: currentPassword, new_password: newPassword },
      token,
    }),

  listTemplates: (token, { includeArchived = false } = {}) =>
    request(`/templates${includeArchived ? '?include_archived=1' : ''}`, { token }),
  templateFunctions: (token) => request('/templates/functions', { token }),
  getTemplate: (token, id) => request(`/templates/${id}`, { token }),
  getTemplateAudit: (token, id) => request(`/templates/${id}/audit`, { token }),
  createTemplate: (token, payload) =>
    request('/templates', { method: 'POST', body: payload, token }),
  updateTemplate: (token, id, payload) =>
    request(`/templates/${id}`, { method: 'PUT', body: payload, token }),
  /** Archive (default) or permanently delete a template. */
  deleteTemplate: (token, id, { permanent = false } = {}) =>
    request(`/templates/${id}${permanent ? '?permanent=1' : ''}`, { method: 'DELETE', token }),
  restoreTemplate: (token, id) => request(`/templates/${id}/restore`, { method: 'POST', token }),
  previewTemplate: (token, id, seatId, draft) =>
    request(`/templates/${id}/preview`, {
      method: 'POST',
      body: { seat_id: seatId, draft },
      token,
    }),

  listSessions: (token) => request('/sessions', { token }),
  getSession: (token, id) => request(`/sessions/${id}`, { token }),
  createSession: (token, payload) => request('/sessions', { method: 'POST', body: payload, token }),
  terminateSession: (token, id) => request(`/sessions/${id}/terminate`, { method: 'POST', token }),
  extendSession: (token, id, minutes) =>
    request(`/sessions/${id}/extend`, { method: 'POST', body: { minutes }, token }),
  pushTemplate: (token, id) => request(`/sessions/${id}/push-template`, { method: 'POST', token }),
  deleteSession: (token, id) => request(`/sessions/${id}`, { method: 'DELETE', token }),
  exportSession: (token, id) => request(`/sessions/${id}/export`, { token }),

  /* ------------------------------ Participant --------------------------- */

  join: (roomCode, firstName, lastName) =>
    request('/participant/join', {
      method: 'POST',
      body: { room_code: roomCode, first_name: firstName, last_name: lastName },
    }),
  content: (token) => request('/participant/content', { token }),
  submitCheckpoint: (token, sectionIndex, stepIndex, answer) =>
    request('/participant/checkpoint', {
      method: 'POST',
      body: { section_index: sectionIndex, step_index: stepIndex, answer },
      token,
    }),
  reportProgress: (token, sectionIndex) =>
    request('/participant/progress', {
      method: 'POST',
      body: { section_index: sectionIndex },
      token,
    }),
  recordHint: (token, sectionIndex, stepIndex, hintIndex) =>
    request('/participant/hint', {
      method: 'POST',
      body: { section_index: sectionIndex, step_index: stepIndex, hint_index: hintIndex },
      token,
    }),
  revealSolution: (token, sectionIndex, stepIndex) =>
    request('/participant/solution', {
      method: 'POST',
      body: { section_index: sectionIndex, step_index: stepIndex },
      token,
    }),
  finish: (token) => request('/participant/finish', { method: 'POST', token }),
  status: (token) => request('/participant/status', { token }),
};

/**
 * Copy text to the clipboard with a fallback for non-secure contexts (e.g. a
 * LAN deployment over plain HTTP, where navigator.clipboard is unavailable).
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
