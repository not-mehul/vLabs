// CSP-safe event attributes.
//
// The Studio's markup wires events with attributes such as
//   data-on-click="moveStep(2, 0, -1)"   data-on-input="filterOutline(this.value)"
// (they were inline onclick= handlers). vLabs serves the Studio under a
// Content-Security-Policy without 'unsafe-inline', which blocks inline
// handlers, so this module runs them instead: one listener per event type
// reads the attribute, parses it with the tiny grammar below and calls into
// the Studio's own functions. Nothing is passed to eval() or Function().
//
// Grammar: statements separated by `;`, each `if (expr) statement`, an
// assignment `target = expr`, or an expression. Expressions: numbers, quoted
// strings, true/false/null, { key: value } objects, [ ] arrays, names,
// member access, calls, `!`, unary `-`, `===` and `!==`. Names resolve to the
// Studio's top-level functions and state, `this` (the element carrying the
// attribute), `event` and `document`; nothing else on window is reachable.

const EVENTS = ['click', 'input', 'change', 'keydown', 'dragover', 'dragleave', 'drop'];

const TOKEN_RE =
  /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_$][\w$]*)|(===|!==|[!=.,;:(){}[\]-]))/y;

function tokenize(src) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while (TOKEN_RE.lastIndex < src.length && (m = TOKEN_RE.exec(src))) {
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'str', v: unquote(m[2]) });
    else if (m[3] !== undefined) out.push({ t: 'id', v: m[3] });
    else if (m[4] !== undefined) out.push({ t: 'op', v: m[4] });
  }
  if (src.slice(TOKEN_RE.lastIndex).trim()) throw new Error(`Unsupported handler: ${src}`);
  return out;
}

function unquote(lit) {
  return lit.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c);
}

