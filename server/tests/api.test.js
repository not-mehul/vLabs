/**
 * HTTP integration tests for the security-critical API surface.
 *
 * Dependency-free: boots the real Express app on an ephemeral port against an
 * isolated temp database and drives it with fetch. Covers auth gating,
 * progressive content delivery, checkpoint validation, step-level solution
 * gating, the live-session kill-switch, and audit-log immutability.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the DB and pin secrets BEFORE importing anything that opens the DB.
// (Dynamic imports below run after these assignments; static imports would be
// hoisted and evaluate first.)
const tmpDb = path.join(os.tmpdir(), `vlabs-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = tmpDb;
process.env.JWT_INSTRUCTOR_SECRET = 'test-instructor-secret';
process.env.JWT_PARTICIPANT_SECRET = 'test-participant-secret';
process.env.NODE_ENV = 'test';

let server;
let base;
let db;
let instructorToken;
let templateId;
let roomCode;
let participantToken;

async function call(p, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data };
}

before(async () => {
  const { createApp } = await import('../src/app.js');
  const { ensureSeed } = await import('../src/db/seed.js');
  ({ default: db } = await import('../src/db/index.js'));
  ensureSeed();

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // Log in as the seeded instructor and create a live session.
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'instructor', password: 'labmanual123' },
  });
  instructorToken = login.data.token;
  const templates = await call('/api/templates', { token: instructorToken });
  templateId = templates.data[0].id;
  const session = await call('/api/sessions', {
    method: 'POST',
    body: { template_id: templateId, duration_minutes: 60 },
    token: instructorToken,
  });
  roomCode = session.data.room_code;

  // Register the first participant (seat 1).
  const join = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: roomCode, first_name: 'Ada', last_name: 'Lovelace' },
  });
  participantToken = join.data.token;
});

after(() => {
  server?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(tmpDb + suffix);
    } catch {
      /* ignore */
    }
  }
});

test('health check is open', async () => {
  const { status, data } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(data.status, 'ok');
});

test('instructor routes reject missing/invalid credentials', async () => {
  const noToken = await call('/api/templates');
  assert.equal(noToken.status, 401);

  const badLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'instructor', password: 'wrong' },
  });
  assert.equal(badLogin.status, 401);

  assert.ok(instructorToken, 'valid login returned a token');
});

test('join rejects an invalid room code but accepts the real one', async () => {
  const bad = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: '000000', first_name: 'Eve', last_name: 'Nobody' },
  });
  assert.equal(bad.status, 401);
  assert.ok(participantToken, 'valid join returned a token');
});

test('participant content requires a token', async () => {
  const anon = await call('/api/participant/content');
  assert.equal(anon.status, 401);
});

test('content is progressively delivered and never leaks answers', async () => {
  const { status, data } = await call('/api/participant/content', {
    token: participantToken,
  });
  assert.equal(status, 200);
  // Sample has 3 sections; section 0 is checkpoint-free (auto-cleared), so the
  // participant unlocks through section 1 (index 1) but NOT section 2.
  assert.equal(data.total_sections, 3);
  assert.equal(data.unlocked_section, 1);
  assert.equal(data.sections.length, 2, 'locked section 3 is not delivered');
  // The checkpoint answer must never appear in the rendered payload.
  const cpStep = data.sections[1].steps.find((s) => s.checkpoint);
  assert.ok(cpStep, 'checkpoint step is present');
  assert.equal(cpStep.checkpoint.answer, undefined);
});

test('a step-level solution is gated behind opening every hint', async () => {
  // section 1 / step 1 (Verify Connectivity) has one hint + a solution.
  const early = await call('/api/participant/solution', {
    method: 'POST',
    body: { section_index: 1, step_index: 1 },
    token: participantToken,
  });
  assert.equal(early.status, 403, 'solution locked until all hints opened');

  const hint = await call('/api/participant/hint', {
    method: 'POST',
    body: { section_index: 1, step_index: 1, hint_index: 0 },
    token: participantToken,
  });
  assert.equal(hint.status, 200);

  const revealed = await call('/api/participant/solution', {
    method: 'POST',
    body: { section_index: 1, step_index: 1 },
    token: participantToken,
  });
  assert.equal(revealed.status, 200);
  assert.match(revealed.data.solution, /Host octet/);
});

test('checkpoint validates server-side and unlocks the next section', async () => {
  const wrong = await call('/api/participant/checkpoint', {
    method: 'POST',
    body: { section_index: 1, step_index: 1, answer: '1.2.3.4' },
    token: participantToken,
  });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.data.correct, false);

  // Seat 1 -> HOST_IP = '10.0.0.' + (100 + 1).
  const right = await call('/api/participant/checkpoint', {
    method: 'POST',
    body: { section_index: 1, step_index: 1, answer: '10.0.0.101' },
    token: participantToken,
  });
  assert.equal(right.status, 200);
  assert.equal(right.data.correct, true);

  const after = await call('/api/participant/content', { token: participantToken });
  assert.equal(after.data.unlocked_section, 2, 'clearing the checkpoint unlocks section 3');
  assert.equal(after.data.sections.length, 3);
});

test('terminating a session immediately revokes participant access', async () => {
  const sessions = await call('/api/sessions', { token: instructorToken });
  const sessionId = sessions.data[0].id;
  const term = await call(`/api/sessions/${sessionId}/terminate`, {
    method: 'POST',
    token: instructorToken,
  });
  assert.equal(term.status, 200);

  const blocked = await call('/api/participant/content', { token: participantToken });
  assert.equal(blocked.status, 403, 'a still-valid JWT is rejected once the session ends');
  assert.equal(blocked.data.code, 'SESSION_ENDED');
});

test('template audit log is append-only (immutability triggers)', () => {
  assert.throws(
    () => db.prepare("UPDATE template_audit SET action = 'x' WHERE id = 1").run(),
    /append-only/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM template_audit WHERE id = 1').run(),
    /append-only/,
  );
});
