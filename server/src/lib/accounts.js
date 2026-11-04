import crypto from 'node:crypto';
import config from '../config.js';

/**
 * Instructor account rules, shared by the portal (routes/auth.js) and the
 * command-line tool (scripts/instructors.js) so both accept the same names
 * and passwords.
 */

/** bcrypt cost for instructor passwords. */
export const BCRYPT_ROUNDS = 10;

/** Longest password accepted (bcrypt reads at most 72 bytes; this only bounds input). */
const MAX_PASSWORD_LENGTH = 200;

export const USERNAME_RULE =
  'Username must be 2–64 characters: letters, digits, dot, dash or underscore';

/** True for a valid instructor username. */
export const isValidUsername = (u) => typeof u === 'string' && /^[A-Za-z0-9._-]{2,64}$/.test(u);

/** Why a chosen password is refused, or null when it is acceptable. */
export function passwordProblem(pw) {
  if (pw.length < config.minPasswordLength) {
    return `Password must be at least ${config.minPasswordLength} characters`;
  }
  if (pw.length > MAX_PASSWORD_LENGTH) return 'Password is too long';
  return null;
}

/** 16 URL-safe characters ≈ 95 bits; comfortably above the minimum length. */
export const randomPassword = () => crypto.randomBytes(12).toString('base64url');
