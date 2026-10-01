/**
 * HTTP integration tests for the security-critical API surface.
 *
 * Dependency-free: boots the real Express app on an ephemeral port against an
 * isolated temp database and drives it with fetch. Covers auth gating,
 * progressive content delivery, checkpoint validation, step-level solution
 * gating, the live-session kill-switch, audit-log immutability, template
 * archive/restore/delete, session snapshots + push, and password rotation.
 *
 * Tests in this file are ORDER-DEPENDENT (node:test runs them serially in
 * declaration order); each builds on the state left by the previous one.
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
process.env.JWT_INSTRUCTOR_SECRET = 'test-instructor-secret-0123456789abcdef';
process.env.JWT_PARTICIPANT_SECRET = 'test-participant-secret-0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

let server;
let base;
let db;
let instructorToken;
let templateId;
let roomCode;
let participantToken;
let sessionId;

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

/** A minimal valid template payload for creating throwaway templates. */
function tinyTemplate(title, opts = {}) {
  return {
    title,
    description: 'test',
    variables: [{ name: 'HOST_IP', expression: "'10.0.0.' + (100 + seat)" }],
    content: [
      {
        title: opts.sectionTitle || 'Only section',
        steps: [
          {
            type: 'computer',
            title: 'Step',
            body: 'Your IP is {{ HOST_IP }}',
            checkpoint: { prompt: 'Enter it', answer: '{{ HOST_IP }}' },
          },
        ],
      },
    ],
  };
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
  sessionId = session.data.id;

  // Register the first participant (seat 1).
  const join = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: roomCode, first_name: 'Ada', last_name: 'Lovelace' },
  });
  participantToken = join.data.token;
});

after(() => {
  server?.close();
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(tmpDb + suffix);
    } catch {
      /* ignore */
    }
  }
});

/* ------------------------------------------------------------------------ */
/*  Baseline gating                                                          */
/* ------------------------------------------------------------------------ */

test('health check is open and touches the database', async () => {
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

  // A participant token must not open instructor routes (audience check).
  const wrongAudience = await call('/api/templates', { token: participantToken });
  assert.equal(wrongAudience.status, 401);

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

test('rejoining with the same name (any case) resumes the same seat', async () => {
  const again = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: roomCode, first_name: 'ADA', last_name: 'lovelace' },
  });
  assert.equal(again.status, 200);
  assert.equal(again.data.resumed, true);
  assert.equal(again.data.seat_number, 1);
  assert.ok(again.data.session.template_version >= 1);
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
  // The checkpoint answer(s) must never appear in the rendered payload.
  const cpStep = data.sections[1].steps.find((s) => s.checkpoint);
  assert.ok(cpStep, 'checkpoint step is present');
  assert.equal(cpStep.checkpoint.answer, undefined);
  assert.equal(cpStep.checkpoint.answers, undefined);
  assert.equal(cpStep.solution, undefined, 'solution not shipped before reveal');
  // The pad() helper rendered in a hint.
  const hint = data.sections[0].steps[1].hints[0];
  assert.match(hint.text, /S01/);
});

