import test from 'node:test';
import assert from 'node:assert/strict';
import { labProgress } from '../src/lib/labProgress.js';
import {
  isOptionalSection,
  countingSections,
  flagLegacyOptionalSections,
} from '../../shared/lab-progress.js';
import { normaliseTemplate } from '../../shared/template-schema.js';
import { normaliseExam } from '../../shared/exam-schema.js';
import { validateTemplatePayload } from '../../shared/validate-template.js';
import { parseMarkdownTemplate, templateToMarkdown } from '../../shared/template-format.js';
import { parseExamMarkdown, examToMarkdown } from '../../shared/exam-format.js';

const cp = { prompt: 'x', answer: 'y' };
const sec = (title, withCheckpoint = false, optional = false) => ({
  title,
  ...(optional ? { optional: true } : {}),
  steps: [{ type: 'desk', title: 's', body: 'b', ...(withCheckpoint ? { checkpoint: cp } : {}) }],
});

test('a section is optional only when flagged, whatever its title', () => {
  assert.equal(isOptionalSection({ title: 'Anything', optional: true }), true);
  for (const t of ['Section 4 · Wrap up', 'Optional: VLAN tagging', 'Bonus challenge']) {
    assert.equal(isOptionalSection({ title: t }), false, t);
  }
  assert.equal(isOptionalSection({ title: 'x', optional: 'true' }), false, 'stored as a boolean');
  // Never an empty denominator.
  assert.deepEqual(countingSections([sec('A', false, true), sec('B', false, true)]), [0, 1]);
});

test('migration 10 flags the sections whose title used to mark them optional', () => {
  const titles = [
    'Section 4 · Wrap up',
    'Wrap-Up',
    'Wrapping up',
    'Optional: VLAN tagging',
    'Bonus challenge',
    'Stretch goal — QoS',
    'Extra credit',
  ];
  const plain = ['Section 1 · Bench Preparation', 'Wrapper scripts', 'Options menu'];
  const out = JSON.parse(
    flagLegacyOptionalSections(
      JSON.stringify([
        ...titles.map((title) => ({ title })),
        ...plain.map((title) => ({ title })),
        { title: 'Bonus but kept', optional: false },
        { type: 'submit', title: 'Optional review' },
      ]),
    ),
  );
  assert.deepEqual(
    out.map((x) => x.optional),
    [...titles.map(() => true), ...plain.map(() => undefined), false, undefined],
  );
  assert.equal(flagLegacyOptionalSections(JSON.stringify([{ title: 'Main' }])), null);
  assert.equal(flagLegacyOptionalSections('not json'), null);
});

test('the optional flag survives normalising, validation and Markdown for labs and exams', () => {
  const lab = {
    title: 'L',
    content: [sec('Main'), { ...sec('Extra'), optional: true }],
  };
  assert.deepEqual(
    normaliseTemplate(lab).content.map((x) => x.optional),
    [false, true],
  );
  const stored = validateTemplatePayload(lab).content;
  assert.equal('optional' in stored[0], false, 'stored only when true');
  assert.equal(stored[1].optional, true);
  const md = templateToMarkdown(lab);
  assert.match(md, /# Extra\n> optional: true\n/);
  assert.deepEqual(
    parseMarkdownTemplate(md).content.map((x) => x.optional),
    [false, true],
  );
  assert.throws(
    () => validateTemplatePayload({ ...lab, content: [{ ...sec('X'), optional: 'maybe' }] }),
    /optional must be true or false/,
  );

  const exam = {
    title: 'E',
    content: [
      { title: 'Q', items: [{ type: 'truefalse', prompt: 'T?', correct: true }] },
      {
        title: 'More',
        optional: true,
        items: [{ type: 'truefalse', prompt: 'T?', correct: true }],
      },
      { type: 'submit', title: 'Submit', optional: true },
    ],
  };
  const parts = normaliseExam(exam).content;
  assert.deepEqual(
    parts.map((x) => x.optional),
    [false, true, undefined],
    'the submit section never takes it',
  );
  const emd = examToMarkdown(exam);
  assert.match(emd, /# More\n> optional: true\n/);
  assert.deepEqual(
    parseExamMarkdown(emd).content.map((x) => x.optional),
    [false, true, undefined],
  );
});

test('a section is done once moved past, and reviewing it does not undo that', () => {
  const sections = [sec('One', true), sec('Two', true), sec('Three'), sec('Wrap up', false, true)];
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
