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
const RESUME_KEYS = 'vlabs.resume';

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

/**
 * Exam seats are bound to the device that joined them: the server hands out a
 * resume key per seat, kept here per room code + name (a shared iPad may hold
 * several students' seats) and NOT cleared on Exit, so a participant who exits
 * can come back on the same device. Without it a rejoin by name is refused
 * until the instructor releases the seat.
 */
const seatId = (roomCode, first, last) =>
  `${roomCode}:${`${first} ${last}`.trim().replace(/\s+/g, ' ').toLowerCase()}`;

export const resumeKeys = {
  get(roomCode, first, last) {
    try {
      return (
        JSON.parse(localStorage.getItem(RESUME_KEYS) || '{}')[seatId(roomCode, first, last)] || ''
      );
    } catch {
      return '';
    }
  },
  set(roomCode, first, last, key) {
    try {
      const all = JSON.parse(localStorage.getItem(RESUME_KEYS) || '{}');
      delete all[seatId(roomCode, first, last)]; // re-insert as newest
      all[seatId(roomCode, first, last)] = key;
      // Keep the map small: room codes are recycled, old entries are useless.
      const entries = Object.entries(all).slice(-50);
      localStorage.setItem(RESUME_KEYS, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* storage unavailable: the seat can still be released by the instructor */
    }
  },
};

/**
 * Milliseconds to add to Date.now() to get the server's clock, from a response
 * carrying `server_time`. Keeps countdowns right on devices whose clock is off.
 */
export function clockOffset(serverTime) {
  const t = Date.parse(serverTime || '');
  return Number.isNaN(t) ? 0 : t - Date.now();
}

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

  /* ---------------------------- Instructor accounts ------------------------ */

  listInstructors: (token) => request('/auth/instructors', { token }),
  /**
   * Create an instructor. Signed in → pass `token`; from the unlinked page on
   * the sign-in screen → pass `authorize: { username, password }` of an
   * existing instructor instead.
   */
  createInstructor: (token, { username, password, authorize }) =>
    request('/auth/instructors', {
      method: 'POST',
      body: { username, password: password || undefined, authorize },
      token,
    }),
  resetInstructorPassword: (token, id) =>
    request(`/auth/instructors/${id}/reset-password`, { method: 'POST', token }),
  removeInstructor: (token, id) => request(`/auth/instructors/${id}`, { method: 'DELETE', token }),

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
  getParticipant: (token, sessionId, participantId) =>
    request(`/sessions/${sessionId}/participants/${participantId}`, { token }),
  /** Exam sessions: mark a response correct / incorrect (null clears the mark). */
  markResponse: (token, sessionId, participantId, key, correct) =>
    request(`/sessions/${sessionId}/participants/${participantId}/marks/${key}`, {
      method: 'PUT',
      body: { correct },
      token,
    }),
  /** Exam sessions: every participant's response to one question. */
  questionResponses: (token, sessionId, key) =>
    request(`/sessions/${sessionId}/questions/${key}`, { token }),
  /** Start (on: true) or end (on: false) a class-wide break. */
  setBreak: (token, id, on) =>
    request(`/sessions/${id}/break`, { method: 'POST', body: { on }, token }),
  removeParticipant: (token, sessionId, participantId) =>
    request(`/sessions/${sessionId}/participants/${participantId}`, { method: 'DELETE', token }),
  /** Exams: let the seat be resumed on another device (signs out the current one). */
  releaseSeat: (token, sessionId, participantId) =>
    request(`/sessions/${sessionId}/participants/${participantId}/release`, {
      method: 'POST',
      token,
    }),
  /** Exams: undo a submission. */
  reopenExam: (token, sessionId, participantId) =>
    request(`/sessions/${sessionId}/participants/${participantId}/reopen`, {
      method: 'POST',
      token,
    }),

  /* -------------------------------- Images ------------------------------ */

  listImages: (token) => request('/images', { token }),
  /** Upload a File/Blob as the raw body; the server sniffs the real type. */
  uploadImage: async (token, file, { name, replace = false } = {}) => {
    const qs = new URLSearchParams({ name: name || file.name });
    if (replace) qs.set('replace', '1');
    let res;
    try {
      res = await fetch(`/api/images?${qs}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
    } catch {
      throw new ApiError('Network error — is the server reachable?', 0);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new ApiError(
        (data && data.error) || `Upload failed (${res.status})`,
        res.status,
        data && data.code,
      );
      err.existing = data && data.existing;
      throw err;
    }
    return data;
  },
  imageReferences: (token, id) => request(`/images/${id}/references`, { token }),
  deleteImage: (token, id) => request(`/images/${id}`, { method: 'DELETE', token }),

  /* ------------------------------ Participant --------------------------- */

  join: async (roomCode, firstName, lastName) => {
    const res = await request('/participant/join', {
      method: 'POST',
      body: {
        room_code: roomCode,
        first_name: firstName,
        last_name: lastName,
        resume_key: resumeKeys.get(roomCode, firstName, lastName) || undefined,
      },
    });
    if (res?.resume_key) resumeKeys.set(roomCode, firstName, lastName, res.resume_key);
    return res;
  },
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

  /* ------------------------------ Exam (participant) --------------------- */

  exam: (token) => request('/participant/exam', { token }),
  saveAnswer: (token, key, value) =>
    request('/participant/exam/answer', { method: 'PUT', body: { key, value }, token }),
  submitExam: (token) => request('/participant/exam/submit', { method: 'POST', token }),
  /** Exams: the section being viewed (time per section, furthest section). */
  examProgress: (token, sectionIndex) =>
    request('/participant/exam/progress', {
      method: 'POST',
      body: { section_index: sectionIndex },
      token,
    }),
  /**
   * Fire-and-forget save that survives the page closing (fetch keepalive):
   * used to flush a typed answer still waiting for its debounce on pagehide.
   */
  saveAnswerOnExit: (token, key, value) => {
    try {
      fetch('/api/participant/exam/answer', {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ key, value }),
      }).catch(() => {});
    } catch {
      /* best effort */
    }
  },
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
