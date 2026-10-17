import { IMAGE_MD_RE, imageRefName, LIMITS } from '../../../shared/template-schema.js';
import { minutesInvalid } from './validateTemplate.js';
import { EXAM_LIMITS, normaliseExam, examErrors } from '../../../shared/exam-schema.js';

/**
 * Validate & normalise an instructor-authored EXAM payload (the counterpart of
 * validateTemplate.js for labs). Returns { kind, title, description, content,
 * variables: [] } in storage shape or throws a 400 listing every problem.
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
    serialised = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
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
    const n = Array.isArray(s?.questions) ? s.questions.length : 0;
    if (n > EXAM_LIMITS.questionsPerSection) {
      errors.push(
        `Section ${si + 1} has too many questions (max ${EXAM_LIMITS.questionsPerSection})`,
      );
    }
    (Array.isArray(s?.questions) ? s.questions : []).forEach((q, qi) => {
      if (Array.isArray(q?.options) && q.options.length > EXAM_LIMITS.options) {
        errors.push(
          `Section ${si + 1} · question ${qi + 1} has too many options (max ${EXAM_LIMITS.options})`,
        );
      }
    });
  });

  const exam = normaliseExam(payload);
  const content = exam.content.map(({ minutes, ...sec }) => ({
    ...sec,
    title: sec.title.trim(),
    ...(minutes ? { minutes } : {}),
    ...('body' in sec ? { body: sec.body.trim() } : {}),
    ...(sec.steps ? { steps: sec.steps.map((st) => ({ ...st, body: st.body.trim() })) } : {}),
    questions: sec.questions.map((q) => ({ ...q, prompt: q.prompt.trim() })),
  }));
  const clean = {
    kind: 'exam',
    title: exam.title.trim(),
    description: exam.description.trim(),
    content,
    variables: [],
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
      (sec.steps || []).forEach((st, sti) =>
        check([st.body, ...st.tasks], `Section ${si + 1} · step ${sti + 1}`),
      );
      sec.questions.forEach((q, qi) =>
        check([q.prompt, ...q.options], `Section ${si + 1} · question ${qi + 1}`),
      );
    });
  }

  if (errors.length) return fail(errors);
  return clean;
}

function fail(errors) {
  const err = new Error(errors.join('; '));
  err.status = 400;
  err.details = errors;
  throw err;
}
