import { Router } from 'express';
import db from '../db/index.js';
import { requireInstructor } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { validateTemplatePayload } from '../../../shared/validate-template.js';
import { validateExamPayload } from '../../../shared/validate-exam.js';
import {
  listQuestions,
  totalPoints,
  isSubmitSection,
  isQuestion,
  examCaptures,
} from '../../../shared/exam-schema.js';
import {
  renderManual,
  countSteps,
  injectVariables,
  injectImages,
  FUNCTION_NAMES,
} from '../../../shared/templating.js';
import { maskExample } from '../../../shared/template-schema.js';
import { imageNames, imageUrlMap } from '../lib/images.js';
import { examContext, examForSeat } from '../lib/examSeat.js';
import { nowIso } from '../lib/time.js';
import { log } from '../lib/logger.js';

const router = Router();

// Every template route requires an authenticated instructor. Templates are a
// SHARED workspace: any instructor may view and edit any template (sessions,
// by contrast, are owned by the instructor who launched them).
router.use(requireInstructor);

const q = {
  list: db.prepare(
    `SELECT t.id, t.kind, t.title, t.description, t.version, t.content, t.updated_at, t.archived_at,
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
    `INSERT INTO templates (kind, title, description, content, variables, version, created_by)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
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

const kindOf = (row) => (row.kind === 'exam' ? 'exam' : 'lab');

/**
 * Validate a create/update payload for the given kind. Labs go through the
 * lab validator (unchanged); exams through their own (shared/validate-exam.js).
 */
function validateFor(kind, payload) {
  return kind === 'exam'
    ? validateExamPayload(payload, { imageNames: imageNames() })
    : validateTemplatePayload(payload, { imageNames: imageNames() });
}

function rowToTemplate(row) {
  return {
    id: row.id,
    kind: kindOf(row),
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
    kind: kindOf(row),
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
      const exam = kindOf(r) === 'exam';
      return {
        id: r.id,
        kind: kindOf(r),
        title: r.title,
        description: r.description,
        version: r.version,
        section_count: content.length,
        step_count: exam ? 0 : countSteps(content),
        question_count: exam ? listQuestions(content).length : 0,
        total_points: exam ? totalPoints(content) : 0,
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

/** POST /api/templates — create. Body `kind: 'exam'` creates an exam; default lab. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const kind = req.body?.kind === 'exam' ? 'exam' : 'lab';
    const clean = validateFor(kind, req.body);
    const info = q.insert.run(
      kind,
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
 * PUT /api/templates/:id — update (bumps version). The kind is fixed at
 * creation; the payload is validated as the existing template's kind.
 * Running sessions are NOT affected: they render from their own snapshot until
 * the instructor pushes the new version from the session monitor.
 */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = loadOr404(req);
    // Optimistic concurrency: templates are shared, so an editor sends the
    // version it loaded and a save over someone else's newer save is refused
    // instead of silently discarding their change.
    const expected = req.body?.expected_version;
    if (expected !== undefined && expected !== null && Number(expected) !== existing.version) {
      throw httpError(
        409,
        `This template was changed by someone else (now v${existing.version}, you loaded v${expected}). Reload it and apply your edits again.`,
        'VERSION_CONFLICT',
      );
    }
    const clean = validateFor(kindOf(existing), req.body);
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
    log.info('template.updated', {
      template: row.id,
      version: row.version,
      instructor: req.instructor.id,
    });
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
    throw httpError(
      409,
      'Cannot permanently delete a template with active sessions — end them first',
    );
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
 * errors such as unknown placeholders surface here too). Optional
 * `first_name` / `last_name` stand in for the participant; values captured by
 * pattern checkpoints are stood in by an example matching each mask.
 */
router.post(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const seatRaw = parseInt(req.body?.seat_id, 10);
    const seatId = Number.isInteger(seatRaw) ? Math.min(Math.max(seatRaw, 0), 9999) : 1;
    let content;
    let variables;
    let kind;

    if (req.body?.draft) {
      kind = req.body.draft.kind === 'exam' ? 'exam' : 'lab';
      const clean = validateFor(kind, req.body.draft);
      content = clean.content;
      variables = clean.variables;
    } else {
      const row = loadOr404(req);
      kind = kindOf(row);
      content = JSON.parse(row.content);
      variables = JSON.parse(row.variables);
    }

    const name = (v, fallback) =>
      String(v ?? '')
        .trim()
        .slice(0, 60) || fallback;

    if (kind === 'exam') {
      // The exam as the chosen seat sees it (answers included — instructor-only
      // route), placeholders and library images resolved.
      const images = imageUrlMap();
      // Saved answers stand in as a label until a participant gives them.
      const captured = {};
      for (const c of examCaptures({ content })) {
        if (!(c.name in captured)) captured[c.name] = `[answer to ${c.where}]`;
      }
      const context = examContext(
        variables,
        {
          seat_number: seatId,
          first_name: name(req.body?.first_name, 'Sample'),
          last_name: name(req.body?.last_name, 'Participant'),
        },
        undefined,
        captured,
      );
      return res.json({
        kind,
        seat_id: seatId,
        context,
        sections: examForSeat(content, context).map((sec, si) =>
          isSubmitSection(sec)
            ? { ...sec, index: si, body: injectImages(sec.body, images) }
            : {
                ...sec,
                index: si,
                type: 'part',
                items: sec.items.map((it) =>
                  isQuestion(it)
                    ? {
                        ...it,
                        prompt: injectImages(it.prompt, images),
                        options: it.options.map((o) => injectImages(o, images)),
                      }
                    : {
                        ...it,
                        body: injectImages(it.body, images),
                        ...(it.tasks
                          ? { tasks: it.tasks.map((t) => injectImages(t, images)) }
                          : {}),
                      },
                ),
              },
        ),
      });
    }

    const who = {
      firstName: name(req.body?.first_name, 'Sample'),
      lastName: name(req.body?.last_name, 'Participant'),
      captured: {},
      images: imageUrlMap(),
    };
    for (const section of content) {
      for (const step of section.steps || []) {
        const cp = step.checkpoint;
        if (cp?.capture) {
          who.captured[cp.capture] = cp.pattern ? maskExample(cp.pattern) : cp.answer || '';
        }
      }
    }
    const { context, sections } = renderManual(content, variables, seatId, who);
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
