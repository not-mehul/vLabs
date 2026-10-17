import db from '../db/index.js';
import { nowIso, secondsBetween } from './time.js';
import {
  activeSecondsBetween,
  sectionSecondsView,
  timeStatus,
  allocatedSeconds,
} from './sectionTiming.js';
import {
  listQuestions,
  gradeResponse,
  describeResponse,
  describeExpected,
  isManualQuestion,
  totalPoints,
  QUESTION_TYPES,
  isSubmitSection,
  isExamSectionComplete,
} from '../../../shared/exam-schema.js';
import { isOptionalSection } from '../../../shared/lab-progress.js';
import { visitedSections } from './labProgress.js';
import { seatExam } from './examSeat.js';

/**
 * Instructor-side grading for EXAM sessions: per-participant scores, the
 * per-question breakdown with expected answers, and class-wide question
 * statistics. Automatic questions (multiple choice, true/false, short answers
 * with an accepted list) are graded on the fly; anything else waits for — and
 * any question can be overridden by — a manual mark stored in
 * participants.grades as { key: { correct: 0|1 | points: N, comment?, by, at } }
 * (points: a partial mark; comment: the marker's note, never shown to
 * participants). Each participant
 * is graded against their own seat's exam (`variables`: the session's
 * per-seat formulas), so accepted answers may use {{ PLACEHOLDERS }}.
 */

