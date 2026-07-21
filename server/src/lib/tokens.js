import jwt from 'jsonwebtoken';
import config from '../config.js';

/**
 * Two token audiences with independent secrets:
 *   - "instructor" tokens authenticate the authoring / monitoring portal.
 *   - "participant" tokens authenticate a single seat within a single session.
 *
 * A participant token is only ever a *claim* of identity; every protected
 * participant request additionally re-checks the live session record, so a
 * still-valid JWT is rejected the instant the session is terminated or expires
 * (see middleware/auth.js). This satisfies the spec's "tokens are invalidated
 * immediately" requirement without needing a token blocklist.
 */

export function signInstructorToken(instructor) {
  return jwt.sign(
    { sub: instructor.id, username: instructor.username, role: 'instructor' },
    config.jwt.instructorSecret,
    { expiresIn: config.jwt.instructorTtl },
  );
}

export function verifyInstructorToken(token) {
  return jwt.verify(token, config.jwt.instructorSecret);
}

export function signParticipantToken(participant, session) {
  return jwt.sign(
    {
      sub: participant.id,
      seat: participant.seat_id,
      session: session.id,
      role: 'participant',
    },
    config.jwt.participantSecret,
    { expiresIn: config.jwt.participantTtl },
  );
}

export function verifyParticipantToken(token) {
  return jwt.verify(token, config.jwt.participantSecret);
}

/** Extract a bearer token from an Authorization header. */
export function bearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value ? value : null;
}
