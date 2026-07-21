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

-- A seat within a session. current_step and step_entered_at power the live
-- analytics ("Seat 7 has been on Step 4 for 15 minutes"). unlocked_step is the
-- highest step index the server has released to this seat (progressive
-- disclosure / anti-scraping). completed_checkpoints is a JSON array of indices.
CREATE TABLE IF NOT EXISTS participants (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seat_id                TEXT NOT NULL,
  current_step           INTEGER NOT NULL DEFAULT 0,
  unlocked_step          INTEGER NOT NULL DEFAULT 0,
  completed_checkpoints  TEXT NOT NULL DEFAULT '[]',
  step_entered_at        TEXT NOT NULL DEFAULT (datetime('now')),
  joined_at              TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, seat_id)
);

-- Append-only analytics log: how long each seat spent on each step.
CREATE TABLE IF NOT EXISTS step_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  session_id     INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_index     INTEGER NOT NULL,
  entered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  left_at        TEXT,
  seconds_spent  INTEGER
);
`;

db.exec(SCHEMA);

export default db;
