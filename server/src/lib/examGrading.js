import { nowIso, secondsBetween } from './time.js';
import {
  listQuestions,
  gradeResponse,
  describeResponse,
  describeExpected,
  isManualQuestion,
  totalPoints,
  QUESTION_TYPES,
} from '../../../shared/exam-schema.js';

/**
 * Instructor-side grading for EXAM sessions: per-participant scores, the
 * per-question breakdown with expected answers, and class-wide question
 * statistics. Automatic questions (multiple choice, true/false, short answers
 * with an accepted list) are graded on the fly; anything else waits for — and
 * any question can be overridden by — a manual mark stored in
 * participants.grades as { key: { correct: 0|1, by, at } }.
 */

export function parseObject(json) {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
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
export function gradeParticipant(p, content) {
  const answers = parseObject(p.answers);
  const grades = parseObject(p.grades);
  return listQuestions(content).map(({ key, si, qi, number, q }) => {
    const value = answers[key];
    const g = gradeResponse(q, value, overrideOf(grades, key));
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
      ...g,
    };
  });
}

/** Score summary for one participant. */
export function examParticipantView(p, content) {
  const now = nowIso();
  const graded = gradeParticipant(p, content);
  const secondsSinceSeen = secondsBetween(p.last_seen_at, now);
  const score = graded.reduce((n, g) => n + g.points_awarded, 0);
  const maxScore = totalPoints(content);
  const submitted = Boolean(p.submitted_at);
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
    status: submitted ? 'submitted' : secondsSinceSeen < 90 ? 'active' : 'idle',
    total_seconds: secondsBetween(p.joined_at, p.submitted_at || now),
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
export function examParticipantDetail(p, content) {
  const view = examParticipantView(p, content);
  const history = parseArray(p.answer_log);
  const questions = listQuestions(content);
  const graded = gradeParticipant(p, content);
  return {
    ...view,
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
export function examQuestionStats(participants, content) {
  const graded = participants.map((p) => gradeParticipant(p, content));
  return listQuestions(content).map(({ key, si, number, q }, i) => {
    const rows = graded.map((g) => g[i]);
    const answered = rows.filter((r) => r.answered).length;
    const correct = rows.filter((r) => r.correct === true).length;
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
      pending: rows.filter((r) => r.pending).length,
      correct_pct: answered ? Math.round((correct / answered) * 100) : 0,
    };
  });
}

/** Every participant's response to one question (grade-by-question view). */
export function examQuestionResponses(participants, content, key) {
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
    points: entry.q.points,
    manual: isManualQuestion(entry.q),
    expected: describeExpected(entry.q),
    responses: participants.map((p) => {
      const g = gradeParticipant(p, content)[i];
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
