/**
 * Canonical lab-template shape, shared by the server (validation + storage) and
 * the client (editor, import/export).
 *
 * This module is dependency-free ESM so it can be imported from both sides
 * without a build step:
 *   server:  import { normaliseTemplate } from '../../../shared/template-schema.js'
 *   client:  import { normaliseTemplate } from '../../../shared/template-schema.js'
 *
 * Having ONE normaliser (instead of the previous three — server validator,
 * client importer, editor `coerce`) means the shape can't drift between them.
 *
 * Canonical shape
 * ---------------
 * {
 *   title: string,
 *   description: string,
 *   variables: [{ name: string, expression: string }],
 *   content: [{
 *     title: string,
 *     steps: [{
 *       type: 'desk' | 'computer' | 'info',
 *       title: string,
 *       body: string,                         // Markdown, may contain {{ VARS }}
 *       hints: [{ label: string, text: string }],   // always [] for info steps
 *       solution: string,                     // Markdown, '' when none / info
 *       checkpoint: null | {                  // always null for info steps
 *         prompt: string,
 *         placeholder: string,
 *         mode: 'exact' | 'pattern',
 *         answer: string,                     // exact: primary expected answer
 *         answers: string[],                  // exact: additional accepted answers
 *         pattern: string,                    // pattern: a MASK (see compileMask)
 *         capture: string,                    // '' or a variable name that later
 *                                             //   steps may reference as {{ NAME }}
 *       },
 *     }],
 *   }],
 * }
 *
 * Step types
 * ----------
 *   desk      hands-on bench work           — may carry hints, solution, checkpoint
 *   computer  work on the workstation       — same
 *   info      context only, nothing to do   — title + body; everything else stripped
 *
 * Checkpoint modes
 * ----------------
 *   exact     the participant's entry must equal one of the authored answers
 *             (after whitespace/case normalisation; answers may use placeholders).
 *   pattern   the entry must fit a mask such as `XXXX.XXXX.XXXX` — for values the
 *             author cannot know in advance (serial numbers, MACs…). The matched
 *             value is normalised to the mask's canonical form and, when
 *             `capture` names a variable, becomes available to every LATER step
 *             as {{ NAME }} (body, hints, solution, prompts, exact answers).
 */

/** Upper bounds on authored structure and text sizes. */
export const LIMITS = Object.freeze({
  variables: 100,
  sections: 100,
  stepsPerSection: 100,
  hintsPerStep: 20,
  altAnswers: 10,
  title: 200,
  description: 1000,
  sectionTitle: 200,
  stepTitle: 200,
  body: 20_000,
  hintLabel: 120,
  hintText: 4000,
  solution: 4000,
  prompt: 300,
  placeholder: 120,
  answer: 200,
  pattern: 120,
  captureName: 40,
  /** Serialised JSON size of a whole template (bytes). */
  serialisedBytes: 900_000,
});

/** Valid identifier for variable names and placeholders. */
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Mustache-style placeholder: {{ NAME }} */
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Placeholders that are always available without an explicit formula.
 *   SEAT_ID                 the participant's seat number
 *   FIRST_NAME / LAST_NAME  as entered at registration
 *   FULL_NAME               "First Last"
 */
export const BUILTIN_PLACEHOLDERS = Object.freeze([
  'SEAT_ID',
  'FIRST_NAME',
  'LAST_NAME',
  'FULL_NAME',
]);

/** Identifiers usable inside formulas without declaring them. */
export const BUILTIN_IDENTIFIERS = Object.freeze(['seat', 'first_name', 'last_name']);

export const STEP_TYPES = Object.freeze(['desk', 'computer', 'info']);
export const CHECKPOINT_MODES = Object.freeze(['exact', 'pattern']);

const str = (v, max) => {
  const s = v === null || v === undefined ? '' : String(v);
  return typeof max === 'number' ? s.slice(0, max) : s;
};

/** A fresh, empty step in canonical shape. */
export function blankStep() {
  return { type: 'desk', title: '', body: '', hints: [], solution: '', checkpoint: null };
}

/** A fresh section with one blank step. */
export function blankSection(n = 1) {
  return { title: `Section ${n}`, steps: [blankStep()] };
}

