import { resolveVariables, injectVariables } from './templating.js';
import { sectionType, infoSteps, listQuestions } from '../../../shared/exam-schema.js';

/**
 * Per-seat exams: an exam's {{ PLACEHOLDERS }} (its variables and the
 * built-ins SEAT_ID, FIRST_NAME, LAST_NAME, FULL_NAME) are resolved for each
 * participant exactly as a lab manual is (lib/templating.js), in everything
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

/** Answers saved as variables: name → this participant's answer ('' until given). */
export function examCaptured(content, answers) {
  const out = {};
  for (const { key, q } of listQuestions(content)) {
    if (!q.capture || q.type !== 'short' || q.capture in out) continue;
    const v = answers?.[key];
    out[q.capture] = typeof v === 'string' ? v.trim() : '';
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

/** An exam's content with every placeholder resolved for one context. */
export function examForSeat(content, context) {
  const inject = (t) => injectVariables(String(t ?? ''), context);
  return (Array.isArray(content) ? content : []).map((sec) => {
    const out = { ...sec, title: inject(sec.title) };
    if (sectionType(sec) === 'info') {
      delete out.body;
      delete out.tasks;
      out.steps = infoSteps(sec).map((st) => ({
        ...st,
        title: inject(st.title),
        body: inject(st.body),
        tasks: (st.tasks || []).map(inject),
      }));
    } else if ('body' in sec) {
      out.body = inject(sec.body);
    }
    out.questions = (sec.questions || []).map((q) => ({
      ...q,
      prompt: inject(q.prompt),
      ...(Array.isArray(q.options) ? { options: q.options.map(inject) } : {}),
      // An accepted answer made of a saved answer not given yet accepts nothing.
      ...(Array.isArray(q.accepted)
        ? { accepted: q.accepted.map(inject).filter((a) => a.trim()) }
        : {}),
    }));
    return out;
  });
}

/** Shorthand: the exam as one participant sees it, with their saved answers. */
export const seatExam = (content, variables, p, images) =>
  examForSeat(
    content,
    examContext(variables, p, images, examCaptured(content, parseAnswers(p?.answers))),
  );
