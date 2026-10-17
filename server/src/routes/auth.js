import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import db, { checkpoint } from '../db/index.js';
import config from '../config.js';
import { signInstructorToken, verifyInstructorToken, bearer } from '../lib/tokens.js';
import { requireInstructor } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { nowIso } from '../lib/time.js';
import { log } from '../lib/logger.js';

const router = Router();

const q = {
  byUsername: db.prepare('SELECT * FROM instructors WHERE username = ?'),
  byId: db.prepare('SELECT * FROM instructors WHERE id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM instructors'),
  list: db.prepare(
    `SELECT i.id, i.username, i.created_at, i.password_changed_at,
            (SELECT COUNT(*) FROM sessions s WHERE s.instructor_id = i.id) AS session_count,
            (SELECT COUNT(*) FROM sessions s WHERE s.instructor_id = i.id AND s.is_active = 1)
              AS active_session_count
       FROM instructors i ORDER BY i.username COLLATE NOCASE`,
  ),
  insert: db.prepare(
    'INSERT INTO instructors (username, password_hash, password_changed_at) VALUES (?, ?, NULL)',
  ),
  setPassword: db.prepare(
    `UPDATE instructors
        SET password_hash = ?, token_version = token_version + 1, password_changed_at = ?
      WHERE id = ?`,
  ),
  // An admin reset: new temporary password, every sign-in revoked, and
  // password_changed_at cleared so the owner is asked to pick their own.
  resetPassword: db.prepare(
    `UPDATE instructors
        SET password_hash = ?, token_version = token_version + 1, password_changed_at = NULL
      WHERE id = ?`,
  ),
  reassignSessions: db.prepare('UPDATE sessions SET instructor_id = ? WHERE instructor_id = ?'),
  remove: db.prepare('DELETE FROM instructors WHERE id = ?'),
  firstId: db.prepare('SELECT MIN(id) AS id FROM instructors'),
};

/**
 * The admin account: the bootstrap instructor (SEED_INSTRUCTOR_USERNAME,
 * "instructor" by default), or the oldest account if that one no longer
 * exists. Only the admin can reset or remove other instructors' accounts;
 * anyone can add one or change their own password.
 */
function adminId() {
  const seed = q.byUsername.get(config.seedInstructor.username);
  return seed ? seed.id : q.firstId.get().id;
}

const isAdmin = (id) => id === adminId();

function requireAdmin(req) {
  if (!isAdmin(req.instructor.id)) {
    throw httpError(403, 'Only the admin account can do this', 'ADMIN_ONLY');
  }
}

// A real bcrypt hash of a random value, computed once at boot, so a login
// attempt for an unknown username costs the same as one for a known user.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

const USERNAME_RE = /^[A-Za-z0-9._-]{2,64}$/;

/**
 * True while the account still uses a password somebody else chose: the
 * bootstrap password from .env / the installer, or a temporary one set by
 * another instructor. Cleared the first time the owner changes it.
 */
const mustChangePassword = (row) => !row.password_changed_at;

function publicInstructor(row) {
  return {
    id: row.id,
    username: row.username,
    must_change_password: mustChangePassword(row),
    password_changed_at: row.password_changed_at,
    is_admin: isAdmin(row.id),
  };
}

function validatePassword(pw) {
  if (pw.length < config.minPasswordLength) {
    throw httpError(400, `Password must be at least ${config.minPasswordLength} characters`);
  }
  if (pw.length > 200) throw httpError(400, 'Password is too long');
}

/** 16 URL-safe characters ≈ 95 bits; comfortably above MIN_PASSWORD_LENGTH. */
const randomPassword = () => crypto.randomBytes(12).toString('base64url');

/** Check a username/password pair; returns the instructor row or null. */
async function checkCredentials(username, password) {
  const instructor = q.byUsername.get(String(username ?? '').trim());
  const ok = await bcrypt.compare(
    String(password ?? ''),
    instructor ? instructor.password_hash : DUMMY_HASH,
  );
  return instructor && ok ? instructor : null;
}

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
    const instructor = await checkCredentials(username, password);
    if (!instructor) {
      log.warn('auth.login.failed', { username: String(username).slice(0, 64), ip: req.ip });
      throw httpError(401, 'Invalid credentials');
    }
    const token = signInstructorToken(instructor);
    log.info('auth.login', { instructor: instructor.id });
    res.json({ token, instructor: publicInstructor(instructor) });
  }),
);

/**
 * GET /api/auth/me
 * Returns the authenticated instructor (token sanity check for the SPA).
 */
router.get('/me', requireInstructor, (req, res) => {
  res.json({ instructor: publicInstructor(q.byId.get(req.instructor.id)) });
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
    validatePassword(next);
    if (next === current) throw httpError(400, 'New password must differ from the current one');

    const row = q.byId.get(req.instructor.id);
    const ok = await bcrypt.compare(current, row.password_hash);
    if (!ok) throw httpError(401, 'Current password is incorrect');

    const hash = await bcrypt.hash(next, 10);
    q.setPassword.run(hash, nowIso(), row.id);
    checkpoint();
    const fresh = q.byId.get(row.id);
    log.info('auth.password.changed', { instructor: row.id });
    res.json({ ok: true, token: signInstructorToken(fresh), instructor: publicInstructor(fresh) });
  }),
);

