/**
 * Canonical EXAM-template shape, shared by the server (validation, grading,
 * storage) and the client (editor, import/export, participant UI).
 *
 * Exams are a separate template kind with their own schema; the lab schema in
 * template-schema.js (and its Markdown parser) is not involved. Dependency-free
 * ESM so both sides import it directly.
 *
 * Canonical shape
 * ---------------
 * {
 *   kind: 'exam',
 *   title: string,
 *   description: string,
 *   variables: [{ name, expression }], // per-seat values, exactly as in labs:
 *                                      //   {{ NAME }} anywhere in the exam text
 *                                      //   (and the built-ins SEAT_ID,
 *                                      //   FIRST_NAME, LAST_NAME, FULL_NAME)
 *   content: [                         // sections ("parts") of the exam
 *     {                                // a section: any mix of items
 *       title: string,
 *       minutes: number | null,        // time allocated (1–600), null = none
 *       items: [                       // in reading order; each declares its type
 *         { type: 'info',              // Informational: instructions only
 *           title: string, body: string },
 *         { type: 'checklist',         // instructions plus items the
 *           title: string,             //   participant ticks off before going on
 *           body: string, tasks: string[] },
 *         { type: 'single' | 'multiple' | 'truefalse' | 'short' | 'long',
 *           prompt: string,            // Markdown (images by library name)
 *           points: number,            // 0–100, default 1
 *           options: string[],         // single / multiple only
 *           correct: number | number[] | boolean | null,
 *                                      // single: option index
 *                                      // multiple: option indices
 *                                      // truefalse: true / false
 *                                      // short / long: null
 *           accepted: string[],        // short, exact matching: accepted answers
 *                                      //   (case and spacing ignored); empty →
 *                                      //   graded by hand
 *           match?: 'pattern',         // short only: grade by a MASK instead,
 *           pattern?: string,          //   exactly like a lab pattern checkpoint
 *           placeholder?: string,      // short only: grey example in the box
 *           capture?: string,          // short only: save the participant's
 *                                      //   answer as {{ NAME }} for every LATER
 *                                      //   section (like a lab capture)
 *         },
 *       ],
 *     },
 *     { type: 'submit',                // always last, exactly once
 *       title: string,
 *       minutes: null,
 *       body: string,                  // Markdown shown above the submit button
 *       review: boolean },             // list answered / unanswered first
 *   ],
 * }
 *
 * Sections and items
 * ------------------
 * A section is a list of items, each with its own type: Informational
 * (instructions), Checklist (instructions plus items the participant ticks
 * off, e.g. "my instructor has checked my bench"; nothing is graded and
 * nobody approves it), or one of the question types. The participant sees
 * each section as one page, its items one below the other.
 *
 * Sections saved before 1.12.0 had a type instead: `questions` sections held
 * `questions`, `info` sections held `steps` of `{ title, body, tasks }` (and
 * 1.9.0 ones `body` / `tasks` on the section). sectionItems reads all of them
 * as items, keeping every answer key the same, so old templates, imports and
 * running sessions keep working.
 *
 * Answer keys
 * -----------
 * A question's key is "<section>.<n>" with n counting only the questions of
 * its section; a checklist tick's is "<section>.t<n>" with n counting the
 * ticks of the whole section in reading order.
 *
 * Correct answers never leave the server for participants: `publicQuestion`
 * strips them, and participants are never told whether an answer was right.
 *
 * Adding a question type
 * ----------------------
 * Add an entry to QUESTION_TYPES with `label`, `normalise` (coerce the
 * authored question), `validate` (push authoring errors), `normaliseResponse`
 * (coerce a participant's submission, or throw) and `grade` (true / false, or
 * null when it needs a human). Everything else — storage, the participant
 * API, manual marking, exports — works off that interface. Then teach the
 * client how to render it (ExamQuestion.jsx) and edit it (the Studio's exam-ui.js).
 */

import {
  LIMITS,
  normaliseMinutes,
  BUILTIN_PLACEHOLDERS,
  BUILTIN_IDENTIFIERS,
  PLACEHOLDER_RE,
  IDENT_RE,
  compileMask,
  matchMask,
} from './template-schema.js';

