import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVariables,
  injectVariables,
  evaluateExpression,
  renderStep,
  checkpointAnswer,
  checkpointAnswers,
  isCorrectAnswer,
  renderManual,
  isSectionCleared,
  computeUnlockedSection,
  computeSectionVisibleThrough,
  isStepReachable,
  checkpointKey,
  countSteps,
  FUNCTION_NAMES,
} from '../src/lib/templating.js';
import { validateTemplatePayload } from '../src/lib/validateTemplate.js';
import { normaliseTemplate, findUnknownPlaceholders } from '../../shared/template-schema.js';

/* ------------------------------ Evaluator -------------------------------- */

test('evaluateExpression handles arithmetic precedence', () => {
  assert.equal(evaluateExpression('100 + 2 * 3', {}), 106);
  assert.equal(evaluateExpression('(100 + 2) * 3', {}), 306);
  assert.equal(evaluateExpression('100 + seat', { seat: 7 }), 107);
  assert.equal(evaluateExpression('10 % 3', {}), 1);
  assert.equal(evaluateExpression('-seat + 10', { seat: 3 }), 7);
});

test('evaluateExpression concatenates strings with numbers', () => {
  assert.equal(
    evaluateExpression("'192.168.1.' + (100 + seat)", { seat: 7 }),
    '192.168.1.107',
  );
  assert.equal(evaluateExpression("'Port ' + seat", { seat: 12 }), 'Port 12');
});

test('evaluateExpression rejects unknown identifiers and illegal chars', () => {
  assert.throws(() => evaluateExpression('seat + foo', { seat: 1 }));
  assert.throws(() => evaluateExpression('1 + 2; process.exit()', {}));
  assert.throws(() => evaluateExpression('__proto__', {}));
  assert.throws(() => evaluateExpression('constructor', {}));
  assert.throws(() => evaluateExpression('1.2.3', {}));
});

test('evaluateExpression: only whitelisted functions are callable', () => {
  assert.throws(() => evaluateExpression('constructor(1)', {}), /Unknown function/);
  assert.throws(() => evaluateExpression('toString()', {}), /Unknown function/);
  assert.throws(() => evaluateExpression('eval("1")', {}), /Unknown function/);
  assert.throws(() => evaluateExpression('seat(1)', { seat: 1 }), /Unknown function/);
  assert.ok(FUNCTION_NAMES.includes('pad') && FUNCTION_NAMES.includes('hex'));
});

test('evaluateExpression helper functions', () => {
  const s = { seat: 7 };
  assert.equal(evaluateExpression('pad(seat, 2)', s), '07');
  assert.equal(evaluateExpression("pad(seat, 3, ' ')", s), '  7');
  assert.equal(evaluateExpression("'S' + pad(seat, 2)", s), 'S07');
  assert.equal(evaluateExpression('hex(255)', {}), 'ff');
  assert.equal(evaluateExpression("'de:ad:be:ef:00:' + pad(hex(seat), 2)", s), 'de:ad:be:ef:00:07');
  assert.equal(evaluateExpression('floor(7 / 2)', {}), 3);
  assert.equal(evaluateExpression('ceil(7 / 2)', {}), 4);
  assert.equal(evaluateExpression('round(2.5)', {}), 3);
  assert.equal(evaluateExpression('abs(-4)', {}), 4);
  assert.equal(evaluateExpression('mod(-1, 24)', {}), 23);
  assert.equal(evaluateExpression('min(4, seat, 9)', s), 4);
  assert.equal(evaluateExpression('max(4, seat, 9)', s), 9);
  assert.equal(evaluateExpression("upper('ab') + lower('CD')", {}), 'ABcd');
  assert.equal(evaluateExpression('str(1) + str(2)', {}), '12');
  assert.equal(evaluateExpression('1 + 2', {}), 3);
  // Third-octet style: seats 1..254 -> 10.(seat/100).(seat%100)
  assert.equal(evaluateExpression("'10.' + floor(seat / 100) + '.' + mod(seat, 100)", { seat: 137 }), '10.1.37');
});

