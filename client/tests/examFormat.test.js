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
  capturedValue,
  describeExpected,
} from '../../shared/exam-schema.js';
import {
  parseExamMarkdown,
  examToMarkdown,
  SAMPLE_EXAM_MARKDOWN,
} from '../../shared/exam-format.js';
import { compileMask } from '../../shared/template-schema.js';

/** The message compileMask gives for a mask. */
const patternError = (mask) => {
  try {
    compileMask(mask);
    return '';
  } catch (err) {
    return err.message;
  }
};

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
      auto_submitted: false,
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

test('examResultsToCsv: fixed columns then response/result/points/marker/comment per question', () => {
  const [header, row] = examResultsToCsv(doc).trim().split('\n');
  assert.ok(header.startsWith('number,name,first_name,last_name,submitted'));
  assert.ok(
    header.endsWith(
      'q1_response,q1_result,q1_points,q1_marked_by,q1_comment,' +
        'q2_response,q2_result,q2_points,q2_marked_by,q2_comment',
    ),
  );
  assert.match(row, /,yes,/, 'booleans as yes/no');
  assert.match(row, /,B,correct,2,,,/);
  assert.match(row, /"Because, ""reasons""",needs marking,0,,$/);

  const marked = {
    ...doc,
    participants: doc.participants.map((p) => ({
      ...p,
      responses: [
        p.responses[0],
        {
          ...p.responses[1],
          pending: false,
          correct: false,
          partial: true,
          points_awarded: 2.5,
          marked_by: 'instructor',
          comment: 'Good start',
        },
      ],
    })),
  };
  const [, markedRow] = examResultsToCsv(marked).trim().split('\n');
  assert.match(markedRow, /,partial,2\.5,instructor,Good start$/);
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
        items: [
          { type: 'single', prompt: 'p', options: ['a', 'b'], correct: '1' },
          { type: 'short', prompt: 'q', accepted: [' x ', 'x', ''] },
          { type: 'mystery', prompt: 'r', options: ['a', 'b'], correct: 0 },
        ],
      },
    ],
  });
  const [single, short, unknown] = exam.content[0].items;
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
  // Partial marks: some of the points, halves allowed; full marks count as correct.
  const long = { type: 'long', points: 5 };
  const half = gradeResponse(long, 'essay', undefined, 2.5);
  assert.equal(half.points_awarded, 2.5);
  assert.equal(half.partial, true);
  assert.equal(half.correct, false);
  assert.equal(half.pending, false);
  assert.equal(gradeResponse(long, 'essay', undefined, 5).correct, true);
  assert.equal(gradeResponse(long, 'essay', undefined, 7).pending, true, 'out of range: ignored');
  assert.equal(gradeResponse(long, 'essay', undefined, 1.3).pending, true, 'not a half step');
  const pub = publicQuestion(single);
  assert.equal('correct' in pub, false);
  assert.deepEqual(pub.options, ['a', 'b']);
});