test('hints and progress on locked sections are refused (same gate as checkpoints)', async () => {
  const hint = await call('/api/participant/hint', {
    method: 'POST',
    body: { section_index: 2, step_index: 0, hint_index: 0 },
    token: participantToken,
  });
  assert.equal(hint.status, 403);

  const progress = await call('/api/participant/progress', {
    method: 'POST',
    body: { section_index: 2 },
    token: participantToken,
  });
  assert.equal(progress.status, 403);

  const bogus = await call('/api/participant/hint', {
    method: 'POST',
    body: { section_index: 1, step_index: 1, hint_index: 9 },
    token: participantToken,
  });
  assert.equal(bogus.status, 400);
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

test('checkpoint validates server-side (incl. alternatives) and unlocks the next section', async () => {
  const wrong = await call('/api/participant/checkpoint', {
    method: 'POST',
    body: { section_index: 1, step_index: 1, answer: '1.2.3.4' },
    token: participantToken,
  });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.data.correct, false);

  const notAString = await call('/api/participant/checkpoint', {
    method: 'POST',
    body: { section_index: 1, step_index: 1, answer: { $ne: '' } },
    token: participantToken,
  });
  assert.equal(notAString.status, 400);

  // Seat 1 -> HOST_IP = '10.0.0.' + (100 + 1). The CIDR form is an authored
  // alternative answer; whitespace/case are forgiven.
  const right = await call('/api/participant/checkpoint', {
    method: 'POST',
    body: { section_index: 1, step_index: 1, answer: '  10.0.0.101/24 ' },
    token: participantToken,
  });
  assert.equal(right.status, 200);
  assert.equal(right.data.correct, true);

  const after = await call('/api/participant/content', { token: participantToken });
  assert.equal(after.data.unlocked_section, 2, 'clearing the checkpoint unlocks section 3');
  assert.equal(after.data.sections.length, 3);
});

test('status poll reports liveness + template version without shipping the manual', async () => {
  const { status, data } = await call('/api/participant/status', {
    token: participantToken,
  });
  assert.equal(status, 200);
  assert.equal(data.session_active, true);
  assert.ok(data.expires_at, 'exposes expiry for the countdown');
  assert.equal(data.finished, false);
  assert.equal(data.template_version, 1);
  assert.equal(data.sections, undefined, 'never includes rendered content');
});

/* ------------------------------------------------------------------------ */
/*  Templates: validation, archive, restore, permanent delete                */
/* ------------------------------------------------------------------------ */

test('template validation rejects unknown placeholders and bad formulas with details', async () => {
  const bad = tinyTemplate('Broken');
  bad.content[0].steps[0].checkpoint.answer = '{{ HOST_IPP }}';
  bad.variables.push({ name: 'X', expression: 'seat + nope' });
  const res = await call('/api/templates', { method: 'POST', body: bad, token: instructorToken });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Unknown placeholder \{\{ HOST_IPP \}\}/);
  assert.match(res.data.error, /Unknown variable "nope"/);
  assert.ok(Array.isArray(res.data.details) && res.data.details.length >= 2);
});

test('template formulas may use whitelisted helpers and alternative answers round-trip', async () => {
  const body = tinyTemplate('Helpers');
  body.variables.push({ name: 'TAG', expression: "'S' + pad(seat, 3)" });
  body.content[0].steps[0].body += ' tag {{ TAG }}';
  body.content[0].steps[0].checkpoint.answers = ['{{ HOST_IP }}/24', '{{ HOST_IP }}/24', ''];
  const res = await call('/api/templates', { method: 'POST', body, token: instructorToken });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data.content[0].steps[0].checkpoint.answers, ['{{ HOST_IP }}/24']);

  const preview = await call(`/api/templates/${res.data.id}/preview`, {
    method: 'POST',
    body: { seat_id: 7 },
    token: instructorToken,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.context.TAG, 'S007');
  assert.equal(preview.data.sections[0].steps[0].checkpoint.answer, undefined);

  // Clean up (permanently — no sessions reference it).
  const del = await call(`/api/templates/${res.data.id}?permanent=1`, {
    method: 'DELETE',
    token: instructorToken,
  });
  assert.equal(del.status, 204);
});

let archivedTemplateId;

test('DELETE archives by default; archived templates are hidden and cannot be launched', async () => {
  const created = await call('/api/templates', {
    method: 'POST',
    body: tinyTemplate('To archive'),
    token: instructorToken,
  });
  assert.equal(created.status, 201);
  archivedTemplateId = created.data.id;

  const del = await call(`/api/templates/${archivedTemplateId}`, {
    method: 'DELETE',
    token: instructorToken,
  });
  assert.equal(del.status, 204);

  const visible = await call('/api/templates', { token: instructorToken });
  assert.ok(!visible.data.some((t) => t.id === archivedTemplateId), 'hidden from default list');

  const all = await call('/api/templates?include_archived=1', { token: instructorToken });
  const row = all.data.find((t) => t.id === archivedTemplateId);
  assert.ok(row && row.archived_at, 'listed with archived_at when requested');

  const launch = await call('/api/sessions', {
    method: 'POST',
    body: { template_id: archivedTemplateId },
    token: instructorToken,
  });
  assert.equal(launch.status, 409);

  const still = await call(`/api/templates/${archivedTemplateId}`, { token: instructorToken });
  assert.equal(still.status, 200, 'archived template is still readable/editable');
});

