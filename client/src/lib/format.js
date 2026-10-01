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

/** Build a CSV from the session-export participant rows. */
export function participantsToCsv(rows) {
  const cols = [
    'number',
    'name',
    'first_name',
    'last_name',
    'current_section',
    'sections_completed',
    'total_sections',
    'progress_pct',
    'checkpoints_cleared',
    'hints_taken',
    'solutions_revealed',
    'finished',
    'finished_at',
    'total_seconds',
    'joined_at',
    'last_seen_at',
  ];
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    // Neutralise spreadsheet formula injection (=, +, -, @ at the start).
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.join(',');
  const lines = (rows || []).map((r) => cols.map((c) => esc(r[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}
