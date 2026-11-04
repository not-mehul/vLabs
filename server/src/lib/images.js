import crypto from 'node:crypto';
import db from '../db/index.js';
import {
  IMAGE_MD_RE,
  IMAGE_MIMES,
  LIMITS,
  imageRefName,
  normaliseImageName,
} from '../../../shared/template-schema.js';
import { httpError } from '../middleware/errorHandler.js';
import { nowIso } from './time.js';
import { sniffImage } from './imageSniff.js';
import { jsonArray } from './json.js';

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
  // Candidates only (a cheap substring prefilter); imageReferences checks
  // each one's references exactly.
  candidateTemplates: db.prepare(
    `SELECT id, title, archived_at, content FROM templates WHERE content LIKE ? ESCAPE '\\'`,
  ),
  candidateSessions: db.prepare(
    `SELECT id, title, content FROM sessions WHERE is_active = 1 AND content LIKE ? ESCAPE '\\'`,
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
    throw httpError(400, 'Image name must be a file name with an extension, e.g. rack.png');
  }
  if (!Buffer.isBuffer(data) || data.length === 0) throw httpError(400, 'Empty upload');
  if (data.length > LIMITS.imageBytes) {
    throw httpError(
      413,
      `Image is too large (max ${Math.round(LIMITS.imageBytes / 1024 / 1024)} MB)`,
    );
  }
  const sniffed = sniffImage(data);
  if (!sniffed || !IMAGE_MIMES[sniffed.mime]) {
    throw httpError(415, 'Unsupported image type — use PNG, JPEG, GIF or WebP');
  }
  const existing = q.byName.get(clean);
  if (existing && !replace) {
    const err = httpError(409, `An image named "${existing.name}" already exists`);
    err.code = 'IMAGE_EXISTS';
    err.existing = {
      id: existing.id,
      name: existing.name,
      url: imageUrl(existing),
      // Replacing it changes every one of these (the library is shared).
      templates: imageReferences(existing.name).templates,
    };
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

/**
 * Library names (lower-cased) referenced by `![…](name.png)` anywhere in some
 * stored content, labs and exams alike. Per-seat names (`bench-{{ SEAT_ID }}.png`)
 * cannot be known here and are skipped, as validation skips them.
 */
function referencedNames(json) {
  const names = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(IMAGE_MD_RE)) {
        const name = /\{\{/.test(m[2]) ? null : imageRefName(m[2]);
        if (name) names.add(name.toLowerCase());
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(jsonArray(json));
  return names;
}

/**
 * Templates (archived ones too: restoring one must find its images) and
 * active sessions that use this image, matched by exact file name — `a.png`
 * is not used by a template that shows `rack-a.png`.
 */
export function imageReferences(name) {
  const key = String(name).toLowerCase();
  const needle = `%${String(name).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const uses = (row) => referencedNames(row.content).has(key);
  return {
    templates: q.candidateTemplates
      .all(needle)
      .filter(uses)
      .map((t) => ({ id: t.id, title: t.title, archived: Boolean(t.archived_at) })),
    sessions: q.candidateSessions
      .all(needle)
      .filter(uses)
      .map((x) => ({ id: x.id, title: x.title })),
  };
}

/** Delete an image unless a live template/session still references it. */
export function deleteImage(id) {
  const row = q.byId.get(String(id));
  if (!row) throw httpError(404, 'Image not found');
  const refs = imageReferences(row.name);
  if (refs.templates.length || refs.sessions.length) {
    const where = [
      ...refs.templates.map((t) => `${t.archived ? 'archived ' : ''}template "${t.title}"`),
      ...refs.sessions.map((s) => `active session "${s.title}"`),
    ];
    throw httpError(
      409,
      `"${row.name}" is still used by ${where.slice(0, 3).join(', ')}${where.length > 3 ? ` and ${where.length - 3} more` : ''}`,
    );
  }
  q.remove.run(row.id);
  invalidate();
  return row;
}
