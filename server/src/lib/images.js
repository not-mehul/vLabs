import crypto from 'node:crypto';
import db from '../db/index.js';
import { IMAGE_MIMES, LIMITS, normaliseImageName } from '../../../shared/template-schema.js';
import { nowIso } from './time.js';
import { sniffImage } from './imageSniff.js';

export { sniffImage };

/**
 * Instance-wide image library.
 *
 * Images are stored as blobs in SQLite (they are small diagrams and photos;
 * a few MB each at most, and keeping them in the one database means the
 * nightly backup and the Pi → cloud move carry them along). Authors refer to
 * an image by its file NAME in Markdown; participants' browsers fetch it by a
 * random ID, so names (which may hint at content) never appear in URLs and a
 * URL cannot be guessed. Replacing an image under the same name issues a new
 * id, which also defeats stale browser caches.
 */

const q = {
  byId: db.prepare('SELECT * FROM images WHERE id = ?'),
  byName: db.prepare('SELECT * FROM images WHERE name = ? COLLATE NOCASE'),
  list: db.prepare(
    'SELECT id, name, mime, size, width, height, created_at FROM images ORDER BY name COLLATE NOCASE',
  ),
  names: db.prepare('SELECT id, name FROM images'),
  insert: db.prepare(
    `INSERT INTO images (id, name, mime, size, width, height, data, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  remove: db.prepare('DELETE FROM images WHERE id = ?'),
  referencingTemplates: db.prepare(
    `SELECT id, title FROM templates WHERE archived_at IS NULL AND content LIKE ? ESCAPE '\\'`,
  ),
  referencingSessions: db.prepare(
    `SELECT id, title FROM sessions WHERE is_active = 1 AND content LIKE ? ESCAPE '\\'`,
  ),
};

/* ------------------------------------------------------------------------ */
/*  Name → URL map (cached; invalidated on every write)                      */
/* ------------------------------------------------------------------------ */

let cache = null;

/** Lower-cased name → `/api/images/<id>/<encoded name>` for every image. */
export function imageUrlMap() {
  if (!cache) {
    cache = new Map();
    for (const row of q.names.all()) {
      cache.set(row.name.toLowerCase(), imageUrl(row));
    }
  }
  return cache;
}

export function imageNames() {
  return [...imageUrlMap().keys()];
}

function invalidate() {
  cache = null;
}

export function imageUrl(row) {
  return `/api/images/${row.id}/${encodeURIComponent(row.name)}`;
}

/* ------------------------------------------------------------------------ */
/*  CRUD                                                                     */
/* ------------------------------------------------------------------------ */

export function listImages() {
  return q.list.all().map((r) => ({ ...r, url: imageUrl(r) }));
}

export function getImage(id) {
  return q.byId.get(String(id));
}

export function getImageByName(name) {
  return q.byName.get(normaliseImageName(name));
}

/**
 * Store (or replace) an image. Throws an Error with `.status` on bad input.
 *
 * @param {object} o
 * @param {string} o.name      authored file name (any path is reduced to its base name)
 * @param {Buffer} o.data      file bytes
 * @param {boolean} [o.replace] allow overwriting an existing name
 * @param {number|null} [o.instructorId]
 */
export function saveImage({ name, data, replace = false, instructorId = null }) {
  const clean = normaliseImageName(name);
  if (!clean || !/\.[A-Za-z0-9]+$/.test(clean)) {
    throw httpErr(400, 'Image name must be a file name with an extension, e.g. rack.png');
  }
  if (!Buffer.isBuffer(data) || data.length === 0) throw httpErr(400, 'Empty upload');
  if (data.length > LIMITS.imageBytes) {
    throw httpErr(
      413,
      `Image is too large (max ${Math.round(LIMITS.imageBytes / 1024 / 1024)} MB)`,
    );
  }
  const sniffed = sniffImage(data);
  if (!sniffed || !IMAGE_MIMES[sniffed.mime]) {
    throw httpErr(415, 'Unsupported image type — use PNG, JPEG, GIF or WebP');
  }
  const existing = q.byName.get(clean);
  if (existing && !replace) {
    const err = httpErr(409, `An image named "${existing.name}" already exists`);
    err.code = 'IMAGE_EXISTS';
    err.existing = { id: existing.id, name: existing.name, url: imageUrl(existing) };
    throw err;
  }
  const id = crypto.randomBytes(16).toString('base64url');
  const row = {
    id,
    name: existing ? existing.name : clean, // keep the original casing on replace
    mime: sniffed.mime,
    size: data.length,
    width: sniffed.width ?? null,
    height: sniffed.height ?? null,
  };
  const tx = db.transaction(() => {
    if (existing) q.remove.run(existing.id);
    q.insert.run(
      row.id,
      row.name,
      row.mime,
      row.size,
      row.width,
      row.height,
      data,
      instructorId,
      nowIso(),
    );
  });
  tx();
  invalidate();
  return { ...row, url: imageUrl(row), replaced: Boolean(existing) };
}

/** Templates / active sessions whose content mentions this image name. */
export function imageReferences(name) {
  const needle = `%${String(name).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return {
    templates: q.referencingTemplates.all(needle),
    sessions: q.referencingSessions.all(needle),
  };
}

/** Delete an image unless a live template/session still references it. */
export function deleteImage(id) {
  const row = q.byId.get(String(id));
  if (!row) throw httpErr(404, 'Image not found');
  const refs = imageReferences(row.name);
  if (refs.templates.length || refs.sessions.length) {
    const where = [
      ...refs.templates.map((t) => `template "${t.title}"`),
      ...refs.sessions.map((s) => `active session "${s.title}"`),
    ];
    throw httpErr(
      409,
      `"${row.name}" is still used by ${where.slice(0, 3).join(', ')}${where.length > 3 ? ` and ${where.length - 3} more` : ''}`,
    );
  }
  q.remove.run(row.id);
  invalidate();
  return row;
}

function httpErr(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
