import { IMAGE_MD_RE, imageRefName, LIMITS, assignItemIds } from './template-schema.js';
import {
  minutesInvalid,
  optionalInvalid,
  cleanVariables,
  utf8Bytes,
  fail,
} from './validate-template.js';
import {
  EXAM_LIMITS,
  normaliseExam,
  examErrors,
  sectionItems,
  sectionLayout,
} from './exam-schema.js';

/**
 * Validate & normalise an instructor-authored EXAM payload (the counterpart of
 * validate-template.js for labs). Returns { kind, title, description, content,
 * variables } in storage shape or throws a 400 listing every problem.
 *
 * @param {object} payload
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.imageNames] library names; when given, every
 *        `![…](name.png)` reference in a prompt or option must be one of them.
 */
export function validateExamPayload(payload, opts = {}) {
  const errors = [];
  let serialised = 0;
  try {
    serialised = utf8Bytes(JSON.stringify(payload ?? null));
  } catch {
    errors.push('Exam payload is not serialisable');
  }
  if (serialised > EXAM_LIMITS.serialisedBytes) {
    errors.push(`Exam is too large (max ${Math.round(EXAM_LIMITS.serialisedBytes / 1024)} kB)`);
    return fail(errors);
  }

  // Raw counts before normalisation silently truncates to the caps.
  const rawSections = Array.isArray(payload?.content) ? payload.content : [];
  if (rawSections.length > EXAM_LIMITS.sections) {
    errors.push(`Too many sections (max ${EXAM_LIMITS.sections})`);
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
    const items = sectionItems(s);
    if (items.length > EXAM_LIMITS.itemsPerSection) {
      errors.push(
        `Section ${si + 1} has too many questions and steps (max ${EXAM_LIMITS.itemsPerSection})`,
      );
    }
    items.forEach((it, ii) => {
      if (Array.isArray(it?.options) && it.options.length > EXAM_LIMITS.options) {
        errors.push(
          `Section ${si + 1} · item ${ii + 1} has too many options (max ${EXAM_LIMITS.options})`,
        );
      }
      if (Array.isArray(it?.tasks) && it.tasks.length > EXAM_LIMITS.tasks) {
        errors.push(
          `Section ${si + 1} · item ${ii + 1} has too many checklist items (max ${EXAM_LIMITS.tasks})`,
        );
      }
    });
  });

  const exam = normaliseExam(payload);
  const content = exam.content.map(({ minutes, optional, ...sec }) => ({
    ...sec,
    title: sec.title.trim(),
    ...(minutes ? { minutes } : {}),
    ...(optional ? { optional: true } : {}),
    ...('body' in sec ? { body: sec.body.trim() } : {}),
    ...(sec.items
      ? {
          items: sec.items.map((it) =>
            'prompt' in it ? { ...it, prompt: it.prompt.trim() } : { ...it, body: it.body.trim() },
          ),
        }
      : {}),
  }));
  if ((payload?.variables?.length || 0) > LIMITS.variables) {
    errors.push(`Too many variables (max ${LIMITS.variables})`);
  }
  // Per-seat variables follow the lab rules exactly.
  const { variables } = cleanVariables(exam.variables, errors);
  const clean = {
    kind: 'exam',
    title: exam.title.trim(),
    description: exam.description.trim(),
    content,
    variables,
  };
  errors.push(...examErrors(clean));

  if (opts.imageNames) {
    const have = new Set([...opts.imageNames].map((n) => String(n).toLowerCase()));
    const missing = new Set();
    const check = (texts, where) => {
      for (const text of texts) {
        for (const m of String(text).matchAll(IMAGE_MD_RE)) {
          const name = imageRefName(m[2]);
          if (!name || have.has(name.toLowerCase()) || missing.has(name)) continue;
          missing.add(name);
          errors.push(
            `Image "${name}" referenced in ${where} is not in the image library — upload it first`,
          );
        }
      }
    };
    content.forEach((sec, si) => {
      check([sec.body || ''], `Section ${si + 1}`);
      for (const at of sectionLayout(sec, si)) {
        const it = at.item;
        const where = `Section ${si + 1} · ${'qi' in at ? 'question' : 'step'} ${at.n}`;
        check('qi' in at ? [it.prompt, ...it.options] : [it.body, ...(it.tasks || [])], where);
      }
    });
  }

  if (errors.length) return fail(errors);
  assignItemIds(clean.content, (sec) => sec.items);
  return clean;
}
