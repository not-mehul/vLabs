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
 * numbers, quoted strings, a fixed set of identifiers, arithmetic operators and
 * parentheses. This keeps instructor-authored content fully sandboxed.
 */

// ---------------------------------------------------------------------------
// Safe arithmetic / string expression evaluator
// ---------------------------------------------------------------------------

const TOKEN_RE =
  /\s*([0-9]*\.?[0-9]+|'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*|[+\-*/%()])/y;

function tokenize(expr) {
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

/**
 * Grammar (standard precedence):
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/' | '%') factor)*
 *   factor  := NUMBER | STRING | IDENT | '(' expr ')' | ('-' factor)
 */
function evaluateExpression(expr, scope) {
  const tokens = tokenize(String(expr));
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

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
      else if (op === '/') left = toNum(left) / toNum(right);
      else left = toNum(left) % toNum(right);
    }
    return left;
  }

  function parseFactor() {
    const tok = peek();
    if (tok === undefined) throw new Error('Unexpected end of expression');

    if (tok === '(') {
      next();
      const val = parseExpr();
      if (next() !== ')') throw new Error('Missing closing parenthesis');
      return val;
    }
    if (tok === '-') {
      next();
      return -toNum(parseFactor());
    }
    if (/^[0-9]/.test(tok)) {
      next();
      return parseFloat(tok);
    }
    if (tok[0] === "'" || tok[0] === '"') {
      next();
      return tok.slice(1, -1);
    }
    if (/^[A-Za-z_]/.test(tok)) {
      next();
      // hasOwnProperty (not `in`) so inherited keys like __proto__/constructor
      // are treated as unknown variables rather than resolving up the chain.
      if (!Object.prototype.hasOwnProperty.call(scope, tok)) {
        throw new Error(`Unknown variable "${tok}"`);
      }
      return scope[tok];
    }
    throw new Error(`Unexpected token "${tok}"`);
  }

  function toNum(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (Number.isNaN(n)) throw new Error(`"${v}" is not a number`);
    return n;
  }

  const result = parseExpr();
  if (pos !== tokens.length) {
    throw new Error(`Unexpected token "${peek()}"`);
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
  const scope = {
    // Built-in identifiers available to every formula.
    seat: Number.isNaN(seatNumber) ? 0 : seatNumber,
  };
  // Built-in placeholder always available even without an explicit formula.
  const context = { SEAT_ID: seatId };

  for (const def of variables || []) {
    if (!def || !def.name) continue;
    const name = String(def.name).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid variable name "${def.name}"`);
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

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Replace {{ NAME }} tokens in a string with values from the context.
 * Unknown placeholders are left visibly marked so authoring mistakes surface
 * rather than silently vanishing.
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
 * so the "unlock string" is never shipped to the browser.
 *
 * @param {Object} step Raw authored step.
 * @param {Object} context Resolved variable context for the seat.
 * @param {number} index Step index within the manual.
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

  if (step.checkpoint && step.checkpoint.answer) {
    // Ship the prompt and its shape, but never the answer.
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

/**
 * Compute the expected checkpoint answer for a seat (server-side only).
 * Comparison is case-insensitive and whitespace-trimmed to be forgiving of
 * participant input while still requiring the correct value.
 */
export function checkpointAnswer(step, context) {
  if (!step || !step.checkpoint || !step.checkpoint.answer) return null;
  return injectVariables(String(step.checkpoint.answer), context)
    .trim()
    .toLowerCase();
}

export function normaliseAnswer(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Render every step of a manual for a seat. Used by the instructor preview.
 * Participant delivery uses renderStep directly with a slice for progressive
 * disclosure (see routes/participant.js).
 */
export function renderManual(content, variables, seatId) {
  const context = resolveVariables(variables, seatId);
  const steps = Array.isArray(content) ? content : [];
  return {
    context,
    steps: steps.map((step, i) => renderStep(step, context, i)),
  };
}

export { evaluateExpression };
