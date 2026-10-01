/**
 * Import/export helpers for lab templates.
 *
 * Two formats:
 *   - JSON  : the exact template object ({ title, description, variables,
 *             content }). Lossless canonical format.
 *   - Markdown : a human-friendly authoring format (documented below), useful
 *             for writing labs in any editor and uploading them.
 *
 * Markdown convention
 * -------------------
 *   ---
 *   title: My Lab
 *   description: One-line summary
 *   variables:
 *     PORT_NUM = seat
 *     GATEWAY_IP = '192.168.1.' + (100 + seat)
 *   ---
 *
 *   # Section 1 · Getting Started
 *
 *   ## [desk] Prepare your bench
 *   Body markdown for the step. Use {{ VARIABLE }} placeholders.
 *   Fenced code blocks (``` or ~~~) are copied verbatim — headings and
 *   directives inside them are NOT interpreted.
 *
 *   > hint: Label shown on the toggle :: Hidden hint text
 *   > continues on quoted lines until a blank line
 *
 *   > solution:
 *   > A multi-line markdown walkthrough, revealed once every hint is opened.
 *   > - Supports bullet points and links.
 *
 *   ## [computer] Assign an IP
 *   Body…
 *
 *   > checkpoint: Prompt shown to the participant :: {{ HOST_IP }} | {{ HOST_IP }}/24
 *   > placeholder: e.g. 10.0.0.1XX
 *
 *   `# ` starts a section, `## ` starts a step (optional [desk]/[computer]
 *   prefix sets the type, default desk). `> hint:` and `> checkpoint:` lines use
 *   `::` to separate the two parts; write `\::` for a literal `::`. Checkpoint
 *   answers may list alternatives separated by ` | ` (write `\|` for a literal
 *   pipe). `> placeholder:` sets the checkpoint's input placeholder.
 *   `> solution:` starts a block whose following quoted (`> `) lines are the
 *   step's markdown solution. Round-trips through export → import are lossless.
 */

import { normaliseTemplate } from '../../../shared/template-schema.js';
// Re-exported for backwards compatibility with earlier imports of this module.
export { downloadFile, readTextFile } from './files.js';

/* ------------------------------- Escaping -------------------------------- */

const escSep = (s) => String(s ?? '').replace(/::/g, '\\::');
const unescSep = (s) => String(s ?? '').replace(/\\::/g, '::');
const escPipe = (s) => String(s ?? '').replace(/\|/g, '\\|');

/** Split on the first `::` that is not escaped as `\::`. */
function splitOnceUnescaped(str) {
  const s = String(str ?? '');
  for (let i = 0; i < s.length - 1; i += 1) {
    if (s[i] === ':' && s[i + 1] === ':' && s[i - 1] !== '\\') {
      return [unescSep(s.slice(0, i)), unescSep(s.slice(i + 2))];
    }
  }
  return [unescSep(s), ''];
}

/** Split answers on ` | ` respecting `\|` escapes. */
function splitAnswers(str) {
  const out = [];
  let cur = '';
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (s[i] === '|') {
      out.push(cur);
      cur = '';
    } else {
      cur += s[i];
    }
  }
  out.push(cur);
  return out.map((a) => a.trim()).filter(Boolean);
}

