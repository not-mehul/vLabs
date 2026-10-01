import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import db from '../db/index.js';
import config from '../config.js';
import { signInstructorToken } from '../lib/tokens.js';
import { requireInstructor } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { nowIso } from '../lib/time.js';
import { log } from '../lib/logger.js';

const router = Router();

const q = {
  byUsername: db.prepare('SELECT * FROM instructors WHERE username = ?'),
  byId: db.prepare('SELECT * FROM instructors WHERE id = ?'),
  setPassword: db.prepare(
    `UPDATE instructors
        SET password_hash = ?, token_version = token_version + 1, password_changed_at = ?
      WHERE id = ?`,
  ),
};

// A real bcrypt hash of a random value, computed once at boot, so a login
// attempt for an unknown username costs the same as one for a known user.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

/**
 * POST /api/auth/login
 * Instructor authentication. Returns a bearer token for the authoring/monitor
 * portal.
 */
router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      throw httpError(400, 'Username and password are required');
    }
    const instructor = q.byUsername.get(String(username).trim());

    // Constant-ish work regardless of whether the user exists.
    const ok = await bcrypt.compare(String(password), instructor ? instructor.password_hash : DUMMY_HASH);

    if (!instructor || !ok) {
      log.warn('auth.login.failed', { username: String(username).slice(0, 64), ip: req.ip });
      throw httpError(401, 'Invalid credentials');
    }
    const token = signInstructorToken(instructor);
    log.info('auth.login', { instructor: instructor.id });
    res.json({
      token,
      instructor: {
        id: instructor.id,
        username: instructor.username,
        // Nudge the UI to prompt for a change while the bootstrap password is in use.
        must_change_password: !instructor.password_changed_at && config.seedPasswordIsDefault,
      },
    });
  }),
);

/**
 * GET /api/auth/me
 * Returns the authenticated instructor (token sanity check for the SPA).
 */
router.get('/me', requireInstructor, (req, res) => {
  const row = q.byId.get(req.instructor.id);
  res.json({
    instructor: {
      id: row.id,
      username: row.username,
      must_change_password: !row.password_changed_at && config.seedPasswordIsDefault,
      password_changed_at: row.password_changed_at,
    },
  });
});

/**
 * PUT /api/auth/password
 * Body: { current_password, new_password }
 * Changes the instructor's password and bumps token_version, which revokes
 * every previously issued instructor token (including other browsers). The
 * response carries a fresh token so the current portal session continues.
 */
router.put(
  '/password',
  requireInstructor,
  asyncHandler(async (req, res) => {
    const current = String(req.body?.current_password ?? '');
    const next = String(req.body?.new_password ?? '');
    if (!current || !next) throw httpError(400, 'Current and new password are required');
    if (next.length < config.minPasswordLength) {
      throw httpError(400, `New password must be at least ${config.minPasswordLength} characters`);
    }
    if (next.length > 200) throw httpError(400, 'New password is too long');
    if (next === current) throw httpError(400, 'New password must differ from the current one');

    const row = q.byId.get(req.instructor.id);
    const ok = await bcrypt.compare(current, row.password_hash);
    if (!ok) throw httpError(401, 'Current password is incorrect');

    const hash = await bcrypt.hash(next, 10);
    q.setPassword.run(hash, nowIso(), row.id);
    const fresh = q.byId.get(row.id);
    log.info('auth.password.changed', { instructor: row.id });
    res.json({
      ok: true,
      token: signInstructorToken(fresh),
      instructor: { id: fresh.id, username: fresh.username, must_change_password: false },
    });
  }),
);

export default router;
