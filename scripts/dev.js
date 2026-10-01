#!/usr/bin/env node
/**
 * Local development launcher (macOS / Linux). No dependencies.
 *
 *   npm run dev            # from the repo root
 *
 * Starts, side by side:
 *   api  — `node --watch src/index.js` in server/  (restarts on file change)
 *   web  — `vite` in client/ (HMR; proxies /api to the backend)
 *
 * Open http://localhost:5173. The backend binds loopback only in dev
 * (HOST=127.0.0.1) and the SPA is served by Vite, so nothing on your Wi-Fi
 * can reach the app — set HOST=0.0.0.0 and VITE host flags if you want to
 * test from a phone.
 *
 * Ctrl-C stops both; if either process dies the other is stopped too.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const ws of ['server', 'client']) {
  if (!fs.existsSync(path.join(root, ws, 'node_modules'))) {
    console.error(`\n  ${ws}/node_modules is missing — run \`npm run setup\` first.\n`);
    process.exit(1);
  }
}
if (!fs.existsSync(path.join(root, '.env'))) {
  console.log(
    '  No .env found; using development defaults (copy .env.example to .env to override).',
  );
}

const colours = { api: '\x1b[36m', web: '\x1b[35m' };
const reset = '\x1b[0m';
const children = [];
let exiting = false;

function start(name, cwd, args, env = {}) {
  const child = spawn(npm, args, {
    cwd: path.join(root, cwd),
    env: { ...process.env, FORCE_COLOR: '1', ...env },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const prefix = `${colours[name]}[${name}]${reset} `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
    stream.on('end', () => buf && out.write(prefix + buf + '\n'));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (exiting) return;
    console.error(`${prefix}exited (${signal || code}); stopping the other process.`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const c of children) {
    if (c.exitCode === null) c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('api', 'server', ['run', 'dev'], {
  NODE_ENV: process.env.NODE_ENV || 'development',
  HOST: process.env.HOST || '127.0.0.1',
});
start('web', 'client', ['run', 'dev', '--', '--clearScreen', 'false']);
