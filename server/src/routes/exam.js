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

const MAX_LOG = 1000;

const q = {
  saveAnswers: db.prepare(
    'UPDATE participants SET answers = ?, answer_log = ?, last_seen_at = ? WHERE id = ?',
  ),
  touch: db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?'),
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
const parseArray = (json) => {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

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
    q.touch.run(nowIso(), p.id);

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
    const p = req.participant;
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
      q.touch.run(now, p.id);
      noStore(res);
      return res.json({ ok: true, saved_at: now });
    }

    const log_ = parseArray(p.answer_log);
    log_.push({ k: key, a: describeResponse(entry.q, value).slice(0, 500), at: now });
    q.saveAnswers.run(JSON.stringify(answers), JSON.stringify(log_.slice(-MAX_LOG)), now, p.id);
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
  const p = req.participant;
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