/**
 * Normalise a checkpoint object; returns null when there is nothing to check
 * (no answer in exact mode, no pattern in pattern mode). A checkpoint with a
 * pattern but no explicit mode is treated as pattern mode, so older JSON and
 * hand-written imports need not spell it out.
 */
export function normaliseCheckpoint(cp) {
  if (!cp || typeof cp !== 'object') return null;
  const answer = str(cp.answer, LIMITS.answer).trim();
  const pattern = str(cp.pattern, LIMITS.pattern).trim();
  const mode =
    cp.mode === 'pattern' || (cp.mode !== 'exact' && !answer && pattern) ? 'pattern' : 'exact';
  if (mode === 'exact' && !answer) return null;
  if (mode === 'pattern' && !pattern) return null;
  const rawAlts = Array.isArray(cp.answers) ? cp.answers : [];
  const answers =
    mode === 'exact'
      ? rawAlts
          .map((a) => str(a, LIMITS.answer).trim())
          .filter((a) => a && a !== answer)
          .filter((a, i, arr) => arr.indexOf(a) === i)
          .slice(0, LIMITS.altAnswers)
      : [];
  return {
    prompt: str(cp.prompt, LIMITS.prompt).trim(),
    placeholder: str(cp.placeholder, LIMITS.placeholder).trim(),
    mode,
    answer: mode === 'exact' ? answer : '',
    answers,
    pattern: mode === 'pattern' ? pattern : '',
    capture: str(cp.capture, LIMITS.captureName).trim(),
  };
}

/** Normalise a single step into canonical shape. */
export function normaliseStep(st) {
  const s = st && typeof st === 'object' ? st : {};
  const type = STEP_TYPES.includes(s.type) ? s.type : 'desk';
  if (type === 'info') {
    // Context-only: nothing to do, so nothing to hint at, solve or check.
    return {
      type,
      title: str(s.title, LIMITS.stepTitle),
      body: str(s.body, LIMITS.body),
      hints: [],
      solution: '',
      checkpoint: null,
    };
  }
  return {
    type,
    title: str(s.title, LIMITS.stepTitle),
    body: str(s.body, LIMITS.body),
    hints: (Array.isArray(s.hints) ? s.hints : []).slice(0, LIMITS.hintsPerStep).map((h) => ({
      label: str(h && h.label, LIMITS.hintLabel),
      text: str(h && h.text, LIMITS.hintText),
    })),
    solution: str(s.solution, LIMITS.solution),
    checkpoint: normaliseCheckpoint(s.checkpoint),
  };
}

/**
 * Coerce any template-ish object (API response, imported JSON, editor state,
 * legacy shapes) into the canonical shape. Never throws; unknown fields are
 * dropped and missing ones defaulted. Structural validation (required titles,
 * non-empty bodies, unknown placeholders…) lives in `validateTemplate` on the
 * server — this is only shape coercion.
 */
export function normaliseTemplate(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const content = Array.isArray(o.content) ? o.content : [];
  return {
    title: str(o.title, LIMITS.title),
    description: str(o.description, LIMITS.description),
    variables: (Array.isArray(o.variables) ? o.variables : [])
      .filter((v) => v && typeof v === 'object')
      .slice(0, LIMITS.variables)
      .map((v) => ({ name: str(v.name).trim(), expression: str(v.expression).trim() })),
    content: content.slice(0, LIMITS.sections).map((sec) => {
      const s = sec && typeof sec === 'object' ? sec : {};
      return {
        title: str(s.title, LIMITS.sectionTitle),
        steps: (Array.isArray(s.steps) ? s.steps : [])
          .slice(0, LIMITS.stepsPerSection)
          .map(normaliseStep),
      };
    }),
  };
}

/**
 * Every text field of a template that may contain placeholders, with a
 * human-readable location, in READING ORDER. Used by placeholder validation on
 * both sides. After a step whose checkpoint captures a value, a
 * `{ defines: NAME }` marker is yielded so order-aware consumers know that
 * placeholder exists from the next step onward.
 */
