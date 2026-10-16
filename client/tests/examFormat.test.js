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
} from '../../shared/exam-schema.js';

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
