/**
 * Timestamp helpers.
 *
 * SQLite's datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS" (no timezone
 * marker), whereas values we compute in JS are ISO-8601 ("...T...Z"). This
 * module normalises both so all comparisons happen in real UTC.
 */

/** Parse a timestamp that may be SQLite-flavoured or ISO-8601 into epoch ms. */
export function parseUtc(value) {
  if (!value) return NaN;
  const str = String(value).trim();
  if (str.includes('T')) {
    // ISO-8601. If it carries no explicit zone (Z or ±HH:MM), treat it as UTC
    // rather than letting Date interpret it in the server's local timezone.
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(str);
    return new Date(hasZone ? str : `${str}Z`).getTime();
  }
  // SQLite "YYYY-MM-DD HH:MM:SS" is UTC; make it explicit.
  return new Date(str.replace(' ', 'T') + 'Z').getTime();
}

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
