/**
 * vLabs Template Studio (client/studio): the handler interpreter that stands
 * in for inline onclick="…" under the app's CSP, and the Studio's own sources
 * (node:test, no DOM needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test as handlers } from '../studio/src/inline-handlers.js';
import { APP_SCRIPTS, topLevelNames } from '../studio/app-source.mjs';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../studio/src');
const read = (f) => fs.readFileSync(path.join(srcDir, f), 'utf8');
const run = (src, scope, el = {}, event = {}) =>
  handlers.run(handlers.parse(src), scope, el, event);

test('handlers: calls, members, literals, if, assignment', () => {
  const calls = [];
  const scope = {
    view: 'builder',
    go: (...args) => calls.push(args),
    state: { open: false },
  };
  run("go('x', 2, -1.5, true, null, {a: 1, 'b': [3, 4]})", scope);
  assert.deepEqual(calls.pop(), ['x', 2, -1.5, true, null, { a: 1, b: [3, 4] }]);
  run('go(this.value, event.key)', scope, { value: 'v' }, { key: 'Enter' });
  assert.deepEqual(calls.pop(), ['v', 'Enter']);
  run("if (event.key === 'Enter') go(1); go(2)", scope, {}, { key: 'Esc' });
  assert.deepEqual(calls, [[2]]);
  run("view = 'preview'; state.open = !state.open", scope);
  assert.equal(scope.view, 'preview');
  assert.equal(scope.state.open, true);
  run(
    'event.stopPropagation(); go(this.checked !== false)',
    scope,
    { checked: true },
    { stopPropagation() {} },
  );
  assert.deepEqual(calls.pop(), [true]);
});

test('handlers: refuse what inline JavaScript could do and they cannot', () => {
  const scope = { go: () => {} };
  for (const src of [
    'go(x => x)', // functions
    'go(a || b)', // operators beyond ! - === !==
    'go(`t`)', // template literals
    "go('a' + 'b')",
    'window.alert(1)', // names outside the scope
  ]) {
    assert.throws(() => run(src, scope), undefined, src);
  }
  assert.throws(() => run('go.constructor', scope), /Blocked/);
  assert.throws(() => run('this.__proto__.x = 1', scope, {}), /Blocked/);
  assert.throws(() => run('nope = 1', scope), /Unknown name/);
});

/** Every data-on-* handler the Studio writes, with `${…}` filled in. */
function studioHandlers() {
  const out = [];
  const fill = (s) => {
    let prev;
    do {
      prev = s;
      s = s.replace(/\$\{[^{}]*\}/g, '0');
    } while (s !== prev);
    return s;
  };
  const templates = (code) => [...code.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  for (const file of [...APP_SCRIPTS, 'body.html']) {
    const code = read(file);
    for (const m of code.matchAll(/data-on-[a-z]+="((?:[^"\\]|\\.)*)"/g)) {
      const value = m[1];
      const whole = value.match(/^\$\{([\s\S]*)\}$/);
      let sources = [value];
      if (whole && /^\w+$/.test(whole[1].trim())) {
        // data-on-click="${action}": the handlers are what `action` is set to.
        const def = code.match(
          new RegExp(`(?:const|let)\\s+${whole[1].trim()}\\s*=([\\s\\S]*?);\\n`),
        );
        assert.ok(def, `${file}: cannot find ${whole[1]} for a handler`);
        sources = templates(def[1]);
      } else if (whole) {
        sources = templates(whole[1]);
      }
      for (const src of sources) out.push({ file, src: fill(src) });
    }
  }
  return out;
}

test('every Studio handler parses and names only the Studio scope', () => {
  const code = APP_SCRIPTS.map(read).join('\n');
  const { fns, lets, consts } = topLevelNames(code);
  const known = new Set([...fns, ...lets, ...consts, 'this', 'event', 'document']);
  const all = studioHandlers();
  assert.ok(all.length > 100, `found only ${all.length} handlers`);
  for (const { file, src } of all) {
    let ast;
    assert.doesNotThrow(() => (ast = handlers.parse(src)), `${file}: ${src}`);
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.k === 'name')
        assert.ok(known.has(n.v), `${file}: "${n.v}" is not in the Studio's scope (${src})`);
      Object.values(n).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : walk(v)));
    };
    ast.forEach(walk);
  }
});

test('the Studio evaluates formulas with the shared evaluator, never eval', () => {
  for (const file of APP_SCRIPTS) {
    const code = read(file);
    assert.doesNotMatch(code, /new Function\s*\(|\beval\s*\(/, file);
  }
  // Its exam and lab rules are vLabs' own modules, not a copy.
  const imports = read('imports.js');
  for (const mod of [
    'exam-schema',
    'exam-format',
    'template-schema',
    'templating',
    'template-format',
    'validate-template',
    'validate-exam',
  ]) {
    assert.match(imports, new RegExp(`shared/${mod}\\.js`), mod);
  }
});
