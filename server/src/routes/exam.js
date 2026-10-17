import { Router } from 'express';
import db from '../db/index.js';
import { requireParticipant } from '../middleware/auth.js';
import { actionLimiter, contentLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { nowIso } from '../lib/time.js';
import { log } from '../lib/logger.js';
import { imageUrlMap } from '../lib/images.js';
import { seatExam } from '../lib/examSeat.js';
import { injectImages } from '../lib/templating.js';
import { breaksOf, currentBreak, activeSecondsBetween } from '../lib/sectionTiming.js';
import {
  QUESTION_TYPES,
  listQuestions,
  publicQuestion,
  describeResponse,
  isAnswered,
  examUnlockedSection,
  isExamSectionComplete,
  listTasks,
  sectionTasks,
  infoSteps,
  taskKey,
  sectionType,
} from '../../../shared/exam-schema.js';

/**
 * Participant side of EXAM sessions, mounted at /api/participant/exam.
 *
 * Sections unlock like a lab's: a section opens once every question in the
 * sections before it has an answer and every checklist item (informational
 * sections) is ticked — unticking one locks what follows again — and locked
 * sections are never sent (nor can they be answered).
 * Ticks are stored with the answers, under "<section>.t<item>" keys. Participants may move freely back through what they
 * have unlocked. Correct answers and accepted-answer lists never leave the
 * server, and participants are never told whether a response was right.
 * Responses autosave (latest value per question on the seat, every change as a
 * row in exam_answer_events). Time per section is tracked like a lab's (breaks
 * excluded). Once the exam is SUBMITTED nothing more is served: no questions,
 * no answers — the participant cannot go back and review.
 */
const router = Router();
router.use(requireParticipant);
router.use((req, res, next) => {
  if (req.session.kind === 'exam') return next();
  res.status(409).json({ error: 'This session is not an exam', code: 'WRONG_KIND' });
});

/** History rows kept per question per seat (oldest dropped beyond this). */
const MAX_EVENTS_PER_QUESTION = 200;
const TOUCH_EVERY_MS = 10_000;

const q = {
  byId: db.prepare('SELECT * FROM participants WHERE id = ?'),
  saveAnswers: db.prepare('UPDATE participants SET answers = ?, last_seen_at = ? WHERE id = ?'),
  // Presence heartbeat, at most every TOUCH_EVERY_MS (each write is an fsync).
  touch: db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?'),
  logEvent: db.prepare(
    'INSERT INTO exam_answer_events (participant_id, question_key, response, at) VALUES (?, ?, ?, ?)',
  ),
  trimEvents: db.prepare(
    `DELETE FROM exam_answer_events
      WHERE participant_id = ? AND question_key = ? AND id NOT IN (
        SELECT id FROM exam_answer_events WHERE participant_id = ? AND question_key = ?
         ORDER BY id DESC LIMIT ${MAX_EVENTS_PER_QUESTION})`,
  ),
  countEvents: db.prepare(
    'SELECT COUNT(*) AS n FROM exam_answer_events WHERE participant_id = ? AND question_key = ?',
  ),
  setSection: db.prepare(
    `UPDATE participants
        SET current_section = ?, max_section = MAX(max_section, ?),
            section_times = ?, section_entered_at = ?, last_seen_at = ?
      WHERE id = ?`,
  ),
  // Submitting stops the clock: the open section visit is closed into
  // section_times at the same moment.
  submit: db.prepare(
    `UPDATE participants SET submitted_at = ?, completed_at = COALESCE(completed_at, ?),
            finished_at = COALESCE(finished_at, ?), section_times = ?, last_seen_at = ?
      WHERE id = ? AND submitted_at IS NULL`,
  ),
};

const parseObject = (json) => {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

function touch(id, now) {
  q.touch.run(now, id, new Date(Date.parse(now) - TOUCH_EVERY_MS).toISOString());
}

/** Fold the open section visit into section_times (breaks excluded). */
function closeOpenVisit(p, now, breaks) {
  const times = parseObject(p.section_times);
  const key = String(p.current_section);
  times[key] = (Number(times[key]) || 0) + activeSecondsBetween(p.section_entered_at, now, breaks);
  return times;
}

/** Store one answer change: latest value on the seat, history as one small row. */
const recordAnswer = db.transaction((p, answers, key, response, now) => {
  q.saveAnswers.run(JSON.stringify(answers), now, p.id);
  q.logEvent.run(p.id, key, response, now);
  if (q.countEvents.get(p.id, key).n > MAX_EVENTS_PER_QUESTION) {
    q.trimEvents.run(p.id, key, p.id, key);
  }
});

function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
}

const contentOf = (session) => JSON.parse(session.content || '[]');
const variablesOf = (session) => {
  try {
    const v = JSON.parse(session.variables || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const unlockedFor = (content, p) =>
  examUnlockedSection(content, parseObject(p.answers), p.max_section);

/**
 * GET /api/participant/exam
 * The unlocked sections (no correct answers) and this seat's saved responses
 * to them. After submission: only the confirmation, no questions or answers.
 */
router.get(
  '/',
  contentLimiter,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    // This seat's exam: {{ PLACEHOLDERS }} resolved as in a lab manual.
    const content = seatExam(contentOf(req.session), variablesOf(req.session), p);
    const questions = listQuestions(content);
    const now = nowIso();
    touch(p.id, now);
    const all = parseObject(p.answers);
    const base = {
      seat_number: p.seat_number,
      first_name: p.first_name,
      last_name: p.last_name,
      title: req.session.title,
      expires_at: req.session.expires_at,
      server_time: now,
      on_break: Boolean(currentBreak(breaksOf(req.session))),
      template_version: req.session.template_version,
      question_count: questions.length,
      total_sections: content.length,
      // -1 for sessions launched before exams had a submit section.
      submit_section: content.findIndex((sec) => sectionType(sec) === 'submit'),
      submitted: Boolean(p.submitted_at),
      submitted_at: p.submitted_at,
    };
    noStore(res);

    if (p.submitted_at) {
      // No review after handing in: counts only.
      return res.json({
        ...base,
        answered_count: questions.filter(({ key }) => isAnswered(all[key])).length,
        unlocked_section: null,
        current_section: null,
        sections: [],
        answers: {},
      });
    }

    const unlocked = unlockedFor(content, p);
    const images = imageUrlMap();
    let n = 0;
    const sections = [];
    content.forEach((sec, si) => {
      const delivered = si <= unlocked;
      const type = sectionType(sec);
      const block = {
        index: si,
        type,
        title: sec.title,
        complete: isExamSectionComplete(content, si, all),
        questions: [],
      };
      if (delivered && type !== 'questions') {
        if (type === 'info') {
          // Checklist items are numbered across the steps (see taskKey).
          const tasks = sectionTasks(sec);
          block.steps = infoSteps(sec).map((st, sti) => ({
            title: st.title || '',
            body: injectImages(st.body || '', images),
            tasks: tasks
              .filter((t) => t.sti === sti)
              .map((t) => ({ key: taskKey(si, t.ti), text: injectImages(t.text, images) })),
          }));
        } else {
          block.body = injectImages(sec.body || '', images);
          block.review = sec.review !== false;
        }
      }
      (sec.questions || []).forEach((question, qi) => {
        n += 1;
        if (!delivered) return;
        const pub = publicQuestion(question);
        block.questions.push({
          ...pub,
          key: `${si}.${qi}`,
          index: qi,
          number: n,
          prompt: injectImages(pub.prompt, images),
          ...(pub.options ? { options: pub.options.map((o) => injectImages(o, images)) } : {}),
        });
      });
      if (delivered) sections.push(block);
    });
    const answers = {};
    for (const { key, si } of [...questions, ...listTasks(content)]) {
      if (si <= unlocked && key in all) answers[key] = all[key];
    }

    res.json({
      ...base,
      answered_count: questions.filter(({ key }) => isAnswered(all[key])).length,
      unlocked_section: unlocked,
      current_section: Math.min(p.current_section, unlocked),
      sections,
      answers,
    });
  }),
);

/**
 * PUT /api/participant/exam/answer
 * Body: { key: "section.question", value } — value null clears the response.
 * Shapes: single → option index, multiple → array of indices, truefalse →
 * boolean, short / long → text. A checklist item ("section.tN") takes true
 * (ticked) or null / false (unticked). Refused for a locked section and once
 * the exam has been submitted. Returns the (possibly newly) unlocked section.
 */
router.put(
  '/answer',
  actionLimiter,
  asyncHandler(async (req, res) => {
    // Re-read: the guard loaded the row before the async rate limiter ran.
    const p = q.byId.get(req.participant.id) || req.participant;
    if (p.submitted_at) throw httpError(409, 'This exam has already been submitted', 'SUBMITTED');
    const key = String(req.body?.key ?? '');
    const content = contentOf(req.session);
    const entry =
      listQuestions(content).find((x) => x.key === key) ||
      listTasks(content).find((x) => x.key === key);
    if (!entry) throw httpError(400, 'Unknown question');
    if (entry.si > unlockedFor(content, p)) throw httpError(403, 'Section is locked');

    const raw = req.body?.value;
    let value = null;
    if (!entry.q) value = raw === true ? true : null;
    else if (raw !== null && raw !== undefined) {
      value = QUESTION_TYPES[entry.q.type].normaliseResponse(raw, entry.q);
    }

    const answers = parseObject(p.answers);
    const before = JSON.stringify(answers[key] ?? null);
    if (isAnswered(value)) answers[key] = value;
    else delete answers[key];
    const now = nowIso();
    const unlocked = examUnlockedSection(content, answers, p.max_section);
    noStore(res);
    if (before === JSON.stringify(answers[key] ?? null)) {
      touch(p.id, now);
      return res.json({ ok: true, saved_at: now, unlocked_section: unlocked });
    }
    const logged = entry.q
      ? describeResponse(entry.q, value).slice(0, 500)
      : value
        ? 'Ticked'
        : 'Unticked';
    recordAnswer(p, answers, key, logged, now);
    res.json({
      ok: true,
      saved_at: now,
      unlocked_section: unlocked,
      section_complete: isExamSectionComplete(content, entry.si, answers),
    });
  }),
);

/**
 * POST /api/participant/exam/progress
 * Body: { section_index } — the section being viewed. Drives time-per-section
 * (breaks excluded) and the furthest-section high-water mark, exactly like a
 * lab. Only unlocked sections; ignored after submission.
 */
router.post(
  '/progress',
  actionLimiter,
  asyncHandler(async (req, res) => {
    const p = q.byId.get(req.participant.id) || req.participant;
    const si = Number(req.body?.section_index);
    const content = contentOf(req.session);
    if (!Number.isInteger(si) || si < 0 || si >= content.length) {
      throw httpError(400, 'Invalid section index');
    }
    if (p.submitted_at) return res.json({ current_section: null, submitted: true });
    if (si > unlockedFor(content, p)) throw httpError(403, 'Section is locked');
    const now = nowIso();
    if (si !== p.current_section) {
      const times = closeOpenVisit(p, now, breaksOf(req.session));
      q.setSection.run(si, si, JSON.stringify(times), now, now, p.id);
    } else {
      touch(p.id, now);
    }
    res.json({ current_section: si });
  }),
);

/**
 * POST /api/participant/exam/submit
 * Hands the exam in (idempotent). Responses are locked and no longer served;
 * the participant is not shown a score. The section clock stops here.
 */
router.post('/submit', actionLimiter, (req, res) => {
  const p = q.byId.get(req.participant.id) || req.participant;
  const now = nowIso();
  const times = p.submitted_at
    ? parseObject(p.section_times)
    : closeOpenVisit(p, now, breaksOf(req.session));
  const { changes } = q.submit.run(now, now, now, JSON.stringify(times), now, p.id);
  if (changes) {
    const all = parseObject(p.answers);
    const answered = listQuestions(contentOf(req.session)).filter(({ key }) =>
      isAnswered(all[key]),
    ).length;
    log.info('exam.submitted', { participant: p.id, session: req.session.id, answered });
  }
  noStore(res);
  res.json({ submitted: true, submitted_at: p.submitted_at || now });
});

export default router;
