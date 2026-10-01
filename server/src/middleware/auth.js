import db from '../db/index.js';
import { verifyInstructorToken, verifyParticipantToken, bearer } from '../lib/tokens.js';
import { parseUtc } from '../lib/time.js';

const q = {
  instructor: db.prepare('SELECT id, username, token_version FROM instructors WHERE id = ?'),
  participant: db.prepare('SELECT * FROM participants WHERE id = ? AND session_id = ?'),
  session: db.prepare('SELECT * FROM sessions WHERE id = ?'),
};

/** Guard instructor-only routes. */
export function requireInstructor(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let claims;
  try {
    claims = verifyInstructorToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Database errors from here on are real 500s, not auth failures — let them
  // reach the error handler instead of masquerading as "invalid token".
  const instructor = q.instructor.get(Number(claims.sub));
  if (!instructor) {
    return res.status(401).json({ error: 'Instructor no longer exists' });
  }
  // Password changes bump token_version; older tokens are rejected.
  if ((claims.tv ?? 0) !== (instructor.token_version ?? 0)) {
    return res.status(401).json({ error: 'Session expired — please sign in again', code: 'TOKEN_REVOKED' });
  }
  req.instructor = { id: instructor.id, username: instructor.username };
  next();
}

/**
 * Guard participant routes. Beyond verifying the JWT signature this re-validates
 * the live session on every request:
 *   - session must still exist and be is_active = 1
 *   - session must not be past expires_at
 *   - the participant (seat) record must still exist
 * Any failure -> 401/403, giving instructors an immediate kill-switch.
 */
export function requireParticipant(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let claims;
  try {
    claims = verifyParticipantToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const participant = q.participant.get(Number(claims.sub), claims.session);
  if (!participant) {
    return res.status(401).json({ error: 'Seat is no longer registered', code: 'SEAT_REMOVED' });
  }

  const session = q.session.get(claims.session);

  if (!session || !session.is_active) {
    return res
      .status(403)
      .json({ error: 'This session has ended. Access revoked.', code: 'SESSION_ENDED' });
  }
  if (parseUtc(session.expires_at) < Date.now()) {
    return res
      .status(403)
      .json({ error: 'This session has expired. Access revoked.', code: 'SESSION_EXPIRED' });
  }

  req.participant = participant;
  req.session = session;
  next();
}
