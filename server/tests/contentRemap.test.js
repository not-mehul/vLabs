import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRemap, remapParticipant, remapEventKey } from '../src/lib/contentRemap.js';

const step = (id, cp = true) => ({
  id,
  type: 'desk',
  title: id,
  body: 'b',
  ...(cp ? { checkpoint: { prompt: 'x', answer: 'y' } } : {}),
});
const lab = (sections) => sections.map(([id, steps]) => ({ id, title: id, steps }));

test('lab: progress follows reordered sections and steps; removed ones are dropped', () => {
  const before = lab([
    ['sA', [step('a1'), step('a2')]],
    ['sB', [step('b1')]],
    ['sC', [step('c1')]],
  ]);
  // B moves first, a1/a2 swap, C is removed, a new section D is added.
  const after = lab([
    ['sB', [step('b1')]],
    ['sA', [step('a2'), step('a1')]],
    ['sD', [step('d1')]],
  ]);
  const remap = contentRemap(before, after, 'lab');
  const p = {
    completed_checkpoints: JSON.stringify(['0.0', '1.0', '2.0']),
    hints_taken: JSON.stringify(['0.1.0', '2.0.1']),
    revealed_solutions: JSON.stringify(['0.1']),
    checkpoint_log: JSON.stringify([
      { k: '0.0', a: 'y', ok: 1 },
      { k: '2.0', a: 'n', ok: 0 },
    ]),
    answers: '{}',
    grades: '{}',
    section_times: JSON.stringify({ 0: 60, 1: 30, 2: 10 }),
    current_section: 2,
    max_section: 2,
  };
  const m = remapParticipant(p, remap);
  assert.deepEqual(JSON.parse(m.completed_checkpoints), ['1.1', '0.0']);
  assert.deepEqual(JSON.parse(m.hints_taken), ['1.0.0']);
  assert.deepEqual(JSON.parse(m.revealed_solutions), ['1.0']);
  assert.deepEqual(
    JSON.parse(m.checkpoint_log).map((e) => e.k),
    ['1.1'],
  );
  assert.deepEqual(JSON.parse(m.section_times), { 0: 30, 1: 60 });
  assert.equal(m.max_section, 1, 'furthest section that still exists');
  assert.equal(m.current_section, 1, 'was on a removed section');
});

test('without ids on one side, positions pair up as pushing always did', () => {
  const before = lab([
    ['sA', [step('a1')]],
    ['sB', [step('b1')]],
  ]);
  const fresh = lab([
    ['xA', [step('x1')]],
    ['xB', [step('x2')]],
  ]); // a revert or Markdown re-import: new ids everywhere
  assert.equal(contentRemap(before, before, 'lab'), null, 'unchanged layout');
  assert.equal(contentRemap(before, fresh, 'lab'), null, 'positions pair up: nothing moves');
  const swapped = contentRemap(before, [fresh[1], fresh[0]], 'lab');
  assert.equal(swapped, null, 'no shared ids, so a reorder cannot be seen');
  const noIds = before.map(({ id: _id, ...s }) => ({
    ...s,
    steps: s.steps.map(({ id: _i, ...st }) => st),
  }));
  assert.equal(contentRemap(noIds, before, 'lab'), null);
});

test('exam: answers, marks and checklist ticks follow their items', () => {
  const q = (id, type = 'truefalse') => ({ id, type, prompt: id, correct: true, points: 1 });
  const before = [
    {
      id: 's1',
      title: 'One',
      items: [
        q('q1'),
        { id: 'c1', type: 'checklist', title: 'C', body: '', tasks: ['a', 'b'] },
        q('q2'),
      ],
    },
    { id: 'sub', type: 'submit', title: 'Submit', body: '' },
  ];
  const after = [
    {
      id: 's1',
      title: 'One',
      items: [
        q('q0'),
        q('q1'),
        { id: 'c1', type: 'checklist', title: 'C', body: '', tasks: ['a', 'b'] },
        q('q2'),
      ],
    },
    { id: 'sub', type: 'submit', title: 'Submit', body: '' },
  ];
  const remap = contentRemap(before, after, 'exam');
  const m = remapParticipant(
    {
      answers: JSON.stringify({ '0.0': true, 0.1: false, '0.t0': true, '0.t1': true }),
      grades: JSON.stringify({ 0.1: { correct: 1 } }),
      completed_checkpoints: '[]',
      hints_taken: '[]',
      revealed_solutions: '[]',
      checkpoint_log: '[]',
      section_times: JSON.stringify({ 0: 100 }),
      current_section: 1,
      max_section: 1,
    },
    remap,
  );
  // q1 (0.0) → 0.1, q2 (0.1) → 0.2; the new q0 starts unanswered.
  assert.deepEqual(JSON.parse(m.answers), { 0.1: true, 0.2: false, '0.t0': true, '0.t1': true });
  assert.deepEqual(JSON.parse(m.grades), { 0.2: { correct: 1 } });
  assert.equal(remapEventKey(remap, '0.0', 3), '0.1');

  // A question removed from the exam: its history keeps a retired key.
  const removed = contentRemap(before, [{ ...after[0], items: [q('q2')] }, after[1]], 'exam');
  assert.equal(remapEventKey(removed, '0.0', 3), '0.0@v3');
  assert.equal(remapEventKey(removed, '0.0@v3', 4), '0.0@v3');
});