const isFence = (line) => /^\s{0,3}(```|~~~)/.test(line);
const isDirective = (line) => /^>\s*(hint|solution|checkpoint|placeholder):/i.test(line);

/* ------------------------------- Export --------------------------------- */

export function templateToJson(tpl) {
  const t = normaliseTemplate(tpl);
  return JSON.stringify(
    { title: t.title, description: t.description, variables: t.variables, content: t.content },
    null,
    2,
  );
}

/** Emit a possibly multi-line text as `> ` quoted continuation lines. */
function quotedLines(text) {
  return String(text ?? '')
    .replace(/\s+$/, '')
    .split('\n')
    .map((l) => `> ${l}`.replace(/\s+$/, ''));
}

export function templateToMarkdown(input) {
  const tpl = normaliseTemplate(input);
  const lines = [];
  lines.push('---');
  lines.push(`title: ${tpl.title}`);
  if (tpl.description) lines.push(`description: ${tpl.description}`);
  if (tpl.variables.length) {
    lines.push('variables:');
    for (const v of tpl.variables) {
      if (v.name) lines.push(`  ${v.name} = ${v.expression}`);
    }
  }
  lines.push('---');
  lines.push('');

  for (const section of tpl.content) {
    lines.push(`# ${section.title || 'Section'}`);
    lines.push('');
    for (const step of section.steps) {
      lines.push(`## [${step.type}] ${step.title}`.trimEnd());
      if (step.body) {
        lines.push('');
        lines.push(step.body.trimEnd());
      }
      for (const h of step.hints) {
        lines.push('');
        const [first, ...rest] = String(h.text ?? '').replace(/\s+$/, '').split('\n');
        lines.push(`> hint: ${escSep(h.label || 'Hint')} :: ${escSep(first)}`.trimEnd());
        for (const l of rest) lines.push(`> ${l}`.replace(/\s+$/, ''));
      }
      if (step.solution && step.solution.trim()) {
        lines.push('');
        lines.push('> solution:');
        lines.push(...quotedLines(step.solution));
      }
      if (step.checkpoint) {
        const cp = step.checkpoint;
        lines.push('');
        const answers = [cp.answer, ...cp.answers].map((a) => escSep(escPipe(a))).join(' | ');
        lines.push(`> checkpoint: ${escSep(cp.prompt)} :: ${answers}`);
        if (cp.placeholder) lines.push(`> placeholder: ${cp.placeholder}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ------------------------------- Import --------------------------------- */

export function parseJsonTemplate(text) {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Not a template object');
  }
  return normaliseTemplate(obj);
}

/** Parse the documented markdown convention into a template object. */
export function parseMarkdownTemplate(text) {
  const src = String(text).replace(/\r\n?/g, '\n');
  let body = src;
  const tpl = { title: '', description: '', variables: [], content: [] };

  // Frontmatter
  const fm = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = src.slice(fm[0].length);
    parseFrontmatter(fm[1], tpl);
  }

  const lines = body.split('\n');
  let section = null;
  let step = null;
  let bodyLines = [];
  let inFence = false;
  // Exactly one of these collectors may be open at a time.
  let solLines = null; // `> solution:` block
  let hint = null; // the hint whose text is being continued
  // Blank lines that merely separate a directive from what follows are layout,
  // not body content; dropping them keeps export → import from growing gaps.
  let afterDirective = false;

  const flushBody = () => {
    if (step) step.body = bodyLines.join('\n').trim();
    bodyLines = [];
  };
  const closeCollectors = () => {
    if (step && solLines) step.solution = solLines.join('\n').trim();
    solLines = null;
    if (hint) hint.text = hint.lines.join('\n').trim();
    hint = null;
  };

  for (const line of lines) {
    // Fenced code inside a step body is verbatim: no headings/directives apply.
    if (isFence(line)) {
      closeCollectors();
      afterDirective = false;
      inFence = !inFence;
      bodyLines.push(line);
      continue;
    }
    if (inFence) {
      bodyLines.push(line);
      continue;
    }

    // Continuation of an open `> solution:` / `> hint:` block: quoted lines
    // that are not a new directive belong to it; anything else closes it.
    if (solLines !== null || hint) {
      if (isDirective(line)) {
        closeCollectors();
      } else if (/^>/.test(line)) {
        const content = line.replace(/^>\s?/, '');
        if (solLines !== null) solLines.push(content);
        else hint.lines.push(content);
        continue;
      } else {
        closeCollectors();
      }
    }

    if (afterDirective && line.trim() === '') continue;
    afterDirective = false;

    if (/^#\s+/.test(line)) {
      flushBody();
      step = null;
      section = { title: line.replace(/^#\s+/, '').trim(), steps: [] };
      tpl.content.push(section);
    } else if (/^##\s+/.test(line)) {
      flushBody();
      if (!section) {
        section = { title: 'Section 1', steps: [] };
        tpl.content.push(section);
      }
      let heading = line.replace(/^##\s+/, '').trim();
      let type = 'desk';
      const m = heading.match(/^\[(desk|computer)\]\s*/i);
      if (m) {
        type = m[1].toLowerCase();
        heading = heading.slice(m[0].length);
      }
      step = { type, title: heading.trim(), body: '', hints: [], solution: '', checkpoint: null };
      section.steps.push(step);
    } else if (/^>\s*hint:/i.test(line) && step) {
      const rest = line.replace(/^>\s*hint:/i, '').trim();
      const [label, textPart] = splitOnceUnescaped(rest);
      hint = { label: (label || 'Hint').trim(), text: '', lines: [textPart.trim()] };
      step.hints.push(hint);
      afterDirective = true;
    } else if (/^>\s*solution:/i.test(line) && step) {
      // Begin a solution block; any text after "solution:" seeds the first line.
      const inline = line.replace(/^>\s*solution:/i, '').trim();
      solLines = inline ? [inline] : [];
      afterDirective = true;
    } else if (/^>\s*checkpoint:/i.test(line) && step) {
      const rest = line.replace(/^>\s*checkpoint:/i, '').trim();
      const [prompt, answerPart] = splitOnceUnescaped(rest);
      const [answer = '', ...alternatives] = splitAnswers(answerPart);
      step.checkpoint = {
        prompt: (prompt || 'Enter the value to continue').trim(),
        placeholder: '',
        answer,
        answers: alternatives,
      };
      afterDirective = true;
    } else if (/^>\s*placeholder:/i.test(line) && step) {
      const value = line.replace(/^>\s*placeholder:/i, '').trim();
      if (step.checkpoint) step.checkpoint.placeholder = value;
      afterDirective = true;
    } else {
      bodyLines.push(line);
    }
  }
  closeCollectors();
  flushBody();

  if (inFence) throw new Error('Unterminated code fence (``` without a closing ```)');
  if (!tpl.content.length) throw new Error('No sections found (use "# Section title").');
  // Strip the parser's scratch field before normalising.
  for (const s of tpl.content) for (const st of s.steps) for (const h of st.hints) delete h.lines;
  return normaliseTemplate(tpl);
}

function parseFrontmatter(block, tpl) {
  const lines = block.split('\n');
  let inVars = false;
  for (const line of lines) {
    if (/^\s+/.test(line) && inVars) {
      const [name, expr] = splitOnce(line.trim(), '=');
      if (name && name.trim()) {
        tpl.variables.push({ name: name.trim(), expression: (expr || '').trim() });
      }
      continue;
    }
    inVars = false;
    const [key, value] = splitOnce(line, ':');
    if (!key) continue;
    const k = key.trim().toLowerCase();
    if (k === 'title') tpl.title = (value || '').trim();
    else if (k === 'description') tpl.description = (value || '').trim();
    else if (k === 'variables') inVars = true;
  }
}

function splitOnce(str, sep) {
  const i = str.indexOf(sep);
  if (i === -1) return [str, ''];
  return [str.slice(0, i), str.slice(i + sep.length)];
}

/** A ready-to-import sample lab, offered as a download in the editor. */
export const SAMPLE_MARKDOWN = `---
title: Sample Networking Lab
description: A two-section starter lab you can import and adapt.
variables:
  PORT_NUM = seat
  SEAT_TAG = 'S' + pad(seat, 2)
  HOST_IP = '10.0.0.' + (100 + seat)
  GATEWAY_IP = '192.168.1.' + (100 + seat)
---

# Section 1 · Bench Preparation

## [desk] Prepare your bench
Welcome, participant #{{ SEAT_ID }}.

1. Power on your workstation.
2. You have been assigned **switch port {{ PORT_NUM }}** (cable tag {{ SEAT_TAG }}).

> hint: Where is the patch panel? :: It is the grey unit above your desk.
> Look for the label matching your seat tag.

# Section 2 · Network Configuration

## [computer] Assign a static IP
Set your IP address to \`{{ HOST_IP }}\` and gateway to \`{{ GATEWAY_IP }}\`.

\`\`\`
# this comment inside a code block is not a section heading
sudo ip addr add {{ HOST_IP }}/24 dev eth0
\`\`\`

> hint: Command line :: sudo ip addr add {{ HOST_IP }}/24 dev eth0

## [computer] Confirm
Record your assigned Host IP below to complete the lab.

> hint: How do I read my IP? :: Run \`ip addr show eth0\` and copy the IPv4 address.

> solution:
> Your Host IP is built from your seat number:
> - Base network: \`10.0.0.\`
> - Host octet: \`100 + seat\` → **{{ HOST_IP }}**

> checkpoint: Enter your Host IP address :: {{ HOST_IP }} | {{ HOST_IP }}/24
> placeholder: e.g. 10.0.0.1XX
`;
