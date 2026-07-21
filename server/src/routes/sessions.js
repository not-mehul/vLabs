import { Router } from 'express';
import crypto from 'node:crypto';
import db from '../db/index.js';
import { requireInstructor } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { isoInMinutes, nowIso, secondsBetween, parseUtc } from '../lib/time.js';

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
function participantView(p, stepCount) {
  const onStepSeconds = secondsBetween(p.step_entered_at, nowIso());
  return {
    id: p.id,
    seat_id: p.seat_id,
    current_step: p.current_step,
    unlocked_step: p.unlocked_step,
    completed_checkpoints: JSON.parse(p.completed_checkpoints),
    seconds_on_current_step: onStepSeconds,
    progress_pct:
      stepCount > 0
        ? Math.round(((p.current_step + 1) / stepCount) * 100)
        : 0,
    joined_at: p.joined_at,
    last_seen_at: p.last_seen_at,
    seconds_since_seen: secondsBetween(p.last_seen_at, nowIso()),
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

  const steps = JSON.parse(row.template_content);
  const stepCount = steps.length;
  const participants = db
    .prepare('SELECT * FROM participants WHERE session_id = ? ORDER BY seat_id')
    .all(row.id)
    .map((p) => participantView(p, stepCount));

  // Aggregate: how many seats are currently on each step.
  const stepDistribution = steps.map((s, i) => ({
    index: i,
    title: s.title || `Step ${i + 1}`,
    type: s.type === 'computer' ? 'computer' : 'desk',
    has_checkpoint: Boolean(s.checkpoint && s.checkpoint.answer),
    seats_here: participants.filter((p) => p.current_step === i).length,
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
    step_count: stepCount,
    step_distribution: stepDistribution,
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

/** POST /api/sessions/:id/extend — push back the expiry. */
router.post('/:id/extend', (req, res) => {
  const minutes = Math.min(Math.max(parseInt(req.body?.minutes ?? 30, 10) || 30, 5), 24 * 60);
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND instructor_id = ?')
    .get(req.params.id, req.instructor.id);
  if (!row) throw httpError(404, 'Session not found');
  if (!row.is_active) throw httpError(409, 'Cannot extend an ended session');
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
    isoInMinutes(minutes),
    row.id,
  );
  res.json({ id: row.id, expires_at: isoInMinutes(minutes) });
});

export default router;
