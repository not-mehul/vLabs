/**
 * The Studio's page scripts as one module (see build.mjs). Kept free of
 * build dependencies so the repo's lint step can check the combined source
 * (scripts/lint-studio.js) without installing the client.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src');
const read = (p) => fs.readFileSync(p, 'utf8');

/** The Studio's scripts, in page order. They share one top-level scope. */
export const APP_SCRIPTS = [
  'imports.js',
  'exam-core.js',
  'lab-core.js',
  'studio.js',
  'exam-ui.js',
  'documents.js',
  'host.js',
];

/** Top-level declarations of the concatenated scripts (for the handler scope). */
export function topLevelNames(code) {
  const fns = new Set();
  const lets = new Set();
  const consts = new Set();
  for (const m of code.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
    fns.add(m[1]);
  }
  for (const m of code.matchAll(/^(let|var|const)\s+([A-Za-z_$][\w$]*)/gm)) {
    (m[1] === 'const' ? consts : lets).add(m[2]);
  }
  return { fns, lets, consts };
}

export function appModuleSource() {
  const code = APP_SCRIPTS.map(
    (f) => `// ---- ${f} ${'-'.repeat(Math.max(0, 66 - f.length))}\n${read(path.join(srcDir, f))}`,
  ).join('\n');
  const { fns, lets, consts } = topLevelNames(code);
  const entries = [
    ...[...fns, ...consts].map((n) => `  get ${n}() { return ${n}; },`),
    ...[...lets].map((n) => `  get ${n}() { return ${n}; },\n  set ${n}(v) { ${n} = v; },`),
  ];
  return `import { installInlineHandlers } from './inline-handlers.js';
${code}
installInlineHandlers({
${entries.join('\n')}
});
`;
}
