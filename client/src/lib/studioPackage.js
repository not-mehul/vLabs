/**
 * Import a lab or an exam from vLabs Template Studio.
 *
 * The studio exports three formats, all accepted here:
 *   .zip  — package: template.json (canonical) and/or template.md, plus
 *           images/<name> for every library image the template references
 *   .md   — the lab Markdown format (lib/templateFormat.js) or the exam
 *           Markdown format (shared/exam-format.js)
 *   .json — the canonical template object (`"kind": "exam"` for exams)
 *
 * The kind is read from the file: JSON `kind`, or for Markdown
 * looksLikeExamMarkdown (front matter `kind: exam`, or exam question types).
 * Labs go through the existing lab parsers unchanged. JSZip is loaded on
 * demand so it only reaches the bundle chunk of the instructor who imports.
 */
import { parseJsonTemplate, parseMarkdownTemplate } from './templateFormat.js';
import { parseExamMarkdown, looksLikeExamMarkdown } from '../../../shared/exam-format.js';
import { normaliseExam } from '../../../shared/exam-schema.js';
import { readTextFile } from './files.js';
import { IMAGE_MIMES, normaliseImageName } from '../../../shared/template-schema.js';

const EXT_MIME = Object.fromEntries(Object.entries(IMAGE_MIMES).map(([m, e]) => [e, m]));
EXT_MIME.jpeg = 'image/jpeg';

/** Parse template text of either kind. */
export function parseStudioText(text, isJson) {
  if (isJson) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error('The file is not valid JSON');
    }
    if (obj && obj.kind === 'exam') return { kind: 'exam', template: normaliseExam(obj) };
    return { kind: 'lab', template: parseJsonTemplate(text) };
  }
  if (looksLikeExamMarkdown(text)) return { kind: 'exam', template: parseExamMarkdown(text) };
  return { kind: 'lab', template: parseMarkdownTemplate(text) };
}

/**
 * @param {File} file
 * @returns {Promise<{ kind: 'lab'|'exam', template: object, images: File[], source: string }>}
 *   images are ready to upload (named as the template references them).
 */
export async function readStudioFile(file) {
  if (/\.zip$/i.test(file.name)) {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter((f) => !f.dir);
    // Prefer the canonical JSON; fall back to the Markdown.
    const json = entries.find((f) => /(^|\/)template\.json$/i.test(f.name));
    const md = entries.find((f) => /(^|\/)template\.md$/i.test(f.name));
    if (!json && !md) throw new Error('The package has no template.json or template.md');
    const { kind, template } = parseStudioText(await (json || md).async('string'), Boolean(json));

    const images = [];
    for (const f of entries) {
      if (!/(^|\/)images\//i.test(f.name)) continue;
      const base = f.name.split('/').pop();
      const ext = (base.split('.').pop() || '').toLowerCase();
      const mime = EXT_MIME[ext];
      if (!mime) continue;
      const blob = await f.async('blob');
      images.push(new File([blob], normaliseImageName(base), { type: mime }));
    }
    return { kind, template, images, source: json ? 'template.json' : 'template.md' };
  }
  const text = await readTextFile(file);
  const { kind, template } = parseStudioText(text, /\.json$/i.test(file.name));
  return { kind, template, images: [], source: file.name };
}

/**
 * Upload package images. Names that already exist in the library are
 * collected and, if `confirmReplace(names)` agrees, replaced.
 *
 * @returns {Promise<string[]>} human-readable notes
 */
export async function uploadPackageImages(api, call, images, confirmReplace) {
  const notes = [];
  const clashes = [];
  for (const file of images) {
    try {
      await call((t) => api.uploadImage(t, file));
      notes.push(`uploaded ${file.name}`);
    } catch (err) {
      if (err.code === 'IMAGE_EXISTS') clashes.push(file);
      else notes.push(`${file.name}: ${err.message}`);
    }
  }
  if (clashes.length && confirmReplace(clashes.map((f) => f.name))) {
    for (const file of clashes) {
      try {
        await call((t) => api.uploadImage(t, file, { replace: true }));
        notes.push(`replaced ${file.name}`);
      } catch (err) {
        notes.push(`${file.name}: ${err.message}`);
      }
    }
  } else if (clashes.length) {
    notes.push(`kept existing ${clashes.map((f) => f.name).join(', ')}`);
  }
  return notes;
}
