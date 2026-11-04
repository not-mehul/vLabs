/**
 * Timestamp helpers. Parsing (SQLite and ISO-8601, both as UTC) lives in
 * shared/time.js so the portal reads timestamps exactly as the server does.
 */
import { parseUtc } from '../../../shared/time.js';

export { parseUtc };

/** Current time as an ISO-8601 UTC string. */
export function nowIso() {
  return new Date().toISOString();
}

/** ISO-8601 UTC string `minutes` from now. */
export function isoInMinutes(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Whole seconds elapsed between two timestamps (any supported format). */
export function secondsBetween(from, to = nowIso()) {
  const a = parseUtc(from);
  const b = parseUtc(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 1000));
}
