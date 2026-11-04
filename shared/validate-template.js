import {
  LIMITS,
  IDENT_RE,
  normaliseTemplate,
  normaliseMinutes,
  findUnknownPlaceholders,
  findMissingImages,
  compileMask,
  optionalFlag,
  assignItemIds,
} from './template-schema.js';
import { resolveVariables, RESERVED_NAMES, FUNCTION_NAMES } from './templating.js';

/** UTF-8 size of a string (Node and browsers: the Studio runs this file too). */
export const utf8Bytes = (s) => new TextEncoder().encode(s).length;

const SAMPLE_WHO = { firstName: 'Sample', lastName: 'Participant' };

/**
 * Seats every formula is evaluated for on save: a session takes at most 100
 * participants, numbered from 1. Checking seat 1 alone let `10 / (seat - 2)`
 * save, then fail participant #2's every page load.
 */
const CHECKED_SEATS = 100;

/**
 * Validate & normalise instructor-authored template payloads before they hit
 * the database.
 *
 * Shape coercion is delegated to the shared `normaliseTemplate` (the same
 * function the editor and importer use), so this file only has to express
 * the RULES: required fields, structural caps, formulas that evaluate, and —
 * new — that every `{{ PLACEHOLDER }}` in the template refers to a declared
 * variable or a built-in. Previously a typo such as `{{ HOST_IPP }}` in a
 * checkpoint answer produced an unpassable checkpoint that only surfaced if
 * the author happened to preview it.
 *
 * Returns a clean { title, description, content, variables } object in the
 * server's STORAGE shape (steps without a checkpoint omit the key entirely;
 * `answers` is only present when non-empty) or throws a 400 Error listing
 * every problem found.
 */
/**
 * @param {object} payload
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.imageNames] names in the image library; when
 *        given, every static `![…](name.png)` reference must be one of them.
 */