/* -------------------------------------------------------------------------- */
/*  Instructor accounts                                                       */
/* -------------------------------------------------------------------------- */
/*
 * There are no roles: every instructor may manage accounts. Creating an
 * account is authorised EITHER by an instructor bearer token (the portal's
 * Instructors page) OR by an existing instructor's username + password in the
 * body (`authorize`) — the latter backs the unlinked page reachable from the
 * sign-in screen, so a colleague can be added without first opening a portal
 * session. Either way an existing account vouches for the new one.
 */

/** Resolve the acting instructor from a bearer token or inline credentials. */
async function actingInstructor(req) {
  const token = bearer(req);
  if (token) {
    let claims;
    try {
      claims = verifyInstructorToken(token);
    } catch {
      throw httpError(401, 'Invalid or expired token');
    }
    const row = q.byId.get(Number(claims.sub));
    if (!row || (claims.tv ?? 0) !== (row.token_version ?? 0)) {
      throw httpError(401, 'Session expired — please sign in again', 'TOKEN_REVOKED');
    }
    return row;
  }
  const auth = req.body?.authorize || {};
  if (!auth.username || !auth.password) {
    throw httpError(401, "Sign in, or enter an existing instructor's username and password");
  }
  const row = await checkCredentials(auth.username, auth.password);
  if (!row) {
    log.warn('auth.instructor.create.denied', {
      username: String(auth.username).slice(0, 64),
      ip: req.ip,
    });
    throw httpError(401, 'The authorising username or password is incorrect');
  }
  return row;
}

/** GET /api/auth/instructors — every account with its session counts. */
router.get('/instructors', requireInstructor, (req, res) => {
  const admin = adminId();
  res.json(
    q.list.all().map((r) => ({
      id: r.id,
      username: r.username,
      created_at: r.created_at,
      password_changed_at: r.password_changed_at,
      must_change_password: mustChangePassword(r),
      session_count: r.session_count,
      active_session_count: r.active_session_count,
      is_me: r.id === req.instructor.id,
      is_admin: r.id === admin,
    })),
  );
});

/**
 * POST /api/auth/instructors
 * Body: { username, password?, authorize?: { username, password } }
 * Creates an instructor. With no password a temporary one is generated and
 * returned ONCE. The new account is asked to change it at first sign-in.
 */
router.post(
  '/instructors',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const actor = await actingInstructor(req);
    const username = String(req.body?.username ?? '').trim();
    if (!USERNAME_RE.test(username)) {
      throw httpError(
        400,
        'Username must be 2–64 characters: letters, digits, dot, dash or underscore',
      );
    }
    if (q.byUsername.get(username)) throw httpError(409, `Instructor "${username}" already exists`);
    const supplied = req.body?.password ? String(req.body.password) : '';
    if (supplied) validatePassword(supplied);
    const password = supplied || randomPassword();

    const info = q.insert.run(username, await bcrypt.hash(password, 10));
    checkpoint();
    log.info('auth.instructor.created', {
      instructor: Number(info.lastInsertRowid),
      by: actor.id,
    });
    const row = q.byId.get(info.lastInsertRowid);
    res.status(201).json({
      instructor: publicInstructor(row),
      // Only echoed when generated; a chosen password is never sent back.
      temporary_password: supplied ? null : password,
    });
  }),
);

/**
 * POST /api/auth/instructors/:id/reset-password
 * Admin only. Issues a new temporary password (returned once) and signs that
 * instructor out everywhere. Resetting your own account is refused — use PUT /password.
 */
router.post(
  '/instructors/:id/reset-password',
  requireInstructor,
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const row = q.byId.get(Number(req.params.id));
    if (!row) throw httpError(404, 'Instructor not found');
    if (row.id === req.instructor.id) {
      throw httpError(400, 'Change your own password under Your password on the Admin page');
    }
    const password = randomPassword();
    q.resetPassword.run(await bcrypt.hash(password, 10), row.id);
    checkpoint();
    log.info('auth.instructor.reset', { instructor: row.id, by: req.instructor.id });
    res.json({ instructor: publicInstructor(q.byId.get(row.id)), temporary_password: password });
  }),
);

/**
 * DELETE /api/auth/instructors/:id
 * Admin only. Removes an account. Its sessions (and their participant data) are handed to
 * the acting instructor rather than cascade-deleted. You cannot remove
 * yourself, so at least one account always remains.
 */
router.delete('/instructors/:id', requireInstructor, (req, res) => {
  requireAdmin(req);
  const row = q.byId.get(Number(req.params.id));
  if (!row) throw httpError(404, 'Instructor not found');
  if (row.id === req.instructor.id) throw httpError(400, 'You cannot remove your own account');
  if (q.count.get().n <= 1) throw httpError(400, 'At least one instructor must remain');
  const moved = db.transaction(() => {
    const { changes } = q.reassignSessions.run(req.instructor.id, row.id);
    q.remove.run(row.id);
    return changes;
  })();
  checkpoint();
  log.warn('auth.instructor.removed', {
    instructor: row.id,
    by: req.instructor.id,
    sessions_reassigned: moved,
  });
  res.json({ ok: true, sessions_reassigned: moved });
});

export default router;
