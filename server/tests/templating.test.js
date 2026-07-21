import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVariables,
  injectVariables,
  evaluateExpression,
  renderStep,
  checkpointAnswer,
  renderManual,
} from '../src/lib/templating.js';

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

test('renderManual renders every step with resolved context', () => {
  const content = [
    { type: 'desk', title: 'Cable', body: 'Patch into Port {{ PORT_NUM }}' },
    { type: 'computer', title: 'Ping', body: 'ping {{ GATEWAY_IP }}' },
  ];
  const vars = [
    { name: 'PORT_NUM', expression: 'seat' },
    { name: 'GATEWAY_IP', expression: "'192.168.1.' + (100 + seat)" },
  ];
  const { steps } = renderManual(content, vars, 9);
  assert.equal(steps[0].body, 'Patch into Port 9');
  assert.equal(steps[1].body, 'ping 192.168.1.109');
});
