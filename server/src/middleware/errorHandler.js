import config from '../config.js';
import { log } from '../lib/logger.js';

/** 404 fallback for unmatched API routes. */
export function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

/** Centralised error handler. Hides internals in production. */
// eslint-disable-next-line no-unused-vars -- Express identifies this by arity.
export function errorHandler(err, req, res, next) {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Internal server error';

  // body-parser errors carry a `type`; give them friendly, non-leaky messages.
  if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body is too large';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body is not valid JSON';
  }

  if (status >= 500) {
    log.error('unhandled', { err, method: req.method, path: req.path });
  }

  const body = {
    error: status >= 500 && config.env === 'production' ? 'Internal server error' : message,
  };
  if (err.code && status < 500) body.code = err.code;
  if (Array.isArray(err.details) && status < 500) body.details = err.details;
  // The image already in the library on a 409 IMAGE_EXISTS (the editor asks
  // before replacing it, naming the templates that use it).
  if (err.existing && status < 500) body.existing = err.existing;
  res.status(status).json(body);
}

/** Wrap an async route so rejected promises reach the error handler. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Throw a typed HTTP error from anywhere in a handler. */
export function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

/** The numeric :id route parameter, or a 404 with `notFound` as the message. */
export function idParam(req, notFound) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(404, notFound);
  return id;
}
