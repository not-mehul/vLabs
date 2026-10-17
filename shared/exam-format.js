/**
 * Markdown import/export for EXAM templates. Separate from the lab Markdown
 * format (client/src/lib/templateFormat.js), which is unchanged.
 *
 *   ---
 *   kind: exam
 *   title: Network Fundamentals — Unit Test
 *   description: 20 minutes, closed book
 *   ---
 *
 *   # Part 1 · Addressing
 *   > minutes: 10
 *
 *   ## [single] Which address is a valid private IPv4 address?
 *   - [ ] 8.8.8.8
 *   - [x] 192.168.1.20
 *   - [ ] 172.32.0.1
 *   > points: 2
 *
 *   ## [multiple] Select every protocol that runs over UDP.
 *   - [x] DNS
 *   - [ ] SSH
 *   - [x] DHCP
 *
 *   ## [truefalse] A /24 network has 254 usable host addresses.
 *   > answer: true
 *
 *   ## [short] What port does HTTPS use by default?
 *   > accept: 443 | tcp/443
 *
 *   ## [long]
 *   Explain, in a few sentences, why VLANs are used.
 *   Any Markdown works here, including images: ![topology](topology.png)
 *   > points: 5
 *
 *   # [info] Part 2 · Bench check
 *   > minutes: 15
 *   Cable the switch to the router, then call your instructor over.
 *   - [ ] Switch Gi0/1 is cabled to the router
 *   - [ ] My instructor has checked my bench
 *
 *   # [submit] Review and submit
 *   Check every part before you hand in.
 *
 * `kind: exam` in the front matter marks the file as an exam (optional here;
 * it lets importers that also read labs tell the two apart — see
 * looksLikeExamMarkdown). `# ` starts a section and `## [type]` a question. `> minutes: N` under a
 * section heading allocates N minutes to that section (optional). Text after the type and
 * the lines below it form the prompt. Types: single (multiple choice, one
 * answer), multiple (select all that apply), truefalse, short, long — plus
 * the aliases in TYPE_ALIASES. Options are `- [ ]` / `- [x]` lines (x marks
 * the correct ones). `> points: N` sets the weight (default 1); `> answer:`
 * gives a true/false answer; `> accept:` lists accepted short answers
 * separated by ` | ` (write `\|` for a literal pipe) — a short question
 * without `> accept:` is marked by hand, as is every long question. Fenced
 * code blocks are copied verbatim.
 *
 * A section heading may carry a section type: `# [info] Title` is an
 * informational section (no questions): `## Step title` headings split it
 * into steps shown one at a time (text before the first one is an untitled
 * first step; `## [step] Title` is the same), each step's text is its
 * instructions and its `- [ ]` lines the checklist the participant ticks off.
 * `# [submit] Title`
 * the final submit section (its text is shown above the button; `> review:
 * false` leaves out the answered / unanswered summary). Without a tag a
 * section holds questions. An exam without a submit section gets the default
 * one (see normaliseExam), and exports always write it.
 */

import { normaliseExam, QUESTION_TYPES } from './exam-schema.js';

export const TYPE_ALIASES = Object.freeze({
  single: 'single',
  mcq: 'single',
  choice: 'single',
  radio: 'single',
  multiple: 'multiple',
  multi: 'multiple',
  checkbox: 'multiple',
  checkboxes: 'multiple',
  truefalse: 'truefalse',
  'true-false': 'truefalse',
  tf: 'truefalse',
  short: 'short',
  text: 'short',
  'short-answer': 'short',
  long: 'long',
  essay: 'long',
  'long-answer': 'long',
});

/** Section type tags on `# [tag] Title` headings. */
export const SECTION_ALIASES = Object.freeze({
  questions: 'questions',
  info: 'info',
  informational: 'info',
  checklist: 'info',
  tasks: 'info',
  submit: 'submit',
  review: 'submit',
});

const OPTION_RE = /^\s*[-*]\s+\[( |x|X)\]\s?(.*)$/;
const DIRECTIVE_RE = /^>\s*(points|answer|accept)\s*:\s*(.*)$/i;
const FENCE_RE = /^\s*(```|~~~)/;

/** Lab step types: a `## [desk]`-style heading means a lab, not an exam. */
const LAB_STEP_TYPES = new Set(['desk', 'computer', 'info']);

/**
 * True when Markdown text is an exam rather than a lab: `kind: exam` in the
 * front matter, or a `## [type]` heading with an exam question type (labs
 * only use [desk] / [computer] / [info]). Fenced code is ignored.
 */
export function looksLikeExamMarkdown(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length && lines[i].trim() !== '---'; i += 1) {
      const m = /^kind\s*:\s*(\w+)/i.exec(lines[i]);
      if (m) return m[1].toLowerCase() === 'exam';
    }
  }
  let inFence = false;
  for (; i < lines.length; i += 1) {
    if (FENCE_RE.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const sm = /^#\s+\[([^\]]+)\]/.exec(lines[i]);
    if (sm && SECTION_ALIASES[sm[1].trim().toLowerCase()]) return true;
    const m = /^##\s+\[([^\]]+)\]/.exec(lines[i]);
    if (!m) continue;
    const t = m[1].trim().toLowerCase();
    if (LAB_STEP_TYPES.has(t)) return false;
    if (TYPE_ALIASES[t]) return true;
  }
  return false;
}

