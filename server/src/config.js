import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Centralised runtime configuration.
 *
 * Secrets fall back to development defaults so the app boots out-of-the-box,
 * but a warning is emitted (see index.js) whenever the insecure defaults are
 * used, and production deployments MUST supply their own values via env vars.
 */
const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),

  // Absolute path to the SQLite database file.
  dbPath:
    process.env.DB_PATH ||
    path.resolve(__dirname, '..', 'data', 'vlabs.sqlite'),

  // Separate secrets for the two token audiences so an instructor token can
  // never be replayed as a participant token and vice-versa.
  jwt: {
    instructorSecret:
      process.env.JWT_INSTRUCTOR_SECRET || 'dev-instructor-secret-change-me',
    participantSecret:
      process.env.JWT_PARTICIPANT_SECRET || 'dev-participant-secret-change-me',
    // Instructor sessions last a work day; participant tokens are additionally
    // gated by the live session record so this is only an upper bound.
    instructorTtl: process.env.JWT_INSTRUCTOR_TTL || '12h',
    participantTtl: process.env.JWT_PARTICIPANT_TTL || '12h',
  },

  // Comma separated list of allowed CORS origins. Defaults to the Vite dev
  // server. Use "*" only for throwaway demos.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  // Default bootstrap instructor, created by the seeder if no instructor exists.
  seedInstructor: {
    username: process.env.SEED_INSTRUCTOR_USERNAME || 'instructor',
    password: process.env.SEED_INSTRUCTOR_PASSWORD || 'labmanual123',
  },
};

config.usingDefaultSecrets =
  config.jwt.instructorSecret === 'dev-instructor-secret-change-me' ||
  config.jwt.participantSecret === 'dev-participant-secret-change-me';

export default config;
