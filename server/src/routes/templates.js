import { Router } from 'express';
import db from '../db/index.js';
import { requireInstructor } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { validateTemplatePayload } from '../lib/validateTemplate.js';
import { renderManual, countSteps, injectVariables, FUNCTION_NAMES } from '../lib/templating.js';
import { nowIso } from '../lib/time.js';
import { log } from '../lib/logger.js';

const router = Router();

// Every template route requires an authenticated instructor. Templates are a
// SHARED workspace: any instructor may view and edit any template (sessions,
// by contrast, are owned by the instructor who launched them).
router.use(requireInstructor);

const q = {
  list: db.prepare(
    `SELECT t.id, t.title, t.description, t.version, t.content, t.updated_at, t.archived_at,
            (SELECT instructor_username FROM template_audit a
              WHERE a.template_id = t.id AND a.action IN ('created', 'updated')
              ORDER BY a.id DESC LIMIT 1) AS updated_by,
            (SELECT COUNT(*) FROM sessions s WHERE s.template_id = t.id) AS session_count,
            (SELECT COUNT(*) FROM sessions s WHERE s.template_id = t.id AND s.is_active = 1) AS active_session_count
       FROM templates t
      WHERE (? = 1 OR t.archived_at IS NULL)
      ORDER BY t.archived_at IS NOT NULL, t.updated_at DESC`,
  ),
  get: db.prepare('SELECT * FROM templates WHERE id = ?'),
  audit: db.prepare(
    `SELECT id, action, version, snapshot, instructor_username, at
       FROM template_audit WHERE template_id = ? ORDER BY id DESC`,
  ),
  insert: db.prepare(
    `INSERT INTO templates (title, description, content, variables, version, created_by)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ),
  update: db.prepare(
    `UPDATE templates
        SET title = ?, description = ?, content = ?, variables = ?,
            version = version + 1, updated_at = ?
      WHERE id = ?`,
  ),
  archive: db.prepare('UPDATE templates SET archived_at = ?, updated_at = ? WHERE id = ?'),
  restore: db.prepare('UPDATE templates SET archived_at = NULL, updated_at = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM templates WHERE id = ?'),
  sessionCounts: db.prepare(
    `SELECT COUNT(*) AS total, SUM(is_active = 1) AS active FROM sessions WHERE template_id = ?`,
  ),
  recordAudit: db.prepare(
    `INSERT INTO template_audit
       (template_id, template_title, action, version, snapshot, instructor_id, instructor_username)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ),
};

function rowToTemplate(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    content: JSON.parse(row.content),
    variables: JSON.parse(row.variables),
    version: row.version,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Record an immutable audit entry (with an optional full snapshot). */
function recordAudit(instructor, { templateId, title, action, version, snapshot }) {
  q.recordAudit.run(
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

/** Parse and validate a numeric :id param. */
function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(404, 'Template not found');
  return id;
}

function loadOr404(req) {
  const row = q.get.get(idParam(req));
  if (!row) throw httpError(404, 'Template not found');
  return row;
}

/**
 * GET /api/templates — list (summaries) with the most recent editor.
 * Archived templates are hidden unless `?include_archived=1`.
 */
router.get('/', (req, res) => {
  const includeArchived = req.query.include_archived === '1' ? 1 : 0;
  const rows = q.list.all(includeArchived);
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
        archived_at: r.archived_at,
        session_count: r.session_count,
        active_session_count: r.active_session_count,
      };
    }),
  );
});

/** GET /api/templates/functions — formula helper names for the editor. */
router.get('/functions', (req, res) => {
  res.json({ functions: FUNCTION_NAMES });
});

/** GET /api/templates/:id/audit — read-only change history (with snapshots). */
router.get('/:id/audit', (req, res) => {
  const rows = q.audit.all(idParam(req));
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
  res.json(rowToTemplate(loadOr404(req)));
});

