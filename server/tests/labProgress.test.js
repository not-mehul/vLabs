import test from 'node:test';
import assert from 'node:assert/strict';
import { labProgress } from '../src/lib/labProgress.js';
import { isOptionalSection, countingSections } from '../../shared/lab-progress.js';

const cp = { prompt: 'x', answer: 'y' };
const sec = (title, withCheckpoint = false) => ({
  title,
  steps: [{ type: 'desk', title: 's', body: 'b', ...(withCheckpoint ? { checkpoint: cp } : {}) }],
});

test('optional / wrap-up sections are recognised by title', () => {
  for (const t of [
    'Section 4 · Wrap up',
    'Wrap-Up',
    'Wrapping up',
    'Optional: VLAN tagging',
    'Bonus challenge',
    'Stretch goal — QoS',
    'Extra credit',
  ]) {
    assert.equal(isOptionalSection({ title: t }), true, t);
  }
  for (const t of ['Section 1 · Bench Preparation', 'Wrapper scripts', 'Options menu']) {
    assert.equal(isOptionalSection({ title: t }), false, t);
  }
  // Never an empty denominator.
  assert.deepEqual(countingSections([sec('Optional A'), sec('Wrap up')]), [0, 1]);
});

test('a section is done once moved past, and reviewing it does not undo that', () => {
  const sections = [sec('One', true), sec('Two', true), sec('Three'), sec('Wrap up')];
  const completed = new Set(['0.0']);
  // On section 2 (index 1) with section 1 cleared.
  let p = { max_section: 1, current_section: 1, completed_at: null };
  let r = labProgress(sections, p, completed);
  assert.deepEqual(r.done, [true, false, false, false]);
  assert.equal(r.countingTotal, 3);
  assert.equal(r.completedCounting, 1);
  assert.equal(r.progressPct, 33);
  assert.equal(r.complete, false);

  // Goes back to review section 1: nothing changes.
  p = { ...p, current_section: 0 };
  r = labProgress(sections, p, completed);
  assert.deepEqual(r.done, [true, false, false, false]);
  assert.equal(r.furthest, 1);

  // Clears section 2 but has not moved on yet: not done until they move past.
  completed.add('1.0');
  r = labProgress(sections, { ...p, max_section: 1 }, completed);
  assert.equal(r.done[1], false);

  // Reaches section 3 (last counting, no checkpoint): complete without the wrap-up.
  r = labProgress(sections, { ...p, max_section: 2 }, completed);
  assert.equal(r.complete, true);
  assert.equal(r.progressPct, 100);
  assert.deepEqual(r.done, [true, true, true, false]);
  assert.deepEqual(r.optional, [false, false, false, true]);
});

test('reachedIndex covers a checkpoint cleared before the progress ping arrives', () => {
  const sections = [sec('One'), sec('Two', true)];
  const completed = new Set(['1.0']);
  const p = { max_section: 0, completed_at: null };
  assert.equal(labProgress(sections, p, completed).complete, false);
  assert.equal(labProgress(sections, p, completed, 1).complete, true);
});
