/**
 * Unit tests for the template import/export format. Runs under `node --test`
 * with no browser or bundler: the module only touches DOM APIs inside the
 * download/read helpers, which are never invoked here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarkdownTemplate,
  templateToMarkdown,
  parseJsonTemplate,
  templateToJson,
  SAMPLE_MARKDOWN,
} from '../src/lib/templateFormat.js';
import { normaliseTemplate, findUnknownPlaceholders } from '../../shared/template-schema.js';

const FULL = normaliseTemplate({
  title: 'Round trip',
  description: 'desc',
  variables: [
    { name: 'HOST_IP', expression: "'10.0.0.' + (100 + seat)" },
    { name: 'TAG', expression: "'S' + pad(seat, 2)" },
  ],
  content: [
    {
      title: 'Section 1 · Setup',
      steps: [
        {
          type: 'desk',
          title: 'Cable',
          body: 'Plug in.\n\n> A quote in the body stays in the body.\n\n```\n# not a heading\n## not a step\n> hint: not a hint\n```\n\nDone.',
          hints: [
            { label: 'Where?', text: 'Line one\nLine two\n\nLine four after blank' },
            { label: 'Ratio 1::2', text: 'Uses :: inside' },
          ],
          solution: 'Step one\n- bullet\n\nParagraph two',
          checkpoint: null,
        },
        {
          type: 'computer',
          title: 'IP',
          body: 'Set {{ HOST_IP }}',
          hints: [],
          solution: '',
          checkpoint: {
            prompt: 'Enter host :: address',
            placeholder: 'e.g. 10.0.0.1XX',
            answer: '{{ HOST_IP }}',
            answers: ['{{ HOST_IP }}/24', 'a|b'],
          },
        },
      ],
    },
    {
      title: 'Section 2',
      steps: [
        {
          type: 'desk',
          title: 'Wrap',
          body: 'Bye {{ TAG }}',
          hints: [],
          solution: '',
          checkpoint: null,
        },
      ],
    },
  ],
});

test('markdown export → import is lossless', () => {
  const md = templateToMarkdown(FULL);
  const back = parseMarkdownTemplate(md);
  assert.deepEqual(back, FULL);
});

test('json export → import is lossless', () => {
  assert.deepEqual(parseJsonTemplate(templateToJson(FULL)), FULL);
});

test('fenced code blocks are not interpreted as headings or directives', () => {
  const md = `# S\n\n## [computer] Step\n\n\`\`\`bash\n# comment\n## another\n> hint: nope :: nope\n\`\`\`\n\n> hint: real :: yes\n`;
  const t = parseMarkdownTemplate(md);
  assert.equal(t.content.length, 1);
  assert.equal(t.content[0].steps.length, 1);
  const step = t.content[0].steps[0];
  assert.match(step.body, /```bash\n# comment\n## another\n> hint: nope :: nope\n```/);
  assert.deepEqual(step.hints, [{ label: 'real', text: 'yes' }]);
});

test('unterminated code fences are reported', () => {
  assert.throws(() => parseMarkdownTemplate('# S\n\n## Step\n```\nstill open\n'), /Unterminated/);
});

test('multi-line hints, escaped separators and alternative answers parse', () => {
  const md = [
    '# S',
    '## Step',
    'Body',
    '',
    '> hint: A \\:: B :: first',
    '> second',
    '>',
    '> fourth',
    '',
    '> checkpoint: Prompt :: one | two \\| three | {{ SEAT_ID }}',
    '> placeholder: hint text',
    '',
  ].join('\n');
  const t = parseMarkdownTemplate(md);
  const step = t.content[0].steps[0];
  assert.deepEqual(step.hints, [{ label: 'A :: B', text: 'first\nsecond\n\nfourth' }]);
  assert.deepEqual(step.checkpoint, {
    prompt: 'Prompt',
    placeholder: 'hint text',
    answer: 'one',
    answers: ['two | three', '{{ SEAT_ID }}'],
  });
});

test('a blank line ends a hint so following body text is not swallowed', () => {
  const md = '# S\n## Step\nBody\n\n> hint: L :: text\n\nMore body after the hint.\n';
  const step = parseMarkdownTemplate(md).content[0].steps[0];
  assert.equal(step.hints[0].text, 'text');
  assert.equal(step.body, 'Body\n\nMore body after the hint.');
});

test('steps before any section heading get an implicit section', () => {
  const t = parseMarkdownTemplate('## [computer] Only\nBody\n');
  assert.equal(t.content[0].title, 'Section 1');
  assert.equal(t.content[0].steps[0].type, 'computer');
});

test('frontmatter variables are parsed', () => {
  const t = parseMarkdownTemplate(
    '---\ntitle: T\nvariables:\n  A = seat\n  B = A + 1\n---\n# S\n## Step\nb\n',
  );
  assert.equal(t.title, 'T');
  assert.deepEqual(t.variables, [
    { name: 'A', expression: 'seat' },
    { name: 'B', expression: 'A + 1' },
  ]);
});

test('the bundled sample imports cleanly with no unknown placeholders', () => {
  const t = parseMarkdownTemplate(SAMPLE_MARKDOWN);
  assert.equal(t.content.length, 2);
  assert.deepEqual(findUnknownPlaceholders(t), []);
  const confirm = t.content[1].steps[1];
  assert.deepEqual(confirm.checkpoint.answers, ['{{ HOST_IP }}/24']);
  assert.equal(confirm.checkpoint.placeholder, 'e.g. 10.0.0.1XX');
  assert.match(t.content[1].steps[0].body, /# this comment inside a code block/);
  assert.deepEqual(parseMarkdownTemplate(templateToMarkdown(t)), t);
});

test('invalid inputs are rejected', () => {
  assert.throws(() => parseMarkdownTemplate('just some text'), /No sections/);
  assert.throws(() => parseJsonTemplate('[]'), /Not a template/);
  assert.throws(() => parseJsonTemplate('nope'));
});
