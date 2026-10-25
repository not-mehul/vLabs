import db from '../db/index.js';
import { nowIso } from './time.js';

/**
 * Helpers shared by the participant routes (labs, routes/participant.js;
 * exams, routes/exam.js).
 */

const q = {
  byId: db.prepare('SELECT * FROM participants WHERE id = ?'),
  // Presence heartbeat, written at most every TOUCH_EVERY_MS per seat: with
  // synchronous=FULL every write is an fsync, and status polls would otherwise
  // add a write per seat every 15 s for no information gain.
  touch: db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?'),
};

const TOUCH_EVERY_MS = 10_000;

/** Record presence (throttled; see q.touch). */
export function touchSeat(id, now = nowIso()) {
  q.touch.run(now, id, new Date(Date.parse(now) - TOUCH_EVERY_MS).toISOString());
}

/** No-store headers so rendered content is never cached to disk. */
export function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
}

/**
 * The participant row as it is NOW. req.participant was loaded by the auth
 * guard before the (async) rate limiter ran; handlers that read-modify-write
 * JSON columns re-read it so two near-simultaneous requests from one seat can
 * never overwrite each other's change.
 */
export const freshSeat = (req) => q.byId.get(req.participant.id) || req.participant;
