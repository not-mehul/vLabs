/**
 * vLabs Template Studio (docs/vlabs_template_studio.html) is a standalone page,
 * so it carries its own copy of the exam format in a DOM-free
 * <script id="vlabs-exam-core"> block. These tests load that block and check it
 * still reads, writes, normalises and validates exams exactly like the app's
 * shared modules — so what the Studio exports is what vLabs imports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  parseExamMarkdown,
  examToMarkdown,
  looksLikeExamMarkdown,
  SAMPLE_EXAM_MARKDOWN,
  TYPE_ALIASES,
} from '../../shared/exam-format.js';
import { normaliseExam, examErrors, QUESTION_TYPES } from '../../shared/exam-schema.js';

const html = fs.readFileSync(
  new URL('../../docs/vlabs_template_studio.html', import.meta.url),
  'utf8',
);
const block = /<script id="vlabs-exam-core">([\s\S]*?)<\/script>/.exec(html);
assert.ok(block, 'the Studio has a vlabs-exam-core script block');
const studio = vm.runInNewContext(
  `${block[1]}\n;({ examParseMarkdown, examToMarkdownText, looksLikeExamMarkdown, examNormalise, examErrorsList, examGrade, EXAM_TYPE_ALIASES })`,
  {},
);

const SAMPLES = [
  SAMPLE_EXAM_MARKDOWN,
  `# Only part
> minutes: 7

## [mcq] Pick
- [ ] a
- [X] b

## [checkboxes]
Multi-line prompt with **Markdown**

\`\`\`
## [single] not a heading inside a fence
- [x] not an option
\`\`\`
- [x] one
- [x] two
- [ ] three
> points: 2.5

## [tf] Sky is blue
> answer: yes

## [text] Port?
> accept: 443 | tcp/443 | a\\|b

## [essay] Explain
> points: 0
`,
  `---
kind: exam
title: Edge
description: d
---

## [single] Before any section
- [x] only one option
`,
  `# [submit] Hand in early
> review: false
> minutes: 4
Bye.

# [checklist] Bench
> minutes: 12
Do it.
## Not a question heading
\`\`\`
- [ ] fenced
\`\`\`
- [ ] one
- [X] two
* [ ] three

# [weird] Literal title
## [tf] ok
> answer: no
`,
];

const json = (v) => JSON.parse(JSON.stringify(v));

test('Studio exam Markdown parsing and export match vLabs exactly', () => {
  for (const md of SAMPLES) {
    const app = parseExamMarkdown(md);
    assert.deepEqual(json(studio.examParseMarkdown(md)), app);
    assert.equal(studio.examToMarkdownText(app), examToMarkdown(app));
    assert.deepEqual(parseExamMarkdown(studio.examToMarkdownText(app)), app, 'round-trips');
    assert.deepEqual(json(studio.examErrorsList(app)), examErrors(app));
  }
  assert.throws(() => studio.examParseMarkdown('# A\n\n## [nope] x\n'), /Unknown question type/);
  assert.throws(
    () => studio.examParseMarkdown('# [info] I\n## [mcq] x\n'),
    /cannot go in a \[info\] section/,
  );
  assert.deepEqual(json(studio.EXAM_TYPE_ALIASES), json(TYPE_ALIASES));
});

test('Studio tells labs and exams apart like vLabs', () => {
  const cases = [
    SAMPLE_EXAM_MARKDOWN,
    '# S\n\n## [desk] Do it\n',
    '---\nkind: lab\n---\n# S\n## [single] x\n',
    '# S\n```\n## [single] x\n```\n## [info] y\n',
    '# S\n\n## No type\n',
    '# [checklist] Only a checklist\n- [ ] a\n',
    '# [nope] S\n',
  ];
  for (const c of cases) assert.equal(studio.looksLikeExamMarkdown(c), looksLikeExamMarkdown(c), c);
});

test('Studio normalises odd JSON like vLabs and grades like the server', () => {
  const odd = {
    kind: 'exam',
    title: 'T'.repeat(250),
    content: [
      {
        title: 'S',
        minutes: '12 min',
        questions: [
          { type: 'multiple', options: ['a', 'b', 'c'], correct: [2, '0', 2, -1], points: 500 },
          { type: 'truefalse', correct: 'f' },
          { type: 'weird', options: ['x', 'y'], correct: '1' },
          { type: 'short', accepted: [' a ', 'a', '', 'b'] },
          null,
        ],
      },
      { minutes: 0, questions: 'nope' },
      { type: 'submit', title: 'Go', review: 'no', minutes: 9, questions: [{}] },
      { type: 'info', title: 'I', body: 7, tasks: [' a ', '', null, 'b'], questions: [{}] },
      { type: 'submit', title: 'Dropped' },
    ],
  };
  const app = normaliseExam(odd);
  assert.deepEqual(json(studio.examNormalise(odd)), app);
  const qs = app.content[0].questions;
  const responses = [[0, 2], [2, 0], false, 1, 'A ', '  b', null];
  for (const q of qs) {
    for (const r of responses) {
      let expected;
      try {
        expected = QUESTION_TYPES[q.type].grade(q, QUESTION_TYPES[q.type].normaliseResponse(r, q));
      } catch {
        continue; // the server would refuse this response outright
      }
      assert.equal(studio.examGrade(q, r), expected, `${q.type} ${JSON.stringify(r)}`);
    }
  }
});
