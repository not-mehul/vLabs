/**
 * Templating engine for the dynamic lab manual.
 *
 * Two responsibilities:
 *   1. Resolve a per-seat "variable dictionary" from instructor-authored
 *      formulas (e.g. GATEWAY_IP = "'192.168.1.' + (100 + seat)").
 *   2. Inject those variables into mustache-style {{PLACEHOLDER}} tokens found
 *      in the master template's step bodies.
 *
 * SECURITY: formulas are NEVER passed to eval()/Function(). They are parsed by
 * a tiny hand-written recursive-descent evaluator that only understands
 * numbers, quoted strings, a fixed set of identifiers, arithmetic operators,
 * parentheses and a small whitelist of pure helper functions. Instructor
 * content stays fully sandboxed: unknown identifiers (including `__proto__`,
 * `constructor`, `process`…) are rejected, and only names in FUNCTIONS may be
 * called.
 */

import { PLACEHOLDER_RE, IDENT_RE } from '../../../shared/template-schema.js';

// ---------------------------------------------------------------------------
// Safe arithmetic / string expression evaluator
// ---------------------------------------------------------------------------

const TOKEN_RE =
  /\s*([0-9]*\.?[0-9]+|'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*|[+\-*/%(),])/y;

/** Hard cap on formula length: keeps a pathological expression from doing work. */
const MAX_EXPRESSION_LENGTH = 500;
/** Hard cap on nesting depth (parentheses / function calls). */
const MAX_DEPTH = 32;

function tokenize(expr) {
  if (expr.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Expression is too long (max ${MAX_EXPRESSION_LENGTH} characters)`);
  }
  const tokens = [];
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(expr)) !== null) {
    tokens.push(m[1]);
    lastIndex = TOKEN_RE.lastIndex;
  }
  // If we didn't consume the whole string, there was an illegal character.
  if (expr.slice(lastIndex).trim() !== '') {
    throw new Error(`Unexpected token near "${expr.slice(lastIndex).trim()}"`);
  }
  return tokens;
}

const toNum = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (Number.isNaN(n)) throw new Error(`"${v}" is not a number`);
  return n;
};
const toInt = (v) => Math.trunc(toNum(v));
const toStr = (v) => String(v);

function arity(name, args, min, max = min) {
  if (args.length < min || args.length > max) {
    const want = min === max ? `${min}` : `${min}–${max}`;
    throw new Error(`${name}() expects ${want} argument${want === '1' ? '' : 's'}`);
  }
}

/**
 * Whitelisted pure helper functions available inside formulas. Each receives
 * already-evaluated argument values and must not touch anything outside its
 * arguments. Keep this list small and boring.
 *
 *   pad(value, width [, char])  zero-pad (default) or pad with `char` on the left
 *   hex(n)                      lowercase hexadecimal of an integer
 *   floor(n) ceil(n) round(n) abs(n)
 *   mod(a, b)                   mathematical modulo (always >= 0 for b > 0)
 *   min(a, b, …) max(a, b, …)
 *   upper(s) lower(s)           string case
 *   str(v)                      force string (e.g. to concatenate numbers as text)
 */
const FUNCTIONS = Object.freeze({
  pad(args) {
    arity('pad', args, 2, 3);
    const [value, width, ch = '0'] = args;
    const padChar = toStr(ch);
    if (padChar.length !== 1) throw new Error('pad() padding character must be one character');
    return toStr(value).padStart(Math.max(0, Math.min(64, toInt(width))), padChar);
  },
  hex(args) {
    arity('hex', args, 1);
    return toInt(args[0]).toString(16);
  },
  floor(args) {
    arity('floor', args, 1);
    return Math.floor(toNum(args[0]));
  },
  ceil(args) {
    arity('ceil', args, 1);
    return Math.ceil(toNum(args[0]));
  },
  round(args) {
    arity('round', args, 1);
    return Math.round(toNum(args[0]));
  },
  abs(args) {
    arity('abs', args, 1);
    return Math.abs(toNum(args[0]));
  },
  mod(args) {
    arity('mod', args, 2);
    const a = toNum(args[0]);
    const b = toNum(args[1]);
    if (b === 0) throw new Error('mod() by zero');
    return ((a % b) + b) % b;
  },
  min(args) {
    arity('min', args, 1, 16);
    return Math.min(...args.map(toNum));
  },
  max(args) {
    arity('max', args, 1, 16);
    return Math.max(...args.map(toNum));
  },
  upper(args) {
    arity('upper', args, 1);
    return toStr(args[0]).toUpperCase();
  },
  lower(args) {
    arity('lower', args, 1);
    return toStr(args[0]).toLowerCase();
  },
  str(args) {
    arity('str', args, 1);
    return toStr(args[0]);
  },
});

/** Names instructors may call in formulas (exposed for docs / editor help). */
export const FUNCTION_NAMES = Object.freeze(Object.keys(FUNCTIONS));

/**
 * Grammar (standard precedence):
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/' | '%') factor)*
 *   factor  := NUMBER | STRING | IDENT | IDENT '(' args? ')' | '(' expr ')' | ('-' factor)
 *   args    := expr (',' expr)*
 */
function evaluateExpression(expr, scope) {
  const tokens = tokenize(String(expr));
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const enter = () => {
    depth += 1;
    if (depth > MAX_DEPTH) throw new Error('Expression is nested too deeply');
  };
  const leave = () => {
    depth -= 1;
  };

  function parseExpr() {
    let left = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const right = parseTerm();
      if (op === '+') {
        // String concatenation when either operand is a string, else numeric.
        left =
          typeof left === 'string' || typeof right === 'string'
            ? `${left}${right}`
            : left + right;
      } else {
        left = toNum(left) - toNum(right);
      }
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const right = parseFactor();
      if (op === '*') left = toNum(left) * toNum(right);
      else if (op === '/') {
        const d = toNum(right);
        if (d === 0) throw new Error('Division by zero');
        left = toNum(left) / d;
      } else {
        const d = toNum(right);
        if (d === 0) throw new Error('Modulo by zero');
        left = toNum(left) % d;
      }
    }
    return left;
  }

  function parseArgs() {
    const args = [];
    if (peek() === ')') return args;
    args.push(parseExpr());
    while (peek() === ',') {
      next();
      args.push(parseExpr());
    }
    return args;
  }

  function parseFactor() {
    const tok = peek();
    if (tok === undefined) throw new Error('Unexpected end of expression');

    if (tok === '(') {
      next();
      enter();
      const val = parseExpr();
      leave();
      if (next() !== ')') throw new Error('Missing closing parenthesis');
      return val;
    }
    if (tok === '-') {
      next();
      return -toNum(parseFactor());
    }
    if (/^[0-9.]/.test(tok)) {
      next();
      return parseFloat(tok);
    }
    if (tok[0] === "'" || tok[0] === '"') {
      next();
      return tok.slice(1, -1);
    }
    if (/^[A-Za-z_]/.test(tok)) {
      next();
      // Function call?
      if (peek() === '(') {
        // hasOwnProperty so `constructor(...)`, `toString(...)` etc. are rejected.
        if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, tok)) {
          throw new Error(`Unknown function "${tok}"`);
        }
        next(); // '('
        enter();
        const args = parseArgs();
        leave();
        if (next() !== ')') throw new Error(`Missing closing parenthesis after ${tok}(`);
        return FUNCTIONS[tok](args);
      }
      // hasOwnProperty (not `in`) so inherited keys like __proto__/constructor
      // are treated as unknown variables rather than resolving up the chain.
      if (!Object.prototype.hasOwnProperty.call(scope, tok)) {
        throw new Error(`Unknown variable "${tok}"`);
      }
      return scope[tok];
    }
    throw new Error(`Unexpected token "${tok}"`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) {
    throw new Error(`Unexpected token "${peek()}"`);
  }
  if (typeof result === 'number' && !Number.isFinite(result)) {
    throw new Error('Expression did not produce a finite number');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Variable dictionary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the full variable context for a given seat.
 *
 * @param {Array<{name:string, expression:string}>} variables Author formulas.
 * @param {number|string} seatId The participant's seat identifier.
 * @returns {Object} Map of variable name -> resolved value.
 */
export function resolveVariables(variables, seatId) {
  const seatNumber = parseInt(String(seatId).replace(/[^0-9]/g, ''), 10);
  const scope = Object.create(null);
  // Built-in identifiers available to every formula.
  scope.seat = Number.isNaN(seatNumber) ? 0 : seatNumber;
  // Built-in placeholder always available even without an explicit formula.
  const context = { SEAT_ID: seatId };

  for (const def of variables || []) {
    if (!def || !def.name) continue;
    const name = String(def.name).trim();
    if (!IDENT_RE.test(name)) {
      throw new Error(`Invalid variable name "${def.name}"`);
    }
    if (Object.prototype.hasOwnProperty.call(FUNCTIONS, name)) {
      throw new Error(`Variable name "${name}" clashes with a built-in function`);
    }
    let value;
    try {
      value = evaluateExpression(def.expression ?? '', scope);
    } catch (err) {
      throw new Error(`Error in variable "${name}": ${err.message}`);
    }
    // Expose resolved value to subsequent formulas (allows composition) and to
    // the placeholder-injection context.
    scope[name] = value;
    context[name] = value;
  }

  return context;
}

// ---------------------------------------------------------------------------
// Placeholder injection
// ---------------------------------------------------------------------------

/**
 * Replace {{ NAME }} tokens in a string with values from the context.
 * Unknown placeholders are left visibly marked so authoring mistakes surface
 * rather than silently vanishing. (Templates are also rejected at save time
 * when they reference unknown placeholders — see validateTemplate.js.)
 */
export function injectVariables(text, context) {
  if (typeof text !== 'string') return text;
  return text.replace(PLACEHOLDER_RE, (_match, name) =>
    Object.prototype.hasOwnProperty.call(context, name)
      ? String(context[name])
      : `⟨missing:${name}⟩`,
  );
}

// ---------------------------------------------------------------------------
// Step rendering
// ---------------------------------------------------------------------------

/**
 * Render a single authored step for a specific seat.
 *
 * IP-PROTECTION NOTE: checkpoint answers are intentionally stripped from the
 * rendered output. The server keeps them private and validates submissions,
 * so the "unlock string" is never shipped to the browser. Solutions are also
 * omitted here; the participant route adds them only once revealed.
 *
 * @param {Object} step Raw authored step.
 * @param {Object} context Resolved variable context for the seat.
 * @param {number} index Step index within the section.
 */
export function renderStep(step, context, index) {
  const rendered = {
    index,
    type: step.type === 'computer' ? 'computer' : 'desk',
    title: injectVariables(step.title || `Step ${index + 1}`, context),
    body: injectVariables(step.body || '', context),
    hints: (step.hints || []).map((h) => ({
      label: injectVariables(h.label || 'Hint', context),
      text: injectVariables(h.text || '', context),
    })),
  };

  if (stepHasCheckpoint(step)) {
    // Ship the prompt and its shape, but never the answer(s).
    rendered.checkpoint = {
      prompt: injectVariables(
        step.checkpoint.prompt || 'Enter the value to continue',
        context,
      ),
      placeholder: injectVariables(step.checkpoint.placeholder || '', context),
    };
  }

  return rendered;
}

/** Normalise a participant-submitted (or authored) answer for comparison. */
export function normaliseAnswer(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * All accepted checkpoint answers for a seat (server-side only), normalised.
 * The primary `answer` plus any authored alternatives (`answers`).
 */
export function checkpointAnswers(step, context) {
  if (!stepHasCheckpoint(step)) return [];
  const all = [step.checkpoint.answer, ...(step.checkpoint.answers || [])];
  return [...new Set(all.map((a) => normaliseAnswer(injectVariables(String(a), context))))];
}

/**
 * Compute the primary expected checkpoint answer for a seat (server-side only).
 * Kept for backwards compatibility; prefer `isCorrectAnswer` / `checkpointAnswers`.
 */
export function checkpointAnswer(step, context) {
  const all = checkpointAnswers(step, context);
  return all.length ? all[0] : null;
}

/** Does a submitted value match any accepted answer for this seat? */
export function isCorrectAnswer(step, context, submitted) {
  const want = checkpointAnswers(step, context);
  return want.includes(normaliseAnswer(submitted));
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
//
// A manual's content is an ordered list of SECTIONS, each with an ordered list
// of STEPS. Checkpoints live on steps. A checkpoint is identified globally by
// the key "<sectionIndex>.<stepIndex>" so participant progress can be tracked
// with a single flat set.

export function checkpointKey(sectionIndex, stepIndex) {
  return `${sectionIndex}.${stepIndex}`;
}

/** Does a step carry a real (answerable) checkpoint? */
export function stepHasCheckpoint(step) {
  return Boolean(step && step.checkpoint && step.checkpoint.answer);
}

/** True when every checkpoint in a section has been completed. */
export function isSectionCleared(section, sectionIndex, completedSet) {
  const steps = (section && section.steps) || [];
  for (let i = 0; i < steps.length; i += 1) {
    if (stepHasCheckpoint(steps[i]) && !completedSet.has(checkpointKey(sectionIndex, i))) {
      return false;
    }
  }
  return true;
}

/**
 * Highest section index a participant may access. You can only enter section
 * n once every earlier section is fully cleared, so this returns the first
 * not-yet-cleared section (capped at the last section).
 */
export function computeUnlockedSection(sections, completedSet) {
  for (let s = 0; s < sections.length; s += 1) {
    if (!isSectionCleared(sections[s], s, completedSet)) return s;
  }
  return Math.max(sections.length - 1, 0);
}

/**
 * Within a section, the index of the last visible step. Steps reveal up to and
 * including the first step whose checkpoint is not yet completed (mid-section
 * gating); once that checkpoint clears, the rest of the section reveals.
 */
export function computeSectionVisibleThrough(section, sectionIndex, completedSet) {
  const steps = (section && section.steps) || [];
  for (let i = 0; i < steps.length - 1; i += 1) {
    if (stepHasCheckpoint(steps[i]) && !completedSet.has(checkpointKey(sectionIndex, i))) {
      return i;
    }
  }
  return Math.max(steps.length - 1, 0);
}

/**
 * Is (sectionIndex, stepIndex) currently reachable by a participant with the
 * given completed-checkpoint set? Shared by every participant action route so
 * hints, solutions, checkpoints and progress all apply the same gate.
 */
export function isStepReachable(sections, sectionIndex, stepIndex, completedSet) {
  if (!Number.isInteger(sectionIndex) || !Number.isInteger(stepIndex)) return false;
  const section = sections[sectionIndex];
  if (!section || !section.steps || !section.steps[stepIndex]) return false;
  if (sectionIndex > computeUnlockedSection(sections, completedSet)) return false;
  if (isSectionCleared(section, sectionIndex, completedSet)) return true;
  return stepIndex <= computeSectionVisibleThrough(section, sectionIndex, completedSet);
}

/**
 * Render one section for a seat. `stepLimit` optionally caps how many steps are
 * returned (progressive within-section disclosure). Checkpoint answers are
 * stripped by renderStep; each rendered step is tagged with its checkpoint key
 * and completion state.
 */
export function renderSection(section, context, sectionIndex, completedSet, stepLimit) {
  const steps = (section && section.steps) || [];
  const limit = stepLimit === undefined ? steps.length - 1 : stepLimit;
  const rendered = steps.slice(0, limit + 1).map((step, i) => {
    const r = renderStep(step, context, i);
    if (r.checkpoint) {
      r.checkpoint.key = checkpointKey(sectionIndex, i);
      r.checkpoint.completed = completedSet ? completedSet.has(r.checkpoint.key) : false;
    }
    return r;
  });
  return {
    index: sectionIndex,
    title: injectVariables(section?.title || `Section ${sectionIndex + 1}`, context),
    total_steps: steps.length,
    steps: rendered,
  };
}

/** Total number of steps across all sections. */
export function countSteps(sections) {
  return (sections || []).reduce((n, s) => n + ((s.steps && s.steps.length) || 0), 0);
}

/**
 * Render an entire manual (all sections, all steps) for a seat. Used by the
 * instructor preview. Participant delivery renders a slice (see participant.js).
 */
export function renderManual(content, variables, seatId) {
  const context = resolveVariables(variables, seatId);
  const sections = Array.isArray(content) ? content : [];
  const empty = new Set();
  return {
    context,
    sections: sections.map((section, i) => renderSection(section, context, i, empty)),
  };
}

export { evaluateExpression };