export function* templateTextFields(tpl) {
  const t = tpl || {};
  const content = Array.isArray(t.content) ? t.content : [];
  for (const [si, section] of content.entries()) {
    const sec = `Section ${si + 1}`;
    yield { where: `${sec} title`, text: section?.title };
    const steps = Array.isArray(section?.steps) ? section.steps : [];
    for (const [i, step] of steps.entries()) {
      const at = `${sec} · step ${i + 1}`;
      yield { where: `${at} title`, text: step?.title };
      yield { where: `${at} body`, text: step?.body };
      for (const [hi, h] of (Array.isArray(step?.hints) ? step.hints : []).entries()) {
        yield { where: `${at} hint ${hi + 1} label`, text: h?.label };
        yield { where: `${at} hint ${hi + 1}`, text: h?.text };
      }
      yield { where: `${at} solution`, text: step?.solution };
      if (step?.checkpoint) {
        yield { where: `${at} checkpoint prompt`, text: step.checkpoint.prompt };
        yield { where: `${at} checkpoint placeholder`, text: step.checkpoint.placeholder };
        yield { where: `${at} checkpoint answer`, text: step.checkpoint.answer };
        for (const [ai, a] of (step.checkpoint.answers || []).entries()) {
          yield { where: `${at} checkpoint alternative answer ${ai + 1}`, text: a };
        }
        if (step.checkpoint.capture) yield { defines: String(step.checkpoint.capture).trim() };
      }
    }
  }
}

/** Names captured by pattern checkpoints anywhere in the template. */
export function captureNames(tpl) {
  const out = [];
  for (const f of templateTextFields(tpl)) if (f.defines) out.push(f.defines);
  return out;
}

/** Distinct placeholder names used in a string. */
export function placeholdersIn(text) {
  const names = new Set();
  if (typeof text !== 'string') return names;
  for (const m of text.matchAll(PLACEHOLDER_RE)) names.add(m[1]);
  return names;
}

/**
 * Find placeholders that reference neither a declared variable nor a built-in.
 * A typo here used to silently produce an unpassable checkpoint
 * (`⟨missing:HOST_IPP⟩` as the expected answer), so callers should treat any
 * result as an authoring error.
 *
 * @returns {Array<{name:string, where:string}>}
 */