/** POST /api/templates — create. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const clean = validateTemplatePayload(req.body);
    const info = q.insert.run(
      clean.title,
      clean.description,
      JSON.stringify(clean.content),
      JSON.stringify(clean.variables),
      req.instructor.id,
    );
    const row = q.get.get(info.lastInsertRowid);
    recordAudit(req.instructor, {
      templateId: row.id,
      title: row.title,
      action: 'created',
      version: row.version,
      snapshot: snapshotOf(row),
    });
    log.info('template.created', { template: row.id, instructor: req.instructor.id });
    res.status(201).json(rowToTemplate(row));
  }),
);

/**
 * PUT /api/templates/:id — update (bumps version).
 * Running sessions are NOT affected: they render from their own snapshot until
 * the instructor pushes the new version from the session monitor.
 */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = loadOr404(req);
    const clean = validateTemplatePayload(req.body);
    q.update.run(
      clean.title,
      clean.description,
      JSON.stringify(clean.content),
      JSON.stringify(clean.variables),
      nowIso(),
      existing.id,
    );
    const row = q.get.get(existing.id);
    recordAudit(req.instructor, {
      templateId: row.id,
      title: row.title,
      action: 'updated',
      version: row.version,
      snapshot: snapshotOf(row),
    });
    log.info('template.updated', { template: row.id, version: row.version, instructor: req.instructor.id });
    res.json(rowToTemplate(row));
  }),
);

/**
 * DELETE /api/templates/:id — ARCHIVE by default.
 * Archiving hides the template from lists and the session launcher; nothing
 * is destroyed and it can be restored. With `?permanent=1` the row is deleted
 * for good: sessions keep their own copy of the content (template_id becomes
 * NULL), and the audit history survives. Permanent deletion is refused while
 * a session launched from the template is still active.
 */
router.delete('/:id', (req, res) => {
  const existing = loadOr404(req);
  const counts = q.sessionCounts.get(existing.id);
  const permanent = req.query.permanent === '1';

  if (!permanent) {
    if (existing.archived_at) return res.status(204).end();
    q.archive.run(nowIso(), nowIso(), existing.id);
    recordAudit(req.instructor, {
      templateId: existing.id,
      title: existing.title,
      action: 'archived',
      version: existing.version,
    });
    log.info('template.archived', { template: existing.id, instructor: req.instructor.id });
    return res.status(204).end();
  }

  if ((counts.active || 0) > 0) {
    throw httpError(409, 'Cannot permanently delete a template with active sessions — end them first');
  }
  q.remove.run(existing.id);
  // Audit survives the deletion (no cascading FK on the audit table).
  recordAudit(req.instructor, {
    templateId: existing.id,
    title: existing.title,
    action: 'deleted',
    version: existing.version,
    snapshot: snapshotOf(existing),
  });
  log.warn('template.deleted', {
    template: existing.id,
    sessions_detached: counts.total || 0,
    instructor: req.instructor.id,
  });
  res.status(204).end();
});

/** POST /api/templates/:id/restore — un-archive. */
router.post('/:id/restore', (req, res) => {
  const existing = loadOr404(req);
  if (existing.archived_at) {
    q.restore.run(nowIso(), existing.id);
    recordAudit(req.instructor, {
      templateId: existing.id,
      title: existing.title,
      action: 'restored',
      version: existing.version,
    });
    log.info('template.restored', { template: existing.id, instructor: req.instructor.id });
  }
  res.json(rowToTemplate(q.get.get(existing.id)));
});

/**
 * POST /api/templates/:id/preview
 * Authoring aid: render the manual for a chosen seat so instructors can see the
 * resolved output without a live session. Also accepts an inline draft body so
 * unsaved edits can be previewed (draft is fully validated first, so authoring
 * errors such as unknown placeholders surface here too).
 */
router.post(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const seatRaw = parseInt(req.body?.seat_id, 10);
    const seatId = Number.isInteger(seatRaw) ? Math.min(Math.max(seatRaw, 0), 9999) : 1;
    let content;
    let variables;

    if (req.body?.draft) {
      const clean = validateTemplatePayload(req.body.draft);
      content = clean.content;
      variables = clean.variables;
    } else {
      const row = loadOr404(req);
      content = JSON.parse(row.content);
      variables = JSON.parse(row.variables);
    }

    const { context, sections } = renderManual(content, variables, seatId);
    // Instructor preview shows authored solutions inline (unlocked) so the
    // author can see the rendered walkthrough — this path is instructor-only,
    // so it never leaks to a participant.
    sections.forEach((section) => {
      section.steps.forEach((step) => {
        const raw = content[section.index]?.steps?.[step.index];
        if (raw?.solution) {
          step.has_solution = true;
          step.solution = injectVariables(String(raw.solution), context);
        }
      });
    });
    res.json({ seat_id: seatId, context, sections });
  }),
);

export default router;
