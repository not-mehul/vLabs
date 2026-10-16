/**
 * Instructor account management and password durability. Order-dependent.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `vlabs-acct-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = tmpDb;
process.env.JWT_INSTRUCTOR_SECRET = 'test-instructor-secret-0123456789abcdef';
process.env.JWT_PARTICIPANT_SECRET = 'test-participant-secret-0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

let server;
let base;
let db;
let token;
let aliceId;
let aliceTemp;

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
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const login = (username, password) =>
  call('/api/auth/login', { method: 'POST', body: { username, password } });

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
  token = (await login('instructor', 'labmanual123')).data.token;
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

test('commits are fsynced (synchronous=FULL) so a power cut cannot roll back a password change', () => {
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('synchronous', { simple: true }), 2);
});

test('the bootstrap account is asked to change its password until it does', async () => {
  const me = await call('/api/auth/me', { token });
  assert.equal(me.data.instructor.must_change_password, true);
  const { accountsOnDefaultPassword } = await import('../src/db/seed.js');
  assert.deepEqual(accountsOnDefaultPassword(), ['instructor']);

  const changed = await call('/api/auth/password', {
    method: 'PUT',
    token,
    body: { current_password: 'labmanual123', new_password: 'a much better password' },
  });
  assert.equal(changed.status, 200);
  token = changed.data.token;
  assert.equal(changed.data.instructor.must_change_password, false);
  assert.deepEqual(accountsOnDefaultPassword(), [], 'start-up warning stops');
  // The change is in the main database file, not only the WAL.
  const ro = new (await import('better-sqlite3')).default(tmpDb, { readonly: true });
  assert.ok(
    ro.prepare("SELECT password_changed_at FROM instructors WHERE username = 'instructor'").get()
      .password_changed_at,
  );
  ro.close();
});

test('creating an instructor needs a signed-in instructor or valid authorising credentials', async () => {
  const anon = await call('/api/auth/instructors', { method: 'POST', body: { username: 'alice' } });
  assert.equal(anon.status, 401);

  const wrong = await call('/api/auth/instructors', {
    method: 'POST',
    body: { username: 'alice', authorize: { username: 'instructor', password: 'nope' } },
  });
  assert.equal(wrong.status, 401);

  const bad = await call('/api/auth/instructors', {
    method: 'POST',
    token,
    body: { username: 'a b' },
  });
  assert.equal(bad.status, 400);

  const short = await call('/api/auth/instructors', {
    method: 'POST',
    token,
    body: { username: 'alice', password: 'short' },
  });
  assert.equal(short.status, 400);

  // Hidden page flow: an existing instructor's credentials vouch for the new account.
  const viaCreds = await call('/api/auth/instructors', {
    method: 'POST',
    body: {
      username: 'alice',
      authorize: { username: 'instructor', password: 'a much better password' },
    },
  });
  assert.equal(viaCreds.status, 201);
  assert.equal(viaCreds.data.instructor.must_change_password, true);
  assert.ok(viaCreds.data.temporary_password.length >= 10);
  aliceId = viaCreds.data.instructor.id;
  aliceTemp = viaCreds.data.temporary_password;

  const dup = await call('/api/auth/instructors', {
    method: 'POST',
    token,
    body: { username: 'alice' },
  });
  assert.equal(dup.status, 409);

  // A chosen password is never echoed back.
  const bob = await call('/api/auth/instructors', {
    method: 'POST',
    token,
    body: { username: 'bob', password: 'bobs own password' },
  });
  assert.equal(bob.status, 201);
  assert.equal(bob.data.temporary_password, null);
  assert.equal((await login('bob', 'bobs own password')).status, 200);
});

test('listing, resetting and removing instructors', async () => {
  const list = await call('/api/auth/instructors', { token });
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.data.map((i) => i.username),
    ['alice', 'bob', 'instructor'],
  );
  assert.equal(list.data.find((i) => i.username === 'instructor').is_me, true);

  const aliceLogin = await login('alice', aliceTemp);
  assert.equal(aliceLogin.status, 200);
  const aliceToken = aliceLogin.data.token;

  const self = await call(
    `/api/auth/instructors/${list.data.find((i) => i.is_me).id}/reset-password`,
    {
      method: 'POST',
      token,
    },
  );
  assert.equal(self.status, 400, 'own password changes go through Account');

  const reset = await call(`/api/auth/instructors/${aliceId}/reset-password`, {
    method: 'POST',
    token,
  });
  assert.equal(reset.status, 200);
  assert.notEqual(reset.data.temporary_password, aliceTemp);
  assert.equal((await call('/api/auth/me', { token: aliceToken })).status, 401, 'signed out');
  assert.equal((await login('alice', aliceTemp)).status, 401);
  const aliceAgain = await login('alice', reset.data.temporary_password);
  assert.equal(aliceAgain.status, 200);

  // Alice launches a session; removing her hands it to the remover.
  const tpl = (await call('/api/templates', { token })).data[0];
  const s = await call('/api/sessions', {
    method: 'POST',
    token: aliceAgain.data.token,
    body: { template_id: tpl.id },
  });
  assert.equal(s.status, 201);
  const removed = await call(`/api/auth/instructors/${aliceId}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.sessions_reassigned, 1);
  assert.equal((await call(`/api/sessions/${s.data.id}`, { token })).status, 200);

  const me = list.data.find((i) => i.is_me);
  assert.equal(
    (await call(`/api/auth/instructors/${me.id}`, { method: 'DELETE', token })).status,
    400,
  );
});
