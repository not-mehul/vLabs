#!/usr/bin/env node
/**
 * Instructor account administration (CLI, no UI yet).
 *
 *   node server/scripts/instructors.js list
 *   node server/scripts/instructors.js create <username> [password]
 *   node server/scripts/instructors.js reset-password <username> [password]
 *
 * When no password is given a random one is generated and printed ONCE.
 * Resetting a password bumps token_version, which signs that instructor out
 * of every browser. On the Pi:
 *   sudo -u vlabs /usr/bin/node /opt/vlabs/server/scripts/instructors.js list
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from '../src/db/index.js';
import config from '../src/config.js';

const [cmd, username, passwordArg] = process.argv.slice(2);

function usage(code = 1) {
  console.error(
    [
      'Usage:',
      '  instructors.js list',
      '  instructors.js create <username> [password]',
      '  instructors.js reset-password <username> [password]',
    ].join('\n'),
  );
  process.exit(code);
}

function randomPassword() {
  // 16 URL-safe characters ≈ 95 bits; satisfies MIN_PASSWORD_LENGTH.
  return crypto.randomBytes(12).toString('base64url');
}

function validUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9._-]{2,64}$/.test(u);
}

function pickPassword() {
  if (passwordArg !== undefined) {
    if (passwordArg.length < config.minPasswordLength) {
      console.error(`Password must be at least ${config.minPasswordLength} characters.`);
      process.exit(1);
    }
    return { password: passwordArg, generated: false };
  }
  return { password: randomPassword(), generated: true };
}

try {
  switch (cmd) {
    case 'list': {
      const rows = db
        .prepare(
          `SELECT i.id, i.username, i.created_at, i.password_changed_at, i.token_version,
                  (SELECT COUNT(*) FROM sessions s WHERE s.instructor_id = i.id) AS sessions
             FROM instructors i ORDER BY i.id`,
        )
        .all();
      if (!rows.length) console.log('No instructors.');
      for (const r of rows) {
        console.log(
          `#${r.id}\t${r.username}\tcreated ${r.created_at}\t` +
            `password ${r.password_changed_at ? `changed ${r.password_changed_at}` : 'never changed'}\t` +
            `sessions ${r.sessions}`,
        );
      }
      break;
    }
    case 'create': {
      if (!validUsername(username)) usage();
      if (db.prepare('SELECT 1 FROM instructors WHERE username = ?').get(username)) {
        console.error(`Instructor "${username}" already exists.`);
        process.exit(1);
      }
      const { password, generated } = pickPassword();
      db.prepare('INSERT INTO instructors (username, password_hash, password_changed_at) VALUES (?, ?, NULL)').run(
        username,
        bcrypt.hashSync(password, 10),
      );
      console.log(`Created instructor "${username}".`);
      if (generated) console.log(`Temporary password (shown once): ${password}`);
      console.log('Ask them to change it from Account → Change password.');
      break;
    }
    case 'reset-password': {
      if (!validUsername(username)) usage();
      const row = db.prepare('SELECT id FROM instructors WHERE username = ?').get(username);
      if (!row) {
        console.error(`No instructor named "${username}".`);
        process.exit(1);
      }
      const { password, generated } = pickPassword();
      db.prepare(
        `UPDATE instructors
            SET password_hash = ?, token_version = token_version + 1, password_changed_at = NULL
          WHERE id = ?`,
      ).run(bcrypt.hashSync(password, 10), row.id);
      console.log(`Password reset for "${username}"; all their existing sign-ins were revoked.`);
      if (generated) console.log(`Temporary password (shown once): ${password}`);
      break;
    }
    default:
      usage(cmd ? 1 : 0);
  }
} finally {
  db.close();
}
