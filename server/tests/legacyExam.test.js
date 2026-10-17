import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeLegacyExamContent } from '../src/lib/legacyExam.js';
import { listTasks, examUnlockedSection, normaliseExam } from '../../shared/exam-schema.js';

test('migration 12 rewrites pre-1.12 exam sections with items, keeping every answer key', () => {
  const legacy = [
    {
      type: 'questions',
      title: 'Q',
      minutes: 5,
      questions: [{ type: 'truefalse', prompt: 'p', correct: true }],
    },
    { type: 'info', title: 'Bench', body: 'Do it.', tasks: ['a', 'b'], questions: [] },
    {
      type: 'info',
      title: 'Steps',
      steps: [
        { title: 'One', body: 'Read.', tasks: [] },
        { title: 'Two', body: '', tasks: ['c'] },
      ],
      questions: [],
    },
    { type: 'submit', title: 'Submit', body: '', review: true, questions: [] },
  ];
  const content = JSON.parse(upgradeLegacyExamContent(JSON.stringify(legacy)));
  assert.deepEqual(content[0], {
    title: 'Q',
    minutes: 5,
    items: [{ type: 'truefalse', prompt: 'p', correct: true }],
  });
  assert.deepEqual(content[1], {
    title: 'Bench',
    items: [{ type: 'checklist', title: '', body: 'Do it.', tasks: ['a', 'b'] }],
  });
  assert.deepEqual(
    content[2].items.map((it) => it.type),
    ['info', 'checklist'],
  );
  assert.deepEqual(content[3], { type: 'submit', title: 'Submit', body: '', review: true });
  // The keys running sessions saved answers under are unchanged.
  assert.deepEqual(
    listTasks(content).map((t) => t.key),
    ['1.t0', '1.t1', '2.t0'],
  );
  assert.equal(examUnlockedSection(content, { '0.0': true, '1.t0': true }), 1);
  assert.equal(examUnlockedSection(content, { '0.0': true, '1.t0': true, '1.t1': true }), 2);
  assert.equal(normaliseExam({ title: 'T', content }).content.length, 4);

  // Already current, or unreadable: nothing to do.
  assert.equal(upgradeLegacyExamContent(JSON.stringify(content)), null);
  assert.equal(upgradeLegacyExamContent('nope'), null);
});