test('evaluateExpression guards against abuse', () => {
  assert.throws(() => evaluateExpression('1/0', {}), /Division by zero/);
  assert.throws(() => evaluateExpression('1 % 0', {}), /Modulo by zero/);
  assert.throws(() => evaluateExpression('pad(1)', {}), /expects/);
  assert.throws(() => evaluateExpression('pad(1, 2, "ab")', {}), /one character/);
  assert.throws(() => evaluateExpression('('.repeat(40) + '1' + ')'.repeat(40), {}), /nested too deeply/);
  assert.throws(() => evaluateExpression('1 + '.repeat(300) + '1', {}), /too long/);
});

/* --------------------------- Variable resolution ------------------------- */

test('resolveVariables computes the spec example (Seat 7 -> IP .107)', () => {
  const vars = [
    { name: 'PORT_NUM', expression: 'seat' },
    { name: 'IP_ADDRESS', expression: "'10.0.0.' + (100 + seat)" },
    { name: 'GATEWAY_IP', expression: "'192.168.1.' + (100 + seat)" },
  ];
  const ctx = resolveVariables(vars, 7);
  assert.equal(ctx.SEAT_ID, 7);
  assert.equal(ctx.PORT_NUM, 7);
  assert.equal(ctx.IP_ADDRESS, '10.0.0.107');
  assert.equal(ctx.GATEWAY_IP, '192.168.1.107');
});

test('resolveVariables allows composition of later formulas', () => {
  const vars = [
    { name: 'BASE', expression: '100 + seat' },
    { name: 'IP', expression: "'10.0.0.' + BASE" },
  ];
  const ctx = resolveVariables(vars, 5);
  assert.equal(ctx.IP, '10.0.0.105');
});

test('resolveVariables handles non-numeric seat ids gracefully', () => {
  const ctx = resolveVariables([{ name: 'X', expression: 'seat + 1' }], 'A12');
  assert.equal(ctx.X, 13); // digits extracted -> 12
});

test('resolveVariables rejects names that clash with helper functions', () => {
  assert.throws(() => resolveVariables([{ name: 'pad', expression: '1' }], 1), /clashes/);
});

/* ---------------------------- Injection ---------------------------------- */

test('injectVariables replaces placeholders and flags missing ones', () => {
  const ctx = { PORT_NUM: 7, GATEWAY_IP: '192.168.1.107' };
  const out = injectVariables(
    'Connect to Port {{ PORT_NUM }} then ping {{GATEWAY_IP}}',
    ctx,
  );
  assert.equal(out, 'Connect to Port 7 then ping 192.168.1.107');
  assert.match(injectVariables('{{ NOPE }}', ctx), /missing:NOPE/);
});

/* ----------------------------- Steps ------------------------------------- */

test('renderStep strips checkpoint answers but keeps the prompt', () => {
  const ctx = resolveVariables(
    [{ name: 'MAC', expression: "'de:ad:be:ef:00:' + pad(seat, 2)" }],
    3,
  );
  const step = {
    type: 'computer',
    title: 'Find the MAC',
    body: 'Record the MAC for seat {{ SEAT_ID }}',
    checkpoint: { prompt: 'Enter the MAC', answer: '{{ MAC }}', answers: ['{{ MAC }} '] },
  };
  const rendered = renderStep(step, ctx, 2);
  assert.equal(rendered.type, 'computer');
  assert.equal(rendered.body, 'Record the MAC for seat 3');
  assert.ok(rendered.checkpoint);
  assert.equal(rendered.checkpoint.prompt, 'Enter the MAC');
  assert.equal(rendered.checkpoint.answer, undefined); // never leaked
  assert.equal(rendered.checkpoint.answers, undefined); // never leaked
  assert.equal(checkpointAnswer(step, ctx), 'de:ad:be:ef:00:03');
  assert.deepEqual(checkpointAnswers(step, ctx), ['de:ad:be:ef:00:03']); // de-duplicated
});

