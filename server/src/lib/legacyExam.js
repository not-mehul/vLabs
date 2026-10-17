/**
 * Migration 12: exam sections saved before 1.12.0 rewritten in today's shape.
 *
 * Those sections had a type instead of `items`: `questions` sections held
 * `questions`; `info` sections held `steps` of { title, body, tasks } (and
 * 1.9.0 ones `body` / `tasks` on the section itself). Each becomes an
 * ordinary section with `items`, in the same order, so the answer keys a
 * running session saved ("si.qi", checklist ticks "si.tN") still point at the
 * same things. The app reads only `items` from 1.18.0 on.
 */

const LEGACY_KEYS = ['type', 'questions', 'steps', 'body', 'tasks'];

/** One legacy section's items. */
function legacyItems(sec) {
  if (sec.type === 'info') {
    const steps = Array.isArray(sec.steps)
      ? sec.steps
      : sec.body || (Array.isArray(sec.tasks) && sec.tasks.length)
        ? [{ title: '', body: sec.body, tasks: sec.tasks }]
        : [];
    return steps.map((st) => {
      const tasks = Array.isArray(st?.tasks) ? st.tasks.filter((t) => String(t ?? '').trim()) : [];
      const step = { title: st?.title ?? '', body: st?.body ?? '' };
      return tasks.length ? { type: 'checklist', ...step, tasks } : { type: 'info', ...step };
    });
  }
  return Array.isArray(sec.questions) ? sec.questions : [];
}

/**
 * An exam's content (JSON text) with every legacy section rewritten, or null
 * when there is none (or it can't be read).
 */
export function upgradeLegacyExamContent(json) {
  let sections;
  try {
    sections = JSON.parse(json || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(sections)) return null;
  let changed = false;
  const out = sections.map((sec) => {
    if (!sec || typeof sec !== 'object') return sec;
    if (sec.type === 'submit') {
      if (!('questions' in sec)) return sec;
      changed = true;
      const { questions: _q, ...rest } = sec;
      return rest;
    }
    if (Array.isArray(sec.items)) return sec;
    changed = true;
    const rest = Object.fromEntries(Object.entries(sec).filter(([k]) => !LEGACY_KEYS.includes(k)));
    return { ...rest, items: legacyItems(sec) };
  });
  return changed ? JSON.stringify(out) : null;
}
