#!/usr/bin/env node
/**
 * Instructor account administration from the command line (the portal's
 * Admin page does the same; this is the fallback when nobody can sign in).
 *
 *   node server/scripts/instructors.js list
 *   node server/scripts/instructors.js create <username> [password]
 *   node server/scripts/instructors.js reset-password <username> [password]
 *
 * When no password is given a random one is generated and printed ONCE.
 * Resetting a password bumps token_version, which signs that instructor out
 * of every browser. On the Pi, run it through deploy/pi/vlabs-cli.sh so it
 * uses the production configuration and database:
 *   sudo /opt/vlabs/deploy/pi/vlabs-cli.sh instructors list
 */
import bcrypt from 'bcryptjs';
import db, { checkpoint, schema } from '../src/db/index.js';
import {
  BCRYPT_ROUNDS,
  USERNAME_RULE,
  isValidUsername,
  passwordProblem,
  randomPassword,
} from '../src/lib/accounts.js';

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

function checkUsername() {
  if (isValidUsername(username)) return;
  console.error(`${USERNAME_RULE}.`);
  usage();
}

function pickPassword() {
  if (passwordArg !== undefined) {
    const problem = passwordProblem(passwordArg);
    if (problem) {
      console.error(`${problem}.`);
      process.exit(1);
    }
    return { password: passwordArg, generated: false };
  }
  return { password: randomPassword(), generated: true };
}

if (schema.ahead) {
  console.error(
    `The database is at schema version ${schema.version}, newer than this vLabs (${schema.latest}). ` +
      'Restore the backup taken before the update, or use the newer release.',
  );
  process.exit(1);
}

try {
  switch (cmd) {
    case 'list': {
      const rows = db
        .prepare(
          `SELECT i.id, i.username, i.created_at, i.password_changed_at, i.token_version, i.is_admin,
                  (SELECT COUNT(*) FROM sessions s WHERE s.instructor_id = i.id) AS sessions
             FROM instructors i ORDER BY i.id`,
        )
        .all();
      if (!rows.length) console.log('No instructors.');
      for (const r of rows) {
        console.log(
          `#${r.id}\t${r.username}${r.is_admin ? ' (admin)' : ''}\tcreated ${r.created_at}\t` +
            `password ${r.password_changed_at ? `changed ${r.password_changed_at}` : 'never changed'}\t` +
            `sessions ${r.sessions}`,
        );
      }
      break;
    }
    case 'create': {
      checkUsername();
      if (db.prepare('SELECT 1 FROM instructors WHERE username = ?').get(username)) {
        console.error(`Instructor "${username}" already exists.`);
        process.exit(1);
      }
      const { password, generated } = pickPassword();
      db.prepare(
        'INSERT INTO instructors (username, password_hash, password_changed_at) VALUES (?, ?, NULL)',
      ).run(username, bcrypt.hashSync(password, BCRYPT_ROUNDS));
      checkpoint();
      console.log(`Created instructor "${username}".`);
      if (generated) console.log(`Temporary password (shown once): ${password}`);
      console.log('Ask them to change it from Admin → Your password.');
      break;
    }
    case 'reset-password': {
      checkUsername();
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
      ).run(bcrypt.hashSync(password, BCRYPT_ROUNDS), row.id);
      checkpoint();
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