test('isCorrectAnswer accepts any authored alternative, normalised', () => {
  const ctx = resolveVariables([{ name: 'HOST_IP', expression: "'10.0.0.' + (100 + seat)" }], 1);
  const step = { checkpoint: { answer: '{{ HOST_IP }}', answers: ['{{ HOST_IP }}/24', 'done'] } };
  assert.equal(isCorrectAnswer(step, ctx, '10.0.0.101'), true);
  assert.equal(isCorrectAnswer(step, ctx, ' 10.0.0.101/24 '), true);
  assert.equal(isCorrectAnswer(step, ctx, 'DONE'), true);
  assert.equal(isCorrectAnswer(step, ctx, '10.0.0.102'), false);
  assert.equal(isCorrectAnswer({}, ctx, ''), false);
});

test('renderStep never leaks a step-level solution', () => {
  const ctx = resolveVariables([], 1);
  const step = {
    type: 'desk',
    title: 'Solve it',
    body: 'Do the thing',
    solution: 'The answer is 42',
  };
  const rendered = renderStep(step, ctx, 0);
  assert.equal(rendered.solution, undefined); // gated behind reveal, never shipped
});

/* --------------------------- Validation ---------------------------------- */

test('validateTemplatePayload keeps solution at step level, not on the checkpoint', () => {
  const clean = validateTemplatePayload({
    title: 'Lab',
    content: [
      {
        title: 'Section 1',
        steps: [
          {
            type: 'computer',
            title: 'Step with both',
            body: 'body text',
            solution: '- bullet one\n- bullet two',
            checkpoint: { prompt: 'Enter it', answer: '{{ SEAT_ID }}' },
          },
          {
            type: 'desk',
            title: 'Step, solution only, no hints',
            body: 'body',
            solution: 'Just the answer',
          },
        ],
      },
    ],
  });
  const [s0, s1] = clean.content[0].steps;
  // Solution lives on the step, and the checkpoint carries only the gate fields.
  assert.equal(s0.solution, '- bullet one\n- bullet two');
  assert.ok(s0.checkpoint);
  assert.equal(s0.checkpoint.solution, undefined);
  assert.equal(s0.checkpoint.answer, '{{ SEAT_ID }}');
  assert.equal(s0.checkpoint.answers, undefined, 'answers omitted when empty');
  // A step may carry a solution with no checkpoint at all.
  assert.equal(s1.solution, 'Just the answer');
  assert.equal(s1.checkpoint, undefined);
});

test('validateTemplatePayload rejects structures over the safety caps', () => {
  const steps = Array.from({ length: 101 }, (_, i) => ({
    type: 'desk',
    title: `s${i}`,
    body: 'x',
  }));
  assert.throws(
    () =>
      validateTemplatePayload({
        title: 'Huge',
        content: [{ title: 'Section 1', steps }],
      }),
    /too many steps/i,
  );

  const sections = Array.from({ length: 101 }, (_, i) => ({
    title: `Section ${i}`,
    steps: [{ type: 'desk', title: 's', body: 'x' }],
  }));
  assert.throws(
    () => validateTemplatePayload({ title: 'Huge', content: sections }),
    /too many sections/i,
  );
});

test('validateTemplatePayload rejects unknown placeholders anywhere in the template', () => {
  const payload = {
    title: 'Typos',
    variables: [{ name: 'HOST_IP', expression: "'10.0.0.' + seat" }],
    content: [
      {
        title: 'S1 {{ SECTION_VAR }}',
        steps: [
          {
            title: 'T',
            body: 'IP {{ HOST_IP }} ok, {{ HOST_IPP }} not',
            hints: [{ label: 'h', text: '{{ HINTVAR }}' }],
            solution: '{{ SOLVAR }}',
            checkpoint: { prompt: 'p', answer: '{{ HOST_IPP }}', answers: ['{{ ALT }}'] },
          },
        ],
      },
    ],
  };
  let err;
  try {
    validateTemplatePayload(payload);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'throws');
  assert.equal(err.status, 400);
  const names = err.details.filter((d) => d.startsWith('Unknown placeholder')).join('\n');
  for (const n of ['SECTION_VAR', 'HOST_IPP', 'HINTVAR', 'SOLVAR', 'ALT']) {
    assert.match(names, new RegExp(`\\{\\{ ${n} \\}\\}`));
  }
  assert.doesNotMatch(names, /HOST_IP \}\}/);
});

