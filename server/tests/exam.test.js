/**
 * HTTP integration tests for examination mode: exam templates (validation,
 * kind), participant delivery without answers, autosave + submit lock,
 * automatic grading, manual marks, and exports. Also covers the shared exam
 * Markdown format. Order-dependent, like api.test.js.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `vlabs-exam-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = tmpDb;
process.env.JWT_INSTRUCTOR_SECRET = 'test-instructor-secret-0123456789abcdef';
process.env.JWT_PARTICIPANT_SECRET = 'test-participant-secret-0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

let server;
let base;
let db;
let token;
let examId;
let sessionId;
let roomCode;
let ada;
let bob;

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

const EXAM = {
  kind: 'exam',
  title: 'Unit test',
  description: 'All question types',
  content: [
    {
      title: 'Part 1',
      questions: [
        { type: 'single', prompt: 'Pick B', options: ['A', 'B', 'C'], correct: 1, points: 2 },
        { type: 'multiple', prompt: 'Pick A and C', options: ['A', 'B', 'C'], correct: [0, 2] },
        { type: 'truefalse', prompt: 'True?', correct: true },
      ],
    },
    {
      title: 'Part 2',
      questions: [
        { type: 'short', prompt: 'Port?', accepted: ['443', 'tcp/443'] },
        { type: 'short', prompt: 'Your name?' },
        { type: 'long', prompt: 'Explain', points: 5 },
      ],
    },
  ],
};

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
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'instructor', password: 'labmanual123' },
  });
  token = login.data.token;
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

test('a fresh install seeds a sample lab AND a sample exam', async () => {
  const list = await call('/api/templates', { token });
  const kinds = list.data.map((t) => t.kind).sort();
  assert.deepEqual(kinds, ['exam', 'lab']);
  const exam = list.data.find((t) => t.kind === 'exam');
  assert.ok(exam.question_count > 0);
  assert.ok(exam.total_points > 0);
});

test('exam validation reports every authoring problem', async () => {
  const bad = await call('/api/templates', {
    method: 'POST',
    token,
    body: {
      kind: 'exam',
      title: '',
      content: [
        {
          title: 'S',
          questions: [
            { type: 'single', prompt: 'x', options: ['only one'], correct: 0 },
            { type: 'multiple', prompt: 'y', options: ['a', 'b'], correct: [] },
            { type: 'truefalse', prompt: '' },
          ],
        },
      ],
    },
  });
  assert.equal(bad.status, 400);
  const joined = bad.data.details.join('\n');
  assert.match(joined, /Title is required/);
  assert.match(joined, /at least two options/);
  assert.match(joined, /at least one correct option/);
  assert.match(joined, /empty prompt/);
  assert.match(joined, /true or false/);
});

test('an exam template is created as kind exam and launches an exam session', async () => {
  const created = await call('/api/templates', { method: 'POST', token, body: EXAM });
  assert.equal(created.status, 201);
  assert.equal(created.data.kind, 'exam');
  assert.deepEqual(created.data.variables, []);
  examId = created.data.id;

  // Updating keeps the kind even if the payload claims otherwise.
  const upd = await call(`/api/templates/${examId}`, {
    method: 'PUT',
    token,
    body: { ...EXAM, kind: 'lab', title: 'Unit test v2' },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.kind, 'exam');
  assert.equal(upd.data.version, 2);

  const s = await call('/api/sessions', {
    method: 'POST',
    token,
    body: { template_id: examId, duration_minutes: 30 },
  });
  assert.equal(s.status, 201);
  assert.equal(s.data.kind, 'exam');
  sessionId = s.data.id;
  roomCode = s.data.room_code;

  const j1 = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: roomCode, first_name: 'Ada', last_name: 'Lovelace' },
  });
  assert.equal(j1.data.session.kind, 'exam');
  ada = j1.data.token;
  const j2 = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: roomCode, first_name: 'Bob', last_name: 'Byte' },
  });
  bob = j2.data.token;
});

test('sections unlock like a lab: locked sections are neither sent nor answerable; no answers leak', async () => {
  const res = await call('/api/participant/exam', { token: ada });
  assert.equal(res.status, 200);
  assert.equal(res.data.question_count, 6);
  assert.equal(res.data.total_sections, 3, 'two parts plus the submit section');
  assert.equal(res.data.unlocked_section, 0);
  assert.equal(res.data.sections.length, 1, 'only the unlocked section is delivered');
  assert.ok(!JSON.stringify(res.data).includes('Port?'), 'locked questions never sent');
  const locked = await call('/api/participant/exam/answer', {
    method: 'PUT',
    token: ada,
    body: { key: '1.0', value: '443' },
  });
  assert.equal(locked.status, 403);
  const lockedNav = await call('/api/participant/exam/progress', {
    method: 'POST',
    token: ada,
    body: { section_index: 1 },
  });
  assert.equal(lockedNav.status, 403);
  const raw = JSON.stringify(res.data);
  assert.ok(!/"correct"/.test(raw), 'no correct answers');
  assert.ok(!/"accepted"/.test(raw), 'no accepted answers');
  assert.ok(!raw.includes('tcp/443'));
  assert.deepEqual(res.data.sections[0].questions[0].options, ['A', 'B', 'C']);
  assert.equal(res.data.sections[0].questions[0].key, '0.0');

  const lab = await call('/api/participant/content', { token: ada });
  assert.equal(lab.status, 409);
  assert.equal(lab.data.code, 'WRONG_KIND');
  // The shared status poll works for both kinds.
  const st = await call('/api/participant/status', { token: ada });
  assert.equal(st.status, 200);
  assert.equal(st.data.kind, 'exam');
});

test('answers autosave, are validated per type, and can be changed until submitted', async () => {
  const put = (t, key, value) =>
    call('/api/participant/exam/answer', { method: 'PUT', token: t, body: { key, value } });

  assert.equal((await put(ada, '0.0', 5)).status, 400, 'option out of range');
  assert.equal((await put(ada, '9.9', 1)).status, 400, 'unknown question');
  assert.equal((await put(ada, '0.2', 'maybe')).status, 400, 'not a boolean');

  // Ada: B (right), then changes multiple to the right set, True, " TCP/443 ".
  assert.equal((await put(ada, '0.0', 0)).status, 200);
  assert.equal((await put(ada, '0.0', 1)).status, 200);
  assert.equal((await put(ada, '0.1', [2, 0])).status, 200);
  assert.equal((await put(ada, '0.2', true)).status, 200);
  assert.equal((await put(ada, '1.0', ' TCP/443 ')).status, 200);
  assert.equal((await put(ada, '1.1', 'Ada')).status, 200);
  assert.equal((await put(ada, '1.2', 'Because broadcast domains…')).status, 200);
  // Bob: wrong single, partially-right multiple, False.
  await put(bob, '0.0', 2);
  await put(bob, '0.1', [0]);
  await put(bob, '0.2', false);

  const mine = await call('/api/participant/exam', { token: ada });
  assert.equal(mine.data.answers['0.0'], 1);
  assert.deepEqual(mine.data.answers['0.1'], [0, 2], 'stored sorted');

  // Clearing an answer removes it.
  await put(bob, '0.2', null);
  const bobs = await call('/api/participant/exam', { token: bob });
  assert.equal('0.2' in bobs.data.answers, false);
});

test('submitting locks the exam (idempotent)', async () => {
  const sub = await call('/api/participant/exam/submit', { method: 'POST', token: ada });
  assert.equal(sub.status, 200);
  assert.equal(sub.data.submitted, true);
  const again = await call('/api/participant/exam/submit', { method: 'POST', token: ada });
  assert.equal(again.status, 200);
  const late = await call('/api/participant/exam/answer', {
    method: 'PUT',
    token: ada,
    body: { key: '0.0', value: 0 },
  });
  assert.equal(late.status, 409);
  assert.equal(late.data.code, 'SUBMITTED');
  const view = await call('/api/participant/exam', { token: ada });
  assert.equal(view.data.submitted, true);
  // No going back to review: neither questions nor answers are served.
  assert.deepEqual(view.data.sections, []);
  assert.deepEqual(view.data.answers, {});
  assert.equal(view.data.answered_count, 6);
  assert.ok(!JSON.stringify(view.data).includes('Pick B'));
});

test('the monitor grades automatically and lists what still needs a manual mark', async () => {
  const res = await call(`/api/sessions/${sessionId}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.kind, 'exam');
  assert.equal(res.data.question_count, 6);
  assert.equal(res.data.total_points, 2 + 1 + 1 + 1 + 1 + 5);
  assert.equal(res.data.submitted_count, 1);

  const a = res.data.participants.find((p) => p.name === 'Ada Lovelace');
  assert.equal(a.answered, 6);
  assert.equal(a.score, 2 + 1 + 1 + 1, 'single + multiple + tf + accepted short');
  assert.equal(a.pending_count, 2, 'short without accepted list + long');
  assert.equal(a.fully_graded, false);
  assert.equal(a.status, 'submitted');

  const b = res.data.participants.find((p) => p.name === 'Bob Byte');
  assert.equal(b.score, 0);
  assert.equal(b.answered, 2);

  const q0 = res.data.questions.find((x) => x.key === '0.0');
  assert.equal(q0.answered, 2);
  assert.equal(q0.correct, 1);
  assert.equal(q0.expected, 'B');
  const qLong = res.data.questions.find((x) => x.key === '1.2');
  assert.equal(qLong.manual, true);
  assert.equal(qLong.pending, 1);
});

test('manual marks override or complete grading; clearing restores the automatic verdict', async () => {
  const detail = await call(`/api/sessions/${sessionId}`, { token });
  const a = detail.data.participants.find((p) => p.name === 'Ada Lovelace');
  const mark = (key, correct) =>
    call(`/api/sessions/${sessionId}/participants/${a.id}/marks/${key}`, {
      method: 'PUT',
      token,
      body: { correct },
    });

  assert.equal((await mark('1.2', 'yes')).status, 400);
  assert.equal((await mark('7.7', true)).status, 404);
  const long = await mark('1.2', true);
  assert.equal(long.status, 200);
  assert.equal(long.data.correct, true);
  assert.equal(long.data.points_awarded, 5);
  assert.equal(long.data.marked_by, 'instructor');
  await mark('1.1', false);
  // Override an automatic verdict, then clear it again.
  assert.equal((await mark('0.0', false)).data.correct, false);
  assert.equal((await mark('0.0', null)).data.correct, true);

  const pd = await call(`/api/sessions/${sessionId}/participants/${a.id}`, { token });
  assert.equal(pd.status, 200);
  assert.equal(pd.data.score, 2 + 1 + 1 + 1 + 5);
  assert.equal(pd.data.fully_graded, true);
  const q00 = pd.data.questions.find((q) => q.key === '0.0');
  assert.equal(q00.expected, 'B');
  assert.equal(q00.response, 'B');
  assert.deepEqual(
    q00.history.map((h) => h.response),
    ['A', 'B'],
    'every change is logged',
  );

  // Grade-by-question view lists every participant's response.
  const byQ = await call(`/api/sessions/${sessionId}/questions/1.2`, { token });
  assert.equal(byQ.status, 200);
  assert.equal(byQ.data.responses.length, 2);
  assert.equal(byQ.data.responses.find((r) => r.name === 'Ada Lovelace').correct, true);
});

test('the export carries questions, expected answers, responses, marks and the answer log', async () => {
  const res = await call(`/api/sessions/${sessionId}/export`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.session.kind, 'exam');
  assert.equal(res.data.questions.length, 6);
  assert.equal(res.data.questions[3].expected, '443 | tcp/443');
  const a = res.data.participants.find((p) => p.name === 'Ada Lovelace');
  assert.equal(a.score, 10);
  assert.equal(a.responses.find((r) => r.key === '1.2').override, true);
  assert.ok(res.data.answer_log.length >= 9);
  assert.ok(res.data.answer_log.every((e, i, arr) => i === 0 || arr[i - 1].at <= e.at));
});

test('the exam Markdown format round-trips and rejects unknown types', async () => {
  const { parseExamMarkdown, examToMarkdown, SAMPLE_EXAM_MARKDOWN } =
    await import('../../shared/exam-format.js');
  const exam = parseExamMarkdown(SAMPLE_EXAM_MARKDOWN);
  assert.deepEqual(
    exam.content.map((s) => s.type),
    ['questions', 'questions', 'info', 'submit'],
  );
  assert.deepEqual(
    exam.content[2].steps.map((st) => [st.title, st.tasks.length]),
    [
      ['Cable the bench', 2],
      ['Instructor check', 1],
    ],
  );
  assert.equal(exam.content[0].questions[1].type, 'multiple');
  assert.deepEqual(exam.content[0].questions[1].correct, [0, 2]);
  assert.deepEqual(parseExamMarkdown(examToMarkdown(exam)), exam);

  const aliases = parseExamMarkdown(
    '# S\n\n## [tf] Sky is blue\n> answer: yes\n\n## [essay]\nWhy?\n',
  );
  assert.equal(aliases.content[0].questions[0].type, 'truefalse');
  assert.equal(aliases.content[0].questions[0].correct, true);
  assert.equal(aliases.content[0].questions[1].type, 'long');
  assert.equal(aliases.content[0].questions[1].prompt, 'Why?');

  assert.throws(() => parseExamMarkdown('# S\n## [poll] x\n'), /Unknown question type/);
  // Code fences are verbatim: a "# heading" inside one is not a new section.
  const fenced = parseExamMarkdown('# S\n## [long] Read:\n```\n# not a section\n```\n');
  assert.equal(fenced.content.length, 2, 'the section and the default submit section');
  assert.match(fenced.content[0].questions[0].prompt, /# not a section/);
});

test('an exam seat is bound to its device: rejoining by name needs the resume key', async () => {
  const first = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: roomCode, first_name: 'Cara', last_name: 'Key' },
  });
  assert.equal(first.status, 200);
  const key = first.data.resume_key;
  assert.ok(key && key.length >= 20, 'exam joins hand out a resume key');

  // Someone else typing the same name on another device is refused…
  const thief = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: roomCode, first_name: 'cara', last_name: 'KEY' },
  });
  assert.equal(thief.status, 409);
  assert.equal(thief.data.code, 'SEAT_TAKEN');

  // …while the original device resumes with its key.
  const again = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: roomCode, first_name: 'Cara', last_name: 'Key', resume_key: key },
  });
  assert.equal(again.status, 200);
  assert.equal(again.data.resumed, true);
  assert.equal(again.data.seat_number, first.data.seat_number);

  // The instructor releases the seat: the old device is signed out and the
  // next join (any device) takes the seat over with a fresh key.
  const detail = await call(`/api/sessions/${sessionId}`, { token });
  const cara = detail.data.participants.find((p) => p.name === 'Cara Key');
  const rel = await call(`/api/sessions/${sessionId}/participants/${cara.id}/release`, {
    method: 'POST',
    token,
  });
  assert.equal(rel.status, 200);
  const old = await call('/api/participant/exam', { token: again.data.token });
  assert.equal(old.status, 401);
  assert.equal(old.data.code, 'SEAT_RELEASED');
  const moved = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: roomCode, first_name: 'Cara', last_name: 'Key' },
  });
  assert.equal(moved.status, 200);
  assert.notEqual(moved.data.resume_key, key);
  assert.equal((await call('/api/participant/exam', { token: moved.data.token })).status, 200);
});

test('the instructor can reopen a submission and remove a participant', async () => {
  const detail = await call(`/api/sessions/${sessionId}`, { token });
  const ada = detail.data.participants.find((p) => p.name === 'Ada Lovelace');
  assert.equal(ada.submitted, true);
  const reopen = await call(`/api/sessions/${sessionId}/participants/${ada.id}/reopen`, {
    method: 'POST',
    token,
  });
  assert.equal(reopen.status, 200);
  const after = await call(`/api/sessions/${sessionId}/participants/${ada.id}`, { token });
  assert.equal(after.data.submitted, false);
  assert.equal(after.data.answered, 6, 'answers are kept');

  const cara = detail.data.participants.find((p) => p.name === 'Cara Key');
  const del = await call(`/api/sessions/${sessionId}/participants/${cara.id}`, {
    method: 'DELETE',
    token,
  });
  assert.equal(del.status, 204);
  const gone = await call(`/api/sessions/${sessionId}`, { token });
  assert.equal(
    gone.data.participants.some((p) => p.name === 'Cara Key'),
    false,
  );
});

test('answer history lives in its own table, one small row per change', async () => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM exam_answer_events').get().n;
  assert.ok(n >= 9);
  const row = db.prepare("SELECT answer_log FROM participants WHERE first_name = 'Ada'").get();
  assert.equal(row.answer_log, '[]', 'the participants row no longer carries the log');
  const st = await call('/api/participant/status', { token: ada });
  assert.ok(Date.parse(st.data.server_time) > 0, 'status reports server time');
});

test('exam sections are timed like lab sections; submitting stops the clock', async () => {
  const fresh = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: roomCode, first_name: 'Tess', last_name: 'Timer' },
  });
  const t = fresh.data.token;
  const put = (key, value) =>
    call('/api/participant/exam/answer', { method: 'PUT', token: t, body: { key, value } });
  await put('0.0', 1);
  await put('0.1', [0]);
  const last = await put('0.2', true);
  // Part 2 is the last questions part, so the submit section opens with it.
  assert.equal(last.data.unlocked_section, 2, 'answering the whole section unlocks the next');
  assert.equal(last.data.section_complete, true);
  const nav = await call('/api/participant/exam/progress', {
    method: 'POST',
    token: t,
    body: { section_index: 1 },
  });
  assert.equal(nav.status, 200);
  // Clearing an earlier answer never re-locks a section already opened.
  await put('0.0', null);
  const view = await call('/api/participant/exam', { token: t });
  assert.equal(view.data.unlocked_section, 2);
  assert.equal(view.data.sections.length, 3);
  assert.equal(view.data.sections[2].type, 'submit');
  assert.equal(view.data.sections[2].review, true);

  const detail = await call(`/api/sessions/${sessionId}`, { token });
  const tess = detail.data.participants.find((p) => p.name === 'Tess Timer');
  assert.equal(tess.furthest_section, 1);
  assert.deepEqual(tess.sections_done, [true, false, false]);
  assert.equal(detail.data.section_distribution[0].completed_count >= 1, true);

  await call('/api/participant/exam/submit', { method: 'POST', token: t });
  const after = await call(`/api/sessions/${sessionId}/participants/${tess.id}`, { token });
  assert.equal(after.data.submitted, true);
  assert.equal(after.data.time_status, 'ok');
  assert.ok(Array.isArray(after.data.section_times));
});

test('section drawer for exams: timing plus that section’s question results', async () => {
  const d = await call(`/api/sessions/${sessionId}/sections/0`, { token });
  assert.equal(d.status, 200);
  assert.equal(d.data.kind, 'exam');
  assert.equal(d.data.question_count, 3);
  assert.deepEqual(
    d.data.questions.map((q) => q.key),
    ['0.0', '0.1', '0.2'],
  );
  assert.ok(d.data.completed_count >= 1);
  assert.ok(d.data.completed.some((p) => p.name === 'Tess Timer'));
  assert.equal(d.data.questions[0].expected !== undefined, true);
  const second = await call(`/api/sessions/${sessionId}/sections/1`, { token });
  assert.ok(second.data.questions.every((q) => q.section_index === 1));
});

test('informational sections: the participant ticks every item to move on; nobody approves it', async () => {
  const tpl = await call('/api/templates', {
    method: 'POST',
    token,
    body: {
      kind: 'exam',
      title: 'Bench exam',
      content: [
        { title: 'Theory', questions: [{ type: 'truefalse', prompt: 'True?', correct: true }] },
        {
          type: 'info',
          title: 'Bench check',
          minutes: 15,
          steps: [
            { body: 'Cable it, then call your instructor.', tasks: ['Cabled'] },
            { title: 'Check', body: '', tasks: ['Instructor checked it'] },
          ],
        },
        { title: 'After', questions: [{ type: 'short', prompt: 'Port?', accepted: ['443'] }] },
        { type: 'submit', title: 'Hand in', review: false, body: 'Done?' },
      ],
    },
  });
  assert.equal(tpl.status, 201);
  assert.deepEqual(
    tpl.data.content.map((s) => s.type),
    ['questions', 'info', 'questions', 'submit'],
  );
  const sess = await call('/api/sessions', {
    method: 'POST',
    token,
    body: { template_id: tpl.data.id },
  });
  assert.equal(sess.status, 201);
  const minutes = (Date.parse(sess.data.expires_at) - Date.now()) / 60_000;
  assert.ok(minutes > 55 && minutes <= 60, 'exams run for an hour by default');

  const join = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: sess.data.room_code, first_name: 'Cat', last_name: 'Bench' },
  });
  const t = join.data.token;
  const put = (key, value) =>
    call('/api/participant/exam/answer', { method: 'PUT', token: t, body: { key, value } });

  assert.equal((await put('1.t0', true)).status, 403, 'a locked checklist cannot be ticked');
  assert.equal((await put('0.0', true)).data.unlocked_section, 1);
  let view = await call('/api/participant/exam', { token: t });
  assert.equal(view.data.submit_section, 3);
  const info = view.data.sections[1];
  assert.equal(info.type, 'info');
  assert.equal(info.steps[0].body, 'Cable it, then call your instructor.');
  assert.equal(info.steps[1].title, 'Check');
  assert.deepEqual(
    info.steps.map((st) => st.tasks.map((x) => x.key)),
    [['1.t0'], ['1.t1']],
    'items are numbered across the steps',
  );
  assert.equal(view.data.question_count, 2, 'checklist items are not questions');

  assert.equal((await put('1.t9', true)).status, 400, 'unknown item');
  const one = await put('1.t0', true);
  assert.equal(one.data.unlocked_section, 1, 'one tick is not enough');
  assert.equal(one.data.section_complete, false);
  const both = await put('1.t1', 'yes');
  assert.equal(both.data.unlocked_section, 1, 'only `true` ticks an item');
  const done = await put('1.t1', true);
  assert.equal(done.data.unlocked_section, 3, 'the next part, and the submit section after it');
  view = await call('/api/participant/exam', { token: t });
  assert.equal(view.data.answers['1.t0'], true);
  assert.equal(view.data.answered_count, 1);
  assert.equal(view.data.sections[3].review, false);
  assert.equal(view.data.sections[3].body, 'Done?');
  assert.equal((await put('2.0', '443')).status, 200);
  const untick = await put('1.t0', null);
  assert.equal(untick.data.unlocked_section, 1, 'unticking locks what follows again');
  view = await call('/api/participant/exam', { token: t });
  assert.equal('1.t0' in view.data.answers, false, 'unticking removes it');
  assert.equal(view.data.sections.length, 2, 'later sections are no longer sent');
  assert.equal((await put('2.0', '80')).status, 403);
  assert.equal((await put('1.t0', true)).data.unlocked_section, 3, 'ticking it again reopens them');

  const sub = await call('/api/participant/exam/submit', { method: 'POST', token: t });
  assert.equal(sub.status, 200);
  const detail = await call(`/api/sessions/${sess.data.id}`, { token });
  assert.equal(detail.data.question_count, 2);
  assert.equal(detail.data.section_count, 4);
  const log = await call(`/api/sessions/${sess.data.id}/export`, { token });
  assert.ok(
    log.data.answer_log.some((e) => e.question === '1.t1' && e.response === 'Ticked'),
    'ticks are in the answer log',
  );
});

test('per-seat variables and saved answers resolve throughout the exam and its grading', async () => {
  const body = {
    kind: 'exam',
    title: 'Seats',
    variables: [{ name: 'STORE', expression: '100 + seat' }],
    content: [
      {
        type: 'info',
        title: 'Bench {{ SEAT_ID }}',
        steps: [
          {
            title: 'Hi {{ FIRST_NAME }}',
            body: 'Store {{ STORE }}',
            tasks: ['Ping store {{ STORE }}'],
          },
        ],
      },
      {
        title: 'Setup',
        questions: [
          { type: 'short', prompt: 'Which store is yours?', accepted: ['{{ STORE }}'] },
          { type: 'short', prompt: 'Your router IP?', capture: 'ROUTER_IP' },
        ],
      },
      {
        title: 'Check {{ ROUTER_IP }}',
        questions: [
          {
            type: 'single',
            prompt: 'Is {{ ROUTER_IP }} on store {{ STORE }}?',
            options: ['Yes, {{ ROUTER_IP }}', 'No'],
            correct: 0,
          },
          { type: 'short', prompt: 'Repeat your router IP', accepted: ['{{ ROUTER_IP }}'] },
        ],
      },
    ],
  };

  // Placeholders must be declared, and a saved answer only exists after its section.
  const bad = await call('/api/templates', {
    method: 'POST',
    token,
    body: {
      ...body,
      content: [
        { ...body.content[1], title: 'Setup {{ ROUTER_IP }} {{ NOPE }}' },
        { title: 'X', questions: [{ type: 'long', prompt: 'x', capture: 'LONG' }] },
      ],
    },
  });
  assert.equal(bad.status, 400);
  const msgs = bad.data.details.join('\n');
  assert.match(msgs, /Unknown placeholder \{\{ NOPE \}\} in Section 1 title/);
  assert.match(
    msgs,
    /\{\{ ROUTER_IP \}\} is used in Section 1 title before the question that saves it/,
  );
  assert.match(msgs, /Section 2 · question 1: only a short answer can be saved as a variable/);

  const tpl = await call('/api/templates', { method: 'POST', token, body });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
  assert.deepEqual(tpl.data.variables, body.variables);
  assert.equal(tpl.data.content[1].questions[1].capture, 'ROUTER_IP');

  // The instructor preview resolves a chosen seat.
  const pv = await call(`/api/templates/${tpl.data.id}/preview`, {
    method: 'POST',
    token,
    body: { seat_id: 3 },
  });
  assert.equal(pv.status, 200);
  assert.equal(pv.data.context.STORE, 103);
  assert.equal(pv.data.sections[0].steps[0].body, 'Store 103');
  assert.match(pv.data.sections[2].title, /^Check \[answer to Section 2 · question 2\]$/);

  const sess = await call('/api/sessions', {
    method: 'POST',
    token,
    body: { template_id: tpl.data.id },
  });
  const join = await call('/api/participant/join', {
    method: 'POST',
    body: { room_code: sess.data.room_code, first_name: 'Dee', last_name: 'Seat' },
  });
  const t = join.data.token;
  const seat = join.data.seat_number;
  const store = String(100 + Number(seat));
  const put = (key, value) =>
    call('/api/participant/exam/answer', { method: 'PUT', token: t, body: { key, value } });

  let view = await call('/api/participant/exam', { token: t });
  assert.equal(view.data.sections[0].title, `Bench ${seat}`);
  assert.equal(view.data.sections[0].steps[0].title, 'Hi Dee');
  assert.equal(view.data.sections[0].steps[0].tasks[0].text, `Ping store ${store}`);
  await put('0.t0', true);
  view = await call('/api/participant/exam', { token: t });
  assert.equal(view.data.sections[1].questions[1].capture, 'ROUTER_IP');
  await put('1.0', store);
  await put('1.1', ' 10.0.0.1 ');
  view = await call('/api/participant/exam', { token: t });
  const check = view.data.sections[2];
  assert.equal(check.title, 'Check 10.0.0.1');
  assert.equal(check.questions[0].prompt, `Is 10.0.0.1 on store ${store}?`);
  assert.deepEqual(check.questions[0].options, ['Yes, 10.0.0.1', 'No']);
  // Changing the saved answer changes what later sections show.
  await put('1.1', '10.0.0.2');
  view = await call('/api/participant/exam', { token: t });
  assert.equal(view.data.sections[2].title, 'Check 10.0.0.2');
  await put('2.0', 0);
  await put('2.1', '10.0.0.2');

  const detail = await call(`/api/sessions/${sess.data.id}`, { token });
  const d = detail.data.participants.find((x) => x.name === 'Dee Seat');
  assert.equal(d.score, 1 + 1 + 1, 'per-seat and saved answers grade automatically');
  assert.equal(d.pending_count, 1, 'the saved answer itself is marked by hand');
});

test('a lab session runs for 8 hours unless told otherwise', async () => {
  const list = await call('/api/templates', { token });
  const lab = list.data.find((x) => x.kind === 'lab');
  const sess = await call('/api/sessions', {
    method: 'POST',
    token,
    body: { template_id: lab.id },
  });
  assert.equal(sess.status, 201);
  const hours = (Date.parse(sess.data.expires_at) - Date.now()) / 3_600_000;
  assert.ok(hours > 7.9 && hours <= 8, `got ${hours} h`);
});
