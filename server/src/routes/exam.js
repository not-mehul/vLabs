import { Router } from 'express';
import db from '../db/index.js';
import { requireParticipant } from '../middleware/auth.js';
import { actionLimiter, contentLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { nowIso } from '../lib/time.js';
import { log } from '../lib/logger.js';
import { imageUrlMap } from '../lib/images.js';
import { injectImages } from '../lib/templating.js';
import {
  QUESTION_TYPES,
  listQuestions,
  publicQuestion,
  describeResponse,
  isAnswered,
} from '../../../shared/exam-schema.js';

/**
 * Participant side of EXAM sessions, mounted at /api/participant/exam.
 *
 * Unlike labs there is no gating: the whole exam is delivered at once, without
 * correct answers or accepted-answer lists, and participants are never told
 * whether a response was right. Responses autosave (one row per participant,
 * latest value per question) with every change appended to a capped log, and
 * are locked once the exam is submitted or the session ends.
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
  submit: db.prepare(
    `UPDATE participants SET submitted_at = ?, completed_at = COALESCE(completed_at, ?),
            finished_at = COALESCE(finished_at, ?), last_seen_at = ?
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

/** Stored responses, keeping only keys that still exist in the session's exam. */
function answersOf(p, questions) {
  const all = parseObject(p.answers);
  const out = {};
  for (const { key } of questions) if (key in all) out[key] = all[key];
  return out;
}

/**
 * GET /api/participant/exam
 * The whole exam for this seat (no answers), plus their saved responses.
 */
router.get(
  '/',
  contentLimiter,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const content = JSON.parse(req.session.content || '[]');
    const questions = listQuestions(content);
    const images = imageUrlMap();
    const now = nowIso();
    touch(p.id, now);

    let n = 0;
    const sections = content.map((sec, si) => ({
      index: si,
      title: sec.title,
      questions: (sec.questions || []).map((question, qi) => {
        n += 1;
        const pub = publicQuestion(question);
        return {
          ...pub,
          key: `${si}.${qi}`,
          index: qi,
          number: n,
          prompt: injectImages(pub.prompt, images),
          ...(pub.options ? { options: pub.options.map((o) => injectImages(o, images)) } : {}),
        };
      }),
    }));

    noStore(res);
    res.json({
      seat_number: p.seat_number,
      first_name: p.first_name,
      last_name: p.last_name,
      title: req.session.title,
      expires_at: req.session.expires_at,
      server_time: now,
      template_version: req.session.template_version,
      question_count: questions.length,
      submitted: Boolean(p.submitted_at),
      submitted_at: p.submitted_at,
      answers: answersOf(p, questions),
      sections,
    });
  }),
);

/**
 * PUT /api/participant/exam/answer
 * Body: { key: "section.question", value } — value null clears the response.
 * Shapes: single → option index, multiple → array of indices, truefalse →
 * boolean, short / long → text. Refused once the exam has been submitted.
 */
router.put(
  '/answer',
  actionLimiter,
  asyncHandler(async (req, res) => {
    // Re-read: the guard loaded the row before the async rate limiter ran.
    const p = q.byId.get(req.participant.id) || req.participant;
    if (p.submitted_at) throw httpError(409, 'This exam has already been submitted', 'SUBMITTED');
    const key = String(req.body?.key ?? '');
    const content = JSON.parse(req.session.content || '[]');
    const questions = listQuestions(content);
    const entry = questions.find((x) => x.key === key);
    if (!entry) throw httpError(400, 'Unknown question');

    const raw = req.body?.value;
    const value =
      raw === null || raw === undefined
        ? null
        : QUESTION_TYPES[entry.q.type].normaliseResponse(raw, entry.q);

    const answers = parseObject(p.answers);
    const before = JSON.stringify(answers[key] ?? null);
    if (isAnswered(value)) answers[key] = value;
    else delete answers[key];
    const now = nowIso();
    if (before === JSON.stringify(answers[key] ?? null)) {
      touch(p.id, now);
      noStore(res);
      return res.json({ ok: true, saved_at: now });
    }

    recordAnswer(p, answers, key, describeResponse(entry.q, value).slice(0, 500), now);
    noStore(res);
    res.json({ ok: true, saved_at: now });
  }),
);

/**
 * POST /api/participant/exam/submit
 * Hands the exam in (idempotent). Responses are locked from then on; the
 * participant is not shown a score.
 */
router.post('/submit', actionLimiter, (req, res) => {
  const p = q.byId.get(req.participant.id) || req.participant;
  const now = nowIso();
  const { changes } = q.submit.run(now, now, now, now, p.id);
  if (changes) {
    const answered = Object.keys(parseObject(p.answers)).length;
    log.info('exam.submitted', { participant: p.id, session: req.session.id, answered });
  }
  noStore(res);
  res.json({ submitted: true, submitted_at: p.submitted_at || now });
});

export default router;
