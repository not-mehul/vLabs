import { injectVariables } from '../../../shared/templating.js';
import {
  isSubmitSection,
  isQuestion,
  sectionItems,
  listQuestions,
  capturedValue,
} from '../../../shared/exam-schema.js';
import { jsonObject } from './json.js';
import { seatContext } from './seatContext.js';

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
  return seatContext(variables, p?.seat_number ?? 0, {
    firstName: p?.first_name ?? '',
    lastName: p?.last_name ?? '',
    images,
    captured,
  });
}

/** One section item with every placeholder resolved by `inject`. */
function itemForSeat(it, inject) {
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
}

const injector = (context) => (t) => injectVariables(String(t ?? ''), context);

/**
 * An exam's content with every placeholder resolved for one context, sections
 * of any version read as items (sectionItems).
 */
export function examForSeat(content, context) {
  const inject = injector(context);
  return (Array.isArray(content) ? content : []).map((sec) => {
    if (isSubmitSection(sec)) return { ...sec, title: inject(sec.title), body: inject(sec.body) };
    return {
      title: inject(sec.title),
      minutes: sec.minutes ?? null,
      items: sectionItems(sec).map((it) => itemForSeat(it, inject)),
    };
  });
}

/** The placeholder values one participant's exam is rendered with. */
const contextOf = (content, variables, p, images) =>
  examContext(variables, p, images, examCaptured(content, jsonObject(p?.answers)));

/** Shorthand: the exam as one participant sees it, with their saved answers. */
export const seatExam = (content, variables, p, images) =>
  examForSeat(content, contextOf(content, variables, p, images));

/** Item `ii` of section `si` as one participant sees it, without rendering the rest. */
export function seatItem(content, variables, p, si, ii) {
  const it = sectionItems(content?.[si])[ii];
  return it ? itemForSeat(it, injector(contextOf(content, variables, p))) : null;
}
