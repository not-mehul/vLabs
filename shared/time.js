/**
 * Timestamp parsing shared by the server and the portal.
 *
 * SQLite's datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS" (no timezone
 * marker), whereas values computed in JS are ISO-8601 ("...T...Z"). Both are
 * read here as real UTC.
 */

/** Parse a timestamp that may be SQLite-flavoured or ISO-8601 into epoch ms. */
export function parseUtc(value) {
  if (!value) return NaN;
  const str = String(value).trim();
  if (str.includes('T')) {
    // ISO-8601. If it carries no explicit zone (Z or ±HH:MM), treat it as UTC
    // rather than letting Date interpret it in the local timezone.
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(str);
    return new Date(hasZone ? str : `${str}Z`).getTime();
  }
  // SQLite "YYYY-MM-DD HH:MM:SS" is UTC; make it explicit.
  return new Date(str.replace(' ', 'T') + 'Z').getTime();
}
