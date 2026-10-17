#!/usr/bin/env node
/**
 * Builds vLabs Template Studio from client/studio/src, two ways:
 *
 *   client/public/studio/          the Studio inside vLabs (the template
 *                                  editor). Separate studio.js / studio.css /
 *                                  font files, so it runs under the app's
 *                                  Content-Security-Policy (no inline script
 *                                  or style). Generated, not committed.
 *   docs/vlabs_template_studio.html  the standalone Studio: one self-contained
 *                                  file (scripts, styles, fonts and icons
 *                                  inlined) that works offline from disk.
 *                                  Committed, and also copied next to the
 *                                  app's Studio so vLabs can offer it as a
 *                                  download.
 *
 *   node studio/build.mjs            build both
 *   node studio/build.mjs --check    fail if docs/vlabs_template_studio.html
 *                                    is not what the sources build (CI)
 *
 * The Studio's own scripts (src/exam-core.js, src/studio.js, src/exam-ui.js,
 * src/host.js) share one scope, as they did as <script> blocks in one page:
 * they are concatenated into a single module, which can import the app's
 * shared modules (shared/*.js). Their markup wires events with data-on-*
 * attributes, run by src/inline-handlers.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from './tailwind.config.js';
import { APP_SCRIPTS, appModuleSource } from './app-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, '..');
const repoDir = path.resolve(clientDir, '..');
const srcDir = path.join(here, 'src');
const modulesDir = path.join(clientDir, 'node_modules');

const APP_OUT = path.join(clientDir, 'public', 'studio');
const OFFLINE_OUT = path.join(repoDir, 'docs', 'vlabs_template_studio.html');
const OFFLINE_NAME = 'vlabs_template_studio.html';

const { version } = JSON.parse(fs.readFileSync(path.join(clientDir, 'package.json'), 'utf8'));
const read = (p) => fs.readFileSync(p, 'utf8');

/* --------------------------------- Script -------------------------------- */

