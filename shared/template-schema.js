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
 *       type: 'desk' | 'computer',
 *       title: string,
 *       body: string,                         // Markdown, may contain {{ VARS }}
 *       hints: [{ label: string, text: string }],
 *       solution: string,                     // Markdown, '' when none
 *       checkpoint: null | {
 *         prompt: string,
 *         placeholder: string,
 *         answer: string,                     // primary expected answer
 *         answers: string[],                  // additional accepted answers
 *       },
 *     }],
 *   }],
 * }
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
  /** Serialised JSON size of a whole template (bytes). */
  serialisedBytes: 900_000,
});

/** Valid identifier for variable names and placeholders. */
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Mustache-style placeholder: {{ NAME }} */
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Placeholders that are always available without an explicit formula. */
export const BUILTIN_PLACEHOLDERS = Object.freeze(['SEAT_ID']);

export const STEP_TYPES = Object.freeze(['desk', 'computer']);

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

/** Normalise a checkpoint object; returns null when there is no usable answer. */
export function normaliseCheckpoint(cp) {
  if (!cp || typeof cp !== 'object') return null;
  const answer = str(cp.answer, LIMITS.answer).trim();
  if (!answer) return null;
  const rawAlts = Array.isArray(cp.answers) ? cp.answers : [];
  const answers = rawAlts
    .map((a) => str(a, LIMITS.answer).trim())
    .filter((a) => a && a !== answer)
    .filter((a, i, arr) => arr.indexOf(a) === i)
    .slice(0, LIMITS.altAnswers);
  return {
    prompt: str(cp.prompt, LIMITS.prompt).trim(),
    placeholder: str(cp.placeholder, LIMITS.placeholder).trim(),
    answer,
    answers,
  };
}

/** Normalise a single step into canonical shape. */
export function normaliseStep(st) {
  const s = st && typeof st === 'object' ? st : {};
  return {
    type: s.type === 'computer' ? 'computer' : 'desk',
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
 * human-readable location. Used by placeholder validation on both sides.
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
      }
    }
  }
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
  const out = [];
  const seen = new Set();
  for (const { where, text } of templateTextFields(tpl)) {
    for (const name of placeholdersIn(text)) {
      if (known.has(name)) continue;
      const key = `${name}@${where}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, where });
    }
  }
  return out;
}

/** Total number of steps across all sections. */
export function countSteps(sections) {
  return (sections || []).reduce((n, s) => n + ((s && s.steps && s.steps.length) || 0), 0);
}
