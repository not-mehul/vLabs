import db from '../db/index.js';
import config from '../config.js';
import { log } from './logger.js';

const q = {
  sweep: db.prepare(
    `UPDATE sessions SET is_active = 0, ended_at = expires_at
      WHERE is_active = 1 AND expires_at < ?`,
  ),
  template: db.prepare('SELECT id, title, content, variables, version FROM templates WHERE id = ?'),
  push: db.prepare(
    `UPDATE sessions
        SET content = ?, variables = ?, template_version = ?, template_title = ?
      WHERE id = ?`,
  ),
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
  const { changes } = q.sweep.run(cutoff);
  if (changes) log.info('sessions.swept', { ended: changes, cutoff });
  return changes;
}

/**
 * Copy the CURRENT master template (title/content/variables/version) into a
 * session. Used at launch and by the instructor's "push latest version".
 * Participant progress keys (section.step) are recomputed against the new
 * content on their next request; section pointers are clamped so nobody is
 * left pointing past the end of a shorter manual.
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
  const tx = db.transaction(() => {
    q.push.run(t.content, t.variables, t.version, t.title, sessionId);
    q.clampParticipants.run(lastIndex, lastIndex, sessionId);
  });
  tx();
  return { version: t.version, section_count: sections.length, title: t.title };
}
