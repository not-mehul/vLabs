// The vLabs modules the Studio runs on. One import list for the Studio's
// shared scope (see ../build.mjs): exam-core.js and lab-core.js give these
// the names the rest of the Studio uses.
import {
  LIMITS,
  IDENT_RE,
  BUILTIN_PLACEHOLDERS as SHARED_BUILTIN_PLACEHOLDERS,
  BUILTIN_IDENTIFIERS,
  IMAGE_MIMES,
  compileMask,
  matchMask,
  maskExample,
  normaliseImageName,
  normaliseMinutes,
  normaliseTemplate,
  blankSection,
  blankStep,
} from '../../../shared/template-schema.js';
import {
  evaluateExpression,
  FUNCTION_NAMES,
  injectVariables,
  injectImages,
  normaliseAnswer,
} from '../../../shared/templating.js';
import {
  templateToJson,
  templateToMarkdown,
  parseMarkdownTemplate,
} from '../../../shared/template-format.js';
import {
  EXAM_LIMITS as SHARED_EXAM_LIMITS,
  QUESTION_TYPES,
  ITEM_TYPES,
  ITEM_TYPE_NAMES,
  isSubmitSection,
  isQuestion,
  isManualQuestion,
  blankQuestion,
  blankItem,
  defaultSubmitSection,
  normaliseQuestion,
  normaliseItem,
  normaliseExam,
  sectionLayout,
  examCaptures as sharedExamCaptures,
  capturedValue,
  unknownExamPlaceholders,
  captureErrors,
  questionErrors,
  stepErrors,
  gradeResponse,
  examUnlockedSection,
} from '../../../shared/exam-schema.js';
import {
  parseExamMarkdown,
  examToMarkdown,
  looksLikeExamMarkdown as sharedLooksLikeExamMarkdown,
} from '../../../shared/exam-format.js';
import { validateTemplatePayload } from '../../../shared/validate-template.js';
import { validateExamPayload } from '../../../shared/validate-exam.js';
import { renderMarkdown } from '../../src/lib/markdown.js';
