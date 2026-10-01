import rateLimit from 'express-rate-limit';
import { bearer, identifyToken } from '../lib/tokens.js';

/**
 * Layered rate limiting = the spec's "Rate Limiting & Anti-Scraping".
 *
 * A whole classroom typically sits behind ONE shared NAT/public IP, so keying
 * limits purely by IP would throttle the entire class as if it were a single
 * abusive client. Authenticated traffic is therefore keyed by VERIFIED
 * identity (participant id / instructor id); anonymous traffic falls back to
 * the client IP.
 *
 * Why verified identity and not the bearer string: keying on the raw header
 * let any client obtain a fresh bucket per garbage token, and a participant
 * could re-join (which mints a new token for the SAME seat) to reset the
 * per-seat checkpoint-guessing and content-scraping limits. Both bypasses are
 * closed by keying on the identity inside a signature-checked token.
 *
 * - apiLimiter:        broad ceiling on the whole API, per identity else per IP.
 * - joinFailLimiter:   per-IP ceiling on room-code guessing; only FAILED joins
 *                      count, so a class registering with the real code is
 *                      never throttled while code enumeration still is.
 * - joinFloodLimiter:  per-IP ceiling on ALL joins (successful included) so
 *                      token minting can't be used as a flood vector. Generous
 *                      enough for a 100-seat class behind one NAT.
 * - loginLimiter:      per-IP, failed instructor logins only.
 * - checkpointLimiter: per-seat throttle on unlock-string guessing.
 * - contentLimiter:    per-seat cap on rendered-content pulls / status polls.
 * - actionLimiter:     per-seat cap on hint / progress / solution / finish.
 *
 * The per-seat limiters MUST be mounted after requireParticipant (they key on
 * req.participant.id).
 */

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  // We intentionally key on identity or the (trust-proxy-normalised) req.ip.
  // Disable the library's key/IP heuristics that assume the default keying.
  validate: {
    ip: false,
    trustProxy: false,
    xForwardedForHeader: false,
    keyGeneratorIpFallback: false,
  },
};

/** IPv6 clients get a /64 bucket so one host can't rotate through its prefix. */
function ipKey(req) {
  const ip = req.ip || 'unknown';
  if (ip.includes(':') && !ip.includes('.')) {
    return `ip6:${ip.split(':').slice(0, 4).join(':')}`;
  }
  return `ip:${ip}`;
}

/** Verified identity when the bearer token checks out, else the client IP. */
function identityOrIpKey(req) {
  const id = identifyToken(bearer(req));
  if (id) return id.kind === 'participant' ? `p:${id.session}:${id.id}` : `i:${id.id}`;
  return ipKey(req);
}

/** For routes mounted after requireParticipant: key on the loaded seat. */
function seatKey(req) {
  return req.participant ? `seat:${req.participant.session_id}:${req.participant.id}` : ipKey(req);
}

export const apiLimiter = rateLimit({
  ...common,
  keyGenerator: identityOrIpKey,
  windowMs: 60_000,
  limit: 300,
  message: { error: 'Too many requests. Please slow down.' },
});

export const joinFailLimiter = rateLimit({
  ...common,
  keyGenerator: ipKey,
  windowMs: 5 * 60_000,
  limit: 20,
  // Only failed attempts (invalid/expired code -> 4xx) count, so an entire
  // class joining with the correct code is never throttled.
  skipSuccessfulRequests: true,
  message: {
    error: 'Too many join attempts. Wait a few minutes and try again.',
  },
});

export const joinFloodLimiter = rateLimit({
  ...common,
  keyGenerator: ipKey,
  windowMs: 5 * 60_000,
  limit: 300,
  message: { error: 'Too many join requests from this network. Try again shortly.' },
});

export const loginLimiter = rateLimit({
  ...common,
  keyGenerator: ipKey,
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try again later.' },
});

export const checkpointLimiter = rateLimit({
  ...common,
  keyGenerator: seatKey,
  windowMs: 60_000,
  limit: 30,
  message: { error: 'Too many checkpoint attempts. Slow down.' },
});

export const contentLimiter = rateLimit({
  ...common,
  keyGenerator: seatKey,
  windowMs: 60_000,
  limit: 120,
  message: { error: 'Content requests throttled (anti-scraping).' },
});

export const actionLimiter = rateLimit({
  ...common,
  keyGenerator: seatKey,
  windowMs: 60_000,
  limit: 120,
  message: { error: 'Too many requests. Please slow down.' },
});

// Backwards-compatible alias (older code imported `joinLimiter`).
export const joinLimiter = joinFailLimiter;
