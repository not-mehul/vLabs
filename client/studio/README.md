# vLabs Template Studio

The editor for vLabs labs and exams. One set of sources builds it twice:

| Build                                   | Where it runs                                            | Templates and images                                 |
| --------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `client/public/studio/` (not committed) | Inside the portal, framed by `pages/TemplateEditor.jsx`  | The portal's: load, save, versions, image library    |
| `docs/vlabs_template_studio.html`       | Anywhere, offline: one file, nothing loaded from the web | The browser's: documents in IndexedDB, files on disk |

## Layout

- `src/index.html`, `src/body.html` — the page. Buttons use `data-on-click="…"`
  (and `-input`, `-change`, `-keydown`, `-drag*`, `-drop`) instead of
  `onclick`: the portal's CSP allows no inline script, so
  `src/inline-handlers.js` runs these through a small interpreter (calls,
  member access, literals, `if`, assignment, `!`, `-`, `===`, `!==`; no
  functions or other operators). Names resolve only to the Studio's own
  top-level functions and variables, `this`, `event` and `document`.
- `src/imports.js`, `exam-core.js`, `lab-core.js`, `studio.js`, `exam-ui.js`,
  `host.js` — the Studio's scripts. They share one scope: `build.mjs`
  concatenates them, in that order, into one module (`app-source.mjs`), so
  they are linted together by `scripts/lint-studio.js`, not one by one.
  - `imports.js` is the only file with imports: vLabs' own `shared/` modules
    (schema, formats, templating, validators) and `src/lib/markdown.js`.
  - `exam-core.js` / `lab-core.js` give those the names the Studio calls.
    There is no second copy of any rule.
  - `host.js` is the bridge to the portal (`postMessage`, same origin only).
    It is inert unless the page is framed with `?host=vlabs`.
- `src/studio.css` — Tailwind (`tailwind.config.js`) plus the Studio's CSS.
  Icons are Phosphor SVGs as CSS masks, fonts are `@fontsource` files; all
  are inlined into the offline file.

## Building

From `client/`:

```sh
npm run build:studio   # both builds (also run by `npm run dev` and `npm run build`)
npm run check:studio   # fails if docs/vlabs_template_studio.html is out of date (CI)
```

Commit `docs/vlabs_template_studio.html` whenever the Studio or a `shared/`
module it uses changes.

## The portal bridge

Messages carry `source: 'vlabs-app'` or `'vlabs-studio'`; each side checks
the origin and the sending window.

| App → Studio  | Data                                                             |
| ------------- | ---------------------------------------------------------------- |
| `load`        | `kind`, `template` (null: new), `images`, `kindLocked`, `reason` |
| `images`      | `images`, optional `note`, `tone`                                |
| `theme`       | `dark`                                                           |
| `saved`       | `version`                                                        |
| `open-import` | —                                                                |
| `flush-save`  | — (the Studio answers with `save`)                               |

| Studio → App    | Data                         |
| --------------- | ---------------------------- |
| `ready`         | —                            |
| `loaded`        | `kind`, `template`, `reason` |
| `change`        | `kind`, `template`           |
| `save`          | `kind`, `template`           |
| `upload-images` | `files`                      |
| `delete-image`  | `name`                       |

Offline, `src/documents.js` keeps each template as a document in IndexedDB
(several at once, images included), saves to and opens `.zip` files, and
says so when the browser will not store one.

In the portal the Studio hides AI Polish (it needs the open internet, which
the portal's CSP does not allow), its theme switch (it follows the
portal's), **Documents** and **New** (a template's kind is fixed once saved;
the portal has **New lab** and **New exam**).
