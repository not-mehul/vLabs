/** Exam CSV exports and the shared exam schema helpers (node:test, no DOM needed). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { examResultsToCsv, examKeyToCsv, examLogToCsv } from '../src/lib/format.js';
import {
  normaliseExam,
  examErrors,
  gradeResponse,
  publicQuestion,
  isManualQuestion,
  examUnlockedSection,
  isExamSectionComplete,
  listTasks,
} from '../../shared/exam-schema.js';
import {
  parseExamMarkdown,
  examToMarkdown,
  SAMPLE_EXAM_MARKDOWN,
} from '../../shared/exam-format.js';

const doc = {
  questions: [
    {
      key: '0.0',
      number: 1,
      section_title: 'P1',
      type: 'single',
      points: 2,
      prompt: 'Pick',
      options: ['A', 'B'],
      expected: 'B',
    },
    {
      key: '0.1',
      number: 2,
      section_title: 'P1',
      type: 'long',
      points: 5,
      prompt: '=SUM(1)',
      options: [],
      expected: '',
    },
  ],
  participants: [
    {
      number: 1,
      name: 'Ada Lovelace',
      first_name: 'Ada',
      last_name: 'Lovelace',
      submitted: true,
      submitted_at: '2026-01-01T10:00:00.000Z',
      answered: 2,
      question_count: 2,
      score: 2,
      max_score: 7,
      score_pct: 29,
      pending_count: 1,
      fully_graded: false,
      total_seconds: 300,
      responses: [
        {
          key: '0.0',
          response: 'B',
          answered: true,
          pending: false,
          correct: true,
          points_awarded: 2,
          marked_by: null,
        },
        {
          key: '0.1',
          response: 'Because, "reasons"',
          answered: true,
          pending: true,
          correct: null,
          points_awarded: 0,
          marked_by: null,
        },
      ],
    },
  ],
  answer_log: [
    {
      at: '2026-01-01T09:59:00.000Z',
      number: 1,
      name: 'Ada Lovelace',
      question: '0.0',
      response: 'A',
    },
  ],
};

test('examResultsToCsv: fixed columns then response/result/points/marker per question', () => {
  const [header, row] = examResultsToCsv(doc).trim().split('\n');
  assert.ok(header.startsWith('number,name,first_name,last_name,submitted'));
  assert.ok(
    header.endsWith(
      'q1_response,q1_result,q1_points,q1_marked_by,q2_response,q2_result,q2_points,q2_marked_by',
    ),
  );
  assert.match(row, /,yes,/, 'booleans as yes/no');
  assert.match(row, /,B,correct,2,,/);
  assert.match(row, /"Because, ""reasons""",needs marking,0,$/);
});

test('examKeyToCsv neutralises formula injection; examLogToCsv lists changes', () => {
  const key = examKeyToCsv(doc);
  assert.match(key, /'=SUM\(1\)/);
  assert.match(key, /A \| B,B/);
  assert.equal(examLogToCsv(doc).trim().split('\n').length, 2);
});

test('exam schema: normalising, validation, grading and the public view', () => {
  const exam = normaliseExam({
    title: 'T',
    content: [
      {
        title: 'S',
        questions: [
          { type: 'single', prompt: 'p', options: ['a', 'b'], correct: '1' },
          { type: 'short', prompt: 'q', accepted: [' x ', 'x', ''] },
          { type: 'mystery', prompt: 'r', options: ['a', 'b'], correct: 0 },
        ],
      },
    ],
  });
  const [single, short, unknown] = exam.content[0].questions;
  assert.equal(single.correct, 1);
  assert.deepEqual(short.accepted, ['x']);
  assert.equal(unknown.type, 'single', 'unknown types fall back to multiple choice');
  assert.deepEqual(examErrors(exam), []);
  assert.equal(gradeResponse(short, 'X').correct, true);
  assert.equal(
    gradeResponse(single, undefined).correct,
    false,
    'unanswered auto question scores 0',
  );
  assert.equal(isManualQuestion({ type: 'short', accepted: [] }), true);
  const pub = publicQuestion(single);
  assert.equal('correct' in pub, false);
  assert.deepEqual(pub.options, ['a', 'b']);
});

test('exam sections carry a time allocation through markdown', () => {
  const exam = parseExamMarkdown(SAMPLE_EXAM_MARKDOWN);
  assert.deepEqual(
    exam.content.map((s) => s.minutes),
    [5, 10, 10, null],
  );
  assert.deepEqual(parseExamMarkdown(examToMarkdown(exam)), exam);
  const untimed = parseExamMarkdown('# A\n\n## [tf] Sky is blue\n> answer: true\n');
  assert.equal(untimed.content[0].minutes, null);
  assert.ok(!examToMarkdown(untimed).includes('minutes'));
});

test('examResultsToCsv: one time column per section when the export lists sections', () => {
  const timed = {
    ...doc,
    sections: [
      { number: 1, title: 'Part 1' },
      { number: 2, title: 'Part 2' },
    ],
    participants: doc.participants.map((p) => ({ ...p, section_seconds: [61, 122] })),
  };
  const [header, row] = examResultsToCsv(timed).trim().split('\n');
  assert.match(
    header,
    /,furthest_section,joined_at,last_seen_at,time_s1_part_1,time_s2_part_2,q1_response/,
  );
  assert.match(row, /,61,122,/);
});

test('Studio imports: labs and exams are told apart (JSON kind, Markdown types)', async () => {
  const { parseStudioText } = await import('../src/lib/studioPackage.js');
  const { looksLikeExamMarkdown } = await import('../../shared/exam-format.js');
  const { SAMPLE_MARKDOWN } = await import('../src/lib/templateFormat.js');
  assert.equal(parseStudioText(SAMPLE_EXAM_MARKDOWN, false).kind, 'exam');
  assert.equal(parseStudioText(SAMPLE_MARKDOWN, false).kind, 'lab');
  const exam = parseExamMarkdown(SAMPLE_EXAM_MARKDOWN);
  const fromJson = parseStudioText(JSON.stringify(exam), true);
  assert.equal(fromJson.kind, 'exam');
  assert.deepEqual(fromJson.template, exam);
  assert.equal(parseStudioText(JSON.stringify({ title: 'L', content: [] }), true).kind, 'lab');
  // Exported exams say so; older exam files without the marker are still recognised.
  assert.match(examToMarkdown(exam), /^---\nkind: exam\n/);
  assert.equal(looksLikeExamMarkdown('# P\n\n## [mcq] Pick one\n- [x] a\n'), true);
  assert.equal(looksLikeExamMarkdown('# S\n\n## [desk] Do it\nBody\n'), false);
  assert.throws(() => parseExamMarkdown('---\nkind: lab\n---\n# S\n'), /is a lab/);
});

test('informational sections: steps of instructions and checklists the participant ticks off', () => {
  const md = `---
title: Bench exam
---
# Part 1
## [tf] Sky is blue
> answer: true

# [info] Bench check
> minutes: 15
Cable the switch, then call your instructor over.

## Wiring
\`\`\`
- [ ] not an item (fenced)
\`\`\`
- [ ] Switch cabled
- [x] Instructor checked it

# Part 2
## [short] Port?
`;
  const exam = parseExamMarkdown(md);
  const info = exam.content[1];
  assert.equal(info.type, 'info');
  assert.equal(info.minutes, 15);
  assert.equal(info.steps.length, 2, 'text before the first ## is an untitled first step');
  assert.deepEqual(info.steps[0], {
    title: '',
    body: 'Cable the switch, then call your instructor over.',
    tasks: [],
  });
  assert.equal(info.steps[1].title, 'Wiring');
  assert.deepEqual(info.steps[1].tasks, ['Switch cabled', 'Instructor checked it']);
  assert.match(info.steps[1].body, /not an item \(fenced\)/);
  assert.deepEqual(info.questions, []);
  assert.deepEqual(parseExamMarkdown(examToMarkdown(exam)), exam, 'round-trips');
  assert.deepEqual(examErrors(exam), []);
  assert.deepEqual(
    listTasks(exam.content).map((t) => t.key),
    ['1.t0', '1.t1'],
  );

  // The checklist gates the next section; ticks are `true` under the task keys.
  const answered = { '0.0': true };
  assert.equal(examUnlockedSection(exam.content, answered), 1);
  assert.equal(isExamSectionComplete(exam.content, 1, { ...answered, '1.t0': true }), false);
  const ticked = { ...answered, '1.t0': true, '1.t1': true };
  assert.equal(examUnlockedSection(exam.content, ticked), 3, 'part 2, then straight to submit');
  // …and a checklist right before submit has to be ticked too.
  const last = parseExamMarkdown(
    '# A\n## [tf] x\n> answer: true\n\n# [checklist] Check\n- [ ] y\n',
  );
  assert.equal(examUnlockedSection(last.content, { '0.0': true }), 1);
  assert.equal(examUnlockedSection(last.content, { '0.0': true, '1.t0': true }), 2);
  // Unticking re-locks what follows, even past the high-water mark…
  assert.equal(examUnlockedSection(exam.content, { ...ticked, '1.t1': null }, 3), 1);
  // …while clearing an answer does not.
  assert.equal(examUnlockedSection(exam.content, { ...ticked, '0.0': null }, 3), 3);

  // Untitled later steps and titles that start with a tag survive a round trip.
  const steps = parseExamMarkdown(
    '# [informational] I\n## [step]\n- [ ] a\n## [weird] Title\nText\n## [step] [x] odd\n- [ ] b\n',
  );
  assert.deepEqual(
    steps.content[0].steps.map((st) => st.title),
    ['', '[weird] Title', '[x] odd'],
  );
  assert.deepEqual(parseExamMarkdown(examToMarkdown(steps)), steps);
  assert.deepEqual(
    listTasks(steps.content).map((t) => [t.key, t.sti]),
    [
      ['0.t0', 0],
      ['0.t1', 2],
    ],
  );

  assert.throws(
    () => parseExamMarkdown('# [info] I\n## [single] Not here\n- [x] a\n'),
    /cannot go in an? \[info\] section/i,
  );
  assert.deepEqual(examErrors(normaliseExam({ title: 'T', content: [{ type: 'info' }] })), [
    'Section 1 needs a title',
    'Section 1 needs instructions or a checklist',
  ]);
  assert.deepEqual(
    examErrors(
      normaliseExam({
        title: 'T',
        content: [{ type: 'info', title: 'I', steps: [{ tasks: ['a'] }] }],
      }),
    ),
    [],
    'an exam can be checklists only',
  );
  assert.deepEqual(
    examErrors(
      normaliseExam({
        title: 'T',
        content: [{ type: 'info', title: 'I', steps: [{ tasks: ['a'] }, { title: 'Empty' }] }],
      }),
    ),
    ['Section 1 · step 2 needs instructions or a checklist'],
  );
});

test('informational sections saved by 1.9.0 (body and tasks, no steps) still work', () => {
  const legacy = [
    { type: 'info', title: 'Bench', body: 'Do it.', tasks: ['a', 'b'], questions: [] },
    { type: 'submit', title: 'Submit', body: '', review: true, questions: [] },
  ];
  assert.deepEqual(normaliseExam({ title: 'T', content: legacy }).content[0].steps, [
    { title: '', body: 'Do it.', tasks: ['a', 'b'] },
  ]);
  assert.deepEqual(
    listTasks(legacy).map((t) => t.key),
    ['0.t0', '0.t1'],
  );
  assert.equal(examUnlockedSection(legacy, { '0.t0': true }), 0);
  assert.equal(examUnlockedSection(legacy, { '0.t0': true, '0.t1': true }), 1);
});

test('every exam ends with exactly one submit section', () => {
  const plain = normaliseExam({ title: 'T', content: [{ title: 'A', questions: [] }] });
  assert.deepEqual(plain.content[1], {
    type: 'submit',
    title: 'Review and submit',
    minutes: null,
    body: '',
    review: true,
    questions: [],
  });
  const moved = normaliseExam({
    content: [
      { type: 'submit', title: 'Hand in', review: 'false', minutes: 5 },
      { title: 'A' },
      { type: 'submit', title: 'Second' },
    ],
  });
  assert.deepEqual(
    moved.content.map((s) => [s.type, s.title]),
    [
      ['questions', 'A'],
      ['submit', 'Hand in'],
    ],
  );
  assert.equal(moved.content[1].review, false);
  assert.equal(moved.content[1].minutes, null);

  const md = examToMarkdown(moved);
  assert.match(md, /# \[submit\] Hand in\n> review: false\n/);
  assert.deepEqual(parseExamMarkdown(md), moved);
  assert.deepEqual(
    examErrors(normaliseExam({ title: 'T', content: [] })),
    ['At least one section is required'],
    'the submit section alone is not an exam',
  );
});
