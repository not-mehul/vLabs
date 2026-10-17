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
const csvLines = (header, rows) =>
  [header, ...rows].map((r) => r.map(csvEsc).join(',')).join('\n') + '\n';
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
    doc.checkpoints ||
    (rows[0]?.checkpoints || []).map((c) => ({ key: c.key, step_title: c.step_title }));
  const captureCols = Object.keys(rows[0]?.captured || {});

  const fixed = [
    'number',
    'name',
    'first_name',
    'last_name',
    'status',
    'current_section',
    'furthest_section',
    'sections_completed',
    'counting_sections',
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

const verdictText = (r) =>
  !r.answered
    ? 'unanswered'
    : r.pending
      ? 'needs marking'
      : r.correct
        ? 'correct'
        : r.partial
          ? 'partial'
          : 'incorrect';

/**
 * EXAM sessions: one row per participant. Fixed columns, then for every
 * question `q<N>_response`, `q<N>_result` (correct / partial / incorrect /
 * needs marking / unanswered), `q<N>_points`, `q<N>_marked_by` (set when an
 * instructor marked it by hand) and `q<N>_comment` (the marker's note). A `time_s<N>_<title>` column per section (seconds, breaks
 * excluded) sits between the fixed and per-question columns.
 */
export function examResultsToCsv(doc) {
  const questions = doc?.questions || [];
  const sections = doc?.sections || [];
  const fixed = [
    'number',
    'name',
    'first_name',
    'last_name',
    'submitted',
    'submitted_at',
    'answered',
    'question_count',
    'score',
    'max_score',
    'score_pct',
    'pending_count',
    'fully_graded',
    'total_seconds',
    'furthest_section',
    'joined_at',
    'last_seen_at',
  ];
  const header = [
    ...fixed,
    ...sections.map((sec) => `time_s${sec.number}_${colSlug(sec.title)}`),
    ...questions.flatMap((q) => [
      `q${q.number}_response`,
      `q${q.number}_result`,
      `q${q.number}_points`,
      `q${q.number}_marked_by`,
      `q${q.number}_comment`,
    ]),
  ];
  const rows = (doc?.participants || []).map((p) => {
    const byKey = new Map((p.responses || []).map((r) => [r.key, r]));
    return [
      ...fixed.map((c) => (typeof p[c] === 'boolean' ? (p[c] ? 'yes' : 'no') : p[c])),
      ...sections.map((_, i) => p.section_seconds?.[i] ?? 0),
      ...questions.flatMap((q) => {
        const r = byKey.get(q.key);
        if (!r) return ['', '', '', '', ''];
        return [r.response, verdictText(r), r.points_awarded, r.marked_by || '', r.comment || ''];
      }),
    ];
  });
  return csvLines(header, rows);
}

/** EXAM sessions: the question index with expected answers (an answer key). */
export function examKeyToCsv(doc) {
  const header = ['number', 'key', 'section', 'type', 'points', 'prompt', 'options', 'expected'];
  const rows = (doc?.questions || []).map((q) => [
    q.number,
    q.key,
    q.section_title,
    q.type,
    q.points,
    q.prompt,
    (q.options || []).join(' | '),
    q.expected,
  ]);
  return csvLines(header, rows);
}

/** EXAM sessions: every answer change across the class, in time order. */
export function examLogToCsv(doc) {
  const header = ['at', 'number', 'name', 'question', 'response'];
  const rows = (doc?.answer_log || []).map((e) => [e.at, e.number, e.name, e.question, e.response]);
  return csvLines(header, rows);
}

/** Plain-text excerpt of a Markdown prompt for table cells. */
export function excerpt(md, n = 90) {
  const t = String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
    .replace(/[`*_>#[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
