/** Small formatting helpers shared across pages (previously duplicated). */

/** URL/filename-safe slug. */
export function slug(s, fallback = 'file') {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return out || fallback;
}

/** "42s", "3m 05s", "1h 12m". */
export function fmtDuration(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

const csvEsc = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection (=, +, -, @ at the start).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLines = (header, rows) => [header, ...rows].map((r) => r.map(csvEsc).join(',')).join('\n') + '\n';
const colSlug = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);

/**
 * One row per participant, built from a session export document.
 *
 * Fixed columns, then (all derived from the export's own index so every row
 * has the same shape): one `captured_*` column per captured variable, one
 * `time_s<N>_<title>` column per section (seconds), and for every checkpoint
 * `cp_<s.i>_cleared`, `cp_<s.i>_answer` (as typed), `cp_<s.i>_attempts`,
 * `cp_<s.i>_wrong` (incorrect entries joined with " | "), plus the hints
 * opened and solutions revealed as readable lists.
 *
 * @param {object|Array} docOrRows the export document (preferred) or legacy rows
 */
export function participantsToCsv(docOrRows) {
  const doc = Array.isArray(docOrRows) ? { participants: docOrRows } : docOrRows || {};
  const rows = doc.participants || [];
  const sections =
    doc.sections ||
    (rows[0]?.section_times || []).map((t) => ({ number: t.number, title: t.title }));
  const checkpoints =
    doc.checkpoints || (rows[0]?.checkpoints || []).map((c) => ({ key: c.key, step_title: c.step_title }));
  const captureCols = Object.keys(rows[0]?.captured || {});

  const fixed = [
    'number',
    'name',
    'first_name',
    'last_name',
    'status',
    'current_section',
    'sections_completed',
    'total_sections',
    'progress_pct',
    'checkpoints_cleared',
    'wrong_attempts',
    'hints_taken',
    'solutions_revealed',
    'complete',
    'completed_at',
    'finished',
    'finished_at',
    'total_seconds',
    'joined_at',
    'last_seen_at',
  ];
  const header = [
    ...fixed,
    ...captureCols.map((c) => `captured_${c}`),
    ...sections.map((sec) => `time_s${sec.number}_${colSlug(sec.title)}`),
    ...checkpoints.flatMap((c) => [
      `cp_${c.key}_cleared`,
      `cp_${c.key}_answer`,
      `cp_${c.key}_attempts`,
      `cp_${c.key}_wrong`,
    ]),
    'hints_opened',
    'solutions_revealed_list',
  ];

  const lines = rows.map((r) => {
    const status = r.complete ? 'complete' : 'in progress';
    const byKey = new Map((r.checkpoints || []).map((c) => [c.key, c]));
    return [
      ...fixed.map((c) => (c === 'status' ? status : r[c])),
      ...captureCols.map((c) => (r.captured || {})[c]),
      ...sections.map((sec, i) => r.section_seconds?.[i] ?? r.section_times?.[i]?.seconds ?? 0),
      ...checkpoints.flatMap((c) => {
        const x = byKey.get(c.key);
        if (!x) return ['', '', '', ''];
        return [
          x.cleared ? 'yes' : 'no',
          x.accepted_answer ?? '',
          x.attempt_count ?? 0,
          (x.wrong_attempts || []).map((a) => a.answer).join(' | '),
        ];
      }),
      (r.hints_opened || [])
        .map((h) => `${h.section_number}.${h.step_number} ${h.step_title} — ${h.label}`)
        .join(' | '),
      (r.solutions_revealed_list || [])
        .map((x) => `${x.section_number}.${x.step_number} ${x.step_title}`)
        .join(' | '),
    ];
  });
  return csvLines(header, lines);
}

/**
 * Chronological attempt log — one row per checkpoint submission across the
 * class (correct and incorrect), from the export document's `attempts`.
 */
export function attemptsToCsv(doc) {
  const header = [
    'at',
    'number',
    'name',
    'checkpoint',
    'section_number',
    'step_number',
    'step_title',
    'answer',
    'correct',
  ];
  const rows = (doc?.attempts || []).map((a) => [
    a.at,
    a.number,
    a.name,
    a.checkpoint,
    a.section_number,
    a.step_number,
    a.step_title,
    a.answer,
    a.correct ? 'yes' : 'no',
  ]);
  return csvLines(header, rows);
}
