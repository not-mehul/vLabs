import { countingSections } from '../../../shared/lab-progress.js';
import { isSectionCleared } from '../../../shared/templating.js';

/**
 * One participant's progress through a LAB, computed the same way for the
 * participant's own progress bar, the instructor monitor and exports.
 *
 * A section is DONE once the participant has moved past it (max_section is a
 * monotonic high-water mark, so going back to review never "un-completes"
 * it), or when it is the furthest section reached, its checkpoints are cleared
 * and nothing else is left to do (it is the last section, or the lab is
 * complete).
 *
 * The lab is COMPLETE when every counting section is cleared and the
 * participant has reached the last counting section. Optional / wrap-up
 * sections (see shared/lab-progress.js) are neither counted nor required.
 *
 * @param {Array} sections       the session's copy of the manual
 * @param {object} p             participant row (max_section, completed_at)
 * @param {Set<string>} completed cleared checkpoint keys
 * @param {number} [reachedIndex] a section the participant is known to be on
 *        right now, for requests that arrive before the progress ping
 */
export function labProgress(sections, p, completed, reachedIndex = -1) {
  const total = sections.length;
  const furthest = Math.min(Math.max(p.max_section ?? 0, reachedIndex), Math.max(total - 1, 0));
  const counting = countingSections(sections);
  const countingSet = new Set(counting);
  const lastCounting = counting.length ? counting[counting.length - 1] : -1;
  const cleared = sections.map((s, i) => isSectionCleared(s, i, completed));

  const complete =
    Boolean(p.completed_at) ||
    (total > 0 && furthest >= lastCounting && counting.every((i) => cleared[i]));

  const done = sections.map(
    (_, i) => i < furthest || (i === furthest && cleared[i] && (i === total - 1 || complete)),
  );
  const completedCounting = counting.filter((i) => done[i]).length;
  const progressPct = complete
    ? 100
    : counting.length
      ? Math.round((completedCounting / counting.length) * 100)
      : 0;

  return {
    total,
    furthest,
    complete,
    done,
    optional: sections.map((_, i) => !countingSet.has(i)),
    countingTotal: counting.length,
    completedCounting: complete ? counting.length : completedCounting,
    progressPct,
  };
}
