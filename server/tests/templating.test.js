import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVariables,
  injectVariables,
  evaluateExpression,
  renderStep,
  checkpointAnswer,
  renderManual,
  isSectionCleared,
  computeUnlockedSection,
  computeSectionVisibleThrough,
  checkpointKey,
  countSteps,
} from '../src/lib/templating.js';
import { validateTemplatePayload } from '../src/lib/validateTemplate.js';

test('evaluateExpression handles arithmetic precedence', () => {
  assert.equal(evaluateExpression('100 + 2 * 3', {}), 106);
  assert.equal(evaluateExpression('(100 + 2) * 3', {}), 306);
  assert.equal(evaluateExpression('100 + seat', { seat: 7 }), 107);
  assert.equal(evaluateExpression('10 % 3', {}), 1);
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
});

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

test('injectVariables replaces placeholders and flags missing ones', () => {
  const ctx = { PORT_NUM: 7, GATEWAY_IP: '192.168.1.107' };
  const out = injectVariables(
    'Connect to Port {{ PORT_NUM }} then ping {{GATEWAY_IP}}',
    ctx,
  );
  assert.equal(out, 'Connect to Port 7 then ping 192.168.1.107');
  assert.match(injectVariables('{{ NOPE }}', ctx), /missing:NOPE/);
});

test('renderStep strips checkpoint answers but keeps the prompt', () => {
  const ctx = resolveVariables(
    [{ name: 'MAC', expression: "'de:ad:be:ef:00:' + seat" }],
    3,
  );
  const step = {
    type: 'computer',
    title: 'Find the MAC',
    body: 'Record the MAC for seat {{ SEAT_ID }}',
    checkpoint: { prompt: 'Enter the MAC', answer: '{{ MAC }}' },
  };
  const rendered = renderStep(step, ctx, 2);
  assert.equal(rendered.type, 'computer');
  assert.equal(rendered.body, 'Record the MAC for seat 3');
  assert.ok(rendered.checkpoint);
  assert.equal(rendered.checkpoint.prompt, 'Enter the MAC');
  assert.equal(rendered.checkpoint.answer, undefined); // never leaked
  assert.equal(checkpointAnswer(step, ctx), 'de:ad:be:ef:00:3');
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
      ],
    },
    { title: 'S1', steps: [{ type: 'desk', title: 'c', body: 'z' }] },
  ];
  const none = new Set();
  // Section 0 has an uncompleted checkpoint -> it is the furthest reachable.
  assert.equal(computeUnlockedSection(sections, none), 0);
  assert.equal(isSectionCleared(sections[0], 0, none), false);
  // Its second step (the checkpoint) is visible, but that's the end anyway.
  assert.equal(computeSectionVisibleThrough(sections[0], 0, none), 1);

  const done = new Set([checkpointKey(0, 1)]);
  assert.equal(isSectionCleared(sections[0], 0, done), true);
  assert.equal(computeUnlockedSection(sections, done), 1);
});

test('mid-section checkpoint hides later steps until cleared', () => {
  const section = {
    title: 'S',
    steps: [
      { type: 'desk', title: 'a', body: 'x', checkpoint: { answer: 'go' } },
      { type: 'desk', title: 'b', body: 'y' },
    ],
  };
  const none = new Set();
  assert.equal(computeSectionVisibleThrough(section, 0, none), 0); // only step 0
  const done = new Set([checkpointKey(0, 0)]);
  assert.equal(computeSectionVisibleThrough(section, 0, done), 1); // both
});
