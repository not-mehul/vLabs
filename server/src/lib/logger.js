import config from '../config.js';

/**
 * Minimal structured logger (no dependencies).
 *
 *   log.info('session.created', { sessionId: 3, roomCode: '123456' })
 *
 * Emits one JSON object per line in production (easy to ship to any log
 * collector) and a compact human-readable line in development. Levels:
 * debug < info < warn < error < silent.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[config.log.level] ?? LEVELS.info;
const pretty = config.log.format === 'pretty';

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const record = { time: new Date().toISOString(), level, msg, ...(fields || {}) };
  if (record.err instanceof Error) {
    record.err = {
      message: record.err.message,
      stack: record.err.stack,
      status: record.err.status,
    };
  }
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (pretty) {
    const { time, level: lvl, msg: m, ...rest } = record;
    const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
    out.write(`${time.slice(11, 19)} ${lvl.toUpperCase().padEnd(5)} ${m}${extra}\n`);
  } else {
    out.write(JSON.stringify(record) + '\n');
  }
}

export const log = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};

/**
 * Express middleware: one line per API request on response finish. Static
 * assets and the health probe are skipped to keep the log useful. Never logs
 * bodies, tokens or query strings (room codes / answers travel in bodies, and
 * the participant token would otherwise end up in log storage).
 */
export function requestLogger() {
  return (req, res, next) => {
    if (!req.path.startsWith('/api') || req.path === '/api/health') return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const fields = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        ip: req.ip,
      };
      // Identity is attached by the auth middleware when present.
      if (req.instructor) fields.instructor = req.instructor.id;
      if (req.participant) fields.participant = req.participant.id;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      write(level, 'http', fields);
    });
    next();
  };
}
