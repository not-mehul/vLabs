/**
 * Robustness: formulas that fail for some seats, unusual input (a bare `%` in
 * an image name, names in another Unicode form, corrupt JSON columns), the
 * stored admin role, token lifetimes, rate-limit keys and buckets, settings
 * that cannot be used, and a database from a newer release. Each test sets up
 * what it needs.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(os.tmpdir(), `vlabs-robust-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = tmpDb;
process.env.JWT_INSTRUCTOR_SECRET = 'test-instructor-secret-0123456789abcdef';
process.env.JWT_PARTICIPANT_SECRET = 'test-participant-secret-0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

let server;
let base;
let db;
let config;
let token;

async function call(p, { method = 'GET', body, token: t } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(base + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
}

const login = async (username, password) =>
  (await call('/api/auth/login', { method: 'POST', body: { username, password } })).data;

/** A one-step lab with these variables and step. */
const lab = (title, variables, step) => ({
  title,
  variables,
  content: [{ title: 'S', steps: [{ type: 'desk', title: 'Step', body: 'Go', ...step }] }],
});

async function create(body) {
  const res = await call('/api/templates', { method: 'POST', token, body });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

/** Launch a session from a template and join it; returns the ids and the seat's token. */
async function launchAndJoin(templateId, first = 'Sam', last = 'Seat') {
  const s = await call('/api/sessions', {
    method: 'POST',
    token,
    body: { template_id: templateId },
  });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  const j = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: s.data.room_code, first_name: first, last_name: last },
  });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  const detail = await call(`/api/sessions/${s.data.id}`, { token });
  const pid = detail.data.participants.find((p) => p.seat_number === j.data.seat_number).id;
  return { session: s.data, join: j.data, pid };
}

