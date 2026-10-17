import { resolveVariables, injectVariables } from '../../../shared/templating.js';
import {
  isSubmitSection,
  isQuestion,
  sectionItems,
  listQuestions,
  capturedValue,
} from '../../../shared/exam-schema.js';

/**
 * Per-seat exams: an exam's {{ PLACEHOLDERS }} (its variables and the
 * built-ins SEAT_ID, FIRST_NAME, LAST_NAME, FULL_NAME) are resolved for each
 * participant exactly as a lab manual is (shared/templating.js), in everything
 * the participant reads and in the accepted answers used to grade them.
 *
 * A short question with `capture: NAME` saves the participant's answer as
 * {{ NAME }} for the sections after it (validation keeps it out of earlier
 * ones), like a lab checkpoint capture. Those sections are only delivered
 * once that answer is in, since a section unlocks when the one before it is
 * complete.
 */

const parseAnswers = (json) => {
  if (json && typeof json === 'object') return json;
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

/**
 * Answers saved as variables: name → this participant's answer ('' until
 * given; a pattern answer in the mask's canonical form).
 */
export function examCaptured(content, answers) {
  const out = {};
  for (const { key, q } of listQuestions(content)) {
    if (!q.capture || q.type !== 'short' || q.capture in out) continue;
    out[q.capture] = capturedValue(q, answers?.[key]);
  }
  return out;
}

/** The placeholder values for one participant (seat row or { seat_number, … }). */
export function examContext(variables, p, images, captured = {}) {
  const who = { firstName: p?.first_name ?? '', lastName: p?.last_name ?? '', images, captured };
  try {
    return resolveVariables(variables || [], p?.seat_number ?? 0, who);
  } catch {
    // Formulas are checked when the template is saved; never fail a seat on one.
    return resolveVariables([], p?.seat_number ?? 0, who);
  }
}

/**
 * An exam's content with every placeholder resolved for one context, sections
 * of any version read as items (sectionItems).
 */
export function examForSeat(content, context) {
  const inject = (t) => injectVariables(String(t ?? ''), context);
  return (Array.isArray(content) ? content : []).map((sec) => {
    if (isSubmitSection(sec)) return { ...sec, title: inject(sec.title), body: inject(sec.body) };
    return {
      title: inject(sec.title),
      minutes: sec.minutes ?? null,
      items: sectionItems(sec).map((it) => {
        if (!isQuestion(it)) {
          return {
            ...it,
            title: inject(it.title),
            body: inject(it.body),
            ...(Array.isArray(it.tasks) ? { tasks: it.tasks.map(inject) } : {}),
          };
        }
        return {
          ...it,
          prompt: inject(it.prompt),
          ...(Array.isArray(it.options) ? { options: it.options.map(inject) } : {}),
          // An accepted answer made of a saved answer not given yet accepts nothing.
          ...(Array.isArray(it.accepted)
            ? { accepted: it.accepted.map(inject).filter((a) => a.trim()) }
            : {}),
        };
      }),
    };
  });
}

/** Shorthand: the exam as one participant sees it, with their saved answers. */
export const seatExam = (content, variables, p, images) =>
  examForSeat(
    content,
    examContext(variables, p, images, examCaptured(content, parseAnswers(p?.answers))),
  );
