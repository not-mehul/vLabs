#!/usr/bin/env node
/**
 * Lint vLabs Template Studio's page scripts as the browser runs them: one
 * module made of client/studio/src/{imports,exam-core,…}.js (see
 * client/studio/app-source.mjs). Linted file by file they would be full of
 * names defined in a sibling file, so `eslint .` skips them and this checks
 * the combined source instead, mainly for undefined and unused names.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import globals from 'globals';
import js from '@eslint/js';
import { appModuleSource } from '../client/studio/app-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    js.configs.recommended,
    {
      languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        globals: { ...globals.browser, __STUDIO_VERSION__: 'readonly', JSZip: 'readonly' },
      },
      rules: {
        // Functions and state are reached from data-on-* attributes in markup.
        'no-unused-vars': 'off',
        'no-empty': ['error', { allowEmptyCatch: true }],
      },
    },
  ],
});

const [result] = await eslint.lintText(appModuleSource(), {
  filePath: path.join(root, 'client/studio/src/studio-app.js'),
});
if (result.messages.length) {
  // Map lines of the combined module back to the source files.
  const lines = appModuleSource().split('\n');
  const where = (line) => {
    let file = '(header)';
    let start = 0;
    for (let i = 0; i < line; i += 1) {
      const m = /^\/\/ ---- (\S+\.js) -+$/.exec(lines[i]);
      if (m) {
        file = m[1];
        start = i + 1;
      }
    }
    return `client/studio/src/${file}:${line - start}`;
  };
  for (const m of result.messages) {
    console.error(`${where(m.line)}:${m.column}  ${m.message}  (${m.ruleId})`);
  }
  console.error(`\n${result.messages.length} problem(s) in vLabs Template Studio's scripts.`);
  process.exit(1);
}
console.log("vLabs Template Studio's scripts: no lint problems.");
