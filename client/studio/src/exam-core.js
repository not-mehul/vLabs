// Exam core: the Studio's names for vLabs' own exam modules.
//
// The Studio used to carry a hand-kept copy of shared/exam-schema.js and
// shared/exam-format.js. It now imports them, so what the Studio reads,
// writes, normalises and checks is exactly what vLabs does on save. The
// names below are the ones the Studio's builder, preview and audit call.

/** Exam limits plus the per-seat limits exams share with labs. */
const EXAM_LIMITS = Object.freeze({
  ...SHARED_EXAM_LIMITS,
  sectionMinutes: LIMITS.sectionMinutes,
  variables: LIMITS.variables,
  captureName: LIMITS.captureName,
  pattern: LIMITS.pattern,
  placeholder: LIMITS.placeholder,
  answer: LIMITS.answer,
});

const examIsSubmit = isSubmitSection;
const EXAM_HAS_OPTIONS = (t) => Boolean(QUESTION_TYPES[t]?.hasOptions);
const EXAM_ITEM_TYPES = ITEM_TYPES;
const EXAM_ITEM_TYPE_NAMES = ITEM_TYPE_NAMES;
const examIsQuestion = isQuestion;
const examIsManual = isManualQuestion;
const examMaskExample = maskExample;
const examNormaliseQuestion = normaliseQuestion;
const examNormaliseItem = normaliseItem;
const examDefaultSubmitSection = defaultSubmitSection;
const examBlankQuestion = blankQuestion;
const examBlankItem = blankItem;
const examNormalise = normaliseExam;
const examSectionLayout = sectionLayout;
const examCaptures = sharedExamCaptures;
const examUnknownPlaceholders = unknownExamPlaceholders;
const examCaptureErrors = captureErrors;
const examQuestionErrors = questionErrors;
const examStepErrors = stepErrors;
const examCapturedValue = capturedValue;
const looksLikeExamMarkdown = sharedLooksLikeExamMarkdown;
const examParseMarkdown = parseExamMarkdown;
const examToMarkdownText = examToMarkdown;

/** true / false, or null when a human marks it (as vLabs grades). */
const examGrade = (q, v) => gradeResponse(q, v).auto;

/** Split `a | b | c` on unescaped pipes (`\|` is a literal pipe). */
const examSplitPipes = (s) =>
  String(s ?? '')
    .split(/(?<!\\)\|/)
    .map((p) => p.replace(/\\\|/g, '|').trim())
    .filter(Boolean);