test('validateTemplatePayload rejects duplicate, reserved and empty variables', () => {
  const base = { title: 'V', content: [{ title: 'S', steps: [{ title: 't', body: 'b' }] }] };
  assert.throws(
    () => validateTemplatePayload({ ...base, variables: [{ name: 'A', expression: '1' }, { name: 'A', expression: '2' }] }),
    /more than once/,
  );
  assert.throws(
    () => validateTemplatePayload({ ...base, variables: [{ name: 'SEAT_ID', expression: '1' }] }),
    /reserved/,
  );
  assert.throws(
    () => validateTemplatePayload({ ...base, variables: [{ name: 'A', expression: '' }] }),
    /no formula/,
  );
  assert.throws(
    () => validateTemplatePayload({ ...base, variables: [{ name: 'pad', expression: '1' }] }),
    /clashes/,
  );
});

test('shared normaliser produces the canonical shape and finds unknown placeholders', () => {
  const t = normaliseTemplate({
    title: 'x',
    content: [{ steps: [{ body: 'hi {{ A }} {{ B }}', checkpoint: { answer: 'a', answers: ['b', 'b', 'a'] } }] }],
    variables: [{ name: 'A', expression: '1' }],
  });
  assert.deepEqual(t.content[0].steps[0].checkpoint, { prompt: '', placeholder: '', answer: 'a', answers: ['b'] });
  assert.equal(t.content[0].steps[0].type, 'desk');
  assert.deepEqual(t.content[0].steps[0].hints, []);
  assert.deepEqual(findUnknownPlaceholders(t).map((u) => u.name), ['B']);
  assert.equal(normaliseTemplate(null).content.length, 0);
});

/* ------------------------------ Sections --------------------------------- */

test('renderManual renders sections and steps with resolved context', () => {
  const content = [
    {
      title: 'Cabling',
      steps: [
        { type: 'desk', title: 'Cable', body: 'Patch into Port {{ PORT_NUM }}' },
      ],
    },
    {
      title: 'Verify',
      steps: [{ type: 'computer', title: 'Ping', body: 'ping {{ GATEWAY_IP }}' }],
    },
  ];
  const vars = [
    { name: 'PORT_NUM', expression: 'seat' },
    { name: 'GATEWAY_IP', expression: "'192.168.1.' + (100 + seat)" },
  ];
  const { sections } = renderManual(content, vars, 9);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'Cabling');
  assert.equal(sections[0].steps[0].body, 'Patch into Port 9');
  assert.equal(sections[1].steps[0].body, 'ping 192.168.1.109');
  assert.equal(countSteps(content), 2);
});

test('section gating: unlocked section advances only when checkpoints clear', () => {
  const sections = [
    {
      title: 'S0',
      steps: [
        { type: 'desk', title: 'a', body: 'x' },
        { type: 'computer', title: 'b', body: 'y', checkpoint: { answer: '42' } },
        { type: 'desk', title: 'c', body: 'z' },
      ],
    },
    { title: 'S1', steps: [{ type: 'desk', title: 'd', body: 'w' }] },
  ];
  const none = new Set();
  // Section 0 has an uncompleted checkpoint -> it is the furthest reachable.
  assert.equal(computeUnlockedSection(sections, none), 0);
  assert.equal(isSectionCleared(sections[0], 0, none), false);
  // Steps reveal up to and including the first open checkpoint (index 1).
  assert.equal(computeSectionVisibleThrough(sections[0], 0, none), 1);
  assert.equal(isStepReachable(sections, 0, 1, none), true);
  assert.equal(isStepReachable(sections, 0, 2, none), false);
  assert.equal(isStepReachable(sections, 1, 0, none), false);
  assert.equal(isStepReachable(sections, 5, 0, none), false);
  assert.equal(isStepReachable(sections, 0, NaN, none), false);

  const done = new Set([checkpointKey(0, 1)]);
  assert.equal(isSectionCleared(sections[0], 0, done), true);
  assert.equal(computeUnlockedSection(sections, done), 1);
  assert.equal(computeSectionVisibleThrough(sections[0], 0, done), 2);
  assert.equal(isStepReachable(sections, 0, 2, done), true);
  assert.equal(isStepReachable(sections, 1, 0, done), true);
});
