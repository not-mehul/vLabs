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
 *
 * Instructor tokens carry `tv` (the instructor's token_version). Changing the
 * password bumps the version, which invalidates every previously issued token.
 */

const ALG = { algorithms: ['HS256'] };

export function signInstructorToken(instructor) {
  return jwt.sign(
    {
      sub: String(instructor.id),
      username: instructor.username,
      role: 'instructor',
      tv: instructor.token_version ?? 0,
    },
    config.jwt.instructorSecret,
    { expiresIn: config.jwt.instructorTtl, algorithm: 'HS256' },
  );
}

export function verifyInstructorToken(token) {
  const claims = jwt.verify(token, config.jwt.instructorSecret, ALG);
  if (claims.role !== 'instructor') throw new Error('Wrong token audience');
  return claims;
}

export function signParticipantToken(participant, session) {
  return jwt.sign(
    {
      sub: String(participant.id),
      seat: participant.seat_number,
      name: `${participant.first_name} ${participant.last_name}`.trim(),
      session: session.id,
      role: 'participant',
    },
    config.jwt.participantSecret,
    { expiresIn: config.jwt.participantTtl, algorithm: 'HS256' },
  );
}

export function verifyParticipantToken(token) {
  const claims = jwt.verify(token, config.jwt.participantSecret, ALG);
  if (claims.role !== 'participant') throw new Error('Wrong token audience');
  return claims;
}

/** Extract a bearer token from an Authorization header. */
export function bearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value ? value : null;
}

/**
 * Cheaply identify who a request claims to be, VERIFYING the signature first.
 * Used by the rate limiters so buckets are keyed on real identities: keying on
 * the raw header let a client get a fresh bucket per garbage token, and
 * re-joining (which mints a new token for the same seat) reset the
 * per-seat checkpoint/content limits.
 *
 * @returns {{kind:'participant', id:string, session:number}|{kind:'instructor', id:string}|null}
 */
export function identifyToken(token) {
  if (!token) return null;
  // Peek at the unverified role claim only to pick which secret to try first;
  // the signature is always verified before anything is trusted.
  let role = null;
  try {
    role = jwt.decode(token)?.role ?? null;
  } catch {
    role = null;
  }
  const attempts = role === 'instructor' ? ['instructor', 'participant'] : ['participant', 'instructor'];
  for (const kind of attempts) {
    try {
      if (kind === 'participant') {
        const c = verifyParticipantToken(token);
        return { kind, id: String(c.sub), session: c.session };
      }
      const c = verifyInstructorToken(token);
      return { kind, id: String(c.sub) };
    } catch {
      /* try the other audience */
    }
  }
  return null;
}
