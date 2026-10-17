import { nowIso, parseUtc, secondsBetween } from './time.js';

/**
 * Section timing shared by labs and exams.
 *
 * Breaks: the instructor can pause the whole class. A session stores its
 * breaks as intervals ([{ start, end|null }], end null while one is running)
 * and every section-time computation subtracts the overlap with them, so time
 * spent on a break never counts towards a section — and the counters resume
 * for everyone the moment the break ends.
 *
 * Allocation: a section may declare `minutes`. Time on a section is judged
 * against it ("near" from 80 %, "over" past 100 %). Sections without an
 * allocation fall back to the fixed thresholds below.
 */

/** Fallback thresholds when a section has no time allocated (seconds). */
export const FALLBACK_NEAR = 8 * 60;
export const FALLBACK_OVER = 15 * 60;
/** "near" kicks in at this share of the allocated time. */
export const NEAR_SHARE = 0.8;

/** Parse a session's breaks column defensively. */
export function breaksOf(session) {
  try {
    const v = JSON.parse(session?.breaks || '[]');
    return Array.isArray(v) ? v.filter((b) => b && b.start) : [];
  } catch {
    return [];
  }
}

/** The running break, if any. */
export function currentBreak(breaks) {
  const last = breaks[breaks.length - 1];
  return last && !last.end ? last : null;
}

/** Seconds of [from, to] that fall inside breaks. */
function breakOverlap(fromMs, toMs, breaks, nowMs) {
  let total = 0;
  for (const b of breaks) {
    const s = parseUtc(b.start);
    const e = b.end ? parseUtc(b.end) : nowMs;
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    const lo = Math.max(fromMs, s);
    const hi = Math.min(toMs, e);
    if (hi > lo) total += hi - lo;
  }
  return total / 1000;
}

/**
 * A seat's section_times with the open section visit folded in up to `now`
 * (breaks excluded): what submitting stores, so the clock stops there.
 */
export function closeOpenVisit(p, now, breaks) {
  let times;
  try {
    times = JSON.parse(p.section_times || '{}');
  } catch {
    times = {};
  }
  if (!times || typeof times !== 'object' || Array.isArray(times)) times = {};
  const key = String(p.current_section);
  times[key] = (Number(times[key]) || 0) + activeSecondsBetween(p.section_entered_at, now, breaks);
  return times;
}

/** Whole seconds between two timestamps, excluding time spent on breaks. */
export function activeSecondsBetween(from, to = nowIso(), breaks = []) {
  const a = parseUtc(from);
  const b = parseUtc(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  if (!breaks.length) return secondsBetween(from, to);
  const raw = (b - a) / 1000;
  return Math.max(0, Math.round(raw - breakOverlap(a, b, breaks, Date.now())));
}

/** Total break time so far in the session (seconds). */
export function totalBreakSeconds(breaks, now = nowIso()) {
  return breaks.reduce((n, b) => n + secondsBetween(b.start, b.end || now), 0);
}

/**
 * Seconds per section index for one participant: the stored closed visits
 * plus the open visit (unless their clock has stopped), break time excluded.
 */
export function sectionSecondsView(
  p,
  sectionCount,
  { now = nowIso(), breaks = [], frozen = false },
) {
  let stored = {};
  try {
    const v = JSON.parse(p.section_times || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) stored = v;
  } catch {
    stored = {};
  }
  const out = [];
  for (let i = 0; i < sectionCount; i += 1) out.push(Number(stored[String(i)]) || 0);
  if (!frozen && p.current_section < sectionCount) {
    out[p.current_section] += activeSecondsBetween(p.section_entered_at, now, breaks);
  }
  return out;
}

/** 'ok' | 'near' | 'over' for time spent against a section's allocation. */
export function timeStatus(seconds, allocatedSeconds) {
  const over = allocatedSeconds || FALLBACK_OVER;
  const near = allocatedSeconds ? allocatedSeconds * NEAR_SHARE : FALLBACK_NEAR;
  if (seconds > over) return 'over';
  if (seconds >= near) return 'near';
  return 'ok';
}

/** Allocated seconds for a section, or null. */
export const allocatedSeconds = (section) =>
  section && section.minutes ? Number(section.minutes) * 60 : null;

/**
 * Per-section class statistics: how many seats have finished each section and
 * their average time on it. `final` is true once every participant has moved
 * past the section, i.e. the average will not change any more.
 *
 * @param {Array} sections
 * @param {Array<{section_seconds:number[], sections_done:boolean[]}>} views
 */
export function sectionAverages(sections, views) {
  return sections.map((_, i) => {
    const done = views.filter((v) => v.sections_done[i]);
    const avg = done.length
      ? Math.round(done.reduce((n, v) => n + (v.section_seconds[i] || 0), 0) / done.length)
      : null;
    return {
      completed_count: done.length,
      avg_seconds: avg,
      final: views.length > 0 && done.length === views.length,
    };
  });
}
