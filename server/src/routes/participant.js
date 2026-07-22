import { Router } from 'express';
import db from '../db/index.js';
import { requireParticipant } from '../middleware/auth.js';
import { joinLimiter, checkpointLimiter, contentLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { signParticipantToken } from '../lib/tokens.js';
import { nowIso, parseUtc } from '../lib/time.js';
import {
  resolveVariables,
  checkpointAnswer,
  normaliseAnswer,
  renderSection,
  isSectionCleared,
  computeUnlockedSection,
  computeSectionVisibleThrough,
  checkpointKey,
  countSteps,
} from '../lib/templating.js';

const router = Router();

/** Load the parsed manual (sections + variables) behind a session. */
function loadManual(session) {
  const template = db
    .prepare('SELECT content, variables FROM templates WHERE id = ?')
    .get(session.template_id);
  return {
    sections: JSON.parse(template.content),
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
         (session_id, seat_number, first_name, last_name, name_key, section_entered_at, joined_at, last_seen_at)
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

    const { sections } = loadManual(session);
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
        section_count: sections.length,
        step_count: countSteps(sections),
      },
    });
  }),
);

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
  requireParticipant,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const { sections, variables } = loadManual(req.session);
    const context = resolveVariables(variables, p.seat_number);
    const completed = new Set(JSON.parse(p.completed_checkpoints));
    const unlockedSection = computeUnlockedSection(sections, completed);

    db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(
      nowIso(),
      p.id,
    );

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
      current_section: p.current_section,
      completed_sections: completedSections,
      progress_pct: total > 0 ? Math.round((completedSections / total) * 100) : 0,
      completed_checkpoints: [...completed],
      sections: rendered,
    });
  }),
);

/**
 * POST /api/participant/checkpoint
 * Body: { section_index, step_index, answer }
 * Validates the seat-specific unlock string server-side and, on success,
 * records completion (which may clear the section and unlock the next).
 */
router.post(
  '/checkpoint',
  checkpointLimiter,
  requireParticipant,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const sectionIndex = parseInt(req.body?.section_index, 10);
    const stepIndex = parseInt(req.body?.step_index, 10);
    const answer = req.body?.answer;

    const { sections, variables } = loadManual(req.session);
    const section = sections[sectionIndex];
    if (!section || Number.isNaN(sectionIndex)) {
      throw httpError(400, 'Invalid section index');
    }
    const step = section.steps?.[stepIndex];
    if (!step || Number.isNaN(stepIndex)) throw httpError(400, 'Invalid step index');
    if (!step.checkpoint || !step.checkpoint.answer) {
      throw httpError(400, 'This step has no checkpoint');
    }

    // Can only attempt a checkpoint in a section you can actually reach.
    const completed = new Set(JSON.parse(p.completed_checkpoints));
    const unlockedSection = computeUnlockedSection(sections, completed);
    if (sectionIndex > unlockedSection) throw httpError(403, 'Section is locked');
    // ...and only up to the first open checkpoint within that section.
    const visibleThrough = computeSectionVisibleThrough(section, sectionIndex, completed);
    if (stepIndex > visibleThrough) throw httpError(403, 'Step is locked');

    const context = resolveVariables(variables, p.seat_number);
    const expected = checkpointAnswer(step, context);
    const correct = normaliseAnswer(answer) === expected;

    if (!correct) {
      noStore(res);
      return res.status(200).json({ correct: false });
    }

    completed.add(checkpointKey(sectionIndex, stepIndex));
    const newUnlocked = computeUnlockedSection(sections, completed);
    db.prepare(
      'UPDATE participants SET completed_checkpoints = ?, last_seen_at = ? WHERE id = ?',
    ).run(JSON.stringify([...completed]), nowIso(), p.id);

    noStore(res);
    res.json({
      correct: true,
      section_cleared: isSectionCleared(section, sectionIndex, completed),
      unlocked_section: newUnlocked,
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
  requireParticipant,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const sectionIndex = parseInt(req.body?.section_index, 10);
    const { sections } = loadManual(req.session);
    if (Number.isNaN(sectionIndex) || sectionIndex < 0 || sectionIndex >= sections.length) {
      throw httpError(400, 'Invalid section index');
    }
    const completed = new Set(JSON.parse(p.completed_checkpoints));
    const unlockedSection = computeUnlockedSection(sections, completed);
    if (sectionIndex > unlockedSection) throw httpError(403, 'Section is locked');

    if (sectionIndex !== p.current_section) {
      const now = nowIso();
      // max_section is a monotonic high-water mark so progress never drops when
      // a participant navigates back to review an earlier section.
      db.prepare(
        `UPDATE participants
            SET current_section = ?, max_section = MAX(max_section, ?),
                section_entered_at = ?, last_seen_at = ?
          WHERE id = ?`,
      ).run(sectionIndex, sectionIndex, now, now, p.id);
    } else {
      db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(
        nowIso(),
        p.id,
      );
    }
    res.json({ current_section: sectionIndex });
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
