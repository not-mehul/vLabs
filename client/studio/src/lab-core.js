// Lab core: the Studio's formula, placeholder, checkpoint, image and Markdown
// helpers, built on the modules vLabs itself runs (shared/*.js). The Studio
// used to carry its own versions (formulas even went through new Function);
// now a formula, a pattern mask or a checkpoint answer behaves here exactly as
// it does for a participant, and Markdown renders through the app's sanitiser.

const BUILTIN_PLACEHOLDERS = new Set(SHARED_BUILTIN_PLACEHOLDERS);
const FORMULA_BUILTINS = new Set(BUILTIN_IDENTIFIERS);
const FORMULA_HELPERS = new Set(FUNCTION_NAMES);
const RESERVED_NAMES = new Set([...BUILTIN_PLACEHOLDERS, ...FORMULA_BUILTINS, ...FORMULA_HELPERS]);
const VALID_VAR_NAME_RE = IDENT_RE;

/** Image types and size the vLabs image library accepts. */
const IMAGE_EXTENSIONS = Object.values(IMAGE_MIMES);
const IMAGE_MAX_BYTES = LIMITS.imageBytes;

// Identifiers referenced in a formula (ignoring string literals).
function extractFormulaIdentifiers(expr) {
  if (!expr || typeof expr !== 'string') return [];
  const strippedStrings = expr.replace(/'[^']*'|"[^"]*"/g, '""');
  const matches = strippedStrings.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  return Array.from(new Set(matches));
}

/**
 * Evaluate one formula with vLabs' own evaluator. `context` holds seat,
 * first_name, last_name and earlier variables; `allowedVars`, when given,
 * limits which of those variables the formula may use (no forward references).
 */
function evaluateFormulaTyped(expr, context = {}, allowedVars = null) {
  const fail = (msg) => {
    const formatted = `⟨FormulaError: ${msg}⟩`;
    return { error: true, value: formatted, display: formatted };
  };
  const src = typeof expr === 'string' ? expr.trim() : '';
  if (!src) return fail('Empty formula');

  const scope = Object.create(null);
  scope.seat = context.seat !== undefined ? Number(context.seat) : 1;
  scope.first_name = context.first_name !== undefined ? String(context.first_name) : '';
  scope.last_name = context.last_name !== undefined ? String(context.last_name) : '';
  for (const [k, v] of Object.entries(context)) {
    if (FORMULA_BUILTINS.has(k) || (allowedVars && !allowedVars.has(k))) continue;
    scope[k] = v;
  }
  for (const id of extractFormulaIdentifiers(src)) {
    const upstream = scope[id];
    if (typeof upstream === 'string' && upstream.startsWith('⟨FormulaError')) {
      return fail(`Depends on "${id}" which has an error`);
    }
  }
  try {
    const value = evaluateExpression(src, scope);
    if (typeof value !== 'number' && typeof value !== 'string') {
      return fail('Expression must evaluate to a number or string');
    }
    return { error: false, value, display: String(value) };
  } catch (err) {
    return fail(err.message);
  }
}

function evaluateFormula(expr, context = {}, allowedVars = null) {
  return evaluateFormulaTyped(expr, context, allowedVars).display;
}

// Evaluate all template variables in order for a given participant.
function buildEvaluatedContext(seat = 1, firstName = 'Mary-Jane', lastName = "O'Neil", extraCaptures = {}) {
  const ctx = {
    seat: Number(seat) || 1,
    first_name: String(firstName ?? 'Mary-Jane').trim(),
    last_name: String(lastName ?? "O'Neil").trim()
  };
  const allowed = new Set();
  (templateData.variables || []).forEach(v => {
    const name = (v.name || '').trim();
    if (!name) return;
    const res = evaluateFormulaTyped(v.expression, ctx, allowed);
    ctx[name] = res.value;
    allowed.add(name);
  });
  return { ...ctx, ...extraCaptures };
}

