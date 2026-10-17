/**
 * Progress classification for lab and exam templates (dependency-free, shared
 * by the server and the client).
 *
 * A section with `optional: true` (Markdown: `> optional: true` under its
 * heading) does not count towards a participant's progress. Participants
 * still see and can complete it; it is left out of "x / y sections" and the
 * progress percentage, and finishing the lab does not require it.
 *
 * Before 1.17.0 this was guessed from words in the section title; migration
 * 10 turned those sections into explicit flags using LEGACY_OPTIONAL_TITLE_RE.
 */

/** The title words that marked a section optional before the explicit flag. */
export const LEGACY_OPTIONAL_TITLE_RE =
  /\b(optional|bonus|extra[\s-]+credit|stretch(?:[\s-]+goals?)?|wrap(?:ping)?[\s-]*up)\b/i;

/**
 * Migration 10: a section list (JSON text) with `optional: true` added to
 * every section whose title marked it optional and that has no flag yet.
 * Returns the new JSON, or null when nothing changed or it can't be read.
 */
export function flagLegacyOptionalSections(json) {
  let sections;
  try {
    sections = JSON.parse(json || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(sections)) return null;
  let changed = false;
  for (const sec of sections) {
    if (!sec || typeof sec !== 'object' || sec.type === 'submit' || 'optional' in sec) continue;
    if (LEGACY_OPTIONAL_TITLE_RE.test(String(sec.title ?? ''))) {
      sec.optional = true;
      changed = true;
    }
  }
  return changed ? JSON.stringify(sections) : null;
}

/** True when a section is marked optional. */
export function isOptionalSection(section) {
  return section?.optional === true;
}

/**
 * Indices of the sections that count towards progress. When every section is
 * optional (or the manual is empty) all sections count, so a lab can never
 * have a zero denominator.
 */
export function countingSections(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const required = [];
  list.forEach((s, i) => {
    if (!isOptionalSection(s)) required.push(i);
  });
  return required.length ? required : list.map((_, i) => i);
}
