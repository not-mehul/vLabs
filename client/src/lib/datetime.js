/**
 * Timestamp helpers for the client. The API returns SQLite ("YYYY-MM-DD
 * HH:MM:SS", UTC) and ISO-8601 timestamps; shared/time.js reads both as UTC,
 * exactly as the server does.
 */
import { parseUtc } from '../../../shared/time.js';

/** Format a timestamp as a locale date-time, or a dash when absent/invalid. */
export function formatDateTime(value, fallback = '—') {
  const ms = parseUtc(value);
  return Number.isNaN(ms) ? fallback : new Date(ms).toLocaleString();
}
