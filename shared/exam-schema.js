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
 *   content: [{                        // sections ("parts") of the exam
 *     title: string,
 *     questions: [{
 *       type: 'single' | 'multiple' | 'truefalse' | 'short' | 'long',
 *       prompt: string,                // Markdown (images by library name)
 *       points: number,                // 0–100, default 1
 *       options: string[],             // single / multiple only
 *       correct: number | number[] | boolean | null,
 *                                      // single: option index
 *                                      // multiple: option indices
 *                                      // truefalse: true / false
 *                                      // short / long: null
 *       accepted: string[],            // short only: accepted answers; empty →
 *                                      //   graded by hand
 *     }],
 *   }],
 * }
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
 * client how to render it (ExamQuestion.jsx) and edit it (ExamEditor.jsx).
 */

export const EXAM_LIMITS = Object.freeze({
  sections: 50,
  questionsPerSection: 200,
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
  serialisedBytes: 900_000,
});

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
export function normaliseText(v) {
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
    normalise(q) {
      const accepted = (Array.isArray(q.accepted) ? q.accepted : [])
        .map((a) => str(a, EXAM_LIMITS.acceptedAnswer).trim())
        .filter(Boolean)
        .filter((a, i, arr) => arr.indexOf(a) === i)
        .slice(0, EXAM_LIMITS.accepted);
      return { accepted };
    },
    validate() {},
    normaliseResponse(v) {
      if (typeof v !== 'string') throw responseError('Answer must be text');
      return v.slice(0, EXAM_LIMITS.shortResponse);
    },
    // Auto-graded against the accepted answers (case/spacing-insensitive) when
    // the author listed any; otherwise marked by hand.
    grade(q, v) {
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

export const QUESTION_TYPE_NAMES = Object.freeze(Object.keys(QUESTION_TYPES));

/** True when a question of this shape is marked by hand. */
export function isManualQuestion(q) {
  return q.type === 'long' || (q.type === 'short' && !(q.accepted || []).length);
}

/** A fresh question of the given type in canonical shape. */
export function blankQuestion(type = 'single') {
  const base = { type, prompt: '', points: 1, options: [], correct: null, accepted: [] };
  if (type === 'single') return { ...base, options: ['', ''], correct: 0 };
  if (type === 'multiple') return { ...base, options: ['', ''], correct: [] };
  if (type === 'truefalse') return { ...base, correct: true };
  return base;
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
  return out;
}

/** Coerce any exam-ish object into canonical shape. Never throws. */
export function normaliseExam(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const content = Array.isArray(o.content) ? o.content : [];
  return {
    kind: 'exam',
    title: str(o.title, EXAM_LIMITS.title),
    description: str(o.description, EXAM_LIMITS.description),
    content: content.slice(0, EXAM_LIMITS.sections).map((sec) => {
      const s = sec && typeof sec === 'object' ? sec : {};
      return {
        title: str(s.title, EXAM_LIMITS.sectionTitle),
        questions: (Array.isArray(s.questions) ? s.questions : [])
          .slice(0, EXAM_LIMITS.questionsPerSection)
          .map(normaliseQuestion),
      };
    }),
  };
}

/**
 * Authoring errors for a (normalised) exam. Returns a list of messages; empty
 * when the exam can be saved.
 */
export function examErrors(exam) {
  const errors = [];
  if (!exam.title.trim()) errors.push('Title is required');
  if (!exam.content.length) errors.push('At least one section is required');
  let count = 0;
  exam.content.forEach((sec, si) => {
    if (!sec.title.trim()) errors.push(`Section ${si + 1} needs a title`);
    if (!sec.questions.length) errors.push(`Section ${si + 1} has no questions`);
    sec.questions.forEach((q, qi) => {
      count += 1;
      const at = `Section ${si + 1} · question ${qi + 1}`;
      if (!q.prompt.trim()) errors.push(`${at} has an empty prompt`);
      QUESTION_TYPES[q.type].validate(q, at, errors);
    });
  });
  if (exam.content.length && !count) errors.push('The exam has no questions');
  return errors;
}

/** Stable key of a question: "<section>.<question>" (like lab checkpoints). */
export const questionKey = (si, qi) => `${si}.${qi}`;

/** Every question in reading order with its key and position. */
export function listQuestions(content) {
  const out = [];
  (Array.isArray(content) ? content : []).forEach((sec, si) => {
    (sec?.questions || []).forEach((q, qi) => {
      out.push({ key: questionKey(si, qi), si, qi, number: out.length + 1, q });
    });
  });
  return out;
}

/** The participant-safe view of a question: no correct answers, no accepted list. */
export function publicQuestion(q) {
  const out = { type: q.type, prompt: q.prompt, points: q.points };
  if (QUESTION_TYPES[q.type]?.hasOptions) out.options = [...q.options];
  return out;
}

/** True when a stored response counts as answered. */
export function isAnswered(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/**
 * Grade one response.
 *  - auto:     true / false / null (null: needs a human, or unanswered text)
 *  - override: the instructor's mark (true / false) when set
 *  - correct:  the final verdict (override wins), or null while pending
 *  - pending:  answered, needs a human mark, none given yet
 */
export function gradeResponse(q, value, override) {
  const answered = isAnswered(value);
  let auto = null;
  if (answered) auto = QUESTION_TYPES[q.type].grade(q, value);
  else if (!isManualQuestion(q)) auto = false; // unanswered auto question scores zero
  const hasOverride = override === true || override === false;
  const correct = hasOverride ? override : auto;
  return {
    answered,
    auto,
    override: hasOverride ? override : null,
    correct,
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
  if (q.type === 'short') return q.accepted.join(' | ');
  return '';
}

/** Total available points. */
export function totalPoints(content) {
  return listQuestions(content).reduce((n, { q }) => n + (Number(q.points) || 0), 0);
}
