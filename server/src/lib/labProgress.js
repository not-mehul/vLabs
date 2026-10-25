import { countingSections } from '../../../shared/lab-progress.js';
import { isSectionCleared } from '../../../shared/templating.js';
import { jsonObject } from './json.js';

/**
 * Sections a participant has opened: every section with recorded time, the
 * one on screen and the furthest one reached (both only ever set by the
 * participant viewing that section).
 */
export function visitedSections(p) {
  const opened = new Set(
    Object.keys(jsonObject(p.section_times)).map(Number).filter(Number.isInteger),
  );
  if (Number.isInteger(p.current_section)) opened.add(p.current_section);
  if (Number.isInteger(p.max_section)) opened.add(p.max_section);
  return opened;
}

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
 * An optional / wrap-up section (see shared/lab-progress.js) is only done
 * when the participant actually opened it and cleared its checkpoints:
 * finishing the lab, or passing a checkpoint-free optional section on the way
 * to a later one, does not complete it.
 *
 * The lab is COMPLETE when every counting section is cleared and the
 * participant has reached the last counting section. Optional sections are
 * neither counted nor required.
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

  const visited = visitedSections(p);
  const done = sections.map((_, i) => {
    const reached = i < furthest || (i === furthest && cleared[i] && (i === total - 1 || complete));
    if (countingSet.has(i)) return reached;
    return reached && cleared[i] && visited.has(i);
  });
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
