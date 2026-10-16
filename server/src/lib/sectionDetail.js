import { allocatedSeconds, sectionAverages, timeStatus } from './sectionTiming.js';
import { stepHasCheckpoint, checkpointMode } from './templating.js';

/**
 * The monitor's section drawer (labs and exams): who is on a section, who has
 * completed it, and how long it took them against the time allocated.
 * `views` are the per-participant monitor views (participantView /
 * examParticipantView), which already exclude break time.
 */

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

function seat(v, i, allocated) {
  const seconds = v.section_seconds[i] || 0;
  return {
    id: v.id,
    seat_number: v.seat_number,
    name: v.name,
    seconds,
    status: v.status,
    time_status: timeStatus(seconds, allocated),
    // The section on their screen right now (they may be reviewing it).
    viewing_now: !v.complete && v.current_section === i,
  };
}

/**
 * @param {object} section the session's copy of the section
 * @param {number} i section index
 * @param {Array} views per-participant monitor views
 */
export function sectionTimeDetail(section, i, views) {
  const allocated = allocatedSeconds(section);
  const here = views.filter((v) => !v.complete && v.furthest_section === i);
  const past = views.filter((v) => v.complete || v.sections_done[i]);
  const notReached = views.filter((v) => !v.complete && v.furthest_section < i);
  // Timing statistics over the participants who completed the section, as the
  // averages on the section cards.
  const timed = views.filter((v) => v.sections_done[i]).map((v) => v.section_seconds[i] || 0);
  const [average] = sectionAverages(
    [section],
    views.map((v) => ({
      section_seconds: [v.section_seconds[i]],
      sections_done: [v.sections_done[i]],
    })),
  );
  const hereRows = here.map((v) => seat(v, i, allocated)).sort((a, b) => b.seconds - a.seconds);
  const pastRows = past.map((v) => seat(v, i, allocated)).sort((a, b) => b.seconds - a.seconds);
  return {
    index: i,
    title: section.title || `Section ${i + 1}`,
    minutes: section.minutes || null,
    allocated_seconds: allocated,
    participant_count: views.length,
    here_count: here.length,
    completed_count: past.length,
    not_reached_count: notReached.length,
    viewing_now_count: views.filter((v) => !v.complete && v.current_section === i).length,
    timing: {
      // Average of those who completed it; `final` once everyone has.
      avg_seconds: average.avg_seconds,
      avg_final: average.final,
      timed_count: timed.length,
      median_seconds: median(timed),
      fastest_seconds: timed.length ? Math.min(...timed) : null,
      slowest_seconds: timed.length ? Math.max(...timed) : null,
      // Completed it, but took longer than the allocation.
      over_allocation_count: allocated ? timed.filter((s) => s > allocated).length : 0,
      // Still on it: nearing / over the allocation (fallback thresholds if none).
      here_near_count: hereRows.filter((r) => r.time_status === 'near').length,
      here_over_count: hereRows.filter((r) => r.time_status === 'over').length,
    },
    here: hereRows,
    completed: pastRows,
    not_reached: notReached.map((v) => ({
      id: v.id,
      seat_number: v.seat_number,
      name: v.name,
      furthest_section: v.furthest_section,
    })),
  };
}

const parseList = (json) => {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * LAB sections: per-step activity across the class — hints opened, solutions
 * revealed and, for checkpoint steps, how many cleared it, wrong attempts and
 * the most common wrong answers.
 *
 * @param {object} section
 * @param {number} si section index
 * @param {Array} rows raw participant rows of the session
 */
export function labStepStats(section, si, rows) {
  const parsed = rows.map((p) => ({
    hints: parseList(p.hints_taken),
    solutions: parseList(p.revealed_solutions),
    cleared: new Set(parseList(p.completed_checkpoints)),
    log: parseList(p.checkpoint_log),
  }));
  return (section.steps || []).map((step, sti) => {
    const key = `${si}.${sti}`;
    const hintPrefix = `${key}.`;
    const hintOpens = parsed.reduce(
      (n, p) => n + p.hints.filter((h) => String(h).startsWith(hintPrefix)).length,
      0,
    );
    const out = {
      index: sti,
      key,
      title: step.title || `Step ${sti + 1}`,
      type: step.type || 'desk',
      hint_count: (step.hints || []).length,
      hint_opens: hintOpens,
      hint_participants: parsed.filter((p) => p.hints.some((h) => String(h).startsWith(hintPrefix)))
        .length,
      solutions_revealed: parsed.filter((p) => p.solutions.includes(key)).length,
      checkpoint: null,
    };
    if (stepHasCheckpoint(step)) {
      const wrong = parsed.flatMap((p) => p.log.filter((e) => e.k === key && !e.ok));
      const tally = new Map();
      for (const e of wrong) {
        const a = String(e.a ?? '').trim() || '(empty)';
        tally.set(a, (tally.get(a) || 0) + 1);
      }
      out.checkpoint = {
        prompt: step.checkpoint.prompt || 'Enter the value to continue',
        mode: checkpointMode(step),
        capture: step.checkpoint.capture || null,
        cleared_count: parsed.filter((p) => p.cleared.has(key)).length,
        wrong_attempts: wrong.length,
        participants_with_wrong: parsed.filter((p) => p.log.some((e) => e.k === key && !e.ok))
          .length,
        common_wrong: [...tally.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([answer, count]) => ({ answer, count })),
      };
    }
    return out;
  });
}
