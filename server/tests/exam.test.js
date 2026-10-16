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

test('the participant gets every question but never the answers; lab routes are refused', async () => {
  const res = await call('/api/participant/exam', { token: ada });
  assert.equal(res.status, 200);
  assert.equal(res.data.question_count, 6);
  assert.equal(res.data.sections.length, 2);
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
  assert.equal(view.data.answers['0.0'], 1, 'answer unchanged');
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
  assert.equal(exam.content.length, 2);
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
  assert.equal(fenced.content.length, 1);
  assert.match(fenced.content[0].questions[0].prompt, /# not a section/);
});
