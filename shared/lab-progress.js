/**
 * Progress classification for LAB templates (dependency-free, shared by the
 * server and the client).
 *
 * Optional and wrap-up sections do not count towards a participant's progress.
 * The lab template format has no flag for this and its parser is deliberately
 * left untouched, so the classification is made at display/analytics time from
 * the section TITLE: a title containing one of the words below marks the
 * section as not counting, e.g.
 *
 *   "Section 4 · Wrap up"            "Optional: VLAN tagging"
 *   "Bonus challenge"                "Stretch goal — QoS"
 *
 * Participants still see and can complete such sections; they are simply left
 * out of "x / y sections" and the progress percentage, and finishing the lab
 * does not require them.
 */

export const NON_COUNTING_SECTION_RE =
  /\b(optional|bonus|extra[\s-]+credit|stretch(?:[\s-]+goals?)?|wrap(?:ping)?[\s-]*up)\b/i;

/** True when a section's title marks it as optional / wrap-up. */
export function isOptionalSection(section) {
  return NON_COUNTING_SECTION_RE.test(String(section?.title ?? ''));
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
