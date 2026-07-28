import { Router } from 'express';
import crypto from 'node:crypto';
import db from '../db/index.js';
import { requireInstructor } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { isoInMinutes, nowIso, secondsBetween, parseUtc } from '../lib/time.js';
import { isSectionCleared, stepHasCheckpoint } from '../lib/templating.js';

const router = Router();
router.use(requireInstructor);

/** Generate a 6-digit code not currently used by an active session. */
function generateRoomCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const clash = db
      .prepare(
        'SELECT 1 FROM sessions WHERE room_code = ? AND is_active = 1',
      )
      .get(code);
    if (!clash) return code;
  }
  throw httpError(503, 'Unable to allocate a room code, please retry');
}

/** Live status derived from is_active + expiry. */
function sessionStatus(row) {
  if (!row.is_active) return 'ended';
  if (parseUtc(row.expires_at) < Date.now()) return 'expired';
  return 'active';
}

/** Build the analytics view for one participant. */
function participantView(p, sections) {
  const completed = new Set(JSON.parse(p.completed_checkpoints));
  const sectionCount = sections.length;
  // Completed = sections the participant has navigated past (monotonic high-
  // water mark), plus the final section once it is cleared/reached. This avoids
  // crediting not-yet-visited sections that happen to have no checkpoint.
  const furthest = p.max_section;
  let completedSections = Math.min(furthest, sectionCount);
  if (
    sectionCount > 0 &&
    furthest >= sectionCount - 1 &&
    isSectionCleared(sections[sectionCount - 1], sectionCount - 1, completed)
  ) {
    completedSections = sectionCount;
  }
  const finished = Boolean(p.finished_at);
  const secondsSinceSeen = secondsBetween(p.last_seen_at, nowIso());
  return {
    id: p.id,
    seat_number: p.seat_number,
    first_name: p.first_name,
    last_name: p.last_name,
    name: `${p.first_name} ${p.last_name}`.trim(),
    current_section: p.current_section,
    completed_sections: completedSections,
    completed_checkpoints: [...completed],
    hints_taken: JSON.parse(p.hints_taken || '[]').length,
    solutions_revealed: JSON.parse(p.revealed_solutions || '[]').length,
    finished,
    finished_at: p.finished_at,
    status: finished ? 'finished' : secondsSinceSeen < 90 ? 'active' : 'idle',
    seconds_on_current_section: secondsBetween(p.section_entered_at, nowIso()),
    total_seconds: finished
      ? secondsBetween(p.joined_at, p.finished_at)
      : secondsBetween(p.joined_at, nowIso()),
    progress_pct:
      sectionCount > 0 ? Math.round((completedSections / sectionCount) * 100) : 0,
    joined_at: p.joined_at,
    last_seen_at: p.last_seen_at,
    seconds_since_seen: secondsSinceSeen,
  };
}