const splitPipes = (s) =>
  String(s)
    .split(/(?<!\\)\|/)
    .map((p) => p.replace(/\\\|/g, '|').trim())
    .filter(Boolean);

/** Parse exam Markdown into a canonical exam. Throws on an unusable file. */
export function parseExamMarkdown(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const exam = { kind: 'exam', title: '', description: '', content: [] };
  let i = 0;

  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') {
      const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(lines[i]);
      if (m) {
        const key = m[1].toLowerCase();
        if (key === 'kind' && m[2].trim().toLowerCase() === 'lab') {
          throw new Error('This file is a lab (kind: lab), not an exam');
        }
        if (key === 'title') exam.title = m[2].trim();
        else if (key === 'description') exam.description = m[2].trim();
      }
      i += 1;
    }
    i += 1; // closing ---
  }

  let section = null;
  let q = null;
  let step = null;
  let body = [];
  let heading = '';
  let inFence = false;

  const flush = () => {
    if (section?.type === 'info') {
      const text = body.join('\n').trim();
      body = [];
      // An untitled first step only exists when it has something in it.
      if (step && (step.explicit || text || step.tasks.length)) {
        section.steps.push({ title: step.title, body: text, tasks: step.tasks });
      }
      step = null;
      return;
    }
    if (section?.type === 'submit') {
      section.body = body.join('\n').trim();
      body = [];
      return;
    }
    if (!q) return;
    q.prompt = [heading.trim(), body.join('\n').trim()].filter(Boolean).join('\n\n');
    section.questions.push(q);
    q = null;
    body = [];
    heading = '';
  };

  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (!inFence && /^#\s+/.test(line)) {
      flush();
      const rest = line.replace(/^#\s+/, '').trim();
      const tag = /^\[([^\]]+)\]\s*(.*)$/.exec(rest);
      const type = tag ? SECTION_ALIASES[tag[1].trim().toLowerCase()] : null;
      section = {
        type: type || 'questions',
        title: type ? tag[2].trim() : rest,
        questions: [],
        steps: [],
      };
      if (section.type === 'info') step = { title: '', tasks: [], explicit: false };
      exam.content.push(section);
      continue;
    }
    if (section && section.type !== 'questions') {
      // Info / submit section: directives, checklist items, and body text.
      if (!inFence) {
        const qm = /^##\s+\[([^\]]+)\]/.exec(line);
        if (qm && TYPE_ALIASES[qm[1].trim().toLowerCase()]) {
          throw new Error(
            `Questions cannot go in a [${section.type}] section ("${section.title}"), line ${i + 1}`,
          );
        }
        if (section.type === 'info' && /^##\s+/.test(line)) {
          flush();
          const rest = line.replace(/^##\s+/, '').trim();
          const sm = /^\[step\]\s*(.*)$/i.exec(rest);
          step = { title: sm ? sm[1].trim() : rest, tasks: [], explicit: true };
          continue;
        }
        const mm = /^>\s*(minutes|review)\s*:\s*(.*)$/i.exec(line);
        if (mm) {
          if (mm[1].toLowerCase() === 'minutes') section.minutes = mm[2].trim();
          else section.review = mm[2].trim();
          continue;
        }
        const task = OPTION_RE.exec(line);
        if (task && section.type === 'info') {
          step.tasks.push(task[2].trim());
          continue;
        }
      }
      body.push(line);
      continue;
    }
    if (!inFence && /^##\s+/.test(line)) {
      flush();
      if (!section) {
        section = { type: 'questions', title: 'Section 1', questions: [] };
        exam.content.push(section);
      }
      const rest = line.replace(/^##\s+/, '');
      const m = /^\[([^\]]+)\]\s*(.*)$/.exec(rest);
      const rawType = m ? m[1].trim().toLowerCase() : 'single';
      const type = TYPE_ALIASES[rawType];
      if (!type) throw new Error(`Unknown question type "[${m[1]}]" on line ${i + 1}`);
      q = { type, points: 1, options: [], correct: type === 'multiple' ? [] : null, accepted: [] };
      heading = m ? m[2] : rest;
      continue;
    }
    if (!q) {
      // Section-level directive; any other text outside a question is ignored.
      const mm = /^>\s*minutes\s*:\s*(.*)$/i.exec(line);
      if (!inFence && mm && section) section.minutes = mm[1].trim();
      continue;
    }
    if (!inFence) {
      const opt = OPTION_RE.exec(line);
      if (opt && QUESTION_TYPES[q.type].hasOptions) {
        q.options.push(opt[2].trim());
        if (opt[1].toLowerCase() === 'x') {
          if (q.type === 'multiple') q.correct.push(q.options.length - 1);
          else q.correct = q.options.length - 1;
        }
        continue;
      }
      const d = DIRECTIVE_RE.exec(line);
      if (d) {
        const key = d[1].toLowerCase();
        if (key === 'points') q.points = Number(d[2]);
        else if (key === 'answer') q.correct = d[2].trim();
        else if (key === 'accept') q.accepted.push(...splitPipes(d[2]));
        continue;
      }
    }
    body.push(line);
  }
  flush();

  if (!exam.content.length) throw new Error('No sections found (start one with "# Title")');
  return normaliseExam(exam);
}

