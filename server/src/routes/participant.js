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
  injectVariables,
  stepHasCheckpoint,
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

      // Augment each step with hint-taken state and, for checkpoint steps whose
      // every hint has been taken, the solution (revealed on request only).
      section.steps.forEach((step) => {
        const raw = sections[s].steps[step.index];
        const hintCount = (raw.hints || []).length;
        step.hints = (step.hints || []).map((h, hi) => ({
          ...h,
          taken: hintsTaken.has(`${s}.${step.index}.${hi}`),
        }));
        if (step.checkpoint && !step.checkpoint.completed) {
          const allHintsTaken =
            hintCount > 0 &&
            step.hints.every((h) => h.taken);
          step.checkpoint.solution_available = allHintsTaken;
          if (revealed.has(`${s}.${step.index}`)) {
            step.checkpoint.solution = injectVariables(
              String(raw.checkpoint.answer),
              context,
            );
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
      current_section: p.current_section,
      completed_sections: completedSections,
      progress_pct: total > 0 ? Math.round((completedSections / total) * 100) : 0,
      completed_checkpoints: [...completed],
      finished: Boolean(p.finished_at),
      expires_at: req.session.expires_at,
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

/**
 * POST /api/participant/hint
 * Body: { section_index, step_index, hint_index }
 * Records that a participant opened a hint (drives "hints taken" analytics and
 * gates the reveal-solution feature).
 */
router.post(
  '/hint',
  requireParticipant,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const si = parseInt(req.body?.section_index, 10);
    const sti = parseInt(req.body?.step_index, 10);
    const hi = parseInt(req.body?.hint_index, 10);
    const { sections } = loadManual(req.session);
    const step = sections[si]?.steps?.[sti];
    if (!step || Number.isNaN(hi) || !step.hints || hi < 0 || hi >= step.hints.length) {
      throw httpError(400, 'Invalid hint');
    }
    const taken = new Set(JSON.parse(p.hints_taken || '[]'));
    taken.add(`${si}.${sti}.${hi}`);
    db.prepare(
      'UPDATE participants SET hints_taken = ?, last_seen_at = ? WHERE id = ?',
    ).run(JSON.stringify([...taken]), nowIso(), p.id);
    res.json({ ok: true, hints_taken: taken.size });
  }),
);

/**
 * POST /api/participant/solution
 * Body: { section_index, step_index }
 * Reveals a checkpoint's answer — but ONLY once every hint on that step has been
 * taken. Until then the answer never leaves the server.
 */
router.post(
  '/solution',
  requireParticipant,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const si = parseInt(req.body?.section_index, 10);
    const sti = parseInt(req.body?.step_index, 10);
    const { sections, variables } = loadManual(req.session);
    const step = sections[si]?.steps?.[sti];
    if (!step || !stepHasCheckpoint(step)) throw httpError(400, 'No checkpoint here');

    const hintCount = (step.hints || []).length;
    if (hintCount === 0) throw httpError(403, 'No hints to exhaust on this step');
    const taken = new Set(JSON.parse(p.hints_taken || '[]'));
    const allTaken = step.hints.every((_, hi) => taken.has(`${si}.${sti}.${hi}`));
    if (!allTaken) throw httpError(403, 'Take all hints before revealing the solution');

    const revealed = new Set(JSON.parse(p.revealed_solutions || '[]'));
    revealed.add(`${si}.${sti}`);
    db.prepare(
      'UPDATE participants SET revealed_solutions = ?, last_seen_at = ? WHERE id = ?',
    ).run(JSON.stringify([...revealed]), nowIso(), p.id);

    const context = resolveVariables(variables, p.seat_number);
    const solution = injectVariables(String(step.checkpoint.answer), context);
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
  requireParticipant,
  asyncHandler(async (req, res) => {
    const p = req.participant;
    const { sections } = loadManual(req.session);
    const completed = new Set(JSON.parse(p.completed_checkpoints));
    const total = sections.length;
    // Require genuine completion: max_section reached the end and the last
    // section is cleared.
    const done =
      total > 0 &&
      p.max_section >= total - 1 &&
      isSectionCleared(sections[total - 1], total - 1, completed);
    if (!done) throw httpError(400, 'Lab is not complete yet');

    if (!p.finished_at) {
      db.prepare('UPDATE participants SET finished_at = ?, last_seen_at = ? WHERE id = ?').run(
        nowIso(),
        nowIso(),
        p.id,
      );
    }
    res.json({ finished: true });
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
