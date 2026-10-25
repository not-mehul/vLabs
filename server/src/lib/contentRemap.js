import { sectionItems, sectionLayout, isSubmitSection } from '../../../shared/exam-schema.js';
import { jsonArray, jsonObject } from './json.js';

/**
 * Pushing a new template version into a running session (Push latest version)
 * without misfiling anyone's work.
 *
 * Progress and answers are keyed by POSITION: lab checkpoints "si.sti", hints
 * "si.sti.hi", exam answers "si.qi", checklist ticks "si.tN", and section
 * indexes in section_times / current_section / max_section. Sections and
 * items carry stable ids once saved (shared/template-schema.js), so the old
 * and new content say which old position is which new one. Everything a
 * participant has done is moved to its new position; work on a section or
 * item that no longer exists is dropped.
 *
 * When the two sides share no id at all (content saved before ids existed, a
 * revert to an old version, a Markdown re-import), or for a section or item
 * without an id, positions pair up instead: what pushing always did.
 */

/** Where every section and item of some content sits, by id and by position. */
function layout(content, kind) {
  const sections = Array.isArray(content) ? content : [];
  const secById = new Map();
  const itemById = new Map();
  const items = sections.map((sec) => (kind === 'exam' ? sectionItems(sec) : sec?.steps || []));
  sections.forEach((sec, si) => {
    if (sec?.id) secById.set(sec.id, si);
    items[si].forEach((it, ii) => {
      if (it?.id) itemById.set(it.id, { si, ii });
    });
  });
  return { sections, items, secById, itemById };
}

/** True when the new content keeps at least one of the old ids. */
const sharesIds = (oldL, newL) =>
  [...oldL.secById.keys()].some((id) => newL.secById.has(id)) ||
  [...oldL.itemById.keys()].some((id) => newL.itemById.has(id));

/** Old section index → new section index (or null when it is gone). */
function sectionMap(oldL, newL, byId) {
  return oldL.sections.map((sec, si) => {
    const there = newL.sections[si];
    if (byId && sec?.id && there?.id) return newL.secById.get(sec.id) ?? null;
    return there ? si : null;
  });
}

/** Old item position → new { si, ii } (or null when it is gone). */
function itemTarget(oldL, newL, secMap, si, ii, item, byId) {
  const nsi = secMap[si];
  const there = nsi === null || nsi === undefined ? null : newL.items[nsi]?.[ii];
  if (byId && item?.id && (there?.id || !there)) return newL.itemById.get(item.id) ?? null;
  return there ? { si: nsi, ii } : null;
}

/** Old key → new key for lab checkpoint/solution keys "si.sti" (steps). */
function labStepMap(oldL, newL, secMap, byId) {
  const map = new Map();
  oldL.sections.forEach((sec, si) => {
    (sec?.steps || []).forEach((st, sti) => {
      const to = itemTarget(oldL, newL, secMap, si, sti, st, byId);
      const exists = to && newL.sections[to.si]?.steps?.[to.ii];
      map.set(`${si}.${sti}`, exists ? `${to.si}.${to.ii}` : null);
    });
  });
  return map;
}

/** Old key → new key for exam answer keys ("si.qi" and checklist "si.tN"). */
function examKeyMap(oldL, newL, secMap, byId) {
  const newKeys = newL.sections.map((sec, si) =>
    isSubmitSection(sec) ? [] : sectionLayout(sec, si),
  );
  const map = new Map();
  oldL.sections.forEach((sec, si) => {
    if (isSubmitSection(sec)) return;
    for (const at of sectionLayout(sec, si)) {
      const to = itemTarget(oldL, newL, secMap, si, at.ii, at.item, byId);
      const dest = to ? newKeys[to.si]?.find((x) => x.ii === to.ii) : null;
      if ('qi' in at) {
        map.set(at.key, dest && 'qi' in dest && dest.item.type === at.item.type ? dest.key : null);
      } else {
        at.tasks.forEach((t, j) => map.set(t.key, dest?.tasks?.[j]?.key ?? null));
      }
    }
  });
  return map;
}

/**
 * How to move one session's participant data from `oldContent` to
 * `newContent`. Returns null when nothing moves (same layout), so the caller
 * can skip rewriting rows.
 */
export function contentRemap(oldContent, newContent, kind) {
  const oldL = layout(oldContent, kind);
  const newL = layout(newContent, kind);
  const byId = sharesIds(oldL, newL);
  const secMap = sectionMap(oldL, newL, byId);
  const keys =
    kind === 'exam' ? examKeyMap(oldL, newL, secMap, byId) : labStepMap(oldL, newL, secMap, byId);
  const identity =
    oldL.sections.length === newL.sections.length &&
    secMap.every((v, i) => v === i) &&
    [...keys].every(([from, to]) => from === to);
  if (identity) return null;
  return { secMap, keys, lastSection: Math.max(newL.sections.length - 1, 0) };
}

/** Move one key ("si.sti", "si.qi", "si.tN"); a hint key "si.sti.hi" keeps its hint index. */
function moveKey(map, key) {
  if (map.has(key)) return map.get(key);
  const m = /^(\d+\.\d+)\.(\d+)$/.exec(key);
  if (m && map.has(m[1])) {
    const to = map.get(m[1]);
    return to ? `${to}.${m[2]}` : null;
  }
  return null;
}

/**
 * The participant row's changed columns under `remap` (from contentRemap):
 * { completed_checkpoints, hints_taken, revealed_solutions, checkpoint_log,
 *   answers, grades, section_times, current_section, max_section }.
 */
export function remapParticipant(p, remap) {
  const { secMap, keys, lastSection } = remap;
  const moveSection = (i) => {
    const to = secMap[i];
    return to === null || to === undefined ? null : to;
  };
  const keyList = (json) =>
    JSON.stringify(
      jsonArray(json)
        .map((k) => moveKey(keys, String(k)))
        .filter((k) => k !== null),
    );
  const keyObject = (json) => {
    const out = {};
    for (const [k, v] of Object.entries(jsonObject(json))) {
      const to = moveKey(keys, k);
      if (to !== null) out[to] = v;
    }
    return JSON.stringify(out);
  };

  const times = {};
  for (const [k, v] of Object.entries(jsonObject(p.section_times))) {
    const to = moveSection(Number(k));
    if (to !== null) times[to] = (times[to] || 0) + (Number(v) || 0);
  }
  // The furthest section reached that still exists, else the first.
  let max = 0;
  for (let i = 0; i <= (p.max_section || 0); i += 1) {
    const to = moveSection(i);
    if (to !== null && to > max) max = to;
  }
  const current = moveSection(p.current_section || 0);

  return {
    completed_checkpoints: keyList(p.completed_checkpoints),
    hints_taken: keyList(p.hints_taken),
    revealed_solutions: keyList(p.revealed_solutions),
    checkpoint_log: JSON.stringify(
      jsonArray(p.checkpoint_log)
        .map((e) => ({ ...e, k: moveKey(keys, String(e?.k ?? '')) }))
        .filter((e) => e.k !== null),
    ),
    answers: keyObject(p.answers),
    grades: keyObject(p.grades),
    section_times: JSON.stringify(times),
    current_section: Math.min(current === null ? max : current, lastSection),
    max_section: Math.min(max, lastSection),
  };
}

/** Move one exam answer-history key; a removed question's history keeps a retired key. */
export function remapEventKey(remap, key, oldVersion) {
  if (key.includes('@')) return key; // already retired
  const to = moveKey(remap.keys, key);
  return to === null ? `${key}@v${oldVersion}` : to;
}
