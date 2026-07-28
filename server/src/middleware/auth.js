import db from '../db/index.js';
import {
  verifyInstructorToken,
  verifyParticipantToken,
  bearer,
} from '../lib/tokens.js';
import { parseUtc } from '../lib/time.js';

/** Guard instructor-only routes. */
export function requireInstructor(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const claims = verifyInstructorToken(token);
    const instructor = db
      .prepare('SELECT id, username FROM instructors WHERE id = ?')
      .get(claims.sub);
    if (!instructor) {
      return res.status(401).json({ error: 'Instructor no longer exists' });
    }
    req.instructor = instructor;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
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

  const participant = db
    .prepare('SELECT * FROM participants WHERE id = ? AND session_id = ?')
    .get(claims.sub, claims.session);
  if (!participant) {
    return res.status(401).json({ error: 'Seat is no longer registered' });
  }

  const session = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(claims.session);

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
