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
  // Sample has 3 sections; section 0 ends with a PATTERN checkpoint (serial
  // number), so only section 0 is delivered until it is cleared.
  assert.equal(data.total_sections, 3);
  assert.equal(data.unlocked_section, 0);
  assert.equal(data.sections.length, 1, 'locked sections are not delivered');
  const steps = data.sections[0].steps;
  assert.equal(steps.length, 4, 'every step up to the first open checkpoint is visible');
  // Info step: context only, personalised with the registered first name.
  assert.equal(steps[0].type, 'info');
  assert.match(steps[0].body, /Welcome, \*\*Ada\*\*/);
  assert.equal(steps[0].checkpoint, undefined);
  assert.deepEqual(steps[0].hints, []);
  // The pad() helper rendered in a hint.
  assert.match(steps[2].hints[0].text, /S01/);
  // The pattern checkpoint ships its mode but never the mask.
  const cpStep = steps[3];
  assert.equal(cpStep.checkpoint.mode, 'pattern');
  assert.equal(cpStep.checkpoint.pattern, undefined);
  assert.equal(cpStep.checkpoint.answer, undefined);
  assert.equal(cpStep.checkpoint.answers, undefined);
});

test('a pattern checkpoint accepts the format, captures the canonical value for later steps', async () => {
  const wrong = await call('/api/participant/checkpoint', {
    method: 'POST',
    body: { section_index: 0, step_index: 3, answer: 'ABCD.1234' },
    token: participantToken,
  });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.data.correct, false);

  // Lower-case, no separators: accepted and normalised to the mask.
  const right = await call('/api/participant/checkpoint', {
    method: 'POST',
    body: { section_index: 0, step_index: 3, answer: 'abcd1234wxyz' },
    token: participantToken,
  });
  assert.equal(right.status, 200);
  assert.equal(right.data.correct, true);
  assert.equal(right.data.section_cleared, true);
  assert.equal(right.data.unlocked_section, 1);

  const after = await call('/api/participant/content', { token: participantToken });
  assert.equal(after.data.sections.length, 2, 'section 2 now delivered');
  assert.equal(after.data.sections[0].steps[3].checkpoint.completed, true);
  // Section 2 / step 1 (Verify Connectivity) solution mentions nothing of the
  // serial, but section 3 / Wrap Up does — checked once unlocked below. The
  // exact checkpoint in section 2 is still hidden-answer.
  const cpStep = after.data.sections[1].steps.find((s) => s.checkpoint);
  assert.ok(cpStep, 'exact checkpoint step is present');
  assert.equal(cpStep.checkpoint.mode, 'exact');
  assert.equal(cpStep.checkpoint.answer, undefined);
  assert.equal(cpStep.solution, undefined, 'solution not shipped before reveal');

  // Instructors see the captured value on the monitor and in the export.
  const detail = await call(`/api/sessions/${sessionId}`, { token: instructorToken });
  assert.deepEqual(detail.data.capture_names, ['SERIAL']);
  assert.equal(detail.data.participants[0].captured.SERIAL, 'ABCD.1234.WXYZ');
  const exported = await call(`/api/sessions/${sessionId}/export`, { token: instructorToken });
  assert.deepEqual(exported.data.participants[0].captured, { SERIAL: 'ABCD.1234.WXYZ' });
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
  // The captured serial and the built-in names are injected into later steps.
  const wrapUp = after.data.sections[2].steps[0].body;
  assert.match(wrapUp, /Ada Lovelace/);
  assert.match(wrapUp, /ABCD\.1234\.WXYZ/);
});