test('archived templates can be restored', async () => {
  const restored = await call(`/api/templates/${archivedTemplateId}/restore`, {
    method: 'POST',
    token: instructorToken,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.archived_at, null);

  const audit = await call(`/api/templates/${archivedTemplateId}/audit`, {
    token: instructorToken,
  });
  assert.deepEqual(
    audit.data.map((a) => a.action),
    ['restored', 'archived', 'created'],
  );
});

test('permanent deletion is refused with active sessions and otherwise detaches sessions intact', async () => {
  const launch = await call('/api/sessions', {
    method: 'POST',
    body: { template_id: archivedTemplateId, duration_minutes: 10 },
    token: instructorToken,
  });
  assert.equal(launch.status, 201);
  const sid = launch.data.id;

  const refused = await call(`/api/templates/${archivedTemplateId}?permanent=1`, {
    method: 'DELETE',
    token: instructorToken,
  });
  assert.equal(refused.status, 409);

  await call(`/api/sessions/${sid}/terminate`, { method: 'POST', token: instructorToken });

  const del = await call(`/api/templates/${archivedTemplateId}?permanent=1`, {
    method: 'DELETE',
    token: instructorToken,
  });
  assert.equal(del.status, 204);

  const gone = await call(`/api/templates/${archivedTemplateId}`, { token: instructorToken });
  assert.equal(gone.status, 404);

  // The ended session and its export survive, rendered from the session copy.
  const detail = await call(`/api/sessions/${sid}`, { token: instructorToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.template_id, null);
  assert.equal(detail.data.template_exists, false);
  assert.equal(detail.data.template_title, 'To archive');
  assert.equal(detail.data.section_count, 1);

  const exported = await call(`/api/sessions/${sid}/export`, { token: instructorToken });
  assert.equal(exported.status, 200);
  assert.equal(exported.data.session.template_title, 'To archive');

  const audit = await call(`/api/templates/${archivedTemplateId}/audit`, {
    token: instructorToken,
  });
  assert.equal(audit.data[0].action, 'deleted', 'audit history survives deletion');
  assert.ok(audit.data[0].snapshot, 'deletion keeps a final snapshot');
});

/* ------------------------------------------------------------------------ */
/*  Sessions: frozen snapshot + explicit push                                */
/* ------------------------------------------------------------------------ */

test('editing a template does not change a live session until the instructor pushes it', async () => {
  const current = await call(`/api/templates/${templateId}`, { token: instructorToken });
  const edited = { ...current.data, content: structuredClone(current.data.content) };
  edited.content[0].title = 'Section 1 · RENAMED';
  const saved = await call(`/api/templates/${templateId}`, {
    method: 'PUT',
    body: edited,
    token: instructorToken,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.version, 2);

  // Participant still sees v1.
  const before = await call('/api/participant/content', { token: participantToken });
  assert.equal(before.data.template_version, 1);
  assert.equal(before.data.sections[0].title, 'Section 1 · Bench Preparation');

  // Monitor shows the update is available.
  const detail = await call(`/api/sessions/${sessionId}`, { token: instructorToken });
  assert.equal(detail.data.template_version, 1);
  assert.equal(detail.data.latest_template_version, 2);
  assert.equal(detail.data.update_available, true);

  // Push, then participant sees v2 (status poll advertises it first).
  const push = await call(`/api/sessions/${sessionId}/push-template`, {
    method: 'POST',
    token: instructorToken,
  });
  assert.equal(push.status, 200);
  assert.equal(push.data.template_version, 2);

  const status = await call('/api/participant/status', { token: participantToken });
  assert.equal(status.data.template_version, 2);

  const after = await call('/api/participant/content', { token: participantToken });
  assert.equal(after.data.template_version, 2);
  assert.equal(after.data.sections[0].title, 'Section 1 · RENAMED');
  assert.equal(
    after.data.unlocked_section,
    2,
    'progress keys still apply to an unchanged structure',
  );
});

test('a session refuses the 101st participant', async () => {
  const launch = await call('/api/sessions', {
    method: 'POST',
    body: { template_id: templateId, duration_minutes: 10, title: 'Full house' },
    token: instructorToken,
  });
  const code = launch.data.room_code;
  for (let i = 1; i <= 100; i += 1) {
    const r = await call('/api/participant/join', {
      method: 'POST',
      body: { room_code: code, first_name: 'Seat', last_name: String(i) },
    });
    assert.equal(r.status, 200, `join #${i}`);
    assert.equal(r.data.seat_number, i);
  }
  const overflow = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: code, first_name: 'One', last_name: 'TooMany' },
  });
  assert.equal(overflow.status, 409);
  await call(`/api/sessions/${launch.data.id}`, { method: 'DELETE', token: instructorToken });
});

