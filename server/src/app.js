import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import db from './db/index.js';
import { requestLogger } from './lib/logger.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import templateRoutes from './routes/templates.js';
import sessionRoutes from './routes/sessions.js';
import participantRoutes from './routes/participant.js';
import imageRoutes from './routes/images.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const healthCheck = db.prepare('SELECT 1 AS ok');

export function createApp() {
  const app = express();

  // Which proxy hops to trust for X-Forwarded-For. Comes from TRUST_PROXY so
  // it matches the real topology: a hard-coded `1` let clients spoof their IP
  // (and dodge the per-IP limiters) whenever the app was exposed directly.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // gzip responses (JSON analytics payloads, the SPA bundle) to cut bandwidth.
  app.use(compression());

  // Security headers. The SPA is fully self-contained, so we can run a strict
  // Content-Security-Policy. No 'unsafe-inline' for styles: React applies the
  // `style` prop via the CSSOM (allowed under CSP), the font CSS is a linked
  // stylesheet, and DOMPurify strips style attributes from authored Markdown.
  //
  // SERVE_PLAIN_HTTP (LAN pilots only) drops `upgrade-insecure-requests` and
  // HSTS; with them, a page loaded from http://192.168.x.x has all its /api
  // requests upgraded to https:// by the browser and the app cannot load.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.plainHttp ? null : [],
        },
      },
      ...(config.plainHttp ? { strictTransportSecurity: false } : {}),
      // Content is delivered as JSON to the DOM only; discourage embedding.
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin / curl (no Origin header) always allowed.
        if (!origin) return cb(null, true);
        if (config.corsOrigins.includes('*')) return cb(null, true);
        return cb(null, config.corsOrigins.includes(origin));
      },
    }),
  );

  // 1 MB comfortably exceeds the validator's own template size cap
  // (LIMITS.serialisedBytes) so authors hit the readable error, not a 413.
  app.use(express.json({ limit: '1mb' }));

  app.use(requestLogger());

  // Health check (unauthenticated, unlimited) for systemd/Caddy/monitoring.
  // Touches the database so a wedged/locked SQLite file is reported as down.
  app.get('/api/health', (req, res) => {
    try {
      healthCheck.get();
      res.json({ status: 'ok', time: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ status: 'degraded', error: 'database unavailable' });
    }
  });

  // Broad rate limit across the whole API surface.
  app.use('/api', apiLimiter);

  app.use('/api/auth', authRoutes);
  app.use('/api/templates', templateRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/participant', participantRoutes);
  app.use('/api/images', imageRoutes);

  // In production, serve the built SPA and fall back to index.html for client
  // routing. In development the Vite dev server handles the frontend instead.
  const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(
      express.static(clientDist, {
        index: false,
        setHeaders(res, filePath) {
          // Vite emits content-hashed filenames under /assets, so those can be
          // cached aggressively and immutably. index.html must always be
          // revalidated, and the un-hashed root files (favicon, manifest,
          // touch icons) get a short TTL so a replaced icon shows up same-day.
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
          }
        },
      }),
    );
    app.get(/^(?!\/api).*/, (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use('/api', notFound);
  app.use(errorHandler);

  return app;
}
