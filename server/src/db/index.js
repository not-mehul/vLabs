import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from '../config.js';
import { log } from '../lib/logger.js';

// Ensure the directory holding the SQLite file exists.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);

// Pragmas: WAL for better read/write concurrency, foreign keys enforced, and a
// busy timeout so a concurrent writer (e.g. a CLI seed) waits instead of failing.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/* -------------------------------------------------------------------------- */
/*  Schema                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Baseline schema in its CURRENT shape. Idempotent (IF NOT EXISTS) so a fresh
 * database is created directly in the final form; older databases are brought
 * forward by the numbered migrations below.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS instructors (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  -- Bumped on password change; instructor JWTs carry it so old tokens die.
  token_version       INTEGER NOT NULL DEFAULT 0,
  password_changed_at TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Master lab manuals. "content" is a JSON document describing an ordered list
-- of sections, each an ordered list of structured steps (Desk vs Computer)
-- with mustache-style {{PLACEHOLDER}} tokens. "variables" is a JSON array of
-- {name, expression} formulas resolved per-seat by the templating engine.
-- archived_at != NULL hides a template from the default lists and from the
-- "launch session" picker without destroying anything.
CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '[]',
  variables   TEXT NOT NULL DEFAULT '[]',
  version     INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_by  INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only audit trail of template changes. Snapshots the template title,
-- the acting instructor and the action so history survives even if the template
-- or instructor is later deleted (hence no cascading FKs). Immutability is
-- enforced by triggers below — the log can only be INSERTed into.
CREATE TABLE IF NOT EXISTS template_audit (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id         INTEGER,
  template_title      TEXT NOT NULL,
  action              TEXT NOT NULL,           -- created | updated | archived | restored | deleted
  version             INTEGER,
  -- Full JSON snapshot { title, description, content, variables } at this
  -- version, enabling change summaries and revert.
  snapshot            TEXT,
  instructor_id       INTEGER,
  instructor_username TEXT NOT NULL,
  at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_template_audit_template ON template_audit(template_id);

-- Enforce append-only: any UPDATE or DELETE on the audit log is rejected.
CREATE TRIGGER IF NOT EXISTS template_audit_no_update
  BEFORE UPDATE ON template_audit
  BEGIN SELECT RAISE(ABORT, 'template_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS template_audit_no_delete
  BEFORE DELETE ON template_audit
  BEGIN SELECT RAISE(ABORT, 'template_audit is append-only'); END;

-- Live classes. Access is gated by a short-lived 6-digit room_code and an
-- expiry timestamp. Terminating a session flips is_active to 0, which the auth
-- layer treats as immediate invalidation of every participant token.
--
-- A session carries its OWN COPY of the template (title/content/variables at
-- template_version). Participants are rendered from this copy, so editing or
-- even deleting the master template never changes a running class; the
-- instructor can explicitly "push" a newer version into the session.
CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code        TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  template_id      INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  instructor_id    INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  template_version INTEGER NOT NULL DEFAULT 1,
  template_title   TEXT NOT NULL DEFAULT '',
  content          TEXT NOT NULL DEFAULT '[]',
  variables        TEXT NOT NULL DEFAULT '[]',
  is_active        INTEGER NOT NULL DEFAULT 1,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at         TEXT
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

/* -------------------------------------------------------------------------- */
/*  Migration helpers                                                         */
/* -------------------------------------------------------------------------- */

