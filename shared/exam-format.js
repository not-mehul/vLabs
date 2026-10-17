/**
 * Markdown import/export for EXAM templates. Separate from the lab Markdown
 * format (client/src/lib/templateFormat.js), which is unchanged.
 *
 *   ---
 *   kind: exam
 *   title: Network Fundamentals — Unit Test
 *   description: 20 minutes, closed book
 *   variables:
 *     SUBNET = '10.' + seat + '.0.0/24'
 *   ---
 *
 *   # Part 1 · Addressing
 *   > minutes: 10
 *
 *   ## [info] Your bench
 *   Your subnet is {{ SUBNET }}.
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
 *   ## [short] Read the serial number off your switch.
 *   > pattern: XXXX.XXXX.XXXX
 *   > placeholder: e.g. ABCD.1234.EFGH
 *   > capture: SERIAL
 *
 *   ## [long]
 *   Explain, in a few sentences, why VLANs are used.
 *   Any Markdown works here, including images: ![topology](topology.png)
 *   > points: 5
 *
 *   # Part 2 · Bench check
 *   > minutes: 15
 *
 *   ## [checklist] Cable the bench
 *   Cable the switch to the router, then call your instructor over.
 *   - [ ] Switch Gi0/1 is cabled to the router
 *   - [ ] My instructor has checked my bench
 *
 *   # [submit] Review and submit
 *   Check every part before you hand in.
 *
 * `kind: exam` in the front matter marks the file as an exam (optional here;
 * it lets importers that also read labs tell the two apart — see
 * looksLikeExamMarkdown). Front matter `variables:` declares per-seat
 * formulas (`  NAME = formula` lines), as in labs.
 *
 * `# Title` starts a section; `> minutes: N` under it allocates N minutes to
 * the section (optional). `## [type]` starts an item of the section, and a
 * section may mix any items:
 *   - `[info]` (alias `[informational]`, `[step]`): instructions; the text
 *     after the type is its title, the lines below its Markdown body.
 *   - `[checklist]` (alias `[tasks]`): instructions plus `- [ ]` items the
 *     participant ticks off (an `[info]` item with `- [ ]` lines is one too).
 *   - a question type: single (multiple choice, one answer), multiple (select
 *     all that apply), truefalse, short, long, or an alias in TYPE_ALIASES.
 *     The text after the type and the lines below it form the prompt. Options
 *     are `- [ ]` / `- [x]` lines (x marks the correct ones). `> points: N`
 *     sets the weight (default 1); `> answer:` gives a true/false answer;
 *     `> accept:` lists accepted short answers separated by ` | ` (write `\|`
 *     for a literal pipe); `> pattern: MASK` grades a short answer by a mask
 *     instead, exactly like a lab pattern checkpoint; `> placeholder:` is the
 *     grey example in its box; `> capture: NAME` saves the answer as
 *     {{ NAME }} for every later section. A short question with neither
 *     `> accept:` nor `> pattern:` is marked by hand, as is every long one.
 * A `##` heading without a type is a multiple-choice question. Text between a
 * section heading and its first item is an untitled Informational item.
 * Fenced code blocks are copied verbatim.
 *
 * `# [submit] Title` is the final submit section: its text is shown above
 * the button and `> review: false` leaves out the answered / unanswered
 * summary. An exam without one gets the default (see normaliseExam), and
 * exports always write it.
 *
 * Files written before 1.12.0 are read as they were: `# [info] Title` (alias
 * `[informational]`, `[checklist]`, `[tasks]`) starts a section whose `##`
 * headings are steps (unless tagged with a question type), each a Checklist
 * item when it has `- [ ]` lines and Informational otherwise.
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

/** Step tags on `## [tag] Title` items. */
const STEP_ALIASES = Object.freeze({
  info: 'info',
  informational: 'info',
  step: 'info',
  checklist: 'checklist',
  tasks: 'checklist',
});

/** Tags on `# [tag] Title` section headings (`info` ones are the pre-1.12 kind). */
const SECTION_ALIASES = Object.freeze({
  info: 'info',
  informational: 'info',
  checklist: 'info',
  tasks: 'info',
  submit: 'submit',
  review: 'submit',
});

