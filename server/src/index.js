import { createApp } from './app.js';
import config from './config.js';
import { ensureSeed } from './db/seed.js';

// Refuse to boot a production deployment on the insecure development secrets:
// they are public in this repo, so running with them would let anyone forge
// instructor/participant tokens.
if (config.env === 'production' && config.usingDefaultSecrets) {
  console.error(
    '\n  \x1b[31mFATAL: refusing to start in production with default JWT secrets.\x1b[0m\n' +
      '  Set JWT_INSTRUCTOR_SECRET and JWT_PARTICIPANT_SECRET to strong random\n' +
      '  values (e.g. `openssl rand -hex 32`) before deploying.\n',
  );
  process.exit(1);
}

// Ensure a bootstrap instructor + sample template exist on first run.
ensureSeed();

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`\n  vLabs API listening on http://localhost:${config.port}`);
  console.log(`  Environment: ${config.env}`);
  if (config.usingDefaultSecrets) {
    // Non-production only (production hard-fails above).
    console.warn(
      '  \x1b[33mNote: default JWT secrets in use (development). Set\n' +
        '  JWT_INSTRUCTOR_SECRET and JWT_PARTICIPANT_SECRET before deploying.\x1b[0m',
    );
  }
  console.log('');
});

// Graceful shutdown for container environments.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n  Received ${sig}, shutting down.`);
    server.close(() => process.exit(0));
  });
}
