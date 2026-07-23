import { Router } from 'express';
import db from '../db/index.js';
import { requireInstructor } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { validateTemplatePayload } from '../lib/validateTemplate.js';
import { renderManual, countSteps } from '../lib/templating.js';
import { nowIso } from '../lib/time.js';

const router = Router();

// Every template route requires an authenticated instructor.
router.use(requireInstructor);

function rowToTemplate(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    content: JSON.parse(row.content),
    variables: JSON.parse(row.variables),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Record an immutable audit entry (with a full snapshot) for a template. */
function recordAudit(instructor, { templateId, title, action, version, snapshot }) {
  db.prepare(
    `INSERT INTO template_audit
       (template_id, template_title, action, version, snapshot, instructor_id, instructor_username)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    templateId ?? null,
    title,
    action,
    version ?? null,
    snapshot ? JSON.stringify(snapshot) : null,
    instructor.id,
    instructor.username,
  );
}

/** Build a snapshot object from a template row. */
function snapshotOf(row) {
  return {
    title: row.title,
    description: row.description,
    content: JSON.parse(row.content),
    variables: JSON.parse(row.variables),
  };
}

/** GET /api/templates — list (summaries) with the most recent editor. */
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.description, t.version, t.content, t.updated_at,
              (SELECT instructor_username FROM template_audit a
                WHERE a.template_id = t.id ORDER BY a.id DESC LIMIT 1) AS updated_by
         FROM templates t ORDER BY t.updated_at DESC`,
    )
    .all();
  res.json(
    rows.map((r) => {
      const content = JSON.parse(r.content);
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        version: r.version,
        section_count: content.length,
        step_count: countSteps(content),
        updated_at: r.updated_at,
        updated_by: r.updated_by,
      };
    }),
  );
});

/** GET /api/templates/:id/audit — read-only change history (with snapshots). */
router.get('/:id/audit', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, action, version, snapshot, instructor_username, at
         FROM template_audit WHERE template_id = ? ORDER BY id DESC`,
    )
    .all(req.params.id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      version: r.version,
      instructor_username: r.instructor_username,
      at: r.at,
      snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
    })),
  );
});

/** GET /api/templates/:id — full template. */
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Template not found');
  res.json(rowToTemplate(row));
});

/** POST /api/templates — create. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const clean = validateTemplatePayload(req.body);
    const info = db
      .prepare(
        `INSERT INTO templates (title, description, content, variables, version, created_by)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(
        clean.title,
        clean.description,
        JSON.stringify(clean.content),
        JSON.stringify(clean.variables),
        req.instructor.id,
      );
    const row = db
      .prepare('SELECT * FROM templates WHERE id = ?')
      .get(info.lastInsertRowid);
    recordAudit(req.instructor, {
      templateId: row.id,
      title: row.title,
      action: 'created',
      version: row.version,
      snapshot: snapshotOf(row),
    });
    res.status(201).json(rowToTemplate(row));
  }),
);

/** PUT /api/templates/:id — update (bumps version). */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = db
      .prepare('SELECT * FROM templates WHERE id = ?')
      .get(req.params.id);
    if (!existing) throw httpError(404, 'Template not found');

    const clean = validateTemplatePayload(req.body);
    db.prepare(
      `UPDATE templates
          SET title = ?, description = ?, content = ?, variables = ?,
              version = version + 1, updated_at = ?
        WHERE id = ?`,
    ).run(
      clean.title,
      clean.description,
      JSON.stringify(clean.content),
      JSON.stringify(clean.variables),
      nowIso(),
      req.params.id,
    );
    const row = db
      .prepare('SELECT * FROM templates WHERE id = ?')
      .get(req.params.id);
    recordAudit(req.instructor, {
      templateId: row.id,
      title: row.title,
      action: 'updated',
      version: row.version,
      snapshot: snapshotOf(row),
    });
    res.json(rowToTemplate(row));
  }),
);

/** DELETE /api/templates/:id. */
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!existing) throw httpError(404, 'Template not found');
  const active = db
    .prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE template_id = ? AND is_active = 1',
    )
    .get(req.params.id);
  if (active.n > 0) {
    throw httpError(409, 'Cannot delete a template with active sessions');
  }
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  // Audit survives the deletion (no cascading FK on the audit table).
  recordAudit(req.instructor, {
    templateId: existing.id,
    title: existing.title,
    action: 'deleted',
    version: existing.version,
  });
  res.status(204).end();
});

/**
 * POST /api/templates/:id/preview
 * Authoring aid: render the manual for a chosen seat so instructors can see the
 * resolved output (and any missing-placeholder warnings) without a live
 * session. Also accepts an inline draft body so unsaved edits can be previewed.
 */
router.post(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const seatId = req.body?.seat_id ?? 1;
    let content;
    let variables;

    if (req.body?.draft) {
      const clean = validateTemplatePayload(req.body.draft);
      content = clean.content;
      variables = clean.variables;
    } else {
      const row = db
        .prepare('SELECT * FROM templates WHERE id = ?')
        .get(req.params.id);
      if (!row) throw httpError(404, 'Template not found');
      content = JSON.parse(row.content);
      variables = JSON.parse(row.variables);
    }

    const { context, sections } = renderManual(content, variables, seatId);
    res.json({ seat_id: seatId, context, sections });
  }),
);

export default router;