/* ------------------------------------------------------------------------ */
/*  Instructor password rotation                                             */
/* ------------------------------------------------------------------------ */

test('changing the password revokes older instructor tokens and issues a fresh one', async () => {
  const weak = await call('/api/auth/password', {
    method: 'PUT',
    body: { current_password: 'labmanual123', new_password: 'short' },
    token: instructorToken,
  });
  assert.equal(weak.status, 400);

  const wrongCurrent = await call('/api/auth/password', {
    method: 'PUT',
    body: { current_password: 'nope-nope-nope', new_password: 'a-much-better-passphrase' },
    token: instructorToken,
  });
  assert.equal(wrongCurrent.status, 401);

  const oldToken = instructorToken;
  const changed = await call('/api/auth/password', {
    method: 'PUT',
    body: { current_password: 'labmanual123', new_password: 'a-much-better-passphrase' },
    token: instructorToken,
  });
  assert.equal(changed.status, 200);
  assert.ok(changed.data.token);
  instructorToken = changed.data.token;

  const revoked = await call('/api/auth/me', { token: oldToken });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.data.code, 'TOKEN_REVOKED');

  const fresh = await call('/api/auth/me', { token: instructorToken });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.instructor.must_change_password, false);

  const relogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'instructor', password: 'a-much-better-passphrase' },
  });
  assert.equal(relogin.status, 200);
});

/* ------------------------------------------------------------------------ */
/*  Kill switch + audit immutability                                         */
/* ------------------------------------------------------------------------ */

test('terminating a session immediately revokes participant access', async () => {
  const term = await call(`/api/sessions/${sessionId}/terminate`, {
    method: 'POST',
    token: instructorToken,
  });
  assert.equal(term.status, 200);

  const blocked = await call('/api/participant/content', { token: participantToken });
  assert.equal(blocked.status, 403, 'a still-valid JWT is rejected once the session ends');
  assert.equal(blocked.data.code, 'SESSION_ENDED');

  const push = await call(`/api/sessions/${sessionId}/push-template`, {
    method: 'POST',
    token: instructorToken,
  });
  assert.equal(push.status, 409, 'cannot push into an ended session');
});

test('template audit log is append-only (immutability triggers)', () => {
  assert.throws(
    () => db.prepare("UPDATE template_audit SET action = 'x' WHERE id = 1").run(),
    /append-only/,
  );
  assert.throws(() => db.prepare('DELETE FROM template_audit WHERE id = 1').run(), /append-only/);
});

test('database schema version is recorded', () => {
  assert.equal(db.pragma('user_version', { simple: true }), 2);
});