export function validateTemplatePayload(payload, opts = {}) {
  const errors = [];

  // Size guard first: the JSON body limit in app.js is the hard ceiling, this
  // gives a readable message well before it.
  let serialised = 0;
  try {
    serialised = utf8Bytes(JSON.stringify(payload ?? null));
  } catch {
    errors.push('Template payload is not serialisable');
  }
  if (serialised > LIMITS.serialisedBytes) {
    errors.push(
      `Template is too large (${Math.round(serialised / 1024)} kB; max ${Math.round(
        LIMITS.serialisedBytes / 1024,
      )} kB)`,
    );
    return fail(errors);
  }

  // Raw counts BEFORE normalisation (which silently truncates to the caps) so
  // the author is told rather than losing content.
  const rawVars = Array.isArray(payload?.variables) ? payload.variables : [];
  const rawSections = Array.isArray(payload?.content) ? payload.content : [];
  if (rawVars.length > LIMITS.variables) {
    errors.push(`Too many variables (max ${LIMITS.variables})`);
  }
  if (rawSections.length > LIMITS.sections) {
    errors.push(`Too many sections (max ${LIMITS.sections})`);
  }
  rawSections.forEach((s, si) => {
    if (minutesInvalid(s?.minutes)) {
      errors.push(
        `Section ${si + 1} time allocated must be a whole number of minutes from 1 to ${LIMITS.sectionMinutes} (or empty)`,
      );
    }
    if (optionalInvalid(s?.optional)) {
      errors.push(`Section ${si + 1} optional must be true or false`);
    }
    const n = Array.isArray(s?.steps) ? s.steps.length : 0;
    if (n > LIMITS.stepsPerSection) {
      errors.push(`Section ${si + 1} has too many steps (max ${LIMITS.stepsPerSection})`);
    }
    (Array.isArray(s?.steps) ? s.steps : []).forEach((st, i) => {
      const h = Array.isArray(st?.hints) ? st.hints.length : 0;
      if (h > LIMITS.hintsPerStep) {
        errors.push(
          `Section ${si + 1} · step ${i + 1} has too many hints (max ${LIMITS.hintsPerStep})`,
        );
      }
      const alts = Array.isArray(st?.checkpoint?.answers) ? st.checkpoint.answers.length : 0;
      if (alts > LIMITS.altAnswers) {
        errors.push(
          `Section ${si + 1} · step ${i + 1} has too many accepted answers (max ${LIMITS.acceptedAnswers}, the answer included)`,
        );
      }
    });
  });

  const tpl = normaliseTemplate(payload);

  // ---- Title / description ----------------------------------------------
  const title = tpl.title.trim();
  if (!title) errors.push('Title is required');
  const description = tpl.description.trim();

  // ---- Variables ---------------------------------------------------------
  const { variables, names: seenNames } = cleanVariables(tpl.variables, errors);

  // ---- Sections & steps --------------------------------------------------
  if (tpl.content.length === 0) errors.push('At least one section is required');

  const captures = new Map(); // name -> where first captured
  const content = tpl.content.map((section, si) => {
    const clean = {
      ...(section.id ? { id: section.id } : {}),
      title: section.title.trim(),
      steps: [],
    };
    // Storage shape: `minutes` only when set (keeps older consumers unaffected).
    if (section.minutes) clean.minutes = section.minutes;
    if (section.optional) clean.optional = true;
    if (!clean.title) errors.push(`Section ${si + 1} needs a title`);
    if (section.steps.length === 0) {
      errors.push(`Section ${si + 1} ("${clean.title || 'untitled'}") has no steps`);
    }
    clean.steps = section.steps.map((s, i) => toStorageStep(s, si, i, errors, seenNames, captures));
    return clean;
  });

  // ---- Placeholder references --------------------------------------------
  for (const { name, where, early } of findUnknownPlaceholders({ variables, content })) {
    errors.push(
      early
        ? `{{ ${name} }} is used in ${where} before the checkpoint that captures it (captured values are available from the following step onward)`
        : `Unknown placeholder {{ ${name} }} in ${where}`,
    );
  }

  // ---- Image references ----------------------------------------------------
  if (opts.imageNames) {
    for (const { name, where } of findMissingImages({ content }, opts.imageNames)) {
      errors.push(
        `Image "${name}" referenced in ${where} is not in the image library — upload it first`,
      );
    }
  }

  if (errors.length) return fail(errors);
  return { title, description, content: assignItemIds(content, (s) => s.steps), variables };
}

/**
 * Problems with a template's variables (labs and exams alike), each with the
 * variable's position: names valid, not reserved, unique, each with a
 * formula; then, once the names are sound, every formula evaluating for every
 * seat 1–100 in order (later ones may use earlier ones). Only the first
 * failing formula is reported, for the first seat it fails: the ones after it
 * would only fail because of it. The Studio shows these at each variable.
 *
 * @param {Array<{name:string, expression:string}>} list normalised variables
 * @returns {Array<{ index: number, name: string, message: string }>}
 */
export function variableIssues(list) {
  const issues = [];
  const names = new Set();
  const formulas = [];
  for (const [index, v] of (list || []).entries()) {
    const name = String(v?.name ?? '').trim();
    const expression = String(v?.expression ?? '').trim();
    const issue = (message) => issues.push({ index, name, message });
    if (!name) issue(`Variable #${index + 1} is missing a name`);
    else if (!IDENT_RE.test(name)) issue(`Variable "${name}" has an invalid name`);
    else if (RESERVED_NAMES.includes(name)) issue(`Variable "${name}" is reserved`);
    else if (names.has(name)) issue(`Variable "${name}" is declared more than once`);
    else {
      names.add(name);
      if (!expression) issue(`Variable "${name}" has no formula`);
      else formulas.push({ index, name, expression });
    }
  }
  if (issues.length) return issues;

  for (let seat = 1; seat <= CHECKED_SEATS; seat += 1) {
    let first = null;
    resolveVariables(formulas, seat, {
      ...SAMPLE_WHO,
      onError: (name, err) => {
        first ??= { name, err };
      },
    });
    if (!first) continue;
    const { index, name } = formulas.find((f) => f.name === first.name);
    const prefix = `Error in variable "${name}": `;
    const reason = first.err.message.startsWith(prefix)
      ? first.err.message.slice(prefix.length)
      : first.err.message;
    issues.push({
      index,
      name,
      message:
        seat === 1
          ? `${prefix}${reason}`
          : `Error in variable "${name}" for seat ${seat}: ${reason}`,
    });
    break;
  }
  return issues;
}