export function parseObject(json) {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const eventsOf = db.prepare(
  `SELECT question_key AS k, response AS a, at FROM exam_answer_events
    WHERE participant_id = ? ORDER BY id`,
);
const eventsOfSession = db.prepare(
  `SELECT e.question_key AS k, e.response AS a, e.at, p.seat_number, p.first_name, p.last_name
     FROM exam_answer_events e JOIN participants p ON p.id = e.participant_id
    WHERE p.session_id = ? ORDER BY e.at, p.seat_number, e.id`,
);

/** Every answer change for one participant, oldest first: { k, a, at }. */
export function answerHistory(participantId) {
  return eventsOf.all(participantId);
}

/** Every answer change across a session, in time order (for exports). */
export function sessionAnswerLog(sessionId) {
  return eventsOfSession.all(sessionId).map((e) => ({
    at: e.at,
    number: e.seat_number,
    name: `${e.first_name} ${e.last_name}`.trim(),
    question: e.k,
    response: e.a,
  }));
}

export function parseArray(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const overrideOf = (grades, key) => {
  const g = grades[key];
  if (!g || (g.correct !== 0 && g.correct !== 1)) return undefined;
  return g.correct === 1;
};

/** Every question graded for one participant, in exam order. */
export function gradeParticipant(p, content, variables = []) {
  const answers = parseObject(p.answers);
  const grades = parseObject(p.grades);
  return listQuestions(seatExam(content, variables, p)).map(({ key, si, qi, number, q }) => {
    const value = answers[key];
    const mark = grades[key];
    const g = gradeResponse(q, value, overrideOf(grades, key), mark?.points ?? null);
    return {
      key,
      section_index: si,
      question_index: qi,
      number,
      type: q.type,
      points: q.points,
      manual: isManualQuestion(q),
      value: value ?? null,
      response: describeResponse(q, value),
      marked_by: grades[key]?.by ?? null,
      marked_at: grades[key]?.at ?? null,
      comment: grades[key]?.comment ?? null,
      ...g,
    };
  });
}

/**
 * One participant's progress through an EXAM, on the same model as a lab's
 * (lib/labProgress.js). A section is DONE once the participant has opened it
 * and every question in it is answered and every checklist item ticked; the
 * submit section is done once they submit. Progress is the share of counting
 * sections done: the submit section and optional sections are left out, and
 * submitting does not complete sections that were left unfinished.
 */
export function examProgress(content, p) {
  const sections = Array.isArray(content) ? content : [];
  const answers = parseObject(p.answers);
  const visited = visitedSections(p);
  const submitted = Boolean(p.submitted_at);
  const done = sections.map((sec, i) =>
    isSubmitSection(sec)
      ? submitted
      : visited.has(i) && isExamSectionComplete(sections, i, answers),
  );
  const parts = sections.map((_, i) => i).filter((i) => !isSubmitSection(sections[i]));
  const required = parts.filter((i) => !isOptionalSection(sections[i]));
  const counting = required.length ? required : parts;
  const completedCounting = counting.filter((i) => done[i]).length;
  return {
    done,
    optional: sections.map((sec, i) => !isSubmitSection(sec) && !counting.includes(i)),
    countingTotal: counting.length,
    completedCounting,
    progressPct: counting.length ? Math.round((completedCounting / counting.length) * 100) : 0,
  };
}

/** Score summary for one participant. */
export function examParticipantView(p, content, breaks = [], variables = []) {
  const now = nowIso();
  const graded = gradeParticipant(p, content, variables);
  const secondsSinceSeen = secondsBetween(p.last_seen_at, now);
  const score = graded.reduce((n, g) => n + g.points_awarded, 0);
  const maxScore = totalPoints(content);
  const submitted = Boolean(p.submitted_at);
  // Section progress and timing, as for labs: placed at the furthest section
  // opened; a section is done once opened and finished (examProgress).
  const count = content.length;
  const progress = examProgress(content, p);
  const furthest = Math.min(p.max_section || 0, Math.max(count - 1, 0));
  const sectionSeconds = sectionSecondsView(p, count, { now, breaks, frozen: submitted });
  const onFurthest = submitted ? 0 : sectionSeconds[furthest] || 0;
  const allocated = allocatedSeconds(content[furthest]);
  return {
    id: p.id,
    seat_number: p.seat_number,
    first_name: p.first_name,
    last_name: p.last_name,
    name: `${p.first_name} ${p.last_name}`.trim(),
    answered: graded.filter((g) => g.answered).length,
    question_count: graded.length,
    correct_count: graded.filter((g) => g.correct === true).length,
    pending_count: graded.filter((g) => g.pending).length,
    score,
    max_score: maxScore,
    score_pct: maxScore ? Math.round((score / maxScore) * 100) : 0,
    // Provisional while answers still await a manual mark.
    fully_graded: graded.every((g) => !g.pending),
    submitted,
    submitted_at: p.submitted_at,
    // Handed in by the session ending, not by the participant.
    auto_submitted: submitted && Boolean(p.auto_submitted),
    status: submitted ? 'submitted' : secondsSinceSeen < 90 ? 'active' : 'idle',
    complete: submitted,
    furthest_section: furthest,
    current_section: p.current_section,
    sections_done: progress.done,
    completed_sections: progress.completedCounting,
    counting_sections: progress.countingTotal,
    progress_pct: progress.progressPct,
    section_seconds: sectionSeconds,
    seconds_on_furthest_section: onFurthest,
    allocated_seconds: allocated,
    time_status: submitted ? 'ok' : timeStatus(onFurthest, allocated),
    total_seconds: activeSecondsBetween(p.joined_at, p.submitted_at || now, breaks),
    joined_at: p.joined_at,
    last_seen_at: p.last_seen_at,
    seconds_since_seen: secondsSinceSeen,
  };
}

/**
 * Everything the instructor's participant drawer needs: each question with the
 * prompt, options, expected answer, the response, the automatic verdict, any
 * manual mark, and the history of changes to that answer.
 */
export function examParticipantDetail(p, content, breaks = [], variables = []) {
  const view = examParticipantView(p, content, breaks, variables);
  const history = answerHistory(p.id);
  // Prompts and expected answers as this participant saw them.
  const questions = listQuestions(seatExam(content, variables, p));
  const graded = gradeParticipant(p, content, variables);
  return {
    ...view,
    section_times: content.map((sec, i) => ({
      index: i,
      title: sec.title || `Section ${i + 1}`,
      seconds: view.section_seconds[i] || 0,
      minutes: sec.minutes || null,
      current: !view.submitted && p.current_section === i,
      done: view.sections_done[i],
    })),
    questions: graded.map((g, i) => {
      const q = questions[i].q;
      return {
        ...g,
        section_title: content[g.section_index]?.title || `Section ${g.section_index + 1}`,
        prompt: q.prompt,
        options: QUESTION_TYPES[q.type].hasOptions ? q.options : [],
        correct_option: q.type === 'single' || q.type === 'multiple' ? q.correct : null,
        expected: describeExpected(q),
        history: history.filter((e) => e.k === g.key).map((e) => ({ response: e.a, at: e.at })),
      };
    }),
  };
}

/** Class-wide statistics per question (answered / correct / awaiting marking). */
export function examQuestionStats(participants, content, variables = []) {
  const perParticipant = participants.map((p) => gradeParticipant(p, content, variables));
  return listQuestions(content).map(({ key, si, number, q }, i) => {
    const rows = perParticipant.map((g) => g[i]);
    const answered = rows.filter((r) => r.answered).length;
    const correct = rows.filter((r) => r.correct === true).length;
    const pending = rows.filter((r) => r.pending).length;
    // Responses with a verdict (automatic or marked); pending ones are excluded
    // from the correct rate until marked.
    const graded = answered - pending;
    return {
      key,
      number,
      section_index: si,
      section_title: content[si]?.title || `Section ${si + 1}`,
      type: q.type,
      type_label: QUESTION_TYPES[q.type].label,
      prompt: q.prompt,
      points: q.points,
      manual: isManualQuestion(q),
      expected: describeExpected(q),
      answered,
      correct,
      pending,
      graded,
      correct_pct: graded ? Math.round((correct / graded) * 100) : 0,
    };
  });
}

/** Every participant's response to one question (grade-by-question view). */
export function examQuestionResponses(participants, content, key, variables = []) {
  const all = listQuestions(content);
  const i = all.findIndex((x) => x.key === key);
  if (i < 0) return null;
  const entry = all[i];
  return {
    key,
    number: entry.number,
    section_title: content[entry.si]?.title || `Section ${entry.si + 1}`,
    type: entry.q.type,
    type_label: QUESTION_TYPES[entry.q.type].label,
    prompt: entry.q.prompt,
    options: QUESTION_TYPES[entry.q.type].hasOptions ? entry.q.options : [],
    correct_option:
      entry.q.type === 'single' || entry.q.type === 'multiple' ? entry.q.correct : null,
    points: entry.q.points,
    manual: isManualQuestion(entry.q),
    expected: describeExpected(entry.q),
    responses: participants.map((p) => {
      const g = gradeParticipant(p, content, variables)[i];
      return {
        participant_id: p.id,
        seat_number: p.seat_number,
        name: `${p.first_name} ${p.last_name}`.trim(),
        submitted: Boolean(p.submitted_at),
        ...g,
      };
    }),
  };
}
