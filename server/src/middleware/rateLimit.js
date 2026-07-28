import rateLimit from 'express-rate-limit';
import { bearer } from '../lib/tokens.js';

/**
 * Layered rate limiting = the spec's "Rate Limiting & Anti-Scraping".
 *
 * A whole classroom typically sits behind ONE shared NAT/public IP, so keying
 * limits purely by IP would throttle the entire class as if it were a single
 * abusive client. Authenticated traffic is therefore keyed by the bearer token
 * (i.e. per seat / per instructor); only anonymous traffic falls back to IP.
 *
 * - apiLimiter:       broad ceiling, per token when authenticated else per IP.
 * - joinLimiter:      per-IP ceiling on room-code guessing, but only FAILED
 *                     joins count — a class registering with the real code is
 *                     never throttled, while code enumeration still is.
 * - checkpointLimiter:per-seat throttle on unlock-string guessing.
 * - contentLimiter:   per-seat cap on rendered-step pulls, blunting scraping.
 * - loginLimiter:     per-IP, failed instructor logins only.
 */

const common = {
  standardHeaders: true,
  legacyHeaders: false,
};

/**
 * Key authenticated requests by their bearer token (unique per seat / per
 * instructor) so shared-IP classrooms aren't rate-limited as one client. Falls
 * back to the client IP (already normalised via `trust proxy`) for anonymous
 * requests. The built-in `ip` validation is disabled because the IP branch is
 * an intentional fallback here, not the primary key.
 */
function tokenOrIpKey(req) {
  const token = bearer(req);
  return token ? `tok:${token}` : req.ip;
}

const perSeat = {
  keyGenerator: tokenOrIpKey,
  validate: { ip: false },
};

export const apiLimiter = rateLimit({
  ...common,
  ...perSeat,
  windowMs: 60_000,
  max: 300,
  message: { error: 'Too many requests. Please slow down.' },
});

export const joinLimiter = rateLimit({
  ...common,
  windowMs: 5 * 60_000,
  max: 20,
  // Only failed attempts (invalid/expired code -> 4xx) count, so an entire
  // class joining with the correct code is never throttled.
  skipSuccessfulRequests: true,
  message: {
    error: 'Too many join attempts. Wait a few minutes and try again.',
  },
});

export const loginLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try again later.' },
});

export const checkpointLimiter = rateLimit({
  ...common,
  ...perSeat,
  windowMs: 60_000,
  max: 30,
  message: { error: 'Too many checkpoint attempts. Slow down.' },
});

export const contentLimiter = rateLimit({
  ...common,
  ...perSeat,
  windowMs: 60_000,
  max: 120,
  message: { error: 'Content requests throttled (anti-scraping).' },
});