export const EXAM_LIMITS = Object.freeze({
  sections: 50,
  itemsPerSection: 200,
  options: 12,
  accepted: 20,
  title: 200,
  description: 1000,
  sectionTitle: 200,
  prompt: 10_000,
  option: 500,
  acceptedAnswer: 200,
  shortResponse: 500,
  longResponse: 10_000,
  maxPoints: 100,
  body: 20_000,
  itemTitle: 200,
  tasks: 30,
  task: 300,
  serialisedBytes: 900_000,
});

/** The final section where the participant hands the exam in. */
export const isSubmitSection = (sec) => sec?.type === 'submit';

const str = (v, max) => {
  const s = v === null || v === undefined ? '' : String(v);
  return typeof max === 'number' ? s.slice(0, max) : s;
};

const toIndex = (v) => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const toBool = (v) => {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (['true', 't', 'yes', '1'].includes(s)) return true;
  if (['false', 'f', 'no', '0'].includes(s)) return false;
  return null;
};

const cleanOptions = (opts) =>
  (Array.isArray(opts) ? opts : [])
    .slice(0, EXAM_LIMITS.options)
    .map((o) => str(o, EXAM_LIMITS.option).trim());

/** Normalise free text for comparison: trim, collapse spaces, ignore case. */
function normaliseText(v) {
  return String(v ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function responseError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * The question-type registry. `grade` returns true / false for automatically
 * gradable responses and null when a human has to mark the answer.
 */
export const QUESTION_TYPES = Object.freeze({
  single: {
    label: 'Multiple choice',
    hasOptions: true,
    normalise(q) {
      return { options: cleanOptions(q.options), correct: toIndex(q.correct) };
    },
    validate(q, at, errors) {
      if (q.options.length < 2) errors.push(`${at} needs at least two options`);
      if (q.options.some((o) => !o)) errors.push(`${at} has an empty option`);
      if (q.correct === null || q.correct >= q.options.length) {
        errors.push(`${at} needs a correct option`);
      }
    },
    normaliseResponse(v, q) {
      const i = toIndex(v);
      if (i === null || i >= q.options.length) throw responseError('Choose one of the options');
      return i;
    },
    grade(q, v) {
      return v === q.correct;
    },
  },
  multiple: {
    label: 'Select all that apply',
    hasOptions: true,
    normalise(q) {
      const options = cleanOptions(q.options);
      const raw = Array.isArray(q.correct) ? q.correct : [];
      const correct = [...new Set(raw.map(toIndex).filter((i) => i !== null))].sort(
        (a, b) => a - b,
      );
      return { options, correct };
    },
    validate(q, at, errors) {
      if (q.options.length < 2) errors.push(`${at} needs at least two options`);
      if (q.options.some((o) => !o)) errors.push(`${at} has an empty option`);
      if (!q.correct.length) errors.push(`${at} needs at least one correct option`);
      if (q.correct.some((i) => i >= q.options.length)) {
        errors.push(`${at} marks an option that does not exist as correct`);
      }
    },
    normaliseResponse(v, q) {
      if (!Array.isArray(v)) throw responseError('Choose any number of options');
      const picked = [...new Set(v.map(toIndex))];
      if (picked.some((i) => i === null || i >= q.options.length)) {
        throw responseError('Choose from the listed options');
      }
      return picked.sort((a, b) => a - b);
    },
    // All or nothing: exactly the correct set.
    grade(q, v) {
      return (
        Array.isArray(v) && v.length === q.correct.length && v.every((i, k) => i === q.correct[k])
      );
    },
  },
  truefalse: {
    label: 'True / false',
    hasOptions: false,
    normalise(q) {
      return { correct: toBool(q.correct) };
    },
    validate(q, at, errors) {
      if (q.correct === null) errors.push(`${at} needs the correct answer (true or false)`);
    },
    normaliseResponse(v) {
      const b = toBool(v);
      if (b === null) throw responseError('Answer true or false');
      return b;
    },
    grade(q, v) {
      return v === q.correct;
    },
  },
  short: {
    label: 'Short answer',
    hasOptions: false,
    // Exact (accepted answers, case and spacing ignored) or, like a lab
    // checkpoint, a pattern: a mask the answer must fit (see compileMask).
    normalise(q) {
      const accepted = (Array.isArray(q.accepted) ? q.accepted : [])
        .map((a) => str(a, EXAM_LIMITS.acceptedAnswer).trim())
        .filter(Boolean)
        .filter((a, i, arr) => arr.indexOf(a) === i)
        .slice(0, EXAM_LIMITS.accepted);
      const pattern = str(q.pattern, LIMITS.pattern).trim();
      const placeholder = str(q.placeholder, LIMITS.placeholder).trim();
      const isPattern =
        q.match === 'pattern' || (q.match !== 'exact' && pattern && !accepted.length);
      return {
        ...(isPattern ? { accepted: [], match: 'pattern', pattern } : { accepted }),
        ...(placeholder ? { placeholder } : {}),
      };
    },
    validate(q, at, errors) {
      if (q.match !== 'pattern') return;
      try {
        compileMask(q.pattern);
      } catch (err) {
        errors.push(`${at} pattern: ${err.message}`);
      }
    },
    normaliseResponse(v) {
      if (typeof v !== 'string') throw responseError('Answer must be text');
      return v.slice(0, EXAM_LIMITS.shortResponse);
    },
    // Exact: against the accepted answers, or marked by hand when there are
    // none. Pattern: the answer fits the mask.
    grade(q, v) {
      if (q.match === 'pattern') return patternValue(q, v) !== null;
      if (!q.accepted.length) return null;
      const want = normaliseText(v);
      return q.accepted.some((a) => normaliseText(a) === want);
    },
  },
  long: {
    label: 'Long answer',
    hasOptions: false,
    normalise() {
      return {};
    },
    validate() {},
    normaliseResponse(v) {
      if (typeof v !== 'string') throw responseError('Answer must be text');
      return v.slice(0, EXAM_LIMITS.longResponse);
    },
    grade() {
      return null;
    },
  },
});

const QUESTION_TYPE_NAMES = Object.freeze(Object.keys(QUESTION_TYPES));

/**
 * A short answer fitted to its question's mask, or null when it does not fit.
 * Answers longer than a lab checkpoint's never fit: the monitor grades on
 * every refresh, and a mask with several `*` costs more the longer the text.
 */
function patternValue(q, v) {
  if (String(v ?? '').trim().length > LIMITS.answer) return null;
  try {
    return matchMask(q.pattern, v);
  } catch {
    return null; // an invalid mask accepts nothing (validation reports it)
  }
}

/**
 * Every item type, in the order editors offer them: the two step types, then
 * the question types.
 */
export const ITEM_TYPES = Object.freeze({
  info: 'Informational',
  checklist: 'Checklist',
  ...Object.fromEntries(QUESTION_TYPE_NAMES.map((t) => [t, QUESTION_TYPES[t].label])),
});
export const ITEM_TYPE_NAMES = Object.freeze(Object.keys(ITEM_TYPES));

/** True for a question item (anything but Informational and Checklist). */
export const isQuestion = (item) => QUESTION_TYPE_NAMES.includes(item?.type);

/** True when a question of this shape is marked by hand. */
export function isManualQuestion(q) {
  return (
    q.type === 'long' || (q.type === 'short' && q.match !== 'pattern' && !(q.accepted || []).length)
  );
}

/** A fresh question of the given type in canonical shape. */
export function blankQuestion(type = 'single') {
  const base = { type, prompt: '', points: 1, options: [], correct: null, accepted: [] };
  if (type === 'single') return { ...base, options: ['', ''], correct: 0 };
  if (type === 'multiple') return { ...base, options: ['', ''], correct: [] };
  if (type === 'truefalse') return { ...base, correct: true };
  return base;
}

/** A fresh item of the given type in canonical shape. */
export function blankItem(type = 'single') {
  if (type === 'info') return { type, title: '', body: '' };
  if (type === 'checklist') return { type, title: '', body: '', tasks: [''] };
  return blankQuestion(type);
}

/** Normalise one question into canonical shape. Never throws. */
export function normaliseQuestion(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  const type = QUESTION_TYPE_NAMES.includes(q.type) ? q.type : 'single';
  const pts = Number(q.points);
  const out = {
    type,
    prompt: str(q.prompt, EXAM_LIMITS.prompt),
    points: Number.isFinite(pts) ? Math.min(Math.max(pts, 0), EXAM_LIMITS.maxPoints) : 1,
    options: [],
    correct: null,
    accepted: [],
    ...QUESTION_TYPES[type].normalise(q),
  };
  const capture = str(q.capture, LIMITS.captureName).trim();
  if (capture) out.capture = capture;
  return out;
}

/** Normalise one item (a step or a question) into canonical shape. Never throws. */
export function normaliseItem(raw) {
  const it = raw && typeof raw === 'object' ? raw : {};
  if (it.type !== 'info' && it.type !== 'checklist') return normaliseQuestion(it);
  const step = {
    type: it.type,
    title: str(it.title, EXAM_LIMITS.itemTitle).trim(),
    body: str(it.body, EXAM_LIMITS.body),
  };
  if (it.type === 'info') return step;
  return {
    ...step,
    tasks: (Array.isArray(it.tasks) ? it.tasks : [])
      .map((t) => str(t, EXAM_LIMITS.task).trim())
      .filter(Boolean)
      .slice(0, EXAM_LIMITS.tasks),
  };
}

/** The submit section added to an exam that has none. */
export function defaultSubmitSection() {
  return { type: 'submit', title: 'Review and submit', minutes: null, body: '', review: true };
}

/** A fresh section in canonical shape. */
export function blankSection(n = 1) {
  return { title: `Section ${n}`, minutes: null, items: [blankQuestion()] };
}

/**
 * The items of a stored section, whatever version saved it (see the header):
 * `items` as is; a 1.10/1.11 `info` section's steps (or a 1.9.0 one's body and
 * tasks) as Checklist items, or Informational when a step has no checklist;
 * a `questions` section's questions.
 */
export function sectionItems(sec) {
  if (!sec || typeof sec !== 'object' || isSubmitSection(sec)) return [];
  if (Array.isArray(sec.items)) return sec.items;
  if (sec.type === 'info') {
    const steps = Array.isArray(sec.steps)
      ? sec.steps
      : sec.body || (Array.isArray(sec.tasks) && sec.tasks.length)
        ? [{ title: '', body: sec.body, tasks: sec.tasks }]
        : [];
    return steps.map((st) => {
      const tasks = Array.isArray(st?.tasks) ? st.tasks.filter((t) => String(t ?? '').trim()) : [];
      const step = { title: st?.title ?? '', body: st?.body ?? '' };
      return tasks.length ? { type: 'checklist', ...step, tasks } : { type: 'info', ...step };
    });
  }
  return Array.isArray(sec.questions) ? sec.questions : [];
}

/** Normalise one section into canonical shape. Never throws. */
function normaliseSection(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const title = str(s.title, EXAM_LIMITS.sectionTitle);
  if (isSubmitSection(s)) {
    return {
      type: 'submit',
      title,
      minutes: null,
      body: str(s.body, EXAM_LIMITS.body),
      review: toBool(s.review) !== false,
    };
  }
  return {
    title,
    minutes: normaliseMinutes(s.minutes),
    items: sectionItems(s).slice(0, EXAM_LIMITS.itemsPerSection).map(normaliseItem),
  };
}

/**
 * Coerce any exam-ish object into canonical shape. Never throws. The exam
 * always ends with exactly one submit section (the first one found, else a
 * default "Review and submit").
 */
export function normaliseExam(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const sections = (Array.isArray(o.content) ? o.content : [])
    .slice(0, EXAM_LIMITS.sections)
    .map(normaliseSection);
  const submit = sections.find(isSubmitSection) || defaultSubmitSection();
  return {
    kind: 'exam',
    title: str(o.title, EXAM_LIMITS.title),
    description: str(o.description, EXAM_LIMITS.description),
    variables: (Array.isArray(o.variables) ? o.variables : [])
      .filter((v) => v && typeof v === 'object')
      .slice(0, LIMITS.variables)
      .map((v) => ({ name: str(v.name).trim(), expression: str(v.expression).trim() })),
    content: [...sections.filter((sec) => !isSubmitSection(sec)), submit],
  };
}

/**
 * The items of a section with their position: `n` numbers the steps
 * (Informational and Checklist) and the questions separately from 1, and
 * questions carry their answer key, checklists the keys of their ticks.
 */
export function sectionLayout(sec, si) {
  let steps = 0;
  let qi = 0;
  let ti = 0;
  return sectionItems(sec).map((item, ii) => {
    if (isQuestion(item)) {
      const at = { item, ii, n: qi + 1, qi, key: questionKey(si, qi) };
      qi += 1;
      return at;
    }
    steps += 1;
    const tasks = item?.type === 'checklist' && Array.isArray(item.tasks) ? item.tasks : [];
    return { item, ii, n: steps, tasks: tasks.map((text) => ({ key: taskKey(si, ti++), text })) };
  });
}

/** Where an item is, for messages: "Section 2 · step 1" / "Section 2 · question 3". */
export const itemWhere = (si, at) =>
  `Section ${si + 1} · ${'qi' in at ? 'question' : 'step'} ${at.n}`;

/**
 * Every text of an exam that may hold {{ PLACEHOLDERS }} (resolved per seat,
 * as in labs), with a readable location, in reading order.
 */
function examTextFields(exam) {
  const out = [];
  (exam?.content || []).forEach((sec, si) => {
    const push = (where, text) => out.push({ si, where, text });
    push(`Section ${si + 1} title`, sec.title);
    if (isSubmitSection(sec)) push(`Section ${si + 1}`, sec.body);
    for (const at of sectionLayout(sec, si)) {
      const where = itemWhere(si, at);
      const it = at.item;
      if ('qi' in at) {
        push(where, it.prompt);
        (it.options || []).forEach((o, oi) => push(`${where} option ${oi + 1}`, o));
        (it.accepted || []).forEach((a) => push(`${where} accepted answers`, a));
      } else {
        push(`${where} title`, it.title);
        push(where, it.body);
        (it.tasks || []).forEach((t, ti) => push(`${where} checklist item ${ti + 1}`, t));
      }
    }
  });
  return out;
}

/**
 * Questions that save their answer as a variable, in reading order (the
 * first one wins a repeated name).
 */
export function examCaptures(exam) {
  const out = [];
  (exam?.content || []).forEach((sec, si) => {
    for (const at of sectionLayout(sec, si)) {
      if (!('qi' in at) || !at.item.capture) continue;
      out.push({
        name: at.item.capture,
        si,
        key: at.key,
        type: at.item.type,
        where: itemWhere(si, at),
      });
    }
  });
  return out;
}

/**
 * The value a question saves for its capture: a pattern answer in the mask's
 * canonical form, any other answer trimmed ('' until answered).
 */
export function capturedValue(q, answer) {
  if (typeof answer !== 'string') return '';
  if (q?.match === 'pattern') return patternValue(q, answer) ?? answer.trim();
  return answer.trim();
}

/**
 * Placeholders in an exam that name neither a variable, a built-in nor an
 * answer saved in an EARLIER section (`early` when it is saved, but only in
 * this section or a later one).
 */
export function unknownExamPlaceholders(exam) {
  const known = new Set([...BUILTIN_PLACEHOLDERS, ...(exam?.variables || []).map((v) => v.name)]);
  const savedIn = new Map();
  for (const c of examCaptures(exam)) if (!savedIn.has(c.name)) savedIn.set(c.name, c.si);
  const out = [];
  const seen = new Set();
  for (const { si, where, text } of examTextFields(exam)) {
    for (const m of String(text ?? '').matchAll(PLACEHOLDER_RE)) {
      const name = m[1];
      const key = `${name}@${where}`;
      if (known.has(name) || savedIn.get(name) < si || seen.has(key)) continue;
      seen.add(key);
      out.push({ name, where, early: savedIn.has(name) });
    }
  }
  return out;
}

/** Problems with the names questions save their answers under. */
export function captureErrors(exam, errors) {
  const reserved = new Set([...BUILTIN_PLACEHOLDERS, ...BUILTIN_IDENTIFIERS]);
  const variables = new Set((exam?.variables || []).map((v) => v.name));
  const saved = new Map();
  for (const { name, type, where } of examCaptures(exam)) {
    if (type !== 'short') {
      errors.push(`${where}: only a short answer can be saved as a variable`);
    } else if (!IDENT_RE.test(name)) {
      errors.push(`${where}: "${name}" is not a valid variable name`);
    } else if (reserved.has(name)) {
      errors.push(`${where}: "${name}" is a reserved name`);
    } else if (variables.has(name)) {
      errors.push(`${where}: "${name}" is already a variable`);
    } else if (saved.has(name)) {
      errors.push(`${where}: "${name}" is already saved by ${saved.get(name)}`);
    } else {
      saved.set(name, where);
    }
  }
}

/** Authoring errors for one (normalised) question; `where` names it in messages. */
export function questionErrors(q, where) {
  const errors = [];
  if (!q.prompt.trim()) errors.push(`${where} has an empty prompt`);
  QUESTION_TYPES[q.type].validate(q, where, errors);
  return errors;
}

/** Authoring errors for one (normalised) Informational or Checklist step. */
export function stepErrors(it, where) {
  if (it.type === 'info' && !it.body.trim()) return [`${where} needs instructions`];
  if (it.type === 'checklist' && !it.tasks.length) {
    return [`${where} needs at least one checklist item`];
  }
  return [];
}

/**
 * Authoring errors for a (normalised) exam. Returns a list of messages; empty
 * when the exam can be saved.
 */
export function examErrors(exam) {
  const errors = [];
  if (!exam.title.trim()) errors.push('Title is required');
  if (!exam.content.some((sec) => !isSubmitSection(sec))) {
    errors.push('At least one section is required');
  }
  exam.content.forEach((sec, si) => {
    if (!sec.title.trim()) errors.push(`Section ${si + 1} needs a title`);
    if (isSubmitSection(sec)) return;
    const layout = sectionLayout(sec, si);
    if (!layout.length) errors.push(`Section ${si + 1} has no questions or steps`);
    for (const at of layout) {
      const where = itemWhere(si, at);
      errors.push(...('qi' in at ? questionErrors(at.item, where) : stepErrors(at.item, where)));
    }
  });
  captureErrors(exam, errors);
  for (const { name, where, early } of unknownExamPlaceholders(exam)) {
    errors.push(
      early
        ? `{{ ${name} }} is used in ${where} before the question that saves it (saved answers are available from the following section onward)`
        : `Unknown placeholder {{ ${name} }} in ${where}`,
    );
  }
  return errors;
}

/** Stable key of a question: "<section>.<question>" (like lab checkpoints). */
export const questionKey = (si, qi) => `${si}.${qi}`;

/** Stable key of a checklist tick: "<section>.t<n>", numbered across the section. */
const taskKey = (si, ti) => `${si}.t${ti}`;

/** Every checklist tick in reading order with its key and position. */
export function listTasks(content) {
  const out = [];
  (Array.isArray(content) ? content : []).forEach((sec, si) => {
    for (const at of sectionLayout(sec, si)) {
      for (const t of at.tasks || []) out.push({ key: t.key, si, ii: at.ii, text: t.text });
    }
  });
  return out;
}

/** Every question in reading order with its key and position. */
export function listQuestions(content) {
  const out = [];
  (Array.isArray(content) ? content : []).forEach((sec, si) => {
    for (const at of sectionLayout(sec, si)) {
      if ('qi' in at) out.push({ key: at.key, si, qi: at.qi, number: out.length + 1, q: at.item });
    }
  });
  return out;
}

/** The participant-safe view of a question: no correct answers, accepted list or mask. */
export function publicQuestion(q) {
  const out = { type: q.type, prompt: q.prompt, points: q.points };
  if (QUESTION_TYPES[q.type]?.hasOptions) out.options = [...q.options];
  if (q.placeholder) out.placeholder = q.placeholder;
  // Lets the participant page refresh later sections when this answer changes.
  if (q.capture) out.capture = q.capture;
  return out;
}

/** True when a stored response counts as answered. */
export function isAnswered(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/** True when `points` is a valid partial mark for a question worth `max`. */
export function isValidMarkPoints(points, max) {
  return (
    typeof points === 'number' &&
    Number.isFinite(points) &&
    points >= 0 &&
    points <= max &&
    Number.isInteger(points * 2)
  );
}

/**
 * Grade one response.
 *  - auto:     true / false / null (null: needs a human, or unanswered text)
 *  - override: the instructor's mark (true / false) when set
 *  - marked_points: the instructor's points (0 … q.points, halves allowed)
 *              when a partial mark was given instead of correct / incorrect
 *  - correct:  the final verdict (a mark wins): true only for full marks,
 *              false otherwise, or null while pending
 *  - partial:  a hand mark of some but not all of the points
 *  - pending:  answered, needs a human mark, none given yet
 */
export function gradeResponse(q, value, override, points = null) {
  const answered = isAnswered(value);
  let auto = null;
  if (answered) auto = QUESTION_TYPES[q.type].grade(q, value);
  else if (!isManualQuestion(q)) auto = false; // unanswered auto question scores zero
  if (isValidMarkPoints(points, q.points)) {
    return {
      answered,
      auto,
      override: null,
      marked_points: points,
      correct: points === q.points,
      partial: points > 0 && points < q.points,
      pending: false,
      points_awarded: points,
    };
  }
  const hasOverride = override === true || override === false;
  const correct = hasOverride ? override : auto;
  return {
    answered,
    auto,
    override: hasOverride ? override : null,
    marked_points: null,
    correct,
    partial: false,
    pending: correct === null && answered,
    points_awarded: correct === true ? q.points : 0,
  };
}

/** Human-readable rendering of a response (for exports and the instructor view). */
export function describeResponse(q, value) {
  if (!isAnswered(value)) return '';
  if (q.type === 'single') return q.options[value] ?? `#${value + 1}`;
  if (q.type === 'multiple') return value.map((i) => q.options[i] ?? `#${i + 1}`).join(' | ');
  if (q.type === 'truefalse') return value ? 'True' : 'False';
  return String(value);
}

/** Human-readable expected answer, or '' for hand-marked questions. */
export function describeExpected(q) {
  if (q.type === 'single') return q.options[q.correct] ?? '';
  if (q.type === 'multiple') return q.correct.map((i) => q.options[i]).join(' | ');
  if (q.type === 'truefalse') return q.correct ? 'True' : 'False';
  if (q.type === 'short')
    return q.match === 'pattern' ? `fits ${q.pattern}` : q.accepted.join(' | ');
  return '';
}

/** Total available points. */
export function totalPoints(content) {
  return listQuestions(content).reduce((n, { q }) => n + (Number(q.points) || 0), 0);
}

/* -------------------------------------------------------------------------- */
/*  Section progression (exams unlock section by section, like labs)          */
/* -------------------------------------------------------------------------- */

/** True when a section has checklist items to tick. */
const hasTicks = (sec) => sectionItems(sec).some((it) => it?.type === 'checklist');

/**
 * True when section `si` lets the participant move on: every question
 * answered and every checklist item ticked (a tick is stored in the answers
 * under its taskKey as `true`). The submit section is always complete.
 */
export function isExamSectionComplete(content, si, answers) {
  const sec = content?.[si];
  const a = answers || {};
  if (isSubmitSection(sec)) return true;
  return sectionLayout(sec, si).every((at) =>
    'qi' in at ? isAnswered(a[at.key]) : (at.tasks || []).every((t) => a[t.key] === true),
  );
}

/**
 * Highest section index a participant may open: a section unlocks once every
 * question in all earlier sections has been answered and every checklist
 * ticked (the exam counterpart of a lab's checkpoints). The submit section
 * opens as soon as the section before it does, unless that one has a
 * checklist, so a participant can hand in with questions left blank.
 * `reached` is the participant's stored high-water mark, so clearing an
 * answer later never re-locks a section already opened. A checklist is
 * different: unticking an item locks every section after it again until it
 * is ticked once more.
 */
export function examUnlockedSection(content, answers, reached = 0) {
  const n = Array.isArray(content) ? content.length : 0;
  const passable = (i) =>
    isExamSectionComplete(content, i, answers) ||
    (!hasTicks(content[i]) && isSubmitSection(content[i + 1]));
  let s = 0;
  while (s < n - 1 && passable(s)) s += 1;
  s = Math.min(Math.max(s, reached || 0), Math.max(n - 1, 0));
  while (s < n - 1 && passable(s)) s += 1;
  for (let i = 0; i < s; i += 1) {
    if (hasTicks(content[i]) && !isExamSectionComplete(content, i, answers)) return i;
  }
  return s;
}