export function findUnknownPlaceholders(tpl) {
  const known = new Set(BUILTIN_PLACEHOLDERS);
  for (const v of (tpl && tpl.variables) || []) if (v && v.name) known.add(String(v.name).trim());
  const captures = new Set(captureNames(tpl));
  const out = [];
  const seen = new Set();
  for (const field of templateTextFields(tpl)) {
    if (field.defines) {
      // A captured value exists only once its checkpoint has been passed, i.e.
      // from the following step onward.
      known.add(field.defines);
      continue;
    }
    const { where, text } = field;
    for (const name of placeholdersIn(text)) {
      if (known.has(name)) continue;
      const key = `${name}@${where}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        where,
        // Hint for the author: referenced before the checkpoint that captures it.
        early: captures.has(name),
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Pattern checkpoints: masks                                                */
/* -------------------------------------------------------------------------- */
/**
 * A mask describes the FORMAT of an answer the author cannot know in advance.
 *
 *   9   a digit                               A   a letter → stored upper-case
 *   a   a letter → stored lower-case          X   a letter or digit → upper-case
 *   x   a letter or digit → lower-case        ?   any single visible character, as typed
 *   *   one or more characters of anything, as typed (use sparingly)
 *   \c  the literal character c, REQUIRED — escape a wildcard letter to match it
 *       literally (\A), or a separator to make it mandatory (99\.99)
 *
 * Any other letter or digit is a required literal (`SN-9999` must start with
 * SN). Punctuation and spaces (`.`, `-`, `:`, `/`, ` ` …) are SEPARATORS: they
 * are re-inserted in the canonical value but participants may leave them out,
 * so a mask `XXXX.XXXX.XXXX` accepts both `ABCD.1234.WXYZ` and `abcd1234wxyz`
 * and canonicalises both to `ABCD.1234.WXYZ`. (A different separator, such as
 * `abcd-1234-wxyz`, is not accepted.) Matching is case-insensitive; the
 * canonical value applies the mask's casing.
 */
const MASK_CLASSES = {
  9: { re: '[0-9]', examples: '1234567890' },
  A: { re: '[A-Za-z]', examples: 'ABCDEFGHJK', case: 'upper' },
  a: { re: '[A-Za-z]', examples: 'abcdefghjk', case: 'lower' },
  X: { re: '[A-Za-z0-9]', examples: 'AB12CD34EF', case: 'upper' },
  x: { re: '[A-Za-z0-9]', examples: 'ab12cd34ef', case: 'lower' },
  '?': { re: '[^\\s]', examples: '#' },
  '*': { re: '.+?', examples: '…', wild: true },
};

const reEscape = (c) => c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * Compile a mask into tokens plus an anchored, case-insensitive RegExp whose
 * capture groups line up with the wildcard tokens. Throws on an empty or
 * wildcard-free mask (such a "pattern" would accept exactly one string — use an
 * exact checkpoint instead).
 *
 * @returns {{ tokens: Array, regex: RegExp, example: string, wildcards: number }}
 */
export function compileMask(mask) {
  const src = String(mask ?? '').trim();
  if (!src) throw new Error('Pattern is empty');
  if (src.length > LIMITS.pattern) throw new Error(`Pattern is too long (max ${LIMITS.pattern})`);
  const tokens = [];
  for (let i = 0; i < src.length; i += 1) {
    let ch = src[i];
    if (ch === '\\') {
      i += 1;
      if (i >= src.length) throw new Error('Pattern ends with a dangling backslash');
      ch = src[i];
      tokens.push({ kind: 'literal', ch, escaped: true });
      continue;
    }
    const cls = Object.prototype.hasOwnProperty.call(MASK_CLASSES, ch) ? MASK_CLASSES[ch] : null;
    if (cls) tokens.push({ kind: 'wild', ch, ...cls });
    else tokens.push({ kind: 'literal', ch });
  }
  const wildcards = tokens.filter((t) => t.kind === 'wild').length;
  if (!wildcards) {
    throw new Error('Pattern has no wildcards (9 A a X x ? *) — use an exact answer instead');
  }
  if (tokens.filter((t) => t.wild).length > 3) {
    throw new Error('Pattern may use * at most three times');
  }
  let re = '^';
  let example = '';
  const counters = {};
  for (const t of tokens) {
    if (t.kind === 'wild') {
      re += `(${t.re})`;
      const n = (counters[t.ch] = (counters[t.ch] || 0) + 1);
      example += t.examples[(n - 1) % t.examples.length];
    } else if (/\s/.test(t.ch)) {
      re += '\\s*';
      example += t.ch;
    } else if (t.escaped || /[A-Za-z0-9]/.test(t.ch)) {
      // Literal letters/digits and anything escaped are required
      // (case-insensitively). Escaping is how an author makes a separator
      // mandatory: `99\.99` demands the dot, `99.99` does not.
      re += reEscape(t.ch);
      example += t.ch;
    } else {
      // Punctuation separators are optional on input, canonical on output.
      re += `(?:${reEscape(t.ch)})?`;
      example += t.ch;
    }
  }
  re += '$';
  return { tokens, regex: new RegExp(re, 'i'), example, wildcards };
}

/**
 * Test a participant's entry against a mask. Returns the canonical value
 * (separators restored, casing applied) or null when it does not fit.
 */
export function matchMask(mask, input) {
  const { tokens, regex } = typeof mask === 'string' ? compileMask(mask) : mask;
  const m = regex.exec(String(input ?? '').trim());
  if (!m) return null;
  let out = '';
  let g = 1;
  for (const t of tokens) {
    if (t.kind !== 'wild') {
      out += t.ch;
      continue;
    }
    let v = String(m[g++] ?? '');
    if (t.case === 'upper') v = v.toUpperCase();
    else if (t.case === 'lower') v = v.toLowerCase();
    out += v;
  }
  return out;
}

/** Human-readable example for a mask, or '' when the mask is invalid. */
export function maskExample(mask) {
  try {
    return compileMask(mask).example;
  } catch {
    return '';
  }
}

/** Total number of steps across all sections. */
export function countSteps(sections) {
  return (sections || []).reduce((n, s) => n + ((s && s.steps && s.steps.length) || 0), 0);
}