async function bundleScript() {
  const result = await esbuild.build({
    stdin: {
      contents: read(path.join(srcDir, 'main.js')),
      resolveDir: srcDir,
      sourcefile: 'main.js',
    },
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    write: false,
    define: { __STUDIO_VERSION__: JSON.stringify(version) },
    plugins: [
      {
        name: 'studio-app',
        setup(build) {
          build.onResolve({ filter: /^studio:app$/ }, () => ({ path: 'app', namespace: 'studio' }));
          build.onLoad({ filter: /.*/, namespace: 'studio' }, () => ({
            contents: appModuleSource(),
            resolveDir: srcDir,
            loader: 'js',
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

/* ---------------------------------- Icons -------------------------------- */

/**
 * Phosphor icons as CSS masks, only those the Studio uses: `ph ph-name`
 * (regular), `ph-bold ph-name` and `ph-fill ph-name`. Replaces the Phosphor
 * icon font from a CDN.
 */
function iconCss(sources) {
  const assets = path.join(modulesDir, '@phosphor-icons', 'core', 'assets');
  const names = new Set();
  const heavy = new Set();
  for (const text of sources) {
    for (const line of text.split('\n')) {
      const found = [...line.matchAll(/\bph-([a-z0-9]+(?:-[a-z0-9]+)*)/g)].map((m) => m[1]);
      const weighted = /\bph-(bold|fill)\b/.test(line);
      for (const n of found) {
        if (n === 'bold' || n === 'fill') continue;
        names.add(n);
        if (weighted) heavy.add(n);
      }
    }
  }
  const svgUrl = (file) => {
    const svg = read(file)
      .replace(/\s+/g, ' ')
      .replace(/fill="currentColor"/g, 'fill="#000"');
    return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}")`;
  };
  const rules = [
    `.ph,.ph-bold,.ph-fill{display:inline-block;width:1em;height:1em;flex-shrink:0;vertical-align:-0.125em;background-color:currentColor;-webkit-mask:var(--ph-icon) center/contain no-repeat;mask:var(--ph-icon) center/contain no-repeat}`,
  ];
  for (const n of [...names].sort()) {
    const regular = path.join(assets, 'regular', `${n}.svg`);
    if (!fs.existsSync(regular)) continue; // a word that merely looks like an icon class
    rules.push(`.ph.ph-${n}{--ph-icon:${svgUrl(regular)}}`);
    if (!heavy.has(n)) continue;
    rules.push(`.ph-bold.ph-${n}{--ph-icon:${svgUrl(path.join(assets, 'bold', `${n}-bold.svg`))}}`);
    rules.push(`.ph-fill.ph-${n}{--ph-icon:${svgUrl(path.join(assets, 'fill', `${n}-fill.svg`))}}`);
  }
  return rules.join('\n');
}

/* ---------------------------------- Fonts -------------------------------- */

const FONTS = [
  ...[300, 400, 500, 600, 700].map((w) => [
    'Inter',
    w,
    '@fontsource/inter',
    `inter-latin-${w}-normal.woff2`,
  ]),
  ...[400, 500, 600].map((w) => [
    'JetBrains Mono',
    w,
    '@fontsource/jetbrains-mono',
    `jetbrains-mono-latin-${w}-normal.woff2`,
  ]),
];

function fontFile(pkg, file) {
  return path.join(modulesDir, pkg, 'files', file);
}

/** @font-face rules; `src(file)` gives each font's URL. */
function fontCss(src) {
  return FONTS.map(
    ([family, weight, pkg, file]) =>
      `@font-face{font-family:'${family}';font-style:normal;font-display:swap;font-weight:${weight};src:url(${src(pkg, file)}) format('woff2')}`,
  ).join('\n');
}

/* ----------------------------------- CSS --------------------------------- */

async function buildCss() {
  const result = await postcss([tailwindcss(tailwindConfig)]).process(
    read(path.join(srcDir, 'studio.css')),
    {
      from: path.join(srcDir, 'studio.css'),
    },
  );
  const { code } = await esbuild.transform(result.css, { loader: 'css', minify: true });
  return code;
}

/* ---------------------------------- Page --------------------------------- */

function page({ head, scripts, offline }) {
  return (
    read(path.join(srcDir, 'index.html'))
      .replaceAll('%STUDIO_VERSION%', version)
      .replaceAll('%STUDIO_BUILD%', offline ? 'offline' : 'app')
      // Function replacers: the inlined code is full of `$&`-like sequences.
      .replace('<!-- studio:head -->', () => head)
      .replace('<!-- studio:body -->', () =>
        read(path.join(srcDir, 'body.html')).trimEnd().replaceAll('%STUDIO_VERSION%', version),
      )
      .replace('<!-- studio:scripts -->', () => scripts)
  );
}

/** Inline-safe script text (a literal "</script" would end the element). */
const inlineScript = (js) => js.replace(/<\/script/gi, '<\\/script');

async function build({ check = false } = {}) {
  const [js, css] = await Promise.all([bundleScript(), buildCss()]);
  const icons = iconCss([...APP_SCRIPTS, 'body.html'].map((f) => read(path.join(srcDir, f))));

  const offline = page({
    offline: true,
    head: `<style>\n${fontCss((pkg, file) => `data:font/woff2;base64,${fs.readFileSync(fontFile(pkg, file)).toString('base64')}`)}\n${icons}\n${css}</style>`,
    scripts: `<script>${inlineScript(js)}</script>`,
  });

  if (check) {
    const current = fs.existsSync(OFFLINE_OUT) ? read(OFFLINE_OUT) : '';
    if (current !== offline) {
      console.error(
        `${path.relative(repoDir, OFFLINE_OUT)} is out of date: run \`npm run build:studio --prefix client\` and commit it.`,
      );
      process.exit(1);
    }
    console.log('Template Studio: offline build is up to date.');
    return;
  }

  fs.writeFileSync(OFFLINE_OUT, offline);

  fs.rmSync(APP_OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(APP_OUT, 'fonts'), { recursive: true });
  for (const [, , pkg, file] of FONTS)
    fs.copyFileSync(fontFile(pkg, file), path.join(APP_OUT, 'fonts', file));
  fs.writeFileSync(
    path.join(APP_OUT, 'studio.css'),
    `${fontCss((pkg, file) => `fonts/${file}`)}\n${icons}\n${css}`,
  );
  fs.writeFileSync(path.join(APP_OUT, 'studio.js'), js);
  fs.writeFileSync(
    path.join(APP_OUT, 'index.html'),
    page({
      offline: false,
      head: `<link rel="stylesheet" href="studio.css?v=${version}">`,
      scripts: `<script src="studio.js?v=${version}" defer></script>`,
    }),
  );
  fs.copyFileSync(OFFLINE_OUT, path.join(APP_OUT, OFFLINE_NAME));
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  console.log(
    `Template Studio ${version}: ${path.relative(repoDir, APP_OUT)}/ (js ${kb(js.length)}, css ${kb(css.length + icons.length)}) · ${path.relative(repoDir, OFFLINE_OUT)} (${kb(offline.length)})`,
  );
}

build({ check: process.argv.includes('--check') }).catch((err) => {
  console.error(err);
  process.exit(1);
});
