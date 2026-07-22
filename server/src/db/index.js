import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from '../config.js';

// Ensure the directory holding the SQLite file exists.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);

// Pragmas: WAL for better read/write concurrency, foreign keys enforced.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Schema definition. Kept idempotent (IF NOT EXISTS) so start-up always
 * converges the database to the expected shape without a migration tool.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS instructors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Master lab manuals. "content" is a JSON document describing an ordered list
-- of structured steps (Desk Action vs Computer Action) with mustache-style
-- {{PLACEHOLDER}} tokens. "variables" is a JSON array of {name, expression}
-- formulas resolved per-seat by the templating engine.
CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '[]',
  variables   TEXT NOT NULL DEFAULT '[]',
  version     INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Live classes. Access is gated by a short-lived 6-digit room_code and an
-- expiry timestamp. Terminating a session flips is_active to 0, which the auth
-- layer treats as immediate invalidation of every participant token.
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code     TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  template_id   INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  -- Snapshot of template version at session-create time (audit / consistency).
  template_version INTEGER NOT NULL DEFAULT 1,
  is_active     INTEGER NOT NULL DEFAULT 1,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT
);

-- Only one ACTIVE session may hold a given room_code at a time. Expired /
-- terminated codes are freed for reuse.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_code
  ON sessions(room_code) WHERE is_active = 1;

-- A registered participant within a session. Each participant registers with
-- their first + last name and is assigned an ascending seat_number (1-100) in
-- join order; that number is what the templating engine uses as the seat value.
-- name_key (lowercased "first last") makes rejoin idempotent so a participant
-- who closes their browser can return and resume the same seat and progress.
-- Progress is tracked by SECTION: current_section is the section being viewed,
-- section_entered_at powers time-on-section, joined_at powers total elapsed
-- time, and completed_checkpoints is a JSON array of "<section>.<step>" keys.
CREATE TABLE IF NOT EXISTS participants (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seat_number            INTEGER NOT NULL,
  first_name             TEXT NOT NULL DEFAULT '',
  last_name              TEXT NOT NULL DEFAULT '',
  name_key               TEXT NOT NULL,
  current_section        INTEGER NOT NULL DEFAULT 0,
  max_section            INTEGER NOT NULL DEFAULT 0,
  completed_checkpoints  TEXT NOT NULL DEFAULT '[]',
  hints_taken            TEXT NOT NULL DEFAULT '[]',
  revealed_solutions     TEXT NOT NULL DEFAULT '[]',
  finished_at            TEXT,
  section_entered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  joined_at              TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, seat_number),
  UNIQUE (session_id, name_key)
);
`;

/**
 * Migration guard: the participants table moved from step-based tracking to
 * section-based tracking (current_section column). A legacy table can't be
 * reshaped by CREATE TABLE IF NOT EXISTS, so drop it — participant rows are
 * ephemeral, session-scoped data that is safe to recreate. The old step_events
 * table is likewise retired.
 */
db.exec('DROP TABLE IF EXISTS step_events;');
const participantsExists = db
  .prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='participants'",
  )
  .get();
if (participantsExists) {
  const cols = db.prepare('PRAGMA table_info(participants)').all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('current_section') || !names.has('max_section')) {
    db.exec('DROP TABLE IF EXISTS participants;');
  }
}

db.exec(SCHEMA);

/**
 * Additive migrations: newer columns are added in place (non-destructive) so
 * existing participant data survives an upgrade. Each entry is applied only if
 * the column is absent.
 */
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumnIfMissing('participants', 'hints_taken', "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing('participants', 'revealed_solutions', "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing('participants', 'finished_at', 'TEXT');

export default db;