/**
 * Check a template's variables (variableIssues). Pushes problems onto
 * `errors`; returns the usable list and the set of declared names.
 */
export function cleanVariables(list, errors) {
  const issues = variableIssues(list);
  errors.push(...issues.map((i) => i.message));
  const names = new Set();
  const variables = [];
  for (const v of list || []) {
    const name = String(v?.name ?? '').trim();
    if (!IDENT_RE.test(name) || RESERVED_NAMES.includes(name) || names.has(name)) continue;
    names.add(name);
    const expression = String(v?.expression ?? '').trim();
    if (expression) variables.push({ name, expression });
  }
  return { variables, names };
}

/**
 * Convert a canonical step into storage shape, collecting rule violations.
 * Storage shape keeps only the keys that apply: exact checkpoints carry
 * `answer` (+ `answers`), pattern checkpoints carry `mode: 'pattern'` +
 * `pattern`; `capture` is present only when set. Info steps carry no hints,
 * solution or checkpoint (the normaliser already stripped them).
 */
function toStorageStep(s, sectionIndex, stepIndex, errors, variableNames, captures) {
  const at = `Section ${sectionIndex + 1} · step ${stepIndex + 1}`;
  const step = {
    ...(s.id ? { id: s.id } : {}),
    type: s.type,
    title: s.title.trim(),
    body: s.body,
    hints: s.hints.map((h) => ({ label: h.label.trim() || 'Hint', text: h.text })),
    solution: s.solution,
  };
  if (!step.body.trim()) errors.push(`${at} has an empty body`);

  if (s.checkpoint) {
    const cp = s.checkpoint;
    step.checkpoint = {
      prompt: cp.prompt || 'Enter the value to continue',
      placeholder: cp.placeholder,
    };
    if (cp.mode === 'pattern') {
      step.checkpoint.mode = 'pattern';
      step.checkpoint.pattern = cp.pattern;
      try {
        compileMask(cp.pattern);
      } catch (err) {
        errors.push(`${at} checkpoint pattern: ${err.message}`);
      }
    } else {
      step.checkpoint.answer = cp.answer;
      if (cp.answers.length) step.checkpoint.answers = cp.answers;
    }
    if (cp.capture) {
      const name = cp.capture;
      if (!IDENT_RE.test(name)) {
        errors.push(`${at} checkpoint: "${name}" is not a valid variable name`);
      } else if (RESERVED_NAMES.includes(name) || FUNCTION_NAMES.includes(name)) {
        errors.push(`${at} checkpoint: variable name "${name}" is reserved`);
      } else if (variableNames.has(name)) {
        errors.push(`${at} checkpoint: "${name}" is already a declared variable`);
      } else if (captures.has(name)) {
        errors.push(`${at} checkpoint: "${name}" is already captured by ${captures.get(name)}`);
      } else {
        captures.set(name, at);
        step.checkpoint.capture = name;
      }
    }
  }
  return step;
}

/** An optional value that was given but is not true or false. */
export function optionalInvalid(v) {
  return optionalFlag(v) === null;
}

/** A minutes value that was given but is not a valid allocation. */
export function minutesInvalid(v) {
  return v !== undefined && v !== null && v !== '' && normaliseMinutes(v) === null;
}

/** Throw the 400 a save is refused with, listing every problem. */
export function fail(errors) {
  const err = new Error(errors.join('; '));
  err.status = 400;
  err.details = errors;
  throw err;
}