/** A pattern mask checked by vLabs' compiler: { valid, error }. */
function parsePatternMaskTokens(pattern) {
  try {
    compileMask(pattern);
    return { valid: true, error: null };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function generateMaskExample(pattern) {
  return maskExample(pattern);
}

/** Match an entry against a mask: { matched, canonical, error }. */
function matchPatternMask(rawInput, pattern) {
  let compiled;
  try {
    compiled = compileMask(pattern);
  } catch (err) {
    return { matched: false, canonical: '', error: err.message };
  }
  if (!String(rawInput ?? '').trim()) return { matched: false, canonical: '', error: 'Input is empty' };
  const canonical = matchMask(compiled, rawInput);
  return canonical === null
    ? { matched: false, canonical: '', error: 'Does not match pattern mask' }
    : { matched: true, canonical };
}

const normalizeExactAnswer = normaliseAnswer;

function verifyCheckpointSubmission(cp, userInput, context) {
  if (!cp) return { matched: true, canonical: '' };
  const raw = String(userInput ?? '');
  if (raw.length > LIMITS.answer) {
    return { matched: false, canonical: '', error: `Entry exceeds ${LIMITS.answer} characters.` };
  }
  if (cp.mode === 'pattern') {
    const res = matchPatternMask(raw, cp.pattern || '');
    if (!res.matched) {
      const hint = cp.placeholder ? ` (${substitutePlaceholders(cp.placeholder, context)})` : '';
      return { matched: false, canonical: '', error: `That doesn't look like the expected format${hint}.` };
    }
    return { matched: true, canonical: res.canonical };
  }
  // Exact: the authored answer that matched, placeholders resolved, its own casing.
  const want = normaliseAnswer(raw);
  for (const authored of [cp.answer, ...(cp.answers || [])]) {
    if (!authored) continue;
    const resolved = substitutePlaceholders(authored, context).trim();
    if (want && normaliseAnswer(resolved) === want) return { matched: true, canonical: resolved };
  }
  return { matched: false, canonical: '', error: 'Incorrect answer. Check your work or open a hint.' };
}

/**
 * The placeholder values a participant gets: SEAT_ID, FIRST_NAME, LAST_NAME,
 * FULL_NAME, variables and saved answers (formula built-ins such as `seat`
 * are not placeholders).
 */
function placeholderContext(context = {}) {
  const first = context.first_name !== undefined ? String(context.first_name) : '';
  const last = context.last_name !== undefined ? String(context.last_name) : '';
  const out = {
    SEAT_ID: context.seat !== undefined ? context.seat : 1,
    FIRST_NAME: first,
    LAST_NAME: last,
    FULL_NAME: `${first} ${last}`.trim(),
  };
  for (const [k, v] of Object.entries(context)) {
    if (!FORMULA_BUILTINS.has(k) && !(k in out)) out[k] = v;
  }
  return out;
}

function substitutePlaceholders(text, context = {}) {
  if (!text || typeof text !== 'string') return '';
  return injectVariables(text, placeholderContext(context));
}

/** Library images by lower-cased name, as vLabs resolves them. */
function imageUrlMap() {
  return new Map((templateData.images || []).filter(i => i.url).map(i => [String(i.name).toLowerCase(), i.url]));
}

// Placeholders first, then library images (per-seat image names work).
function resolveMarkdownImages(mdText, context = {}) {
  if (!mdText || typeof mdText !== 'string') return '';
  return injectImages(substitutePlaceholders(mdText, context), imageUrlMap());
}

function parseMarkdownSafe(mdText) {
  return renderMarkdown(mdText);
}

/**
 * What vLabs answers when this template is saved: [] when it would be
 * accepted, else the messages it would refuse it with. Runs vLabs' own
 * validators (shared/validate-*.js) on the canonical JSON, with the Studio's
 * image library standing in for vLabs' (`imageNames`).
 */
function vlabsSaveErrors() {
  let payload;
  try {
    payload = JSON.parse(generateCanonicalJson());
  } catch (err) {
    return [`The template could not be serialised: ${err.message}`];
  }
  const imageNames = (templateData.images || []).map(i => i.name);
  try {
    if (isExamMode()) validateExamPayload(payload, { imageNames });
    else validateTemplatePayload(payload, { imageNames });
    return [];
  } catch (err) {
    return err.details && err.details.length ? err.details : [err.message];
  }
}
