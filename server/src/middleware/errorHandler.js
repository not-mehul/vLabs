import config from '../config.js';

/** 404 fallback for unmatched API routes. */
export function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

/** Centralised error handler. Hides internals in production. */
// eslint-disable-next-line no-unused-vars -- Express identifies this by arity.
export function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('[error]', err);
  }
  res.status(status).json({
    error:
      status >= 500 && config.env === 'production'
        ? 'Internal server error'
        : err.message || 'Internal server error',
  });
}

/** Wrap an async route so rejected promises reach the error handler. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Throw a typed HTTP error from anywhere in a handler. */
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
