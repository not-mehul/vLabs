#!/usr/bin/env node
/**
 * Online, consistent SQLite backup using the SQLite backup API (safe while the
 * server is running and in WAL mode — no need to stop the app).
 *
 *   node server/scripts/backup.js [destination-dir]
 *
 * Writes <dir>/vlabs-YYYYMMDD-HHMMSS.sqlite and prunes old copies beyond
 * BACKUP_KEEP (default 14). Default destination: <DB dir>/backups.
 * On the Pi use deploy/pi/backup.sh, which runs this as the vlabs user.
 */
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db/index.js';
import config from '../src/config.js';

const dir = process.argv[2] || path.join(path.dirname(config.dbPath), 'backups');
const keep = Math.max(1, parseInt(process.env.BACKUP_KEEP || '14', 10) || 14);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const target = path.join(dir, `vlabs-${stamp}.sqlite`);

fs.mkdirSync(dir, { recursive: true });
try {
  await db.backup(target);
  const { size } = fs.statSync(target);
  console.log(`Backup written: ${target} (${Math.round(size / 1024)} kB)`);

  const old = fs
    .readdirSync(dir)
    .filter((f) => /^vlabs-\d{8}-\d{6}\.sqlite$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) {
    fs.unlinkSync(path.join(dir, f));
    console.log(`Pruned ${f}`);
  }
} finally {
  db.close();
}
