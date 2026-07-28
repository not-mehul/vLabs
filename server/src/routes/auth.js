import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { signInstructorToken } from '../lib/tokens.js';
import { requireInstructor } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';

const router = Router();

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
    const instructor = db
      .prepare('SELECT * FROM instructors WHERE username = ?')
      .get(String(username).trim());

    // Constant-ish work regardless of whether the user exists.
    const hash = instructor
      ? instructor.password_hash
      : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(String(password), hash);

    if (!instructor || !ok) {
      throw httpError(401, 'Invalid credentials');
    }
    const token = signInstructorToken(instructor);
    res.json({
      token,
      instructor: { id: instructor.id, username: instructor.username },
    });
  }),
);

/**
 * GET /api/auth/me
 * Returns the authenticated instructor (token sanity check for the SPA).
 */
router.get('/me', requireInstructor, (req, res) => {
  res.json({ instructor: req.instructor });
});

export default router;