test('exam sections carry a time allocation through markdown', () => {
  const exam = parseExamMarkdown(SAMPLE_EXAM_MARKDOWN);
  assert.deepEqual(
    exam.content.map((s) => s.minutes),
    [5, 15, 10, null],
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

test('exam Markdown is told apart from lab Markdown', async () => {
  const { looksLikeExamMarkdown } = await import('../../shared/exam-format.js');
  const { SAMPLE_MARKDOWN } = await import('../../shared/template-format.js');
  assert.equal(looksLikeExamMarkdown(SAMPLE_EXAM_MARKDOWN), true);
  assert.equal(looksLikeExamMarkdown(SAMPLE_MARKDOWN), false);
  const exam = parseExamMarkdown(SAMPLE_EXAM_MARKDOWN);
  // Exported exams say so; older exam files without the marker are still recognised.
  assert.match(examToMarkdown(exam), /^---\nkind: exam\n/);
  assert.equal(looksLikeExamMarkdown('# P\n\n## [mcq] Pick one\n- [x] a\n'), true);
  assert.equal(looksLikeExamMarkdown('# S\n\n## [desk] Do it\nBody\n'), false);
  assert.throws(() => parseExamMarkdown('---\nkind: lab\n---\n# S\n'), /is a lab/);
});

test('sections mix steps and questions; pages, checklists and unlocking', () => {
  const md = `---
title: Bench exam
---
# Part 1
## [tf] Sky is blue
> answer: true

# Bench check
> minutes: 15
Cable the switch, then call your instructor over.

## [checklist] Wiring
\`\`\`
- [ ] not an item (fenced)
\`\`\`
- [ ] Switch cabled
- [x] Instructor checked it

## [short] Which port did you use?

## [informational] Reminder
Leave the cables in place.

# Part 2
## [short] Port?
`;
  const exam = parseExamMarkdown(md);
  const bench = exam.content[1];
  assert.equal(bench.minutes, 15);
  assert.deepEqual(
    bench.items.map((it) => [it.type, it.title ?? it.prompt]),
    [
      ['info', ''],
      ['checklist', 'Wiring'],
      ['short', 'Which port did you use?'],
      ['info', 'Reminder'],
    ],
    'text before the first item is an untitled Informational item',
  );
  assert.deepEqual(bench.items[1].tasks, ['Switch cabled', 'Instructor checked it']);
  assert.match(bench.items[1].body, /not an item \(fenced\)/);
  assert.deepEqual(parseExamMarkdown(examToMarkdown(exam)), exam, 'round-trips');
  assert.deepEqual(examErrors(exam), []);
  assert.deepEqual(
    listTasks(exam.content).map((t) => [t.key, t.ii]),
    [
      ['1.t0', 1],
      ['1.t1', 1],
    ],
  );

  // A section unlocks the next once its questions are answered and boxes ticked.
  const answered = { '0.0': true };
  assert.equal(examUnlockedSection(exam.content, answered), 1);
  const ticked = { ...answered, '1.t0': true, '1.t1': true };
  assert.equal(examUnlockedSection(exam.content, ticked), 1, 'its question is still open');
  assert.equal(isExamSectionComplete(exam.content, 1, { ...ticked, '1.0': 'Gi0/1' }), true);
  const done = { ...ticked, '1.0': 'Gi0/1' };
  assert.equal(examUnlockedSection(exam.content, done), 3, 'part 2, then straight to submit');
  // …and a checklist right before submit has to be ticked too.
  const last = parseExamMarkdown(
    '# A\n## [tf] x\n> answer: true\n\n# B\n## [checklist]\n- [ ] y\n',
  );
  assert.equal(examUnlockedSection(last.content, { '0.0': true }), 1);
  assert.equal(examUnlockedSection(last.content, { '0.0': true, '1.t0': true }), 2);
  // Unticking re-locks what follows, even past the high-water mark…
  assert.equal(examUnlockedSection(exam.content, { ...done, '1.t1': null }, 3), 1);
  // …while clearing an answer does not.
  assert.equal(examUnlockedSection(exam.content, { ...done, '0.0': null }, 3), 3);

  // Untitled steps and titles that start with a tag survive a round trip.
  const steps = parseExamMarkdown(
    '# I\n## [checklist]\n- [ ] a\n## [info] [weird] Title\nText\n## [step] [x] odd\n- [ ] b\n',
  );
  assert.deepEqual(
    steps.content[0].items.map((it) => [it.type, it.title]),
    [
      ['checklist', ''],
      ['info', '[weird] Title'],
      ['checklist', '[x] odd'],
    ],
    'an [info] item with - [ ] lines is a checklist',
  );
  assert.deepEqual(parseExamMarkdown(examToMarkdown(steps)), steps);

  assert.throws(() => parseExamMarkdown('# A\n## [weird] x\n'), /Unknown question type/);
  assert.throws(
    () => parseExamMarkdown('# [submit] Done\n## [single] Not here\n- [x] a\n'),
    /submit section cannot hold/,
  );
  assert.deepEqual(examErrors(normaliseExam({ title: 'T', content: [{ items: [] }] })), [
    'Section 1 needs a title',
    'Section 1 has no questions or steps',
  ]);
  assert.deepEqual(
    examErrors(
      normaliseExam({
        title: 'T',
        content: [
          {
            title: 'I',
            items: [
              { type: 'checklist', tasks: ['a'] },
              { type: 'info', title: 'Empty' },
            ],
          },
          {
            title: 'J',
            items: [
              { type: 'checklist', body: 'x' },
              { type: 'truefalse', prompt: 'p', correct: true },
            ],
          },
        ],
      }),
    ),
    [
      'Section 1 · step 2 needs instructions',
      'Section 2 · step 1 needs at least one checklist item',
    ],
    'steps need instructions or, for a checklist, its items',
  );
});

test('short answers are checked by exact answers or by a pattern, like lab checkpoints', () => {
  const exam = parseExamMarkdown(`---
title: Patterns
---
# A
## [short] Serial?
> pattern: XXXX.XXXX
> placeholder: e.g. AB12.CD34
> capture: SERIAL
> points: 2

## [short] Port?
> accept: 443 | tcp/443

## [short] Bad mask
> pattern: SN-

# B
## [short] Serial again?
> accept: {{ SERIAL }}
`);
  const [serial, port, bad] = exam.content[0].items;
  assert.equal(serial.match, 'pattern');
  assert.equal(serial.pattern, 'XXXX.XXXX');
  assert.deepEqual(serial.accepted, []);
  assert.equal(port.match, undefined, 'exact is the default');
  assert.deepEqual(examErrors(exam), [`Section 1 · question 3 pattern: ${patternError('SN-')}`]);
  bad.pattern = 'XX';
  assert.deepEqual(examErrors(exam), []);
  assert.deepEqual(parseExamMarkdown(examToMarkdown(exam)), exam, 'round-trips');

  assert.equal(gradeResponse(serial, 'ab12cd34').correct, true, 'separators may be left out');
  assert.equal(gradeResponse(serial, 'ab12-cd34').correct, false);
  assert.equal(gradeResponse(serial, 'ab1').correct, false);
  const anything = { ...serial, pattern: 'SN-*' };
  assert.equal(gradeResponse(anything, `SN-${'x'.repeat(150)}`).correct, true);
  assert.equal(
    gradeResponse(anything, `SN-${'x'.repeat(250)}`).correct,
    false,
    'answers longer than a lab checkpoint answer never fit a pattern',
  );
  assert.equal(gradeResponse(port, ' TCP/443 ').correct, true);
  assert.equal(isManualQuestion(serial), false);
  assert.equal(capturedValue(serial, 'ab12cd34'), 'AB12.CD34', 'saved in the canonical form');
  assert.equal(capturedValue(port, ' 443 '), '443');
  assert.equal(describeExpected(serial), 'fits XXXX.XXXX');

  const pub = publicQuestion(serial);
  assert.equal(pub.placeholder, 'e.g. AB12.CD34');
  assert.equal('pattern' in pub || 'match' in pub || 'accepted' in pub, false, 'mask stays hidden');
  // An empty pattern is still a pattern question (and an error), not an exact one.
  const empty = normaliseExam({
    title: 'T',
    content: [{ title: 'A', items: [{ type: 'short', prompt: 'p', match: 'pattern' }] }],
  });
  assert.equal(empty.content[0].items[0].match, 'pattern');
  assert.deepEqual(examErrors(empty), ['Section 1 · question 1 pattern: Pattern is empty']);
});

test('every exam ends with exactly one submit section', () => {
  const plain = normaliseExam({ title: 'T', content: [{ title: 'A', items: [] }] });
  assert.deepEqual(plain.content[1], {
    type: 'submit',
    title: 'Review and submit',
    minutes: null,
    body: '',
    review: true,
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
      [undefined, 'A'],
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

test('exam variables: front matter round-trips and unknown placeholders are flagged', () => {
  const md = `---
kind: exam
title: Seats
variables:
  STORE = 100 + seat
  SUBNET = "10." + seat + ".0.0"
---

# [info] Bench for {{ FULL_NAME }}
## [checklist] Store {{ STORE }}
Use {{ SUBNET }} on seat {{ SEAT_ID }}.
- [ ] Ping {{ SUBNET }}

# Questions
## [text] Which store number is yours?
> accept: {{ STORE }}
`;
  const exam = parseExamMarkdown(md);
  assert.deepEqual(exam.variables, [
    { name: 'STORE', expression: '100 + seat' },
    { name: 'SUBNET', expression: '"10." + seat + ".0.0"' },
  ]);
  assert.deepEqual(parseExamMarkdown(examToMarkdown(exam)), exam);
  assert.deepEqual(normaliseExam(exam).variables, exam.variables);
  assert.deepEqual(examErrors(exam), []);

  const typo = parseExamMarkdown(md.replace('accept: {{ STORE }}', 'accept: {{ STOER }}'));
  assert.deepEqual(examErrors(typo), [
    'Unknown placeholder {{ STOER }} in Section 2 · question 1 accepted answers',
  ]);
  assert.deepEqual(normaliseExam({ content: [] }).variables, []);
});
