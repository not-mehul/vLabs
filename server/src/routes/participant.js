import { Router } from 'express';
import crypto from 'node:crypto';
import db from '../db/index.js';
import { requireParticipant } from '../middleware/auth.js';
import {
  joinFailLimiter,
  joinFloodLimiter,
  checkpointLimiter,
  contentLimiter,
  actionLimiter,
} from '../middleware/rateLimit.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { signParticipantToken } from '../lib/tokens.js';
import { nowIso, parseUtc } from '../lib/time.js';
import { log } from '../lib/logger.js';
import { imageUrlMap } from '../lib/images.js';
import { nextSeatNumber } from '../lib/seatSource.js';
import { labProgress } from '../lib/labProgress.js';
import { breaksOf, currentBreak, activeSecondsBetween } from '../lib/sectionTiming.js';
import {
  resolveVariables,
  matchCheckpoint,
  renderSection,
  isSectionCleared,
  computeUnlockedSection,
  computeSectionVisibleThrough,
  isStepReachable,
  checkpointKey,
  countSteps,
  injectVariables,
  stepHasCheckpoint,
} from '../lib/templating.js';

const router = Router();

const MAX_PARTICIPANTS = 100;

const q = {
  sessionByCode: db.prepare('SELECT * FROM sessions WHERE room_code = ? AND is_active = 1'),
  byName: db.prepare('SELECT * FROM participants WHERE session_id = ? AND name_key = ?'),
  byId: db.prepare('SELECT * FROM participants WHERE id = ?'),
  seatStats: db.prepare(
    'SELECT COALESCE(MAX(seat_number), 0) AS maxSeat, COUNT(*) AS count FROM participants WHERE session_id = ?',
  ),
  insert: db.prepare(
    `INSERT INTO participants
       (session_id, seat_number, first_name, last_name, name_key, section_entered_at, joined_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  // Presence heartbeat, written at most every TOUCH_EVERY_MS per seat: with
  // synchronous=FULL every write is an fsync, and status polls would otherwise
  // add a write per seat every 15 s for no information gain.
  touch: db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?'),
  setResume: db.prepare('UPDATE participants SET resume_hash = ? WHERE id = ?'),
  setCheckpoints: db.prepare(
    `UPDATE participants
        SET completed_checkpoints = ?, captured_values = ?, checkpoint_log = ?, last_seen_at = ?
      WHERE id = ?`,
  ),
  logAttempt: db.prepare(
    'UPDATE participants SET checkpoint_log = ?, last_seen_at = ? WHERE id = ?',
  ),
  setSection: db.prepare(
    `UPDATE participants
        SET current_section = ?, max_section = MAX(max_section, ?),
            section_times = ?, section_entered_at = ?, last_seen_at = ?
      WHERE id = ?`,
  ),
  complete: db.prepare(
    `UPDATE participants SET completed_at = ?, section_times = ?, last_seen_at = ?
      WHERE id = ? AND completed_at IS NULL`,
  ),
  setHints: db.prepare('UPDATE participants SET hints_taken = ?, last_seen_at = ? WHERE id = ?'),
  setRevealed: db.prepare(
    'UPDATE participants SET revealed_solutions = ?, last_seen_at = ? WHERE id = ?',
  ),
  finish: db.prepare('UPDATE participants SET finished_at = ?, last_seen_at = ? WHERE id = ?'),
};

/**
 * The manual a session renders from is the session's OWN snapshot (taken at
 * launch or when the instructor pushed a newer version) — never the live
 * template, so mid-class edits can't shift step indices under participants.
 */
function loadManual(session) {
  return {
    sections: JSON.parse(session.content || '[]'),
    variables: JSON.parse(session.variables || '[]'),
  };
}

/** No-store headers so rendered lab content is never cached to disk. */
function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
}

const TOUCH_EVERY_MS = 10_000;

/** Record presence (throttled; see q.touch). */
function touchSeat(id, now = nowIso()) {
  q.touch.run(now, id, new Date(Date.parse(now) - TOUCH_EVERY_MS).toISOString());
}

/**
 * The participant row as it is NOW. req.participant was loaded by the auth
 * guard before the (async) rate limiter ran; handlers that read-modify-write
 * JSON columns re-read it so two near-simultaneous requests from one seat can
 * never overwrite each other's change.
 */
const fresh = (req) => q.byId.get(req.participant.id) || req.participant;

/* Exam seats are bound to the device that joined via a random resume key. */
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newResumeKey = () => crypto.randomBytes(18).toString('base64url');
function resumeKeyMatches(key, hash) {
  if (!key || !hash) return false;
  const a = Buffer.from(sha256(key), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const parseIndex = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
};

const completedSetOf = (p) => new Set(JSON.parse(p.completed_checkpoints || '[]'));

/** Values captured at pattern checkpoints so far (name → canonical value). */
function capturedOf(p) {
  try {
    const v = JSON.parse(p.captured_values || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Checkpoint attempt log (newest last). Capped so a guessing seat can't grow it unbounded. */
const MAX_LOG = 200;
function logOf(p) {
  try {
    const v = JSON.parse(p.checkpoint_log || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Seconds spent per section on CLOSED visits ({ "0": 412 }). */
function sectionTimesOf(p) {
  try {
    const v = JSON.parse(p.section_times || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Fold the open visit (section_entered_at → now) into the per-section totals. */
function closeOpenVisit(p, times, now, breaks = []) {
  const key = String(p.current_section);
  // Break time (instructor-toggled, class-wide) never counts towards a section.
  times[key] = (Number(times[key]) || 0) + activeSecondsBetween(p.section_entered_at, now, breaks);
  return times;
}

/**
 * Record completion the moment the manual is cleared: freezes the clock
 * (total time = joined → completed) and lets the monitor show "Complete" even
 * if the participant keeps reviewing instead of pressing Finish.
 */
function markCompleted(p, now, breaks = []) {
  if (p.completed_at) return false;
  const times = closeOpenVisit(p, sectionTimesOf(p), now, breaks);
  const { changes } = q.complete.run(now, JSON.stringify(times), now, p.id);
  if (changes) {
    log.info('participant.completed', { participant: p.id, session: p.session_id });
    p.completed_at = now;
  }
  return Boolean(changes);
}

/** The participant's full placeholder context: seat, names, formulas, captures. */
function contextFor(p, variables) {
  return resolveVariables(variables, p.seat_number, {
    firstName: p.first_name,
    lastName: p.last_name,
    captured: capturedOf(p),
    images: imageUrlMap(),
  });
}

/** 400/403 unless (section, step) exists and is reachable for this seat. */
function requireReachableStep(sections, si, sti, completed) {
  if (Number.isNaN(si) || !sections[si]) throw httpError(400, 'Invalid section index');
  if (Number.isNaN(sti) || !sections[si].steps?.[sti]) throw httpError(400, 'Invalid step index');
  if (si > computeUnlockedSection(sections, completed)) throw httpError(403, 'Section is locked');
  if (!isStepReachable(sections, si, sti, completed)) throw httpError(403, 'Step is locked');
  return sections[si].steps[sti];
}

/* -------------------------------------------------------------------------- */
/*  Join (anonymous)                                                          */
/* -------------------------------------------------------------------------- */

// Assign the next seat number atomically inside a transaction so concurrent
// joins can never collide on a number. An exam linked to a lab session gives
// a matching name its lab seat (lib/seatSource.js).
//
// Resuming by name: lab seats resume on name alone (a documented trade-off —
// a lab seat holds nothing worth stealing). EXAM seats are bound to the device
// that took them by a resume key the client keeps in localStorage; rejoining
// that name without the key is refused until the instructor releases the
// seat (POST /sessions/:id/participants/:pid/release).
const registerParticipant = db.transaction((session, firstName, lastName, nameKey, resumeKey) => {
  const exam = session.kind === 'exam';
  const existing = q.byName.get(session.id, nameKey);
  if (existing) {
    let key = null;
    if (exam) {
      if (existing.resume_hash) {
        if (!resumeKeyMatches(resumeKey, existing.resume_hash)) {
          throw httpError(
            409,
            'This name is already taking the exam on another device. Ask your instructor to release your seat.',
            'SEAT_TAKEN',
          );
        }
        key = resumeKey;
      } else {
        key = newResumeKey();
        q.setResume.run(sha256(key), existing.id);
      }
    }
    touchSeat(existing.id);
    return { participant: q.byId.get(existing.id), resumed: true, resumeKey: key };
  }

  const { maxSeat, count } = q.seatStats.get(session.id);
  if (count >= MAX_PARTICIPANTS) {
    throw httpError(409, `This session is full (${MAX_PARTICIPANTS} participants max).`);
  }
  const seatNumber = nextSeatNumber(session, nameKey, maxSeat);
  const now = nowIso();
  const info = q.insert.run(session.id, seatNumber, firstName, lastName, nameKey, now, now, now);
  let key = null;
  if (exam) {
    key = newResumeKey();
    q.setResume.run(sha256(key), info.lastInsertRowid);
  }
  return { participant: q.byId.get(info.lastInsertRowid), resumed: false, resumeKey: key };
});

/**
 * POST /api/participant/join
 * Body: { room_code, first_name, last_name }
 *
 * Registers a participant by name and assigns the next ascending seat number
 * in join order (or, in an exam linked to a lab, their lab seat; at most 100
 * participants). Rejoining with the same name resumes the same seat
 * and progress, so a participant who closes their browser can come straight
 * back in. Returns a participant token plus lightweight session metadata —
 * never the manual body.
 */
router.post(
  '/join',
  joinFloodLimiter,
  joinFailLimiter,
  asyncHandler(async (req, res) => {
    const roomCode = String(req.body?.room_code || '').trim();
    const firstName = String(req.body?.first_name || '')
      .trim()
      .replace(/\s+/g, ' ');
    const lastName = String(req.body?.last_name || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!/^\d{6}$/.test(roomCode)) {
      throw httpError(400, 'Enter a valid 6-digit room code');
    }
    if (!firstName || firstName.length > 60) {
      throw httpError(400, 'Enter your first name');
    }
    if (!lastName || lastName.length > 60) {
      throw httpError(400, 'Enter your last name');
    }

    const session = q.sessionByCode.get(roomCode);
    // Uniform error for "wrong code" vs "expired" to avoid leaking which codes
    // exist (anti-enumeration).
    if (!session || parseUtc(session.expires_at) < Date.now()) {
      throw httpError(401, 'Invalid or expired room code');
    }

    const nameKey = `${firstName} ${lastName}`.toLowerCase();
    const resumeKeyIn =
      typeof req.body?.resume_key === 'string' ? req.body.resume_key.slice(0, 100) : '';
    let registered;
    try {
      registered = registerParticipant(session, firstName, lastName, nameKey, resumeKeyIn);
    } catch (err) {
      if (err.code === 'SEAT_TAKEN') {
        log.warn('participant.resume.refused', { session: session.id, ip: req.ip });
      }
      throw err;
    }
    const { participant, resumed, resumeKey } = registered;

    const sections = JSON.parse(session.content || '[]');
    const token = signParticipantToken(participant, session);
    log.info(resumed ? 'participant.resumed' : 'participant.joined', {
      session: session.id,
      participant: participant.id,
      seat: participant.seat_number,
    });
    noStore(res);
    res.json({
      token,
      resumed,
      // Exam seats only: keep this on the device to resume the same seat later.
      resume_key: resumeKey,
      seat_number: participant.seat_number,
      first_name: participant.first_name,
      last_name: participant.last_name,
      session: {
        kind: session.kind || 'lab',
        title: session.title,
        expires_at: session.expires_at,
        section_count: sections.length,
        step_count: session.kind === 'exam' ? 0 : countSteps(sections),
        template_version: session.template_version,
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/*  Everything below requires a live seat. Per-seat rate limiters are mounted */
/*  AFTER the guard so they can key on the verified participant id.           */
/* -------------------------------------------------------------------------- */
router.use(requireParticipant);

/**
 * Everything below except /status is LAB-only. Exam sessions are served by
 * routes/exam.js (mounted at /api/participant/exam, ahead of this router).
 */
router.use((req, res, next) => {
  if (req.path === '/status' || (req.session.kind || 'lab') === 'lab') return next();
  res.status(409).json({ error: 'This session is an exam', code: 'WRONG_KIND' });
});

/**
 * GET /api/participant/content
 * Returns ONLY the sections this seat has unlocked, rendered for the seat.
 * Within the furthest section, steps reveal progressively up to the first
 * uncompleted checkpoint. Checkpoint answers are stripped. This progressive
 * delivery is the anti-scraping / IP-protection core: a seat can never pull
 * sections it has not legitimately reached.
 */
router.get(
  '/content',
  contentLimiter,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const { sections, variables } = loadManual(req.session);
    const context = contextFor(p, variables);
    const completed = completedSetOf(p);
    const unlockedSection = computeUnlockedSection(sections, completed);

    touchSeat(p.id);

    const hintsTaken = new Set(JSON.parse(p.hints_taken || '[]'));
    const revealed = new Set(JSON.parse(p.revealed_solutions || '[]'));

    // Send sections 0..unlockedSection. Cleared sections send all steps; the
    // furthest (current) section reveals steps up to its first open checkpoint.
    const rendered = [];
    for (let s = 0; s <= unlockedSection && s < sections.length; s += 1) {
      const cleared = isSectionCleared(sections[s], s, completed);
      const stepLimit = cleared
        ? undefined
        : computeSectionVisibleThrough(sections[s], s, completed);
      const section = renderSection(sections[s], context, s, completed, stepLimit);
      section.cleared = cleared;

      // Augment each step with hint-taken state and step-level solution
      // metadata. A solution (if authored) can be revealed once every hint on
      // the step has been opened — vacuously true when the step has no hints —
      // and only ships to the browser once the participant reveals it.
      section.steps.forEach((step) => {
        const raw = sections[s].steps[step.index];
        step.hints = (step.hints || []).map((h, hi) => ({
          ...h,
          taken: hintsTaken.has(`${s}.${step.index}.${hi}`),
        }));
        if (raw.solution) {
          const allHintsTaken = step.hints.every((h) => h.taken);
          step.has_solution = true;
          step.solution_available = allHintsTaken;
          if (revealed.has(`${s}.${step.index}`)) {
            step.solution = injectVariables(String(raw.solution), context);
          }
        }
      });
      rendered.push(section);
    }

    // Progress for the bar and stepper — the same computation the instructor
    // monitor uses. Optional / wrap-up sections are flagged and not counted.
    const total = sections.length;
    const progress = labProgress(sections, p, completed);

    noStore(res);
    res.json({
      seat_number: p.seat_number,
      first_name: p.first_name,
      last_name: p.last_name,
      total_sections: total,
      unlocked_section: unlockedSection,
      current_section: Math.min(p.current_section, Math.max(total - 1, 0)),
      completed_sections: progress.completedCounting,
      counting_sections: progress.countingTotal,
      progress_pct: progress.progressPct,
      // Per section index: { optional, done } — titles of locked sections are
      // deliberately not included.
      section_flags: sections.map((_, i) => ({
        optional: progress.optional[i],
        done: progress.done[i],
      })),
      completed_checkpoints: [...completed],
      completed: progress.complete,
      finished: Boolean(p.finished_at),
      expires_at: req.session.expires_at,
      // Lets the client correct its countdown for device clock skew.
      server_time: nowIso(),
      on_break: Boolean(currentBreak(breaksOf(req.session))),
      template_version: req.session.template_version,
      sections: rendered,
    });
  }),
);

/**
 * POST /api/participant/checkpoint
 * Body: { section_index, step_index, answer }
 * Validates the entry server-side — against the seat-specific answer(s) for an
 * exact checkpoint, or against the authored mask for a pattern checkpoint —
 * and, on success, records completion (which may clear the section and unlock
 * the next). When the checkpoint captures a variable, the canonical value is
 * stored so later steps can reference it as {{ NAME }}.
 */
router.post(
  '/checkpoint',
  checkpointLimiter,
  asyncHandler(async (req, res) => {
    const p = fresh(req);
    const si = parseIndex(req.body?.section_index);
    const sti = parseIndex(req.body?.step_index);
    const answer = req.body?.answer;
    if (typeof answer !== 'string' || answer.length > 500) {
      throw httpError(400, 'Answer must be a short string');
    }

    const { sections, variables } = loadManual(req.session);
    const completed = completedSetOf(p);
    const step = requireReachableStep(sections, si, sti, completed);
    if (!stepHasCheckpoint(step)) throw httpError(400, 'This step has no checkpoint');

    const context = contextFor(p, variables);
    const key = checkpointKey(si, sti);
    const now = nowIso();
    // Already cleared? Idempotent success; don't log a duplicate attempt.
    if (completed.has(key)) {
      noStore(res);
      return res.json({
        correct: true,
        section_cleared: isSectionCleared(sections[si], si, completed),
        unlocked_section: computeUnlockedSection(sections, completed),
      });
    }
    const { ok, value } = matchCheckpoint(step, context, answer);

    // Attempt log for the instructor's per-participant view (what was typed,
    // right or wrong). Bounded length; the text is capped too.
    const entries = logOf(p);
    entries.push({ k: key, a: answer.trim().slice(0, 200), ok: ok ? 1 : 0, at: now });
    const trimmed = entries.slice(-MAX_LOG);

    noStore(res);
    if (!ok) {
      q.logAttempt.run(JSON.stringify(trimmed), now, p.id);
      log.debug('checkpoint.wrong', { participant: p.id, section: si, step: sti });
      return res.status(200).json({ correct: false });
    }

    completed.add(key);
    const captured = capturedOf(p);
    if (step.checkpoint.capture && value !== null) captured[step.checkpoint.capture] = value;
    q.setCheckpoints.run(
      JSON.stringify([...completed]),
      JSON.stringify(captured),
      JSON.stringify(trimmed),
      now,
      p.id,
    );
    log.info('checkpoint.cleared', {
      participant: p.id,
      session: req.session.id,
      section: si,
      step: sti,
    });
    if (labProgress(sections, p, completed, si).complete) {
      markCompleted(p, now, breaksOf(req.session));
    }
    res.json({
      correct: true,
      section_cleared: isSectionCleared(sections[si], si, completed),
      unlocked_section: computeUnlockedSection(sections, completed),
      completed: Boolean(p.completed_at),
    });
  }),
);

/**
 * POST /api/participant/progress
 * Body: { section_index }
 * Records the section a seat is actively viewing (drives instructor analytics:
 * time-on-section and section distribution).
 */
router.post(
  '/progress',
  actionLimiter,
  asyncHandler(async (req, res) => {
    const p = fresh(req);
    const si = parseIndex(req.body?.section_index);
    const { sections } = loadManual(req.session);
    if (Number.isNaN(si) || si >= sections.length) throw httpError(400, 'Invalid section index');
    const completed = completedSetOf(p);
    if (si > computeUnlockedSection(sections, completed)) throw httpError(403, 'Section is locked');

    const now = nowIso();
    if (si !== p.current_section) {
      // Close the visit to the section being left (time-per-section analytics),
      // then move. max_section is a monotonic high-water mark so progress never
      // drops when a participant navigates back to review an earlier section.
      // Once complete the clock is frozen: later visits are not accumulated.
      const times = p.completed_at
        ? sectionTimesOf(p)
        : closeOpenVisit(p, sectionTimesOf(p), now, breaksOf(req.session));
      q.setSection.run(si, si, JSON.stringify(times), now, now, p.id);
      p.current_section = si;
      p.section_entered_at = now;
      p.max_section = Math.max(p.max_section, si);
    } else {
      touchSeat(p.id, now);
    }
    // Reaching a checkpoint-free last counting section is what completes such a manual.
    if (labProgress(sections, p, completed).complete) markCompleted(p, now, breaksOf(req.session));
    res.json({ current_section: si, completed: Boolean(p.completed_at) });
  }),
);

/**
 * POST /api/participant/hint
 * Body: { section_index, step_index, hint_index }
 * Records that a participant opened a hint (drives "hints taken" analytics and
 * gates the reveal-solution feature). The step must be reachable — the same
 * gate every other participant action applies.
 */
router.post(
  '/hint',
  actionLimiter,
  asyncHandler(async (req, res) => {
    const p = fresh(req);
    const si = parseIndex(req.body?.section_index);
    const sti = parseIndex(req.body?.step_index);
    const hi = parseIndex(req.body?.hint_index);
    const { sections } = loadManual(req.session);
    const completed = completedSetOf(p);
    const step = requireReachableStep(sections, si, sti, completed);
    if (Number.isNaN(hi) || !step.hints || hi >= step.hints.length) {
      throw httpError(400, 'Invalid hint');
    }
    const taken = new Set(JSON.parse(p.hints_taken || '[]'));
    taken.add(`${si}.${sti}.${hi}`);
    q.setHints.run(JSON.stringify([...taken]), nowIso(), p.id);
    res.json({ ok: true, hints_taken: taken.size });
  }),
);

/**
 * POST /api/participant/solution
 * Body: { section_index, step_index }
 * Reveals a step's authored markdown solution — but ONLY once every hint on
 * that step has been opened (vacuously satisfied when the step has no hints).
 * Until then the solution never leaves the server.
 */
router.post(
  '/solution',
  contentLimiter,
  asyncHandler(async (req, res) => {
    const p = fresh(req);
    const si = parseIndex(req.body?.section_index);
    const sti = parseIndex(req.body?.step_index);
    const { sections, variables } = loadManual(req.session);
    const completed = completedSetOf(p);
    const step = requireReachableStep(sections, si, sti, completed);
    if (!step.solution) throw httpError(404, 'No solution authored for this step');

    const taken = new Set(JSON.parse(p.hints_taken || '[]'));
    const allTaken = (step.hints || []).every((_, hi) => taken.has(`${si}.${sti}.${hi}`));
    if (!allTaken) throw httpError(403, 'Open all hints before revealing the solution');

    const revealed = new Set(JSON.parse(p.revealed_solutions || '[]'));
    revealed.add(`${si}.${sti}`);
    q.setRevealed.run(JSON.stringify([...revealed]), nowIso(), p.id);

    const context = contextFor(p, variables);
    const solution = injectVariables(String(step.solution), context);
    log.info('solution.revealed', {
      participant: p.id,
      session: req.session.id,
      section: si,
      step: sti,
    });
    noStore(res);
    res.json({ solution });
  }),
);

/**
 * POST /api/participant/finish
 * Marks the participant as finished (idempotent) — only once the lab is
 * complete (optional / wrap-up sections are not required). Powers the
 * completion screen and the instructor "finished" status.
 */
router.post(
  '/finish',
  actionLimiter,
  asyncHandler(async (req, res) => {
    const p = fresh(req);
    const { sections } = loadManual(req.session);
    const completed = completedSetOf(p);
    // Require genuine completion: every counting section cleared and reached.
    if (!labProgress(sections, p, completed).complete) {
      throw httpError(400, 'Lab is not complete yet');
    }

    const now = nowIso();
    markCompleted(p, now, breaksOf(req.session));
    if (!p.finished_at) {
      q.finish.run(now, now, p.id);
      log.info('participant.finished', { participant: p.id, session: req.session.id });
    }
    res.json({ finished: true });
  }),
);

/**
 * GET /api/participant/status
 * Lightweight liveness poll. Doubles as the presence heartbeat (updates
 * last_seen_at) and lets the client keep the countdown fresh (instructor "+30"),
 * detect session-end and notice a pushed template version WITHOUT re-pulling
 * the whole rendered manual on every tick. requireParticipant already 403s a
 * terminated/expired session, so a 200 here means "still live".
 */
router.get('/status', contentLimiter, (req, res) => {
  const p = req.participant;
  const now = nowIso();
  touchSeat(p.id, now);
  noStore(res);
  res.json({
    session_active: true,
    kind: req.session.kind || 'lab',
    expires_at: req.session.expires_at,
    server_time: now,
    on_break: Boolean(currentBreak(breaksOf(req.session))),
    completed: Boolean(p.completed_at),
    finished: Boolean(p.finished_at),
    submitted: Boolean(p.submitted_at),
    template_version: req.session.template_version,
    // Exams: the instructor can change the seat (and so its values) mid-exam.
    seat_number: p.seat_number,
  });
});

export default router;
