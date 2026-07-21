import rateLimit from 'express-rate-limit';

/**
 * Layered rate limiting = the spec's "Rate Limiting & Anti-Scraping".
 *
 * - apiLimiter:       broad ceiling on every /api call.
 * - joinLimiter:      tight ceiling on room-code guessing (brute-force defence
 *                     against the 6-digit code space).
 * - checkpointLimiter:throttles unlock-string guessing.
 * - contentLimiter:   caps how fast a seat can pull rendered lab steps, blunting
 *                     automated scraping of the manual.
 * - loginLimiter:     protects instructor credentials.
 */

const common = {
  standardHeaders: true,
  legacyHeaders: false,
};

export const apiLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  max: 300,
  message: { error: 'Too many requests. Please slow down.' },
});

export const joinLimiter = rateLimit({
  ...common,
  windowMs: 5 * 60_000,
  max: 15,
  message: {
    error: 'Too many join attempts. Wait a few minutes and try again.',
  },
});

export const loginLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  max: 10,
  message: { error: 'Too many login attempts. Try again later.' },
});

export const checkpointLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  max: 30,
  message: { error: 'Too many checkpoint attempts. Slow down.' },
});

export const contentLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  max: 120,
  message: { error: 'Content requests throttled (anti-scraping).' },
});
