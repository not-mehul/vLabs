/**
 * Timestamp helpers for the client.
 *
 * The API returns timestamps in two shapes: SQLite's "YYYY-MM-DD HH:MM:SS"
 * (UTC, no marker) for column defaults, and ISO-8601 ("...T...Z") for values
 * computed in JS. Both are normalised here so dates always render correctly.
 */

export function parseUtc(value) {
  if (!value) return NaN;
  const s = String(value);
  if (s.includes('T')) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}

/** Format a timestamp as a locale date-time, or a dash when absent/invalid. */
export function formatDateTime(value, fallback = '—') {
  const ms = parseUtc(value);
  return Number.isNaN(ms) ? fallback : new Date(ms).toLocaleString();
}
