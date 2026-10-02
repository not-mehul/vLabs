import { Router } from 'express';
import crypto from 'node:crypto';
import db from '../db/index.js';
import { requireInstructor } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { isoInMinutes, nowIso, secondsBetween, parseUtc } from '../lib/time.js';
import { isSectionCleared, stepHasCheckpoint, checkpointMode } from '../lib/templating.js';
import { sweepExpiredSessions, snapshotTemplateIntoSession } from '../lib/sessionLifecycle.js';
import { log } from '../lib/logger.js';

const router = Router();
router.use(requireInstructor);

const q = {
  codeClash: db.prepare('SELECT 1 FROM sessions WHERE room_code = ? AND is_active = 1'),
  template: db.prepare('SELECT * FROM templates WHERE id = ?'),
  insert: db.prepare(
    `INSERT INTO sessions
       (room_code, title, template_id, instructor_id, template_version, template_title,
        content, variables, is_active, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ),
  byId: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  // LEFT JOIN: the master template may have been archived or deleted since;
  // the session's own copy is authoritative for content and title.
  detail: db.prepare(
    `SELECT s.*, t.version AS latest_template_version, t.archived_at AS template_archived_at,
            t.title AS latest_template_title
       FROM sessions s LEFT JOIN templates t ON t.id = s.template_id
      WHERE s.id = ? AND s.instructor_id = ?`,
  ),
  list: db.prepare(
    `SELECT s.id, s.room_code, s.title, s.template_id, s.template_title, s.template_version,
            s.is_active, s.expires_at, s.created_at, s.ended_at,
            t.version AS latest_template_version,
            (SELECT COUNT(*) FROM participants p WHERE p.session_id = s.id) AS participant_count
       FROM sessions s LEFT JOIN templates t ON t.id = s.template_id
      WHERE s.instructor_id = ?
      ORDER BY s.created_at DESC`,
  ),
  participants: db.prepare('SELECT * FROM participants WHERE session_id = ? ORDER BY seat_number'),
  participant: db.prepare('SELECT * FROM participants WHERE id = ? AND session_id = ?'),
  terminate: db.prepare('UPDATE sessions SET is_active = 0, ended_at = ? WHERE id = ?'),
  extend: db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM sessions WHERE id = ?'),
};

/** Generate a 6-digit code not currently used by an active session. */
function generateRoomCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!q.codeClash.get(code)) return code;
  }
  throw httpError(503, 'Unable to allocate a room code, please retry');
}

/** Live status derived from is_active + expiry. */
function sessionStatus(row) {
  if (!row.is_active) return 'ended';
  if (parseUtc(row.expires_at) < Date.now()) return 'expired';
  return 'active';
}

/** Parse and validate a numeric :id param. */
function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(404, 'Session not found');
  return id;
}

function ownedOr404(req) {
  const row = q.detail.get(idParam(req), req.instructor.id);
  if (!row) throw httpError(404, 'Session not found');
  return row;
}

/** Parse a JSON object column defensively. */
function safeObject(json) {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Names captured by pattern checkpoints, in template order. */
function captureNamesOf(sections) {
  const out = [];
  for (const s of sections) {
    for (const step of s.steps || []) {
      const c = step.checkpoint?.capture;
      if (c && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

/** Seconds per section index, including the open visit (unless complete). */
function sectionTimesView(p, sectionCount, now) {
  const stored = safeObject(p.section_times);
  const out = [];
  for (let i = 0; i < sectionCount; i += 1) out.push(Number(stored[String(i)]) || 0);
  if (!p.completed_at && p.current_section < sectionCount) {
    out[p.current_section] += secondsBetween(p.section_entered_at, now);
  }
  return out;
}

/** Build the analytics view for one participant. */
function participantView(p, sections) {
  const now = nowIso();
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
  // "Complete" is recorded server-side the moment the manual is cleared, so a
  // participant who keeps reviewing (never presses Finish) still counts and
  // their clock stays stopped. Rows from before migration 4 fall back to the
  // cleared-everything computation.
  const completedAt =
    p.completed_at ||
    (completedSections === sectionCount && sectionCount > 0 ? p.finished_at || null : null);
  const complete = Boolean(completedAt) || (sectionCount > 0 && completedSections === sectionCount);
  const finished = Boolean(p.finished_at);
  const secondsSinceSeen = secondsBetween(p.last_seen_at, now);
  const clockEnd = completedAt || (complete ? now : null);
  return {
    id: p.id,
    seat_number: p.seat_number,
    first_name: p.first_name,
    last_name: p.last_name,
    name: `${p.first_name} ${p.last_name}`.trim(),
    current_section: p.current_section,
    max_section: p.max_section,
    completed_sections: completedSections,
    completed_checkpoints: [...completed],
    captured: safeObject(p.captured_values),
    hints_taken: JSON.parse(p.hints_taken || '[]').length,
    solutions_revealed: JSON.parse(p.revealed_solutions || '[]').length,
    wrong_attempts: (safeArray(p.checkpoint_log) || []).filter((e) => !e.ok).length,
    complete,
    completed_at: completedAt,
    finished,
    finished_at: p.finished_at,
    status: complete ? 'finished' : secondsSinceSeen < 90 ? 'active' : 'idle',
    seconds_on_current_section: complete ? 0 : secondsBetween(p.section_entered_at, now),
    total_seconds: secondsBetween(p.joined_at, clockEnd || now),
    section_seconds: sectionTimesView(p, sectionCount, now),
    progress_pct: sectionCount > 0 ? Math.round((completedSections / sectionCount) * 100) : 0,
    joined_at: p.joined_at,
    last_seen_at: p.last_seen_at,
    seconds_since_seen: secondsSinceSeen,
  };
}

function safeArray(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Everything the instructor's per-participant drawer needs, resolved against
 * the session's own copy of the manual so titles/labels are right even if the
 * master template changed since. Answers are shown as typed; the authored
 * expected answers are NOT included (they are per-seat secrets and the
 * instructor can open the template).
 */
function participantDetail(p, sections) {
  const view = participantView(p, sections);
  const stepTitle = (si, sti) => {
    const sec = sections[si];
    const step = sec?.steps?.[sti];
    return {
      section_index: si,
      step_index: sti,
      section_title: sec?.title || `Section ${si + 1}`,
      step_title: step?.title || `Step ${sti + 1}`,
    };
  };
  const parseKey = (k) =>
    String(k)
      .split('.')
      .map((n) => parseInt(n, 10));

  // Checkpoints in manual order with their attempts.
  const log = safeArray(p.checkpoint_log);
  const checkpoints = [];
  sections.forEach((sec, si) => {
    (sec.steps || []).forEach((step, sti) => {
      if (!stepHasCheckpoint(step)) return;
      const key = `${si}.${sti}`;
      const attempts = log
        .filter((e) => e.k === key)
        .map((e) => ({ answer: e.a, correct: Boolean(e.ok), at: e.at }));
      const accepted = attempts.find((a) => a.correct);
      checkpoints.push({
        key,
        ...stepTitle(si, sti),
        prompt: step.checkpoint.prompt || 'Enter the value to continue',
        mode: checkpointMode(step),
        capture: step.checkpoint.capture || null,
        cleared: view.completed_checkpoints.includes(key),
        cleared_at: accepted?.at || null,
        accepted_answer:
          accepted?.answer ??
          (step.checkpoint.capture ? (view.captured[step.checkpoint.capture] ?? null) : null),
        wrong_attempts: attempts.filter((a) => !a.correct),
        attempt_count: attempts.length,
      });
    });
  });

  const hints = safeArray(p.hints_taken).map((k) => {
    const [si, sti, hi] = parseKey(k);
    const label = sections[si]?.steps?.[sti]?.hints?.[hi]?.label || `Hint ${hi + 1}`;
    return { key: k, ...stepTitle(si, sti), hint_index: hi, label };
  });
  const solutions = safeArray(p.revealed_solutions).map((k) => {
    const [si, sti] = parseKey(k);
    return { key: k, ...stepTitle(si, sti) };
  });
  const sectionTimes = sections.map((sec, i) => ({
    index: i,
    title: sec.title || `Section ${i + 1}`,
    seconds: view.section_seconds[i] || 0,
    current: !view.complete && p.current_section === i,
    cleared: isSectionCleared(sec, i, new Set(view.completed_checkpoints)),
  }));

  return { ...view, checkpoints, hints, solutions, section_times: sectionTimes };
}

/** Common session summary fields. */
function summarise(row) {
  return {
    id: row.id,
    room_code: row.room_code,
    title: row.title,
    template_id: row.template_id,
    template_title: row.template_title,
    template_version: row.template_version,
    latest_template_version: row.latest_template_version ?? null,
    update_available:
      row.latest_template_version != null && row.latest_template_version > row.template_version,
    status: sessionStatus(row),
    expires_at: row.expires_at,
    created_at: row.created_at,
    ended_at: row.ended_at,
  };
}

/**
 * POST /api/sessions — create a live class.
 * The template's current title/content/variables are COPIED into the session
 * (frozen at launch). Archived templates cannot be launched.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    sweepExpiredSessions();
    const templateId = Number(req.body?.template_id);
    const durationMinutes = Math.min(
      Math.max(parseInt(req.body?.duration_minutes ?? 120, 10) || 120, 5),
      24 * 60,
    );
    const title = String(req.body?.title || '')
      .trim()
      .slice(0, 200);

    const template = Number.isInteger(templateId) ? q.template.get(templateId) : null;
    if (!template) throw httpError(400, 'template_id does not reference a template');
    if (template.archived_at)
      throw httpError(409, 'This template is archived — restore it to launch a session');

    const roomCode = generateRoomCode();
    const info = q.insert.run(
      roomCode,
      title || template.title,
      template.id,
      req.instructor.id,
      template.version,
      template.title,
      template.content,
      template.variables,
      isoInMinutes(durationMinutes),
    );

    const row = q.detail.get(info.lastInsertRowid, req.instructor.id);
    log.info('session.created', {
      session: row.id,
      template: template.id,
      instructor: req.instructor.id,
    });
    res.status(201).json(summarise(row));
  }),
);

/** GET /api/sessions — list this instructor's sessions with live counts. */
router.get('/', (req, res) => {
  sweepExpiredSessions();
  const rows = q.list.all(req.instructor.id);
  res.json(rows.map((r) => ({ ...summarise(r), participant_count: r.participant_count })));
});

/**
 * GET /api/sessions/:id/participants/:pid — one participant in depth:
 * checkpoints with accepted answer + wrong attempts, hints opened, solutions
 * revealed, time per section, captured values.
 */
router.get('/:id/participants/:pid', (req, res) => {
  const row = ownedOr404(req);
  const pid = Number(req.params.pid);
  const p = Number.isInteger(pid) ? q.participant.get(pid, row.id) : null;
  if (!p) throw httpError(404, 'Participant not found');
  res.json(participantDetail(p, JSON.parse(row.content)));
});

/** GET /api/sessions/:id — detail + live analytics dashboard data. */
router.get('/:id', (req, res) => {
  const row = ownedOr404(req);
  const sections = JSON.parse(row.content);
  const sectionCount = sections.length;
  const participants = q.participants.all(row.id).map((p) => participantView(p, sections));

  // Aggregate: how many seats are currently on each section.
  const sectionDistribution = sections.map((s, i) => ({
    index: i,
    title: s.title || `Section ${i + 1}`,
    step_count: (s.steps && s.steps.length) || 0,
    checkpoint_count: (s.steps || []).filter((step) => stepHasCheckpoint(step)).length,
    has_checkpoint: (s.steps || []).some((step) => stepHasCheckpoint(step)),
    // Seats currently viewing this section (complete seats are counted under `complete`).
    seats_here: participants.filter((p) => !p.complete && p.current_section === i).length,
    // Seats that have moved past (or cleared) this section.
    seats_past: participants.filter((p) => p.complete || p.max_section > i).length,
  }));
  const completeCount = participants.filter((p) => p.complete).length;

  res.json({
    ...summarise(row),
    capture_names: captureNamesOf(sections),
    complete_count: completeCount,
    template_exists: row.latest_template_version != null,
    template_archived: Boolean(row.template_archived_at),
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
  const row = ownedOr404(req);
  if (!row.is_active) {
    return res.json({ id: row.id, status: 'ended', already: true });
  }
  q.terminate.run(nowIso(), row.id);
  log.info('session.terminated', { session: row.id, instructor: req.instructor.id });
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
  const row = ownedOr404(req);
  if (!row.is_active) throw httpError(409, 'Cannot extend an ended session');
  const base = Math.max(parseUtc(row.expires_at), Date.now());
  const expiresAt = new Date(base + minutes * 60_000).toISOString();
  q.extend.run(expiresAt, row.id);
  log.info('session.extended', { session: row.id, minutes, instructor: req.instructor.id });
  res.json({ id: row.id, expires_at: expiresAt });
});

/**
 * POST /api/sessions/:id/push-template — copy the template's LATEST version
 * into this live session. Participants pick it up on their next content load
 * (the status poll reports template_version so the client reloads promptly).
 * Checkpoints already cleared are re-evaluated against the new structure, so
 * a reordered manual can move participants forwards or backwards — the UI
 * warns before calling this.
 */
router.post('/:id/push-template', (req, res) => {
  const row = ownedOr404(req);
  if (!row.is_active) throw httpError(409, 'Cannot update an ended session');
  if (!row.template_id) throw httpError(409, 'The master template was deleted; nothing to push');
  const result = snapshotTemplateIntoSession(row.id, row.template_id);
  log.info('session.template.pushed', {
    session: row.id,
    version: result.version,
    instructor: req.instructor.id,
  });
  res.json({ id: row.id, template_version: result.version, section_count: result.section_count });
});

/** DELETE /api/sessions/:id — permanently delete a session and its data. */
router.delete('/:id', (req, res) => {
  const row = ownedOr404(req);
  // Participants cascade-delete via the FK. The room code (if it was active) is
  // freed for reuse.
  q.remove.run(row.id);
  log.warn('session.deleted', { session: row.id, instructor: req.instructor.id });
  res.status(204).end();
});

/**
 * GET /api/sessions/:id/export — full session data for archival/reporting.
 * Returns a JSON document (meta + per-participant analytics). Works for
 * sessions whose master template has since been archived or deleted, because
 * the session carries its own copy.
 */
router.get('/:id/export', (req, res) => {
  const row = ownedOr404(req);
  const sections = JSON.parse(row.content);
  const captureNames = captureNamesOf(sections);

  // Self-describing index of the manual so consumers (and the CSV builder)
  // can lay out uniform per-section / per-checkpoint columns without parsing
  // the template themselves.
  const sectionIndex = sections.map((sec, i) => ({
    index: i,
    number: i + 1,
    title: sec.title || `Section ${i + 1}`,
    step_count: (sec.steps || []).length,
  }));
  const checkpointIndex = [];
  sections.forEach((sec, si) => {
    (sec.steps || []).forEach((step, sti) => {
      if (!stepHasCheckpoint(step)) return;
      checkpointIndex.push({
        key: `${si}.${sti}`,
        section_number: si + 1,
        step_number: sti + 1,
        section_title: sec.title || `Section ${si + 1}`,
        step_title: step.title || `Step ${sti + 1}`,
        prompt: step.checkpoint.prompt || 'Enter the value to continue',
        mode: checkpointMode(step),
        capture: step.checkpoint.capture || null,
      });
    });
  });

  const participants = q.participants.all(row.id).map((p) => {
    const d = participantDetail(p, sections);
    return {
      number: d.seat_number,
      first_name: p.first_name,
      last_name: p.last_name,
      name: d.name,
      // One key per captured variable (empty string until the seat gets there),
      // so every row has the same columns.
      captured: Object.fromEntries(captureNames.map((n) => [n, d.captured[n] ?? ''])),
      current_section: d.current_section + 1,
      sections_completed: d.completed_sections,
      total_sections: sections.length,
      progress_pct: d.progress_pct,
      checkpoints_cleared: d.completed_checkpoints.length,
      hints_taken: d.hints.length,
      solutions_revealed: d.solutions.length,
      wrong_attempts: d.wrong_attempts,
      complete: d.complete,
      completed_at: d.completed_at,
      finished: d.finished,
      finished_at: p.finished_at,
      total_seconds: d.total_seconds,
      joined_at: p.joined_at,
      last_seen_at: p.last_seen_at,
      // Time spent per section, in manual order (seconds; the open visit of an
      // in-progress seat is included up to export time).
      section_seconds: d.section_seconds,
      section_times: d.section_times.map((t) => ({
        number: t.index + 1,
        title: t.title,
        seconds: t.seconds,
        cleared: t.cleared,
      })),
      // Every checkpoint in the manual with what this seat typed: the accepted
      // answer (as typed) and each incorrect attempt with its timestamp.
      checkpoints: d.checkpoints.map((c) => ({
        key: c.key,
        section_number: c.section_index + 1,
        step_number: c.step_index + 1,
        step_title: c.step_title,
        mode: c.mode,
        capture: c.capture,
        cleared: c.cleared,
        cleared_at: c.cleared_at,
        accepted_answer: c.accepted_answer,
        attempt_count: c.attempt_count,
        wrong_attempts: c.wrong_attempts.map((a) => ({ answer: a.answer, at: a.at })),
      })),
      hints_opened: d.hints.map((h) => ({
        section_number: h.section_index + 1,
        step_number: h.step_index + 1,
        step_title: h.step_title,
        hint_index: h.hint_index + 1,
        label: h.label,
      })),
      solutions_revealed_list: d.solutions.map((x) => ({
        section_number: x.section_index + 1,
        step_number: x.step_index + 1,
        step_title: x.step_title,
      })),
    };
  });

  // Flat chronological attempt log across the whole class — one row per
  // submission — for spreadsheet analysis ("which checkpoint tripped people up").
  const attempts = [];
  for (const pr of participants) {
    for (const c of pr.checkpoints) {
      for (const a of c.wrong_attempts) {
        attempts.push({
          at: a.at,
          number: pr.number,
          name: pr.name,
          checkpoint: c.key,
          section_number: c.section_number,
          step_number: c.step_number,
          step_title: c.step_title,
          answer: a.answer,
          correct: false,
        });
      }
      if (c.cleared && c.cleared_at) {
        attempts.push({
          at: c.cleared_at,
          number: pr.number,
          name: pr.name,
          checkpoint: c.key,
          section_number: c.section_number,
          step_number: c.step_number,
          step_title: c.step_title,
          answer: c.accepted_answer,
          correct: true,
        });
      }
    }
  }
  attempts.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.number - b.number);

  res.json({
    exported_at: nowIso(),
    session: {
      id: row.id,
      title: row.title,
      room_code: row.room_code,
      template_title: row.template_title,
      template_version: row.template_version,
      status: sessionStatus(row),
      section_count: sections.length,
      capture_names: captureNames,
      created_at: row.created_at,
      expires_at: row.expires_at,
      ended_at: row.ended_at,
    },
    sections: sectionIndex,
    checkpoints: checkpointIndex,
    participants,
    attempts,
  });
});

export { sessionStatus };
export default router;
