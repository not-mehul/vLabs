import { createApp } from './app.js';
import config from './config.js';
import { ensureSeed } from './db/seed.js';

// Ensure a bootstrap instructor + sample template exist on first run.
ensureSeed();

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`\n  vLabs API listening on http://localhost:${config.port}`);
  console.log(`  Environment: ${config.env}`);
  if (config.usingDefaultSecrets && config.env === 'production') {
    console.warn(
      '  \x1b[33mWARNING: default JWT secrets in use. Set JWT_INSTRUCTOR_SECRET and\n' +
        '  JWT_PARTICIPANT_SECRET before exposing this deployment.\x1b[0m',
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
