import { Router } from 'express';
import db from '../db/index.js';
import { requireParticipant } from '../middleware/auth.js';
import { joinLimiter, checkpointLimiter, contentLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { signParticipantToken } from '../lib/tokens.js';
import { nowIso, parseUtc } from '../lib/time.js';
import {
  resolveVariables,
  renderStep,
  checkpointAnswer,
  normaliseAnswer,
} from '../lib/templating.js';

const router = Router();

/**
 * Compute the highest step index a seat may view.
 *
 * Progressive disclosure: walk forward from step 0. A step that carries a
 * checkpoint blocks progression until that checkpoint index is in the
 * completed set. The blocking checkpoint step itself is visible (so the seat
 * can read the task and submit an answer) but nothing beyond it is.
 */
function computeVisibleThrough(steps, completedSet) {
  let i = 0;
  while (i < steps.length - 1) {
    const step = steps[i];
    const gated = step.checkpoint && step.checkpoint.answer;
    if (gated && !completedSet.has(i)) break; // stop AT this checkpoint step
    i += 1;
  }
  return Math.min(i, Math.max(steps.length - 1, 0));
}

/** Load the parsed manual (steps + variables) behind a session. */
function loadManual(session) {
  const template = db
    .prepare('SELECT content, variables FROM templates WHERE id = ?')
    .get(session.template_id);
  return {
    steps: JSON.parse(template.content),
    variables: JSON.parse(template.variables),
  };
}

/** No-store headers so rendered lab content is never cached to disk. */
function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
}

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
const MAX_PARTICIPANTS = 100;

