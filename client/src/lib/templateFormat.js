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
 *
 *   > hint: Label shown on the toggle :: Hidden hint text
 *
 *   > solution:
 *   > A multi-line markdown walkthrough, revealed once every hint is opened.
 *   > - Supports bullet points and links.
 *
 *   ## [computer] Assign an IP
 *   Body…
 *
 *   > checkpoint: Prompt shown to the participant :: {{ HOST_IP }}
 *
 *   `# ` starts a section, `## ` starts a step (optional [desk]/[computer]
 *   prefix sets the type, default desk). `> hint:` and `> checkpoint:` lines use
 *   `::` to separate the two parts. `> solution:` starts a block whose following
 *   quoted (`> `) lines are the step's markdown solution.
 */

/* ------------------------------- Export --------------------------------- */

export function templateToJson(tpl) {
  return JSON.stringify(
    {
      title: tpl.title,
      description: tpl.description,
      variables: tpl.variables,
      content: tpl.content,
    },
    null,
    2,
  );
}

export function templateToMarkdown(tpl) {
  const lines = [];
  lines.push('---');
  lines.push(`title: ${tpl.title || ''}`);
  if (tpl.description) lines.push(`description: ${tpl.description}`);
  if (tpl.variables && tpl.variables.length) {
    lines.push('variables:');
    for (const v of tpl.variables) {
      if (v.name) lines.push(`  ${v.name} = ${v.expression || ''}`);
    }
  }
  lines.push('---');
  lines.push('');

  for (const section of tpl.content || []) {
    lines.push(`# ${section.title || 'Section'}`);
    lines.push('');
    for (const step of section.steps || []) {
      lines.push(`## [${step.type === 'computer' ? 'computer' : 'desk'}] ${step.title || ''}`);
      if (step.body) {
        lines.push('');
        lines.push(step.body.trimEnd());
      }
      for (const h of step.hints || []) {
        lines.push('');
        lines.push(`> hint: ${h.label || 'Hint'} :: ${(h.text || '').replace(/\n/g, ' ')}`);
      }
      if (step.solution && step.solution.trim()) {
        lines.push('');
        lines.push('> solution:');
        // Multi-line markdown solution: each line is quoted so its structure
        // (bullets, blank lines) survives the round-trip.
        for (const l of step.solution.replace(/\s+$/, '').split('\n')) {
          lines.push(`> ${l}`.replace(/\s+$/, ''));
        }
      }
      if (step.checkpoint && step.checkpoint.answer) {
        lines.push('');
        lines.push(`> checkpoint: ${step.checkpoint.prompt || ''} :: ${step.checkpoint.answer}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ------------------------------- Import --------------------------------- */

export function parseJsonTemplate(text) {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== 'object') throw new Error('Not a template object');
  return normaliseTemplate(obj);
}

/** Parse the documented markdown convention into a template object. */
export function parseMarkdownTemplate(text) {
  const src = String(text).replace(/\r\n/g, '\n');
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
  let solLines = null; // non-null while collecting a `> solution:` block

  const flushBody = () => {
    if (step) step.body = bodyLines.join('\n').trim();
    bodyLines = [];
  };
  const flushSolution = () => {
    if (step && solLines) step.solution = solLines.join('\n').trim();
    solLines = null;
  };

  for (const raw of lines) {
    const line = raw;
    // While collecting a solution, keep consuming quoted lines; the first line
    // that is not a blockquote (or is another directive) ends the block.
    if (solLines !== null) {
      if (/^>\s*(hint|checkpoint|solution):/i.test(line)) {
        flushSolution();
        // fall through to directive handling below
      } else if (/^>/.test(line)) {
        solLines.push(line.replace(/^>\s?/, ''));
        continue;
      } else {
        flushSolution();
        // fall through to normal handling below
      }
    }
    if (/^#\s+/.test(line) && !/^##\s+/.test(line)) {
      flushSolution();
      flushBody();
      step = null;
      section = { title: line.replace(/^#\s+/, '').trim(), steps: [] };
      tpl.content.push(section);
    } else if (/^##\s+/.test(line)) {
      flushSolution();
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
      const [label, textPart] = splitOnce(rest, '::');
      step.hints.push({ label: (label || 'Hint').trim(), text: (textPart || '').trim() });
    } else if (/^>\s*solution:/i.test(line) && step) {
      // Begin a solution block; any text after "solution:" seeds the first line.
      const inline = line.replace(/^>\s*solution:/i, '').trim();
      solLines = inline ? [inline] : [];
    } else if (/^>\s*checkpoint:/i.test(line) && step) {
      const rest = line.replace(/^>\s*checkpoint:/i, '').trim();
      const [prompt, answer] = splitOnce(rest, '::');
      step.checkpoint = {
        prompt: (prompt || 'Enter the value to continue').trim(),
        placeholder: '',
        answer: (answer || '').trim(),
      };
    } else {
      bodyLines.push(line);
    }
  }
  flushSolution();
  flushBody();

  if (!tpl.content.length) throw new Error('No sections found (use "# Section title").');
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

/** Coerce an imported object into the editor's template shape. */
function normaliseTemplate(obj) {
  const content = Array.isArray(obj.content) ? obj.content : [];
  return {
    title: String(obj.title || '').slice(0, 200),
    description: String(obj.description || '').slice(0, 1000),
    variables: (Array.isArray(obj.variables) ? obj.variables : [])
      .filter((v) => v && v.name)
      .map((v) => ({ name: String(v.name), expression: String(v.expression || '') })),
    content: content.map((s) => ({
      title: String(s.title || 'Section'),
      steps: (Array.isArray(s.steps) ? s.steps : []).map((st) => ({
        type: st.type === 'computer' ? 'computer' : 'desk',
        title: String(st.title || ''),
        body: String(st.body || ''),
        hints: (Array.isArray(st.hints) ? st.hints : []).map((h) => ({
          label: String(h.label || 'Hint'),
          text: String(h.text || ''),
        })),
        solution: String(st.solution || ''),
        checkpoint:
          st.checkpoint && st.checkpoint.answer
            ? {
                prompt: String(st.checkpoint.prompt || ''),
                placeholder: String(st.checkpoint.placeholder || ''),
                answer: String(st.checkpoint.answer),
              }
            : null,
      })),
    })),
  };
}

/* ------------------------------ File I/O -------------------------------- */

export function downloadFile(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsText(file);
  });
}

/** A ready-to-import sample lab, offered as a download in the editor. */
export const SAMPLE_MARKDOWN = `---
title: Sample Networking Lab
description: A two-section starter lab you can import and adapt.
variables:
  PORT_NUM = seat
  HOST_IP = '10.0.0.' + (100 + seat)
  GATEWAY_IP = '192.168.1.' + (100 + seat)
---

# Section 1 · Bench Preparation

## [desk] Prepare your bench
Welcome, participant #{{ SEAT_ID }}.

1. Power on your workstation.
2. You have been assigned **switch port {{ PORT_NUM }}**.

> hint: Where is the patch panel? :: It is the grey unit above your desk.

# Section 2 · Network Configuration

## [computer] Assign a static IP
Set your IP address to \`{{ HOST_IP }}\` and gateway to \`{{ GATEWAY_IP }}\`.

> hint: Command line :: sudo ip addr add {{ HOST_IP }}/24 dev eth0

## [computer] Confirm
Record your assigned Host IP below to complete the lab.

> hint: How do I read my IP? :: Run \`ip addr show eth0\` and copy the IPv4 address.

> solution:
> Your Host IP is built from your seat number:
> - Base network: \`10.0.0.\`
> - Host octet: \`100 + seat\` → **{{ HOST_IP }}**

> checkpoint: Enter your Host IP address :: {{ HOST_IP }}
`;
