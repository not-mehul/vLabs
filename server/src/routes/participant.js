import { Router } from 'express';
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
  touch: db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?'),
  setCheckpoints: db.prepare(
    `UPDATE participants
        SET completed_checkpoints = ?, captured_values = ?, last_seen_at = ?
      WHERE id = ?`,
  ),
  setSection: db.prepare(
    `UPDATE participants
        SET current_section = ?, max_section = MAX(max_section, ?),
            section_entered_at = ?, last_seen_at = ?
      WHERE id = ?`,
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

/** The participant's full placeholder context: seat, names, formulas, captures. */
function contextFor(p, variables) {
  return resolveVariables(variables, p.seat_number, {
    firstName: p.first_name,
    lastName: p.last_name,
    captured: capturedOf(p),
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
// joins can never collide on a number.
const registerParticipant = db.transaction((session, firstName, lastName, nameKey) => {
  const existing = q.byName.get(session.id, nameKey);
  if (existing) {
    q.touch.run(nowIso(), existing.id);
    return { participant: existing, resumed: true };
  }

  const { maxSeat, count } = q.seatStats.get(session.id);
  if (count >= MAX_PARTICIPANTS) {
    throw httpError(409, `This session is full (${MAX_PARTICIPANTS} participants max).`);
  }
  const seatNumber = maxSeat + 1;
  const now = nowIso();
  const info = q.insert.run(session.id, seatNumber, firstName, lastName, nameKey, now, now, now);
  return { participant: q.byId.get(info.lastInsertRowid), resumed: false };
});

/**
 * POST /api/participant/join
 * Body: { room_code, first_name, last_name }
 *
 * Registers a participant by name and assigns the next ascending seat number
 * (1-100) in join order. Rejoining with the same name resumes the same seat
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
    const { participant, resumed } = registerParticipant(session, firstName, lastName, nameKey);

    const { sections } = loadManual(session);
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
      seat_number: participant.seat_number,
      first_name: participant.first_name,
      last_name: participant.last_name,
      session: {
        title: session.title,
        expires_at: session.expires_at,
        section_count: sections.length,
        step_count: countSteps(sections),
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

    q.touch.run(nowIso(), p.id);

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

    // Monotonic completed-section count for the progress bar (mirrors the
    // instructor analytics in sessions.js).
    const total = sections.length;
    let completedSections = Math.min(p.max_section, total);
    if (
      total > 0 &&
      p.max_section >= total - 1 &&
      isSectionCleared(sections[total - 1], total - 1, completed)
    ) {
      completedSections = total;
    }

    noStore(res);
    res.json({
      seat_number: p.seat_number,
      first_name: p.first_name,
      last_name: p.last_name,
      total_sections: total,
      unlocked_section: unlockedSection,
      current_section: Math.min(p.current_section, Math.max(total - 1, 0)),
      completed_sections: completedSections,
      progress_pct: total > 0 ? Math.round((completedSections / total) * 100) : 0,
      completed_checkpoints: [...completed],
      finished: Boolean(p.finished_at),
      expires_at: req.session.expires_at,
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
    const p = req.participant;
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
    const { ok, value } = matchCheckpoint(step, context, answer);

    noStore(res);
    if (!ok) {
      log.debug('checkpoint.wrong', { participant: p.id, section: si, step: sti });
      return res.status(200).json({ correct: false });
    }

    completed.add(checkpointKey(si, sti));
    const captured = capturedOf(p);
    if (step.checkpoint.capture && value !== null) captured[step.checkpoint.capture] = value;
    q.setCheckpoints.run(JSON.stringify([...completed]), JSON.stringify(captured), nowIso(), p.id);
    log.info('checkpoint.cleared', {
      participant: p.id,
      session: req.session.id,
      section: si,
      step: sti,
    });
    res.json({
      correct: true,
      section_cleared: isSectionCleared(sections[si], si, completed),
      unlocked_section: computeUnlockedSection(sections, completed),
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
    const p = req.participant;
    const si = parseIndex(req.body?.section_index);
    const { sections } = loadManual(req.session);
    if (Number.isNaN(si) || si >= sections.length) throw httpError(400, 'Invalid section index');
    const completed = completedSetOf(p);
    if (si > computeUnlockedSection(sections, completed)) throw httpError(403, 'Section is locked');

    if (si !== p.current_section) {
      const now = nowIso();
      // max_section is a monotonic high-water mark so progress never drops when
      // a participant navigates back to review an earlier section.
      q.setSection.run(si, si, now, now, p.id);
    } else {
      q.touch.run(nowIso(), p.id);
    }
    res.json({ current_section: si });
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
    const p = req.participant;
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
    const p = req.participant;
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
 * Marks the participant as finished (idempotent) — only once every section is
 * complete. Powers the completion screen and the instructor "finished" status.
 */
router.post(
  '/finish',
  actionLimiter,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const { sections } = loadManual(req.session);
    const completed = completedSetOf(p);
    const total = sections.length;
    // Require genuine completion: max_section reached the end and the last
    // section is cleared.
    const done =
      total > 0 &&
      p.max_section >= total - 1 &&
      isSectionCleared(sections[total - 1], total - 1, completed);
    if (!done) throw httpError(400, 'Lab is not complete yet');

    if (!p.finished_at) {
      q.finish.run(nowIso(), nowIso(), p.id);
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
  q.touch.run(nowIso(), p.id);
  noStore(res);
  res.json({
    session_active: true,
    expires_at: req.session.expires_at,
    finished: Boolean(p.finished_at),
    template_version: req.session.template_version,
  });
});

export default router;