/** Parse handler source into a small AST (cached per source string). */
function parse(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = (v) => toks[i] && toks[i].v === v && (toks[i].t === 'op' || toks[i].t === 'id');
  const expect = (v) => {
    if (!peek(v)) throw new Error(`Expected "${v}" in handler: ${src}`);
    i += 1;
  };

  function primary() {
    const tok = toks[i++];
    if (!tok) throw new Error(`Unexpected end of handler: ${src}`);
    if (tok.t === 'num' || tok.t === 'str') return { k: 'lit', v: tok.v };
    if (tok.t === 'id') {
      if (tok.v === 'true') return { k: 'lit', v: true };
      if (tok.v === 'false') return { k: 'lit', v: false };
      if (tok.v === 'null') return { k: 'lit', v: null };
      if (tok.v === 'undefined') return { k: 'lit', v: undefined };
      return { k: 'name', v: tok.v };
    }
    if (tok.v === '(') {
      const e = expr();
      expect(')');
      return e;
    }
    if (tok.v === '{') {
      const props = [];
      while (!peek('}')) {
        const key = toks[i++];
        if (!key || (key.t !== 'id' && key.t !== 'str')) throw new Error(`Bad object in: ${src}`);
        expect(':');
        props.push([key.v, expr()]);
        if (!peek('}')) expect(',');
      }
      expect('}');
      return { k: 'obj', props };
    }
    if (tok.v === '[') {
      const items = [];
      while (!peek(']')) {
        items.push(expr());
        if (!peek(']')) expect(',');
      }
      expect(']');
      return { k: 'arr', items };
    }
    throw new Error(`Unexpected "${tok.v}" in handler: ${src}`);
  }

  function postfix() {
    let node = primary();
    for (;;) {
      if (peek('.')) {
        i += 1;
        const name = toks[i++];
        if (!name || name.t !== 'id') throw new Error(`Bad member access in: ${src}`);
        node = { k: 'member', obj: node, key: name.v };
      } else if (peek('(')) {
        i += 1;
        const args = [];
        while (!peek(')')) {
          args.push(expr());
          if (!peek(')')) expect(',');
        }
        expect(')');
        node = { k: 'call', fn: node, args };
      } else return node;
    }
  }

  function unary() {
    if (peek('!')) {
      i += 1;
      return { k: 'not', e: unary() };
    }
    if (peek('-')) {
      i += 1;
      return { k: 'neg', e: unary() };
    }
    return postfix();
  }

  function expr() {
    let left = unary();
    while (peek('===') || peek('!==')) {
      const op = toks[i++].v;
      left = { k: 'cmp', op, left, right: unary() };
    }
    return left;
  }

  function statement() {
    if (peek('if')) {
      i += 1;
      expect('(');
      const cond = expr();
      expect(')');
      return { k: 'if', cond, then: statement() };
    }
    const target = expr();
    if (peek('=')) {
      i += 1;
      if (target.k !== 'name' && target.k !== 'member') throw new Error(`Bad assignment: ${src}`);
      return { k: 'assign', target, value: expr() };
    }
    return target;
  }

  const body = [];
  while (i < toks.length) {
    if (peek(';')) {
      i += 1;
      continue;
    }
    body.push(statement());
  }
  return body;
}

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function run(ast, scope, el, event) {
  const lookup = (name) => {
    if (name === 'this') return el;
    if (name === 'event') return event;
    if (name === 'document') return document;
    if (name in scope) return scope[name];
    throw new Error(`Unknown name in handler: ${name}`);
  };
  const member = (obj, key) => {
    if (BLOCKED_KEYS.has(key)) throw new Error(`Blocked property: ${key}`);
    return obj == null ? undefined : obj[key];
  };
  const evaluate = (n) => {
    switch (n.k) {
      case 'lit':
        return n.v;
      case 'name':
        return lookup(n.v);
      case 'member':
        return member(evaluate(n.obj), n.key);
      case 'obj':
        return Object.fromEntries(n.props.map(([k, v]) => [k, evaluate(v)]));
      case 'arr':
        return n.items.map(evaluate);
      case 'not':
        return !evaluate(n.e);
      case 'neg':
        return -evaluate(n.e);
      case 'cmp': {
        const same = evaluate(n.left) === evaluate(n.right);
        return n.op === '===' ? same : !same;
      }
      case 'call': {
        const self = n.fn.k === 'member' ? evaluate(n.fn.obj) : undefined;
        const fn = n.fn.k === 'member' ? member(self, n.fn.key) : evaluate(n.fn);
        if (typeof fn !== 'function')
          throw new Error('Handler calls something that is not a function');
        return fn.apply(self, n.args.map(evaluate));
      }
      case 'if':
        return evaluate(n.cond) ? evaluate(n.then) : undefined;
      case 'assign': {
        const value = evaluate(n.value);
        if (n.target.k === 'name') {
          if (!(n.target.v in scope)) throw new Error(`Unknown name in handler: ${n.target.v}`);
          scope[n.target.v] = value;
        } else {
          const obj = evaluate(n.target.obj);
          if (BLOCKED_KEYS.has(n.target.key)) throw new Error(`Blocked property: ${n.target.key}`);
          obj[n.target.key] = value;
        }
        return value;
      }
      default:
        throw new Error('Bad handler');
    }
  };
  for (const stmt of ast) evaluate(stmt);
}

/**
 * Start handling data-on-* attributes. `scope` exposes the Studio's
 * top-level functions and variables (getters/setters for `let` state).
 */
export function installInlineHandlers(scope) {
  const cache = new Map();
  for (const type of EVENTS) {
    const attr = `data-on-${type}`;
    // Capture phase on document: like inline handlers, these run before the
    // Studio's own bubbling document listeners, innermost element first.
    document.addEventListener(
      type,
      (event) => {
        const path = [];
        for (let el = event.target; el && el !== document; el = el.parentElement) {
          if (el.hasAttribute?.(attr)) path.push(el);
        }
        for (const el of path) {
          const src = el.getAttribute(attr);
          let ast = cache.get(src);
          if (!ast) {
            try {
              ast = parse(src);
            } catch (err) {
              console.error(err);
              continue;
            }
            cache.set(src, ast);
          }
          try {
            run(ast, scope, el, event);
          } catch (err) {
            console.error(err);
          }
          if (event.cancelBubble) break;
        }
      },
      true,
    );
  }
}

export const __test = { parse, run };