const OPTION_RE = /^\s*[-*]\s+\[( |x|X)\]\s?(.*)$/;
const DIRECTIVE_RE = /^>\s*(points|answer|accept|pattern|placeholder|capture)\s*:\s*(.*)$/i;
const FENCE_RE = /^\s*(```|~~~)/;

/** Lab step types: a `## [desk]` / `## [computer]` heading means a lab. */
const LAB_STEP_TYPES = new Set(['desk', 'computer']);

/**
 * True when Markdown text is an exam rather than a lab: `kind: exam` in the
 * front matter, a tagged `# [section]` heading, or a `## [type]` heading with
 * an exam question or checklist type. Labs use [desk] / [computer] / [info]
 * steps; `[info]` alone is in both, so it decides nothing. Fenced code is
 * ignored.
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
    if (TYPE_ALIASES[t] || STEP_ALIASES[t] === 'checklist') return true;
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
  const exam = { kind: 'exam', title: '', description: '', variables: [], content: [] };
  let i = 0;

  if (lines[0]?.trim() === '---') {
    i = 1;
    let inVars = false;
    while (i < lines.length && lines[i].trim() !== '---') {
      // `variables:` then indented `NAME = formula` lines, exactly as in labs.
      if (inVars && /^\s+\S/.test(lines[i])) {
        const line = lines[i].trim();
        const eq = line.indexOf('=');
        const name = (eq < 0 ? line : line.slice(0, eq)).trim();
        if (name)
          exam.variables.push({ name, expression: eq < 0 ? '' : line.slice(eq + 1).trim() });
        i += 1;
        continue;
      }
      inVars = false;
      const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(lines[i]);
      if (m) {
        const key = m[1].toLowerCase();
        if (key === 'kind' && m[2].trim().toLowerCase() === 'lab') {
          throw new Error('This file is a lab (kind: lab), not an exam');
        }
        if (key === 'title') exam.title = m[2].trim();
        else if (key === 'description') exam.description = m[2].trim();
        else if (key === 'variables') inVars = true;
      }
      i += 1;
    }
    i += 1; // closing ---
  }

  let section = null; // { title, minutes, items, legacy } or a submit section
  let item = null; // the item being read; step items collect `tasks`
  let body = [];
  let inFence = false;

  // Close the current item (or the submit section's text).
  const flush = () => {
    const text = body.join('\n').trim();
    body = [];
    if (section?.type === 'submit') {
      section.body = text;
      return;
    }
    if (!item) {
      // Text before the first item: an untitled Informational item.
      if (text && section) section.items.push({ type: 'info', title: '', body: text });
      return;
    }
    if (item.type === 'step') {
      const { title, tasks, explicit } = item;
      if (explicit || text || tasks.length) {
        section.items.push(
          tasks.length || item.checklist
            ? { type: 'checklist', title, body: text, tasks }
            : { type: 'info', title, body: text },
        );
      }
    } else {
      item.prompt = [item.heading.trim(), text].filter(Boolean).join('\n\n');
      delete item.heading;
      section.items.push(item);
    }
    item = null;
  };

  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (!inFence && /^#\s+/.test(line)) {
      flush();
      const rest = line.replace(/^#\s+/, '').trim();
      const tag = /^\[([^\]]+)\]\s*(.*)$/.exec(rest);
      const kind = tag ? SECTION_ALIASES[tag[1].trim().toLowerCase()] : null;
      const title = kind ? tag[2].trim() : rest;
      section =
        kind === 'submit'
          ? { type: 'submit', title, body: '' }
          : { title, items: [], legacy: kind === 'info' };
      exam.content.push(section);
      // A pre-1.12 info section starts with an untitled step.
      item = section.legacy ? { type: 'step', title: '', tasks: [], explicit: false } : null;
      continue;
    }
    // Section settings, anywhere but inside a question (where they are text).
    const setting = /^>\s*(minutes|review)\s*:\s*(.*)$/i.exec(line);
    if (!inFence && setting && section && (!item || item.type === 'step')) {
      if (setting[1].toLowerCase() === 'minutes') section.minutes = setting[2].trim();
      else if (section.type === 'submit') section.review = setting[2].trim();
      continue;
    }
    if (!inFence && /^##\s+/.test(line)) {
      const rest = line.replace(/^##\s+/, '').trim();
      const m = /^\[([^\]]+)\]\s*(.*)$/.exec(rest);
      const raw = m ? m[1].trim().toLowerCase() : '';
      if (section?.type === 'submit') {
        if (TYPE_ALIASES[raw] || STEP_ALIASES[raw]) {
          throw new Error(`The submit section cannot hold questions or steps, line ${i + 1}`);
        }
        body.push(line);
        continue;
      }
      flush();
      if (!section) {
        section = { title: 'Section 1', items: [] };
        exam.content.push(section);
      }
      // In a pre-1.12 info section any heading that is not a question is a
      // step, a tag that is not a type included (it was part of the title).
      if (STEP_ALIASES[raw] || (section.legacy && !TYPE_ALIASES[raw])) {
        item = {
          type: 'step',
          title: STEP_ALIASES[raw] ? m[2].trim() : rest,
          tasks: [],
          explicit: true,
          checklist: STEP_ALIASES[raw] === 'checklist',
        };
        continue;
      }
      const type = m ? TYPE_ALIASES[raw] : 'single';
      if (!type) throw new Error(`Unknown question type "[${m[1]}]" on line ${i + 1}`);
      item = {
        type,
        heading: m ? m[2] : rest,
        points: 1,
        options: [],
        correct: type === 'multiple' ? [] : null,
        accepted: [],
      };
      continue;
    }
    if (!inFence && item?.type === 'step') {
      const task = OPTION_RE.exec(line);
      if (task) {
        item.tasks.push(task[2].trim());
        continue;
      }
    } else if (!inFence && item) {
      const opt = OPTION_RE.exec(line);
      if (opt && QUESTION_TYPES[item.type].hasOptions) {
        item.options.push(opt[2].trim());
        if (opt[1].toLowerCase() === 'x') {
          if (item.type === 'multiple') item.correct.push(item.options.length - 1);
          else item.correct = item.options.length - 1;
        }
        continue;
      }
      const d = DIRECTIVE_RE.exec(line);
      if (d) {
        const key = d[1].toLowerCase();
        const value = d[2].trim();
        if (key === 'points') item.points = Number(value);
        else if (key === 'answer') item.correct = value;
        else if (key === 'accept') item.accepted.push(...splitPipes(value));
        else if (key === 'pattern') Object.assign(item, { match: 'pattern', pattern: value });
        else item[key] = value; // placeholder, capture
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
  const vars = exam.variables.filter((v) => v.name);
  if (vars.length) {
    out.push('variables:', ...vars.map((v) => `  ${v.name} = ${v.expression}`));
  }
  out.push('---', '');
  for (const sec of exam.content) {
    if (sec.type === 'submit') {
      out.push(`# [submit] ${sec.title}`);
      if (!sec.review) out.push('> review: false');
      out.push('');
      if (sec.body.trim()) out.push(sec.body.trim(), '');
      continue;
    }
    out.push(`# ${sec.title}`);
    if (sec.minutes) out.push(`> minutes: ${sec.minutes}`);
    out.push('');
    for (const it of sec.items) {
      if (it.type === 'info' || it.type === 'checklist') {
        out.push(`## [${it.type}]${it.title ? ` ${it.title}` : ''}`);
        if (it.body.trim()) out.push(it.body.trim());
        if (it.type === 'checklist') out.push(...it.tasks.map((t) => `- [ ] ${t}`));
        out.push('');
        continue;
      }
      const prompt = it.prompt.trim();
      const oneLine = prompt && !prompt.includes('\n') && !prompt.startsWith('#');
      out.push(`## [${it.type}]${oneLine ? ` ${prompt}` : ''}`);
      if (!oneLine && prompt) out.push(prompt);
      if (QUESTION_TYPES[it.type].hasOptions) {
        it.options.forEach((o, oi) => {
          const on = it.type === 'multiple' ? it.correct.includes(oi) : it.correct === oi;
          out.push(`- [${on ? 'x' : ' '}] ${o}`);
        });
      }
      if (it.type === 'truefalse') out.push(`> answer: ${it.correct ? 'true' : 'false'}`);
      if (it.type === 'short' && it.accepted.length) {
        out.push(`> accept: ${it.accepted.map((a) => a.replace(/\|/g, '\\|')).join(' | ')}`);
      }
      if (it.match === 'pattern') out.push(`> pattern: ${it.pattern}`);
      if (it.placeholder) out.push(`> placeholder: ${it.placeholder}`);
      if (it.capture) out.push(`> capture: ${it.capture}`);
      if (it.points !== 1) out.push(`> points: ${it.points}`);
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export const SAMPLE_EXAM_MARKDOWN = `---
kind: exam
title: Network Fundamentals — Quiz (Sample)
description: A short sample exam showing every question and step type.
variables:
  SUBNET = '10.' + seat + '.0.0/24'
---

# Part 1 · Addressing
> minutes: 5

## [info] Your bench
You are on seat {{ SEAT_ID }}. Your subnet is **{{ SUBNET }}**.

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

# Part 2 · Bench check
> minutes: 15

## [checklist] Cable the bench
Cable your switch to the router as shown on the bench card. Tick each item
once it is done.
- [ ] Switch port Gi0/1 is cabled to the router
- [ ] The link light is green on both ends

## [short] Read the serial number off the back of your switch.
> pattern: XXXX.XXXX.XXXX
> placeholder: e.g. ABCD.1234.EFGH
> capture: SERIAL

## [checklist] Instructor check
Raise your hand so your instructor can check your bench.
- [ ] My instructor has checked my bench

# Part 3 · Short answers
> minutes: 10

## [short] What TCP port does HTTPS use by default?
> accept: 443 | tcp/443

## [short] Type the serial number of your switch again.
> accept: {{ SERIAL }}

## [long]
In two or three sentences, explain why networks are split into VLANs.
> points: 5

# [submit] Review and submit

Check that every question has an answer. Once you submit you cannot change
your answers.
`;
