import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The single `.env` lives at the REPO ROOT (next to .env.example) regardless
// of the working directory the server is started from (`npm run dev` from the
// root, `node --watch` inside server/, or systemd with WorkingDirectory=…).
// Real environment variables always win over the file (dotenv never
// overrides), which is what systemd's EnvironmentFile and CI rely on.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

/**
 * Centralised runtime configuration.
 *
 * Secrets fall back to development defaults so the app boots out-of-the-box,
 * but production deployments MUST supply their own values via env vars —
 * index.js refuses to start otherwise.
 *
 * Secret strength is judged by LENGTH and a placeholder denylist rather than
 * by comparing against the one dev string: the old string-equality check was
 * bypassed by copy-pasted `change-me-*` placeholders.
 */

const DEV_INSTRUCTOR_SECRET = 'dev-instructor-secret-change-me';
const DEV_PARTICIPANT_SECRET = 'dev-participant-secret-change-me';
const DEV_SEED_PASSWORD = 'labmanual123';
const MIN_SECRET_LENGTH = 32;

/** Substrings that mark a secret as an unreplaced placeholder. */
const PLACEHOLDER_MARKERS = [
  'change-me',
  'changeme',
  'replace-me',
  'placeholder',
  'secret-here',
  'example',
  'dev-',
];

/** True when a JWT secret is too short or looks like a placeholder. */
export function isWeakSecret(secret) {
  const s = String(secret || '');
  if (s.length < MIN_SECRET_LENGTH) return true;
  const lower = s.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((m) => lower.includes(m))) return true;
  // Very low character diversity (e.g. "aaaa…" or "1234…") is also a placeholder.
  if (new Set(lower).size < 8) return true;
  return false;
}

/**
 * Parse TRUST_PROXY into an Express `trust proxy` setting.
 *   unset / '' / 'false' / '0'  -> false  (direct exposure; safest default)
 *   'true'                      -> true   (trust every hop — only with a proxy)
 *   '1', '2', …                 -> hop count
 *   anything else               -> passed through (e.g. 'loopback', '10.0.0.0/8')
 */
export function parseTrustProxy(value) {
  const v = String(value ?? '').trim();
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

/**
 * Settings that were given but cannot be used. Each falls back to its default
 * and index.js warns about it at start-up: `MIN_PASSWORD_LENGTH=abc` used to
 * become NaN, and `length < NaN` accepted any password at all.
 */
const invalidSettings = [];

/** An integer setting within [min, max]; anything else falls back (and is reported). */
function intSetting(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  invalidSettings.push({ name, value: raw, fallback });
  return fallback;
}

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  port: intSetting('PORT', 4000, 1, 65535),

  // Interface to bind. Defaults to loopback: in development the browser talks
  // to the Vite dev server (which proxies /api), and on the Pi Caddy sits in
  // front and is the only thing that should reach Node directly. Set
  // HOST=0.0.0.0 only when you deliberately expose Node itself to the LAN.
  host: process.env.HOST || '127.0.0.1',

  // Absolute path to the SQLite database file.
  dbPath: process.env.DB_PATH || path.resolve(__dirname, '..', 'data', 'vlabs.sqlite'),

  // Express `trust proxy`. MUST match the real topology: when the app is
  // exposed directly, trusting X-Forwarded-For lets clients spoof their IP and
  // sidestep the per-IP join/login limiters.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  trustProxyConfigured: process.env.TRUST_PROXY !== undefined,

  // Separate secrets for the two token audiences so an instructor token can
  // never be replayed as a participant token and vice-versa.
  jwt: {
    instructorSecret: process.env.JWT_INSTRUCTOR_SECRET || DEV_INSTRUCTOR_SECRET,
    participantSecret: process.env.JWT_PARTICIPANT_SECRET || DEV_PARTICIPANT_SECRET,
    // Instructor sessions last a work day. A participant token lasts this long
    // past its session's expiry (lib/tokens.js) and is gated by the live
    // session record on every request, so this is only an upper bound.
    instructorTtl: process.env.JWT_INSTRUCTOR_TTL || '12h',
    participantTtl: process.env.JWT_PARTICIPANT_TTL || '12h',
  },

  // Comma separated list of allowed CORS origins. Unset: the Vite dev server
  // in development, none in production (the SPA is same-origin there). Set but
  // empty (as install.sh writes it) means none — `||` used to turn that into
  // the dev origin. Use "*" only for throwaway demos.
  corsOrigins: (process.env.CORS_ORIGINS ?? (env === 'production' ? '' : 'http://localhost:5173'))
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  // Default bootstrap instructor, created by the seeder if no instructor exists.
  seedInstructor: {
    username: process.env.SEED_INSTRUCTOR_USERNAME || 'instructor',
    password: process.env.SEED_INSTRUCTOR_PASSWORD || DEV_SEED_PASSWORD,
  },

  // Where the Pi publishes its current join addresses (written by
  // deploy/pi/render-caddy.sh whenever the network changes). Missing file → the
  // portal simply shows no addresses (dev machines, other hosts).
  addressesFile: process.env.VLABS_ADDRESSES_FILE || '/run/vlabs-net/addresses.json',

  // Instructor password policy (applies to the change-password endpoint).
  minPasswordLength: intSetting('MIN_PASSWORD_LENGTH', 10, 1, 200),

  // Structured logging. LOG_LEVEL: debug | info | warn | error | silent.
  // LOG_FORMAT: json (default in production) | pretty (default elsewhere).
  log: {
    level: process.env.LOG_LEVEL || (env === 'test' ? 'silent' : 'info'),
    format: process.env.LOG_FORMAT || (env === 'production' ? 'json' : 'pretty'),
  },

  // Set SERVE_PLAIN_HTTP=true only when the app is reached over plain HTTP
  // (e.g. a LAN pilot without TLS). It removes the CSP
  // `upgrade-insecure-requests` directive and HSTS: browsers honour the
  // directive on http:// pages too, which makes every /api call get rewritten
  // to https:// and fail on a LAN IP. Never enable this on an internet-facing
  // deployment — TLS is mandatory there.
  plainHttp: ['1', 'true', 'yes'].includes(
    String(process.env.SERVE_PLAIN_HTTP || '').toLowerCase(),
  ),

  // Sessions still marked active this long after `expires_at` are swept to
  // "ended" so their room codes recycle. The grace window preserves the
  // instructor's ability to "+30" a session that just ran out.
  expiredSessionGraceMinutes: intSetting('EXPIRED_SESSION_GRACE_MINUTES', 60, 0, 7 * 24 * 60),

  invalidSettings,
};

config.weakSecrets =
  isWeakSecret(config.jwt.instructorSecret) || isWeakSecret(config.jwt.participantSecret);
config.sameSecrets = config.jwt.instructorSecret === config.jwt.participantSecret;
config.seedPasswordIsDefault = config.seedInstructor.password === DEV_SEED_PASSWORD;
config.devSeedPassword = DEV_SEED_PASSWORD;

export default config;