/** POST /api/sessions — create a live class. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const templateId = req.body?.template_id;
    const durationMinutes = Math.min(
      Math.max(parseInt(req.body?.duration_minutes ?? 120, 10) || 120, 5),
      24 * 60,
    );
    const title = String(req.body?.title || '').trim().slice(0, 200);

    const template = db
      .prepare('SELECT * FROM templates WHERE id = ?')
      .get(templateId);
    if (!template) throw httpError(400, 'template_id does not reference a template');

    const roomCode = generateRoomCode();
    const info = db
      .prepare(
        `INSERT INTO sessions
           (room_code, title, template_id, instructor_id, template_version, is_active, expires_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        roomCode,
        title || template.title,
        template.id,
        req.instructor.id,
        template.version,
        isoInMinutes(durationMinutes),
      );

    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({
      id: row.id,
      room_code: row.room_code,
      title: row.title,
      template_id: row.template_id,
      template_title: template.title,
      status: sessionStatus(row),
      expires_at: row.expires_at,
      created_at: row.created_at,
    });
  }),
);

/** GET /api/sessions — list this instructor's sessions with live counts. */
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*, t.title AS template_title,
              (SELECT COUNT(*) FROM participants p WHERE p.session_id = s.id) AS participant_count
         FROM sessions s
         JOIN templates t ON t.id = s.template_id
        WHERE s.instructor_id = ?
        ORDER BY s.created_at DESC`,
    )
    .all(req.instructor.id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      room_code: r.room_code,
      title: r.title,
      template_id: r.template_id,
      template_title: r.template_title,
      participant_count: r.participant_count,
      status: sessionStatus(r),
      expires_at: r.expires_at,
      created_at: r.created_at,
      ended_at: r.ended_at,
    })),
  );
});

/** GET /api/sessions/:id — detail + live analytics dashboard data. */
router.get('/:id', (req, res) => {
  const row = db
    .prepare(
      `SELECT s.*, t.title AS template_title, t.content AS template_content
         FROM sessions s JOIN templates t ON t.id = s.template_id
        WHERE s.id = ? AND s.instructor_id = ?`,
    )
    .get(req.params.id, req.instructor.id);
  if (!row) throw httpError(404, 'Session not found');

  const sections = JSON.parse(row.template_content);
  const sectionCount = sections.length;
  const participants = db
    .prepare('SELECT * FROM participants WHERE session_id = ? ORDER BY seat_number')
    .all(row.id)
    .map((p) => participantView(p, sections));

  // Aggregate: how many seats are currently on each section.
  const sectionDistribution = sections.map((s, i) => ({
    index: i,
    title: s.title || `Section ${i + 1}`,
    step_count: (s.steps && s.steps.length) || 0,
    has_checkpoint: (s.steps || []).some((step) => stepHasCheckpoint(step)),
    seats_here: participants.filter((p) => p.current_section === i).length,
  }));

  res.json({
    id: row.id,
    room_code: row.room_code,
    title: row.title,
    template_id: row.template_id,
    template_title: row.template_title,
    status: sessionStatus(row),
    expires_at: row.expires_at,
    created_at: row.created_at,
    ended_at: row.ended_at,
    section_count: sectionCount,
    section_distribution: sectionDistribution,
    participants,
  });
});

/**
 * POST /api/sessions/:id/terminate — end a session NOW.
 * Flips is_active to 0; the participant auth guard immediately rejects every
 * outstanding token (spec: "access tokens are invalidated immediately").
 */
router.post('/:id/terminate', (req, res) => {
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND instructor_id = ?')
    .get(req.params.id, req.instructor.id);
  if (!row) throw httpError(404, 'Session not found');
  if (!row.is_active) {
    return res.json({ id: row.id, status: 'ended', already: true });
  }
  db.prepare(
    'UPDATE sessions SET is_active = 0, ended_at = ? WHERE id = ?',
  ).run(nowIso(), row.id);
  res.json({ id: row.id, status: 'ended' });
});

/**
 * POST /api/sessions/:id/extend — ADD time to the current expiry.
 * The new expiry is computed from whichever is later — the existing expiry or
 * now — plus the requested minutes, so "+30" always grants 30 more minutes
 * rather than resetting the clock.
 */
router.post('/:id/extend', (req, res) => {
  const minutes = Math.min(Math.max(parseInt(req.body?.minutes ?? 30, 10) || 30, 5), 24 * 60);
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND instructor_id = ?')
    .get(req.params.id, req.instructor.id);
  if (!row) throw httpError(404, 'Session not found');
  if (!row.is_active) throw httpError(409, 'Cannot extend an ended session');
  const base = Math.max(parseUtc(row.expires_at), Date.now());
  const expiresAt = new Date(base + minutes * 60_000).toISOString();
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, row.id);
  res.json({ id: row.id, expires_at: expiresAt });
});

/** DELETE /api/sessions/:id — permanently delete a session and its data. */
router.delete('/:id', (req, res) => {
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND instructor_id = ?')
    .get(req.params.id, req.instructor.id);
  if (!row) throw httpError(404, 'Session not found');
  // Participants cascade-delete via the FK. The room code (if it was active) is
  // freed for reuse.
  db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
  res.status(204).end();
});

/**
 * GET /api/sessions/:id/export — full session data for archival/reporting.
 * Returns a JSON document (meta + per-participant analytics). Handy for
 * exporting a completed session.
 */
router.get('/:id/export', (req, res) => {
  const row = db
    .prepare(
      `SELECT s.*, t.title AS template_title, t.content AS template_content
         FROM sessions s JOIN templates t ON t.id = s.template_id
        WHERE s.id = ? AND s.instructor_id = ?`,
    )
    .get(req.params.id, req.instructor.id);
  if (!row) throw httpError(404, 'Session not found');

  const sections = JSON.parse(row.template_content);
  const participants = db
    .prepare('SELECT * FROM participants WHERE session_id = ? ORDER BY seat_number')
    .all(row.id)
    .map((p) => {
      const view = participantView(p, sections);
      return {
        number: view.seat_number,
        first_name: p.first_name,
        last_name: p.last_name,
        name: view.name,
        current_section: view.current_section + 1,
        sections_completed: view.completed_sections,
        total_sections: sections.length,
        progress_pct: view.progress_pct,
        checkpoints_cleared: view.completed_checkpoints.length,
        hints_taken: view.hints_taken,
        solutions_revealed: view.solutions_revealed,
        finished: view.finished,
        finished_at: p.finished_at,
        total_seconds: view.total_seconds,
        joined_at: p.joined_at,
        last_seen_at: p.last_seen_at,
      };
    });

  res.json({
    exported_at: nowIso(),
    session: {
      id: row.id,
      title: row.title,
      room_code: row.room_code,
      template_title: row.template_title,
      status: sessionStatus(row),
      section_count: sections.length,
      created_at: row.created_at,
      expires_at: row.expires_at,
      ended_at: row.ended_at,
    },
    participants,
  });
});

export default router;