test('opening the checkpoint-free last section completes the manual; detail shows attempts + timings', async () => {
  // Section 3 (Wrap Up) has no checkpoint: entering it is what completes the lab.
  const before = await call(`/api/sessions/${sessionId}`, { token: instructorToken });
  const rowBefore = before.data.participants[0];
  assert.equal(rowBefore.complete, false);
  assert.equal(rowBefore.status, 'active');

  const progress = await call('/api/participant/progress', {
    method: 'POST',
    body: { section_index: 2 },
    token: participantToken,
  });
  assert.equal(progress.status, 200);
  assert.equal(progress.data.completed, true);

  const detail = await call(`/api/sessions/${sessionId}`, { token: instructorToken });
  const row = detail.data.participants[0];
  assert.equal(row.complete, true, 'complete without pressing Finish');
  assert.equal(row.status, 'finished');
  assert.ok(row.completed_at, 'completed_at recorded');
  assert.equal(row.finished, false, 'Finish not pressed');
  assert.equal(row.progress_pct, 100);
  assert.equal(row.seconds_on_current_section, 0, 'clock stopped');
  assert.equal(detail.data.complete_count, 1);
  // Section flow counts the complete seat under "complete", not "here".
  assert.equal(detail.data.section_distribution[2].seats_here, 0);
  assert.equal(detail.data.section_distribution[0].seats_past, 1);

  // Reviewing an earlier section afterwards keeps them complete and frozen.
  await call('/api/participant/progress', {
    method: 'POST',
    body: { section_index: 0 },
    token: participantToken,
  });
  const again = await call(`/api/sessions/${sessionId}`, { token: instructorToken });
  assert.equal(again.data.participants[0].complete, true);
  assert.equal(again.data.participants[0].total_seconds, row.total_seconds);

  // Per-participant detail: wrong attempts were logged with what was typed.
  const pd = await call(`/api/sessions/${sessionId}/participants/${row.id}`, {
    token: instructorToken,
  });
  assert.equal(pd.status, 200);
  assert.equal(pd.data.checkpoints.length, 2);
  const serial = pd.data.checkpoints.find((c) => c.key === '0.3');
  assert.equal(serial.mode, 'pattern');
  assert.equal(serial.cleared, true);
  assert.equal(serial.accepted_answer, 'abcd1234wxyz', 'shown as typed');
  assert.deepEqual(
    serial.wrong_attempts.map((a) => a.answer),
    ['ABCD.1234'],
  );
  const ip = pd.data.checkpoints.find((c) => c.key === '1.1');
  assert.equal(ip.accepted_answer, '10.0.0.101/24');
  assert.deepEqual(
    ip.wrong_attempts.map((a) => a.answer),
    ['1.2.3.4'],
  );
  assert.equal(pd.data.wrong_attempts, 2);
  assert.equal(pd.data.hints.length, 1);
  assert.equal(pd.data.hints[0].label, 'How do I read my IP?');
  assert.equal(pd.data.solutions.length, 1);
  assert.equal(pd.data.section_times.length, 3);
  assert.ok(pd.data.section_times.every((t) => typeof t.seconds === 'number'));
  assert.equal(pd.data.captured.SERIAL, 'ABCD.1234.WXYZ');
  // Unknown participant / wrong session → 404.
  const nope = await call(`/api/sessions/${sessionId}/participants/999999`, {
    token: instructorToken,
  });
  assert.equal(nope.status, 404);

  // Export carries the full detail: section index, checkpoint index, per
  // participant times/answers/attempts/hints, and a flat chronological log.
  const exported = await call(`/api/sessions/${sessionId}/export`, { token: instructorToken });
  const doc = exported.data;
  assert.deepEqual(
    doc.sections.map((x) => x.number),
    [1, 2, 3],
  );
  assert.deepEqual(
    doc.checkpoints.map((c) => [c.key, c.mode, c.capture]),
    [
      ['0.3', 'pattern', 'SERIAL'],
      ['1.1', 'exact', null],
    ],
  );
  const ex = doc.participants[0];
  assert.equal(ex.complete, true);
  assert.equal(ex.wrong_attempts, 2);
  assert.equal(ex.section_seconds.length, 3);
  assert.deepEqual(
    ex.section_times.map((t) => [t.number, t.title, typeof t.seconds]),
    [
      [1, 'Section 1 · Bench Preparation', 'number'],
      [2, 'Section 2 · Network Configuration', 'number'],
      [3, 'Section 3 · Wrap Up', 'number'],
    ],
  );
  const exSerial = ex.checkpoints.find((c) => c.key === '0.3');
  assert.equal(exSerial.cleared, true);
  assert.equal(exSerial.accepted_answer, 'abcd1234wxyz');
  assert.deepEqual(
    exSerial.wrong_attempts.map((a) => a.answer),
    ['ABCD.1234'],
  );
  assert.ok(exSerial.wrong_attempts[0].at, 'attempt timestamps');
  assert.equal(ex.hints_opened.length, 1);
  assert.equal(ex.hints_opened[0].label, 'How do I read my IP?');
  assert.equal(ex.solutions_revealed_list.length, 1);
  // Flat log: 2 wrong + 2 correct, chronological, correct flag set.
  assert.equal(doc.attempts.length, 4);
  assert.deepEqual(
    doc.attempts.map((a) => [a.checkpoint, a.correct]),
    [
      ['0.3', false],
      ['0.3', true],
      ['1.1', false],
      ['1.1', true],
    ],
  );
  for (let i = 1; i < doc.attempts.length; i += 1) {
    assert.ok(doc.attempts[i - 1].at <= doc.attempts[i].at, 'sorted by time');
  }
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

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(
  name,
  bytes,
  { token = instructorToken, replace = false, type = 'image/png' } = {},
) {
  const res = await fetch(
    `${base}/api/images?name=${encodeURIComponent(name)}${replace ? '&replace=1' : ''}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': type },
      body: bytes,
    },
  );
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

test('image library: upload is sniffed, served publicly by id, replace/delete rules, render rewrite', async () => {
  // Instructor-only upload.
  const anon = await upload('rack.png', PNG_1X1, { token: participantToken });
  assert.equal(anon.status, 401);
  // Not an image (even if labelled as one) → 415.
  const html = await upload('evil.png', Buffer.from('<html><script>1</script></html>'));
  assert.equal(html.status, 415);
  // Happy path.
  const up = await upload('images/Rack Diagram.png', PNG_1X1);
  assert.equal(up.status, 201);
  assert.equal(up.data.name, 'Rack-Diagram.png', 'base name, sanitised');
  assert.equal(up.data.mime, 'image/png');
  assert.equal(up.data.width, 1);
  assert.match(up.data.url, /^\/api\/images\/[A-Za-z0-9_-]{22}\/Rack-Diagram\.png$/);
  // Same name again → 409 with the existing record; replace=1 issues a new id.
  const dup = await upload('rack-diagram.png', PNG_1X1);
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'IMAGE_EXISTS');
  const rep = await upload('rack-diagram.png', PNG_1X1, { replace: true });
  assert.equal(rep.status, 200);
  assert.equal(rep.data.replaced, true);
  assert.notEqual(rep.data.id, up.data.id);
  assert.equal(rep.data.name, 'Rack-Diagram.png', 'original casing kept on replace');
  // Served without a token; old id is gone.
  const served = await fetch(`${base}${rep.data.url}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await served.arrayBuffer()).byteLength, PNG_1X1.length);
  assert.equal((await fetch(`${base}${up.data.url}`)).status, 404);
  // Listing.
  const list = await call('/api/images', { token: instructorToken });
  assert.ok(list.data.images.some((i) => i.id === rep.data.id));

  // A template may only reference images that exist.
  const missing = await call('/api/templates', {
    method: 'POST',
    token: instructorToken,
    body: {
      ...tinyTemplate('Img missing'),
      content: [{ title: 'S', steps: [{ type: 'desk', title: 't', body: 'see ![r](nope.png)' }] }],
    },
  });
  assert.equal(missing.status, 400);
  assert.match(
    missing.data.details.join(';'),
    /Image "nope\.png" referenced in Section 1 · step 1 body/,
  );
  const withImg = await call('/api/templates', {
    method: 'POST',
    token: instructorToken,
    body: {
      ...tinyTemplate('Img ok'),
      content: [
        {
          title: 'S',
          steps: [
            {
              type: 'desk',
              title: 't',
              body: 'see ![rack](RACK-DIAGRAM.png "The rack") and ![d](bench-{{ SEAT_ID }}.png)',
            },
          ],
        },
      ],
    },
  });
  assert.equal(withImg.status, 201, JSON.stringify(withImg.data));
  // Rendering (preview) rewrites the reference to the served URL; the dynamic
  // one has no library match and is left as written.
  const preview = await call(`/api/templates/${withImg.data.id}/preview`, {
    method: 'POST',
    token: instructorToken,
    body: { seat_id: 3 },
  });
  const body = preview.data.sections[0].steps[0].body;
  assert.ok(body.includes(`![rack](${rep.data.url} "The rack")`), body);
  assert.ok(body.includes('![d](bench-3.png)'), body);
  // References + delete refusal while a template uses it.
  const refs = await call(`/api/images/${rep.data.id}/references`, { token: instructorToken });
  assert.ok(refs.data.templates.some((t) => t.id === withImg.data.id));
  const del = await call(`/api/images/${rep.data.id}`, {
    method: 'DELETE',
    token: instructorToken,
  });
  assert.equal(del.status, 409);
  // Archive the template (archived templates don't block), then delete works.
  await call(`/api/templates/${withImg.data.id}`, { method: 'DELETE', token: instructorToken });
  const del2 = await call(`/api/images/${rep.data.id}`, {
    method: 'DELETE',
    token: instructorToken,
  });
  assert.equal(del2.status, 204);
  assert.equal((await fetch(`${base}${rep.data.url}`)).status, 404);
});

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

test('database schema version is recorded (migration 4: images, attempt log, section times)', () => {
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  const cols = db
    .prepare('PRAGMA table_info(participants)')
    .all()
    .map((c) => c.name);
  for (const c of ['captured_values', 'checkpoint_log', 'section_times', 'completed_at']) {
    assert.ok(cols.includes(c), c);
  }
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='images'").get());
});