/** Serialise a canonical exam to the Markdown format above. */
export function examToMarkdown(input) {
  const exam = normaliseExam(input);
  const out = ['---', 'kind: exam', `title: ${exam.title}`];
  if (exam.description) out.push(`description: ${exam.description.replace(/\n+/g, ' ')}`);
  out.push('---', '');
  for (const sec of exam.content) {
    out.push(`# ${sec.type === 'questions' ? '' : `[${sec.type}] `}${sec.title}`);
    if (sec.minutes) out.push(`> minutes: ${sec.minutes}`);
    if (sec.type === 'submit' && !sec.review) out.push('> review: false');
    out.push('');
    if (sec.type === 'info') {
      sec.steps.forEach((st, sti) => {
        const empty = !st.body.trim() && !st.tasks.length;
        if (st.title || sti > 0 || empty) {
          const plain = st.title && !st.title.startsWith('[');
          out.push(`## ${plain ? st.title : `[step] ${st.title}`.trim()}`, '');
        }
        if (st.body.trim()) out.push(st.body.trim(), '');
        if (st.tasks.length) out.push(...st.tasks.map((t) => `- [ ] ${t}`), '');
      });
      continue;
    }
    if (sec.type === 'submit') {
      if (sec.body.trim()) out.push(sec.body.trim(), '');
      continue;
    }
    for (const q of sec.questions) {
      const prompt = q.prompt.trim();
      const oneLine = prompt && !prompt.includes('\n') && !prompt.startsWith('#');
      out.push(`## [${q.type}]${oneLine ? ` ${prompt}` : ''}`);
      if (!oneLine && prompt) out.push(prompt);
      if (QUESTION_TYPES[q.type].hasOptions) {
        q.options.forEach((o, oi) => {
          const on = q.type === 'multiple' ? q.correct.includes(oi) : q.correct === oi;
          out.push(`- [${on ? 'x' : ' '}] ${o}`);
        });
      }
      if (q.type === 'truefalse') out.push(`> answer: ${q.correct ? 'true' : 'false'}`);
      if (q.type === 'short' && q.accepted.length) {
        out.push(`> accept: ${q.accepted.map((a) => a.replace(/\|/g, '\\|')).join(' | ')}`);
      }
      if (q.points !== 1) out.push(`> points: ${q.points}`);
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export const SAMPLE_EXAM_MARKDOWN = `---
kind: exam
title: Network Fundamentals — Quiz (Sample)
description: A short sample exam showing every question type.
---

# Part 1 · Addressing
> minutes: 5

## [single] Which address is a valid private IPv4 address?
- [ ] 8.8.8.8
- [x] 192.168.1.20
- [ ] 172.32.0.1
> points: 2

## [multiple] Select every protocol that normally runs over UDP.
- [x] DNS
- [ ] SSH
- [x] DHCP
- [ ] HTTPS

## [truefalse] A /24 network has 254 usable host addresses.
> answer: true

# Part 2 · Short answers
> minutes: 10

## [short] What TCP port does HTTPS use by default?
> accept: 443 | tcp/443

## [long]
In two or three sentences, explain why networks are split into VLANs.
> points: 5

# [info] Part 3 · Bench check
> minutes: 10

## Cable the bench

Cable your switch to the router as shown on the bench card. Tick each item
once it is done.

- [ ] Switch port Gi0/1 is cabled to the router
- [ ] The link light is green on both ends

## Instructor check

Raise your hand so your instructor can check your bench.

- [ ] My instructor has checked my bench

# [submit] Review and submit

Check that every question has an answer. Once you submit you cannot change
your answers.
`;
