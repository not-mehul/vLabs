import { createApp } from './app.js';
import config from './config.js';
import db from './db/index.js';
import { ensureSeed, needsBootstrapInstructor } from './db/seed.js';
import { sweepExpiredSessions } from './lib/sessionLifecycle.js';
import { log } from './lib/logger.js';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function fatal(lines) {
  console.error(`\n  ${RED}FATAL: ${lines[0]}${RESET}`);
  for (const l of lines.slice(1)) console.error(`  ${l}`);
  console.error('');
  process.exit(1);
}

const isProd = config.env === 'production';

/* ---------------------------------------------------------------------- */
/*  Production guard rails — fail fast instead of running insecurely.      */
/* ---------------------------------------------------------------------- */

// Weak / placeholder JWT secrets would let anyone forge instructor or
// participant tokens. Judged by strength, not by comparing against one dev
// string, so compose-file placeholders like "change-me-instructor" also fail.
if (isProd && config.weakSecrets) {
  fatal([
    'refusing to start in production with weak or placeholder JWT secrets.',
    'Set JWT_INSTRUCTOR_SECRET and JWT_PARTICIPANT_SECRET to distinct random values',
    'of at least 32 characters (e.g. `openssl rand -hex 32`) before deploying.',
  ]);
}
if (isProd && config.sameSecrets) {
  fatal([
    'JWT_INSTRUCTOR_SECRET and JWT_PARTICIPANT_SECRET must differ.',
    'Using one secret for both audiences lets a participant token be replayed as an instructor token.',
  ]);
}

// The bootstrap instructor password is public in this repo. Refuse to CREATE
// that account in production; an existing deployment whose instructor already
// changed their password in the UI is unaffected (the env var is then unused).
if (isProd && config.seedPasswordIsDefault && needsBootstrapInstructor()) {
  fatal([
    'refusing to create the bootstrap instructor with the default password in production.',
    'Set SEED_INSTRUCTOR_PASSWORD to a strong value for the first start, then change it',
    'from the portal (Account → Change password).',
  ]);
}

if (isProd && config.plainHttp) {
  log.warn('plain_http.enabled', {
    msg:
      'SERVE_PLAIN_HTTP is on: HSTS and upgrade-insecure-requests are disabled. ' +
      'Acceptable for an isolated LAN pilot only; put TLS in front before exposing this to the internet.',
  });
}

if (isProd && !config.trustProxyConfigured) {
  log.warn('trust_proxy.unset', {
    msg:
      'TRUST_PROXY is not set. Per-IP rate limits will key on the immediate peer. ' +
      'Set TRUST_PROXY=1 when running behind a single reverse proxy.',
  });
}

/* ---------------------------------------------------------------------- */

// Ensure a bootstrap instructor + sample template exist on first run.
ensureSeed();
sweepExpiredSessions();

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`\n  vLabs API listening on http://localhost:${config.port}`);
  console.log(`  Environment: ${config.env}`);
  if (config.weakSecrets) {
    // Non-production only (production hard-fails above).
    console.warn(
      `  ${YELLOW}Note: development JWT secrets in use. Set JWT_INSTRUCTOR_SECRET and\n` +
        `  JWT_PARTICIPANT_SECRET to strong random values before deploying.${RESET}`,
    );
  }
  if (config.seedPasswordIsDefault) {
    console.warn(
      `  ${YELLOW}Note: the bootstrap instructor uses the default password. Change it from\n` +
        `  the portal (Account → Change password) or set SEED_INSTRUCTOR_PASSWORD.${RESET}`,
    );
  }
  console.log('');
  log.info('server.started', { port: config.port, env: config.env });
});

// Keep-alive sockets can otherwise hold the process open past the container's
// stop grace period; close idle ones immediately and give in-flight requests a
// bounded window before forcing exit.
server.keepAliveTimeout = 5_000;
server.headersTimeout = 10_000;

// Periodic housekeeping: end sessions that expired past the grace window so
// their room codes recycle even if no instructor opens the dashboard.
const sweepTimer = setInterval(() => {
  try {
    sweepExpiredSessions();
  } catch (err) {
    log.error('sessions.sweep.failed', { err });
  }
}, 10 * 60_000);
sweepTimer.unref();

/* ---------------------------------------------------------------------- */
/*  Graceful shutdown for container environments.                         */
/* ---------------------------------------------------------------------- */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server.shutdown', { signal });
  clearInterval(sweepTimer);

  const force = setTimeout(() => {
    log.warn('server.shutdown.forced');
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }, 8_000);
  force.unref();

  server.close(() => {
    try {
      db.close(); // checkpoints the WAL so the data file is self-contained
    } catch (err) {
      log.error('db.close.failed', { err });
    }
    process.exit(0);
  });
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
});
