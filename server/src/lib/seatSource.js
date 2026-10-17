import db from '../db/index.js';
import { log } from './logger.js';
import { httpError } from '../middleware/errorHandler.js';

/**
 * Exam seats from a lab session.
 *
 * An exam session may name a lab session as its seat source. Someone joining
 * the exam under the same name (compared like a rejoin: lower-cased, spaces
 * collapsed) gets the seat number they had in that lab, so every per-seat
 * formula gives them the same values. Anyone else gets the next number above
 * both the exam's and the lab's highest seat, so they never take a seat a
 * lab participant may still need. The instructor fixes typos and name
 * clashes with "Change seat" on the monitor.
 */

/** Highest seat number an instructor may give by hand. */
export const MAX_SEAT_NUMBER = 999;

const q = {
  labSeat: db.prepare('SELECT seat_number FROM participants WHERE session_id = ? AND name_key = ?'),
  labSeats: db.prepare('SELECT name_key, seat_number FROM participants WHERE session_id = ?'),
  maxSeat: db.prepare(
    'SELECT COALESCE(MAX(seat_number), 0) AS maxSeat FROM participants WHERE session_id = ?',
  ),
  seatHolder: db.prepare(
    'SELECT id, first_name, last_name FROM participants WHERE session_id = ? AND seat_number = ?',
  ),
  source: db.prepare(
    'SELECT id, title, room_code, created_at, instructor_id, kind FROM sessions WHERE id = ?',
  ),
};

/** The participant holding `seat` in a session, or undefined. */
export function seatHolder(sessionId, seat) {
  return q.seatHolder.get(sessionId, seat);
}

/**
 * The seat number for a NEW participant (call inside the join transaction).
 *
 * @param {object} session   the session row being joined
 * @param {string} nameKey   lower-cased "first last"
 * @param {number} maxSeat   the session's current highest seat (0 when empty)
 */
export function nextSeatNumber(session, nameKey, maxSeat) {
  const sourceId = session.seat_source_session_id;
  if (!sourceId) return maxSeat + 1;
  const labSeat = q.labSeat.get(sourceId, nameKey)?.seat_number;
  if (labSeat) {
    if (!seatHolder(session.id, labSeat)) return labSeat;
    // Only possible when a seat was changed by hand, or the lab gained people
    // after newcomers had been given numbers above it.
    log.warn('participant.labseat.taken', { session: session.id, seat: labSeat });
  }
  return Math.max(maxSeat, q.maxSeat.get(sourceId).maxSeat) + 1;
}

/** name_key → lab seat for the session's seat source; null when it has none. */
export function labSeatMap(session) {
  const sourceId = session.seat_source_session_id;
  if (!sourceId) return null;
  return new Map(q.labSeats.all(sourceId).map((r) => [r.name_key, r.seat_number]));
}

/** The lab session an exam takes its seats from, as the monitor shows it. */
export function seatSourceSummary(session) {
  const sourceId = session.seat_source_session_id;
  const row = sourceId ? q.source.get(sourceId) : null;
  return row
    ? { id: row.id, title: row.title, room_code: row.room_code, created_at: row.created_at }
    : null;
}

/**
 * Validate a launcher's choice of seat source: one of the instructor's own
 * LAB sessions. Returns its id, or null when none was chosen.
 */
export function checkSeatSource(value, instructorId) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  const row = Number.isInteger(id) ? q.source.get(id) : null;
  if (!row || row.instructor_id !== instructorId || row.kind === 'exam') {
    throw httpError(400, 'Seats can only come from one of your lab sessions');
  }
  return row.id;
}
