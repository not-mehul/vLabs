import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import templateRoutes from './routes/templates.js';
import sessionRoutes from './routes/sessions.js';
import participantRoutes from './routes/participant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // correct client IPs behind a reverse proxy

  // Security headers. The SPA is fully self-contained, so we can run a fairly
  // strict Content-Security-Policy.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      // Content is delivered as JSON to the DOM only; discourage embedding.
      crossOriginResourcePolicy: { policy: 'same-origin' },
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

  app.use(express.json({ limit: '256kb' }));

  // Health check (unauthenticated, unlimited) for container orchestration.
  app.get('/api/health', (req, res) =>
    res.json({ status: 'ok', time: new Date().toISOString() }),
  );

  // Broad rate limit across the whole API surface.
  app.use('/api', apiLimiter);

  app.use('/api/auth', authRoutes);
  app.use('/api/templates', templateRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/participant', participantRoutes);

  // In production, serve the built SPA and fall back to index.html for client
  // routing. In development the Vite dev server handles the frontend instead.
  const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^(?!\/api).*/, (req, res) =>
      res.sendFile(path.join(clientDist, 'index.html')),
    );
  }

  app.use('/api', notFound);
  app.use(errorHandler);

  return app;
}
