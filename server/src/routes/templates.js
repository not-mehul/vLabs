import { Router } from 'express';
import db from '../db/index.js';
import { requireInstructor } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { validateTemplatePayload } from '../lib/validateTemplate.js';
import { renderManual } from '../lib/templating.js';
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

/** GET /api/templates — list (summaries). */
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, title, description, version, content, updated_at
         FROM templates ORDER BY updated_at DESC`,
    )
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      version: r.version,
      step_count: JSON.parse(r.content).length,
      updated_at: r.updated_at,
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
    res.json(rowToTemplate(row));
  }),
);

/** DELETE /api/templates/:id. */
router.delete('/:id', (req, res) => {
  const active = db
    .prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE template_id = ? AND is_active = 1',
    )
    .get(req.params.id);
  if (active.n > 0) {
    throw httpError(409, 'Cannot delete a template with active sessions');
  }
  const info = db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  if (info.changes === 0) throw httpError(404, 'Template not found');
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

    const { context, steps } = renderManual(content, variables, seatId);
    res.json({ seat_id: seatId, context, steps });
  }),
);

export default router;