// Assign the next seat number atomically inside a transaction so concurrent
// joins can never collide on a number.
const registerParticipant = db.transaction((session, firstName, lastName, nameKey) => {
  const existing = db
    .prepare('SELECT * FROM participants WHERE session_id = ? AND name_key = ?')
    .get(session.id, nameKey);
  if (existing) {
    db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(
      nowIso(),
      existing.id,
    );
    return { participant: existing, resumed: true };
  }

  const { maxSeat, count } = db
    .prepare(
      'SELECT COALESCE(MAX(seat_number), 0) AS maxSeat, COUNT(*) AS count FROM participants WHERE session_id = ?',
    )
    .get(session.id);
  if (count >= MAX_PARTICIPANTS) {
    throw httpError(409, `This session is full (${MAX_PARTICIPANTS} participants max).`);
  }
  const seatNumber = maxSeat + 1;
  const info = db
    .prepare(
      `INSERT INTO participants
         (session_id, seat_number, first_name, last_name, name_key, step_entered_at, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(session.id, seatNumber, firstName, lastName, nameKey, nowIso(), nowIso(), nowIso());
  const participant = db
    .prepare('SELECT * FROM participants WHERE id = ?')
    .get(info.lastInsertRowid);
  return { participant, resumed: false };
});

router.post(
  '/join',
  joinLimiter,
  asyncHandler(async (req, res) => {
    const roomCode = String(req.body?.room_code || '').trim();
    const firstName = String(req.body?.first_name || '').trim().replace(/\s+/g, ' ');
    const lastName = String(req.body?.last_name || '').trim().replace(/\s+/g, ' ');
    if (!/^\d{6}$/.test(roomCode)) {
      throw httpError(400, 'Enter a valid 6-digit room code');
    }
    if (!firstName || firstName.length > 60) {
      throw httpError(400, 'Enter your first name');
    }
    if (!lastName || lastName.length > 60) {
      throw httpError(400, 'Enter your last name');
    }

    const session = db
      .prepare('SELECT * FROM sessions WHERE room_code = ? AND is_active = 1')
      .get(roomCode);
    // Uniform error for "wrong code" vs "expired" to avoid leaking which codes
    // exist (anti-enumeration).
    if (!session || parseUtc(session.expires_at) < Date.now()) {
      throw httpError(401, 'Invalid or expired room code');
    }

    const nameKey = `${firstName} ${lastName}`.toLowerCase();
    const { participant, resumed } = registerParticipant(
      session,
      firstName,
      lastName,
      nameKey,
    );

    const { steps } = loadManual(session);
    const token = signParticipantToken(participant, session);
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
        step_count: steps.length,
      },
    });
  }),
);

/**
 * GET /api/participant/steps
 * Returns ONLY the steps this seat has unlocked, rendered for the seat.
 * Checkpoint answers are stripped by renderStep. This progressive delivery is
 * the anti-scraping / IP-protection core: a seat can never pull steps it has
 * not legitimately reached.
 */
router.get(
  '/steps',
  contentLimiter,
  requireParticipant,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const { steps, variables } = loadManual(req.session);
    const context = resolveVariables(variables, p.seat_number);
    const completed = new Set(JSON.parse(p.completed_checkpoints));
    const visibleThrough = computeVisibleThrough(steps, completed);

    db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(
      nowIso(),
      p.id,
    );

    const rendered = steps
      .slice(0, visibleThrough + 1)
      .map((s, i) => renderStep(s, context, i));

    // Mark which visible checkpoint steps are already satisfied.
    for (const step of rendered) {
      if (step.checkpoint) {
        step.checkpoint.completed = completed.has(step.index);
      }
    }

    noStore(res);
    res.json({
      seat_number: p.seat_number,
      first_name: p.first_name,
      last_name: p.last_name,
      total_steps: steps.length,
      unlocked_through: visibleThrough,
      current_step: p.current_step,
      completed_checkpoints: [...completed],
      steps: rendered,
    });
  }),
);

/**
 * POST /api/participant/checkpoint
 * Body: { step_index, answer }
 * Validates the seat-specific unlock string server-side and, on success,
 * reveals the next step.
 */
router.post(
  '/checkpoint',
  checkpointLimiter,
  requireParticipant,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const stepIndex = parseInt(req.body?.step_index, 10);
    const answer = req.body?.answer;

    const { steps, variables } = loadManual(req.session);
    if (Number.isNaN(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) {
      throw httpError(400, 'Invalid step index');
    }
    const step = steps[stepIndex];
    if (!step.checkpoint || !step.checkpoint.answer) {
      throw httpError(400, 'This step has no checkpoint');
    }

    // Can only attempt a checkpoint on a step you can actually see.
    const completed = new Set(JSON.parse(p.completed_checkpoints));
    const visibleThrough = computeVisibleThrough(steps, completed);
    if (stepIndex > visibleThrough) {
      throw httpError(403, 'Step is locked');
    }

    const context = resolveVariables(variables, p.seat_number);
    const expected = checkpointAnswer(step, context);
    const correct = normaliseAnswer(answer) === expected;

    if (!correct) {
      noStore(res);
      return res.status(200).json({ correct: false });
    }

    completed.add(stepIndex);
    const newVisible = computeVisibleThrough(steps, completed);
    db.prepare(
      'UPDATE participants SET completed_checkpoints = ?, unlocked_step = ?, last_seen_at = ? WHERE id = ?',
    ).run(JSON.stringify([...completed]), newVisible, nowIso(), p.id);

    noStore(res);
    res.json({ correct: true, unlocked_through: newVisible });
  }),
);

/**
 * POST /api/participant/progress
 * Body: { step_index }
 * Records the step a seat is actively viewing (drives instructor analytics:
 * "Seat 7 has been on Step 4 for 15 minutes"). Closes the previous step_event
 * and opens a new one.
 */
router.post(
  '/progress',
  requireParticipant,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const stepIndex = parseInt(req.body?.step_index, 10);
    const { steps } = loadManual(req.session);
    if (Number.isNaN(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) {
      throw httpError(400, 'Invalid step index');
    }
    const completed = new Set(JSON.parse(p.completed_checkpoints));
    const visibleThrough = computeVisibleThrough(steps, completed);
    if (stepIndex > visibleThrough) throw httpError(403, 'Step is locked');

    if (stepIndex !== p.current_step) {
      const now = nowIso();
      // Close the open analytics event for the previous step.
      const open = db
        .prepare(
          'SELECT * FROM step_events WHERE participant_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1',
        )
        .get(p.id);
      if (open) {
        const seconds = Math.max(
          0,
          Math.round((parseUtc(now) - parseUtc(open.entered_at)) / 1000),
        );
        db.prepare(
          'UPDATE step_events SET left_at = ?, seconds_spent = ? WHERE id = ?',
        ).run(now, seconds, open.id);
      }
      db.prepare(
        'INSERT INTO step_events (participant_id, session_id, step_index, entered_at) VALUES (?, ?, ?, ?)',
      ).run(p.id, req.session.id, stepIndex, now);
      db.prepare(
        'UPDATE participants SET current_step = ?, step_entered_at = ?, last_seen_at = ? WHERE id = ?',
      ).run(stepIndex, now, now, p.id);
    } else {
      db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(
        nowIso(),
        p.id,
      );
    }
    res.json({ current_step: stepIndex });
  }),
);

/** POST /api/participant/heartbeat — keep-alive for presence analytics. */
router.post('/heartbeat', requireParticipant, (req, res) => {
  db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(
    nowIso(),
    req.participant.id,
  );
  res.json({ ok: true, session_active: true });
});

export default router;
