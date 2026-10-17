import db from '../db/index.js';
import config from '../config.js';
import { log } from './logger.js';
import { breaksOf, closeOpenVisit } from './sectionTiming.js';
import { contentRemap, remapParticipant, remapEventKey } from './contentRemap.js';

const q = {
  expired: db.prepare(
    `SELECT id, kind, expires_at, breaks FROM sessions WHERE is_active = 1 AND expires_at < ?`,
  ),
  end: db.prepare('UPDATE sessions SET is_active = 0, ended_at = expires_at WHERE id = ?'),
  openSeats: db.prepare('SELECT * FROM participants WHERE session_id = ? AND submitted_at IS NULL'),
  autoSubmit: db.prepare(
    `UPDATE participants SET submitted_at = ?, completed_at = COALESCE(completed_at, ?),
            finished_at = COALESCE(finished_at, ?), section_times = ?, auto_submitted = 1
      WHERE id = ? AND submitted_at IS NULL`,
  ),
  template: db.prepare('SELECT id, title, content, variables, version FROM templates WHERE id = ?'),
  push: db.prepare(
    `UPDATE sessions
        SET content = ?, variables = ?, template_version = ?, template_title = ?
      WHERE id = ?`,
  ),
  session: db.prepare('SELECT id, kind, content, template_version FROM sessions WHERE id = ?'),
  seats: db.prepare('SELECT * FROM participants WHERE session_id = ?'),
  moveSeat: db.prepare(
    `UPDATE participants
        SET completed_checkpoints = ?, hints_taken = ?, revealed_solutions = ?,
            checkpoint_log = ?, answers = ?, grades = ?, section_times = ?,
            current_section = ?, max_section = ?
      WHERE id = ?`,
  ),
  events: db.prepare(
    `SELECT e.id, e.question_key FROM exam_answer_events e
       JOIN participants p ON p.id = e.participant_id WHERE p.session_id = ?`,
  ),
  moveEvent: db.prepare('UPDATE exam_answer_events SET question_key = ? WHERE id = ?'),
  clampParticipants: db.prepare(
    `UPDATE participants
        SET current_section = MIN(current_section, ?),
            max_section = MIN(max_section, ?)
      WHERE session_id = ?`,
  ),
};

/**
 * Flip sessions that have been past `expires_at` for longer than the grace
 * window to "ended". Until now expired-but-never-terminated sessions kept
 * their room code reserved forever (the partial unique index only frees a
 * code when is_active = 0). The grace window keeps "+30 min" working on a
 * session that just ran out. Cheap enough to call on every session
 * list/create; also run on a timer from index.js.
 *
 * @returns {number} sessions ended by this sweep
 */
export function sweepExpiredSessions(graceMinutes = config.expiredSessionGraceMinutes) {
  const cutoff = new Date(Date.now() - graceMinutes * 60_000).toISOString();
  const rows = q.expired.all(cutoff);
  db.transaction(() => {
    for (const s of rows) {
      q.end.run(s.id);
      // Exams end at their expiry time, as if the instructor had ended them then.
      if (s.kind === 'exam') collectExamSubmissions(s, s.expires_at);
    }
  })();
  if (rows.length) log.info('sessions.swept', { ended: rows.length, cutoff });
  return rows.length;
}

/**
 * When an exam session ends, hand in every exam still open, as it stands at
 * `at`: answers are kept, the section clock stops then, and the seat is
 * flagged auto_submitted so the monitor can tell it apart from a hand-in.
 * Without this an unsubmitted exam stayed "in progress" for good.
 *
 * @returns {number} exams handed in
 */
export function collectExamSubmissions(session, at) {
  const breaks = breaksOf(session);
  let n = 0;
  for (const p of q.openSeats.all(session.id)) {
    const times = closeOpenVisit(p, at, breaks);
    n += q.autoSubmit.run(at, at, at, JSON.stringify(times), p.id).changes;
  }
  if (n) log.info('exam.auto_submitted', { session: session.id, count: n });
  return n;
}

/**
 * Copy the CURRENT master template (title/content/variables/version) into a
 * session. Used at launch and by the instructor's "push latest version".
 * On a push, every participant's progress, answers, marks and timings move
 * with their sections and items (matched by stable id, lib/contentRemap.js),
 * so reordering, inserting or removing never misfiles anyone's work; section
 * pointers are clamped so nobody is left past the end of a shorter manual.
 *
 * @returns {{version:number, section_count:number}}
 */
export function snapshotTemplateIntoSession(sessionId, templateId) {
  const t = q.template.get(templateId);
  if (!t) {
    const err = new Error('Template no longer exists');
    err.status = 409;
    throw err;
  }
  const sections = JSON.parse(t.content);
  const lastIndex = Math.max(sections.length - 1, 0);
  const before = q.session.get(sessionId);
  const tx = db.transaction(() => {
    const remap = before
      ? contentRemap(JSON.parse(before.content || '[]'), sections, before.kind || 'lab')
      : null;
    if (remap) {
      for (const p of q.seats.all(sessionId)) {
        const m = remapParticipant(p, remap);
        q.moveSeat.run(
          m.completed_checkpoints,
          m.hints_taken,
          m.revealed_solutions,
          m.checkpoint_log,
          m.answers,
          m.grades,
          m.section_times,
          m.current_section,
          m.max_section,
          p.id,
        );
      }
      if (before.kind === 'exam') {
        for (const e of q.events.all(sessionId)) {
          const key = remapEventKey(remap, e.question_key, before.template_version);
          if (key !== e.question_key) q.moveEvent.run(key, e.id);
        }
      }
    }
    q.push.run(t.content, t.variables, t.version, t.title, sessionId);
    q.clampParticipants.run(lastIndex, lastIndex, sessionId);
  });
  tx();
  return { version: t.version, section_count: sections.length, title: t.title };
}