function tableExists(name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function columns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function addColumnIfMissing(table, column, definition) {
  if (!columns(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** ON DELETE action of a table's FK on `column`, or null when no such FK. */
function fkOnDelete(table, column) {
  const fk = db
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all()
    .find((f) => f.from === column);
  return fk ? String(fk.on_delete).toUpperCase() : null;
}

/* -------------------------------------------------------------------------- */
/*  Migrations                                                                */
/* -------------------------------------------------------------------------- */
/**
 * Ordered, one-way migrations tracked with `PRAGMA user_version`. Each `up`
 * is written to be safe on BOTH a legacy database and a fresh one created
 * from SCHEMA above (it inspects the current shape and only does work that is
 * needed), so the same path serves every deployment.
 *
 * Adding a migration: append { version: N, name, up } — never edit or reorder
 * past entries once they have shipped.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline',
    up() {
      // Pre-migration-framework databases tracked progress per STEP and had a
      // step_events table. Participant rows are ephemeral, session-scoped data,
      // so a table in the old shape is dropped rather than reshaped. This only
      // ever runs once (user_version < 1).
      db.exec('DROP TABLE IF EXISTS step_events;');
      if (tableExists('participants')) {
        const cols = columns('participants');
        if (!cols.includes('current_section') || !cols.includes('max_section')) {
          db.exec('DROP TABLE IF EXISTS participants;');
        }
      }
      db.exec(SCHEMA);
      // Additive columns introduced before the framework existed.
      addColumnIfMissing('participants', 'hints_taken', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing('participants', 'revealed_solutions', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing('participants', 'finished_at', 'TEXT');
      addColumnIfMissing('template_audit', 'snapshot', 'TEXT');
    },
  },
  {
    version: 2,
    name: 'template-archive, instructor token_version, session snapshots',
    up() {
      addColumnIfMissing('templates', 'archived_at', 'TEXT');
      addColumnIfMissing('instructors', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing('instructors', 'password_changed_at', 'TEXT');

      // Sessions: template_id used to CASCADE (deleting a template wiped every
      // ended session's analytics) and sessions rendered from the LIVE
      // template. Rebuild the table so template_id is nullable with
      // ON DELETE SET NULL and each session carries its own snapshot.
      const needsRebuild =
        fkOnDelete('sessions', 'template_id') === 'CASCADE' ||
        !columns('sessions').includes('content');
      if (needsRebuild) rebuildSessionsTable();
    },
  },
];

/**
 * SQLite cannot alter foreign-key actions in place, so this follows the
 * documented 12-step recipe: foreign_keys OFF (outside any transaction),
 * create new table, copy, drop old, rename, foreign_key_check, foreign_keys ON.
 * Dropping (not renaming) the old table matters: a RENAME would rewrite the
 * participants FK to point at the renamed table.
 */
function rebuildSessionsTable() {
  log.info('db.migrate.sessions.rebuild.start');
  db.pragma('foreign_keys = OFF');
  try {
    const run = db.transaction(() => {
      db.exec(`
        CREATE TABLE sessions_new (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          room_code        TEXT NOT NULL,
          title            TEXT NOT NULL DEFAULT '',
          template_id      INTEGER REFERENCES templates(id) ON DELETE SET NULL,
          instructor_id    INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
          template_version INTEGER NOT NULL DEFAULT 1,
          template_title   TEXT NOT NULL DEFAULT '',
          content          TEXT NOT NULL DEFAULT '[]',
          variables        TEXT NOT NULL DEFAULT '[]',
          is_active        INTEGER NOT NULL DEFAULT 1,
          expires_at       TEXT NOT NULL,
          created_at       TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at         TEXT
        );
      `);

      const oldCols = new Set(columns('sessions'));
      const rows = db
        .prepare(
          `SELECT s.*, t.title AS t_title, t.content AS t_content, t.variables AS t_variables
             FROM sessions s LEFT JOIN templates t ON t.id = s.template_id`,
        )
        .all();
      const snapshotAt = db.prepare(
        `SELECT snapshot FROM template_audit
          WHERE template_id = ? AND version = ? AND snapshot IS NOT NULL
            AND action IN ('created', 'updated')
          ORDER BY id DESC LIMIT 1`,
      );
      const insert = db.prepare(
        `INSERT INTO sessions_new
           (id, room_code, title, template_id, instructor_id, template_version,
            template_title, content, variables, is_active, expires_at, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const r of rows) {
        // Prefer the exact version the session was launched from (audit
        // snapshot); fall back to the live template; finally to empty.
        let title = r.t_title ?? r.title ?? '';
        let content = r.t_content ?? '[]';
        let variables = r.t_variables ?? '[]';
        if (oldCols.has('content') && r.content) content = r.content;
        if (oldCols.has('variables') && r.variables) variables = r.variables;
        if (oldCols.has('template_title') && r.template_title) title = r.template_title;
        const snap = snapshotAt.get(r.template_id, r.template_version ?? 1);
        if (snap && snap.snapshot) {
          try {
            const s = JSON.parse(snap.snapshot);
            if (Array.isArray(s.content)) content = JSON.stringify(s.content);
            if (Array.isArray(s.variables)) variables = JSON.stringify(s.variables);
            if (s.title) title = s.title;
          } catch {
            /* keep the live copy */
          }
        }
        insert.run(
          r.id,
          r.room_code,
          r.title ?? '',
          r.template_id ?? null,
          r.instructor_id,
          r.template_version ?? 1,
          title,
          content,
          variables,
          r.is_active ?? 1,
          r.expires_at,
          r.created_at,
          r.ended_at ?? null,
        );
      }

      db.exec('DROP TABLE sessions;');
      db.exec('ALTER TABLE sessions_new RENAME TO sessions;');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_code ON sessions(room_code) WHERE is_active = 1;',
      );

      const violations = db.pragma('foreign_key_check');
      if (violations.length) {
        throw new Error(`foreign_key_check failed after sessions rebuild: ${JSON.stringify(violations)}`);
      }
    });
    run();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  log.info('db.migrate.sessions.rebuild.done');
}

/** Apply every migration newer than the database's user_version. */
export function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    log.info('db.migrate', { version: m.version, name: m.name });
    m.up();
    db.pragma(`user_version = ${m.version}`);
  }
  // Always converge to the baseline shape (no-op when already current); this
  // also creates any brand-new table added to SCHEMA in a later release.
  db.exec(SCHEMA);
}

migrate();

export default db;