before(async () => {
  const { createApp } = await import('../src/app.js');
  const { ensureSeed } = await import('../src/db/seed.js');
  ({ default: db } = await import('../src/db/index.js'));
  ({ default: config } = await import('../src/config.js'));
  ensureSeed();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await login('instructor', 'labmanual123')).token;
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
/*  Formulas                                                                 */
/* ------------------------------------------------------------------------ */

test('a formula that fails for any seat 1–100 is refused on save, naming the seat', async () => {
  const res = await call('/api/templates', {
    method: 'POST',
    token,
    body: lab('Seat two', [{ name: 'V', expression: '10 / (seat - 2)' }], { body: '{{ V }}' }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.data.details, ['Error in variable "V" for seat 2: Division by zero']);
});

test('past the checked seats a failing formula shows ⟨error:NAME⟩; the page still loads', async () => {
  const t = await create(
    lab(
      'Seat 200',
      [
        { name: 'V', expression: '10 / (seat - 200)' },
        { name: 'W', expression: 'seat * 2' },
      ],
      { body: 'V={{ V }} W={{ W }}' },
    ),
  );
  const { session, join, pid } = await launchAndJoin(t.id);
  const moved = await call(`/api/sessions/${session.id}/participants/${pid}/seat`, {
    method: 'PUT',
    token,
    body: { seat_number: 200 },
  });
  assert.equal(moved.status, 200);
  const content = await call('/api/participant/content', { token: join.token });
  assert.equal(content.status, 200, JSON.stringify(content.data));
  assert.equal(content.data.sections[0].steps[0].body, 'V=⟨error:V⟩ W=400');
});

test('an exam keeps its other variables when one formula fails for a seat', async () => {
  const exam = await call('/api/templates', {
    method: 'POST',
    token,
    body: {
      kind: 'exam',
      title: 'Exam seat 200',
      variables: [
        { name: 'V', expression: '10 / (seat - 200)' },
        { name: 'W', expression: 'seat * 2' },
      ],
      content: [
        {
          title: 'Part',
          items: [{ type: 'short', prompt: 'Type {{ W }}', accepted: ['{{ W }}'] }],
        },
      ],
    },
  });
  assert.equal(exam.status, 201, JSON.stringify(exam.data));
  const { session, join, pid } = await launchAndJoin(exam.data.id);
  await call(`/api/sessions/${session.id}/participants/${pid}/seat`, {
    method: 'PUT',
    token,
    body: { seat_number: 200 },
  });
  const view = await call('/api/participant/exam', { token: join.token });
  assert.equal(view.status, 200);
  assert.equal(view.data.sections[0].items[0].prompt, 'Type 400');
  await call('/api/participant/exam/answer', {
    method: 'PUT',
    token: join.token,
    body: { key: '0.0', value: '400' },
  });
  const detail = await call(`/api/sessions/${session.id}/participants/${pid}`, { token });
  assert.equal(detail.data.questions[0].correct, true, 'graded against the seat-200 answer');
});

/* ------------------------------------------------------------------------ */
/*  Input                                                                    */
/* ------------------------------------------------------------------------ */

test('a bare % in an image reference is a validation message, not a 500', async () => {
  const res = await call('/api/templates', {
    method: 'POST',
    token,
    body: lab('Percent', [], { body: '![chart](50%-done.png)' }),
  });
  assert.equal(res.status, 400);
  assert.match(res.data.details.join('\n'), /Image "50-+done\.png" .* not in the image library/);
});

test('names typed in either Unicode form are one seat', async () => {
  const t = await create(lab('Unicode', [], {}));
  const { session, join } = await launchAndJoin(t.id, 'José', 'Núñez');
  const again = await call('/api/participant/join', {
    method: 'POST',
    // The same name with combining accents (NFD) instead of precomposed letters.
    body: { room_code: session.room_code, first_name: 'José', last_name: 'Núñez' },
  });
  assert.equal(again.status, 200);
  assert.equal(again.data.resumed, true);
  assert.equal(again.data.seat_number, join.seat_number);
});

test('a corrupt JSON column does not break the monitor or the seat', async () => {
  const t = await create(lab('Corrupt', [], {}));
  const { session, join, pid } = await launchAndJoin(t.id);
  db.prepare(
    `UPDATE participants SET checkpoint_log = '{nope', hints_taken = 'x', completed_checkpoints = '['
      WHERE id = ?`,
  ).run(pid);
  assert.equal((await call(`/api/sessions/${session.id}`, { token })).status, 200);
  assert.equal(
    (await call(`/api/sessions/${session.id}/participants/${pid}`, { token })).status,
    200,
  );
  assert.equal((await call(`/api/sessions/${session.id}/export`, { token })).status, 200);
  assert.equal((await call('/api/participant/content', { token: join.token })).status, 200);
});

/* ------------------------------------------------------------------------ */
/*  Checkpoints unlocked by an instructor                                    */
/* ------------------------------------------------------------------------ */

test('an instructor unlock saves an exact capture as authored, casing kept', async () => {
  const t = await create({
    title: 'Unlock casing',
    variables: [],
    content: [
      {
        title: 'S',
        steps: [
          {
            type: 'desk',
            title: 'Label',
            body: 'Find your rack',
            checkpoint: { prompt: 'Rack?', answer: 'Rack-{{ SEAT_ID }}-A', capture: 'RACK' },
          },
          { type: 'desk', title: 'Use it', body: 'Rack is {{ RACK }}' },
        ],
      },
    ],
  });
  const { session, join, pid } = await launchAndJoin(t.id);
  const unlock = await call(
    `/api/sessions/${session.id}/participants/${pid}/checkpoints/0.0/unlock`,
    { method: 'POST', token, body: {} },
  );
  assert.equal(unlock.status, 200, JSON.stringify(unlock.data));
  const content = await call('/api/participant/content', { token: join.token });
  assert.equal(content.data.sections[0].steps[1].body, `Rack is Rack-${join.seat_number}-A`);
});

/* ------------------------------------------------------------------------ */
/*  Accounts and tokens                                                      */
/* ------------------------------------------------------------------------ */

test('the admin is stored: a newly configured seed name does not move the role', async () => {
  const configured = config.seedInstructor.username;
  // An operator renames the bootstrap account in the settings after install.
  config.seedInstructor.username = 'newadmin';
  try {
    const bob = await call('/api/auth/instructors', {
      method: 'POST',
      token,
      body: { username: 'bob', password: 'bob-password-123' },
    });
    assert.equal(bob.status, 201);
    const bobToken = (await login('bob', 'bob-password-123')).token;
    const made = await call('/api/auth/instructors', {
      method: 'POST',
      token: bobToken,
      body: { username: 'newadmin', password: 'newadmin-pass-123' },
    });
    assert.equal(made.status, 201);
    const claimed = await login('newadmin', 'newadmin-pass-123');
    assert.equal(claimed.instructor.is_admin, false);
    const list = await call('/api/auth/instructors', { token: claimed.token });
    const original = list.data.find((i) => i.username === 'instructor');
    assert.equal(original.is_admin, true);
    const reset = await call(`/api/auth/instructors/${original.id}/reset-password`, {
      method: 'POST',
      token: claimed.token,
    });
    assert.equal(reset.status, 403);
    assert.equal(reset.data.code, 'ADMIN_ONLY');
  } finally {
    config.seedInstructor.username = configured;
  }
});

test('a participant token lasts past its session expiry, not past the join', async () => {
  const t = await create(lab('Token', [], {}));
  const { session, join } = await launchAndJoin(t.id);
  const claims = JSON.parse(Buffer.from(join.token.split('.')[1], 'base64url').toString());
  const sessionEnd = Math.floor(Date.parse(session.expires_at) / 1000);
  // Lab sessions default to 8 h; the token outlives them by the 12 h TTL.
  assert.ok(claims.exp >= sessionEnd + 12 * 3600 - 5, `${claims.exp} vs ${sessionEnd}`);
});

/* ------------------------------------------------------------------------ */
/*  Rate limits                                                              */
/* ------------------------------------------------------------------------ */

test('library images have their own rate limit, apart from the API-wide one', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const up = await fetch(`${base}/api/images?name=limit.png`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
    body: png,
  });
  const img = await up.json();
  const served = await fetch(`${base}${img.url}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('ratelimit-limit'), '3000');
  const api = await call('/api/templates', { token });
  assert.equal(api.headers.get('ratelimit-limit'), '300');
  // `/:id/references` is still the instructor route, not an image name.
  const refs = await call(`/api/images/${img.id}/references`, { token });
  assert.equal(refs.status, 200);
  assert.deepEqual(refs.data.templates, []);
});

test('IPv6 clients are bucketed by their /64 however the address is written', async () => {
  const { ipv6Prefix64 } = await import('../src/middleware/rateLimit.js');
  assert.equal(ipv6Prefix64('2001:db8::1'), '2001:db8:0:0');
  assert.equal(ipv6Prefix64('2001:db8:0:0:ffff::2'), '2001:db8:0:0');
  assert.equal(ipv6Prefix64('2001:0db8:0000:0000:1:2:3:4'), '2001:db8:0:0');
  assert.equal(ipv6Prefix64('fe80::1%eth0'), 'fe80:0:0:0');
  assert.equal(ipv6Prefix64('::1'), '0:0:0:0');
});

/* ------------------------------------------------------------------------ */
/*  Start-up                                                                 */
/* ------------------------------------------------------------------------ */

const serverDir = path.resolve(here, '..');
const childEnv = (extra) => ({
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ...extra,
});

test('unusable numeric settings fall back to their defaults', () => {
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { default: c } = await import('./src/config.js'); console.log(JSON.stringify({ m: c.minPasswordLength, p: c.port, g: c.expiredSessionGraceMinutes, bad: c.invalidSettings.map((s) => s.name) }));",
    ],
    {
      cwd: serverDir,
      env: childEnv({
        MIN_PASSWORD_LENGTH: 'abc',
        PORT: '70000',
        EXPIRED_SESSION_GRACE_MINUTES: '',
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), {
    m: 10,
    p: 4000,
    g: 60,
    bad: ['PORT', 'MIN_PASSWORD_LENGTH'],
  });
});

test('a database from a newer release is refused at start-up', async () => {
  const Database = (await import('better-sqlite3')).default;
  const newer = path.join(os.tmpdir(), `vlabs-newer-${process.pid}-${Date.now()}.sqlite`);
  const d = new Database(newer);
  d.pragma('user_version = 99');
  d.close();
  try {
    const out = spawnSync(process.execPath, ['src/index.js'], {
      cwd: serverDir,
      env: childEnv({ DB_PATH: newer, PORT: '0' }),
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /schema version 99; this vLabs understands up to 13/);
    // Untouched: no migration ran and no table was created.
    const after = new Database(newer, { readonly: true });
    assert.equal(after.pragma('user_version', { simple: true }), 99);
    assert.equal(
      after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n,
      0,
    );
    after.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(newer + suffix, { force: true });
  }
});
