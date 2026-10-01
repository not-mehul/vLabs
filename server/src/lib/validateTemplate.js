import {
  LIMITS,
  IDENT_RE,
  normaliseTemplate,
  findUnknownPlaceholders,
} from '../../../shared/template-schema.js';
import { resolveVariables } from './templating.js';

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
export function validateTemplatePayload(payload) {
  const errors = [];

  // Size guard first: the JSON body limit in app.js is the hard ceiling, this
  // gives a readable message well before it.
  let serialised = 0;
  try {
    serialised = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
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
          `Section ${si + 1} · step ${i + 1} has too many alternative answers (max ${LIMITS.altAnswers})`,
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
  const variables = [];
  const seenNames = new Set();
  for (const [i, v] of tpl.variables.entries()) {
    if (!v.name) {
      errors.push(`Variable #${i + 1} is missing a name`);
      continue;
    }
    if (!IDENT_RE.test(v.name)) {
      errors.push(`Variable "${v.name}" has an invalid name`);
      continue;
    }
    if (v.name === 'SEAT_ID' || v.name === 'seat') {
      errors.push(`Variable "${v.name}" is reserved`);
      continue;
    }
    if (seenNames.has(v.name)) {
      errors.push(`Variable "${v.name}" is declared more than once`);
      continue;
    }
    seenNames.add(v.name);
    if (!v.expression) {
      errors.push(`Variable "${v.name}" has no formula`);
      continue;
    }
    variables.push({ name: v.name, expression: v.expression });
  }
  // Every formula must evaluate for a sample seat (and compose in order).
  if (errors.length === 0) {
    try {
      resolveVariables(variables, 1);
    } catch (err) {
      errors.push(err.message);
    }
  }

  // ---- Sections & steps --------------------------------------------------
  if (tpl.content.length === 0) errors.push('At least one section is required');

  const content = tpl.content.map((section, si) => {
    const clean = { title: section.title.trim(), steps: [] };
    if (!clean.title) errors.push(`Section ${si + 1} needs a title`);
    if (section.steps.length === 0) {
      errors.push(`Section ${si + 1} ("${clean.title || 'untitled'}") has no steps`);
    }
    clean.steps = section.steps.map((s, i) => toStorageStep(s, si, i, errors));
    return clean;
  });

  // ---- Placeholder references --------------------------------------------
  for (const { name, where } of findUnknownPlaceholders({ variables, content })) {
    errors.push(`Unknown placeholder {{ ${name} }} in ${where}`);
  }

  if (errors.length) return fail(errors);
  return { title, description, content, variables };
}

/** Convert a canonical step into storage shape, collecting rule violations. */
function toStorageStep(s, sectionIndex, stepIndex, errors) {
  const at = `Section ${sectionIndex + 1} · step ${stepIndex + 1}`;
  const step = {
    type: s.type,
    title: s.title.trim(),
    body: s.body,
    hints: s.hints.map((h) => ({ label: h.label.trim() || 'Hint', text: h.text })),
    solution: s.solution,
  };
  if (!step.body.trim()) errors.push(`${at} has an empty body`);

  if (s.checkpoint) {
    step.checkpoint = {
      prompt: s.checkpoint.prompt || 'Enter the value to continue',
      placeholder: s.checkpoint.placeholder,
      answer: s.checkpoint.answer,
    };
    if (s.checkpoint.answers.length) step.checkpoint.answers = s.checkpoint.answers;
  }
  return step;
}

function fail(errors) {
  const err = new Error(errors.join('; '));
  err.status = 400;
  err.details = errors;
  throw err;
}
