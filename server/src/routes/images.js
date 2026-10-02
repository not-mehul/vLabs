import express, { Router } from 'express';
import { requireInstructor } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { LIMITS } from '../../../shared/template-schema.js';
import {
  listImages,
  getImage,
  saveImage,
  deleteImage,
  imageReferences,
  imageUrl,
} from '../lib/images.js';
import { log } from '../lib/logger.js';

const router = Router();

/** GET /api/images/:id/references — where an image is used (editor delete confirm).
 *  Declared before the public serve route so "references" is never read as a file name. */
router.get('/:id/references', requireInstructor, (req, res) => {
  const row = getImage(req.params.id);
  if (!row) throw httpError(404, 'Image not found');
  res.json({ id: row.id, name: row.name, url: imageUrl(row), ...imageReferences(row.name) });
});

/**
 * GET /api/images/:id/:name — serve an image. Public by design: <img> tags
 * cannot send a bearer token, so the random 128-bit id is the capability.
 * The name segment is cosmetic (nice "Save as…" names, readable logs); the
 * id alone identifies the row. Cacheable: a replaced image gets a new id.
 */
router.get('/:id/:name?', (req, res) => {
  const row = getImage(req.params.id);
  if (!row) return res.status(404).end();
  res.set('Content-Type', row.mime);
  res.set('Content-Length', String(row.size));
  res.set('Cache-Control', 'private, max-age=86400, immutable');
  res.set('Content-Disposition', `inline; filename="${row.name.replace(/"/g, '')}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(row.data);
});

/* Everything below is instructor-only. */
router.use(requireInstructor);

/** GET /api/images — library listing (no bytes). */
router.get('/', (req, res) => {
  res.json({ images: listImages(), limits: { bytes: LIMITS.imageBytes, name: LIMITS.imageName } });
});

/**
 * POST /api/images?name=rack.png[&replace=1] — upload one image as the raw
 * request body (Content-Type image/*). No multipart parser needed: the editor
 * sends `fetch(url, { body: file })`. The type is sniffed server-side.
 * 409 + code IMAGE_EXISTS when the name is taken and replace is not set.
 */
router.post(
  '/',
  express.raw({ type: () => true, limit: LIMITS.imageBytes + 1024 }),
  asyncHandler(async (req, res) => {
    const name = String(req.query.name || req.get('x-image-name') || '').trim();
    if (!name) throw httpError(400, 'Provide the file name as ?name=');
    const saved = saveImage({
      name,
      data: req.body,
      replace: req.query.replace === '1',
      instructorId: req.instructor.id,
    });
    log.info(saved.replaced ? 'image.replaced' : 'image.uploaded', {
      image: saved.id,
      name: saved.name,
      size: saved.size,
      instructor: req.instructor.id,
    });
    res.status(saved.replaced ? 200 : 201).json(saved);
  }),
);

/** DELETE /api/images/:id — refused (409) while a template or active session uses it. */
router.delete('/:id', (req, res) => {
  const row = deleteImage(req.params.id);
  log.info('image.deleted', { image: row.id, name: row.name, instructor: req.instructor.id });
  res.status(204).end();
});

export default router;
