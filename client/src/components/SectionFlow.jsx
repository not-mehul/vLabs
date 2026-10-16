import { fmtDuration } from '../lib/format.js';
import Icon from './Icon.jsx';

/** Row class for time on a section, from the server's allocation-aware status. */
export function timeRowClass(status) {
  if (status === 'over') return 'row--stuck';
  if (status === 'near') return 'row--slow';
  return '';
}

/** "12m 05s / 15m" style label for time against an allocation. */
export function timeAgainst(seconds, allocatedSeconds) {
  return allocatedSeconds
    ? `${fmtDuration(seconds)} / ${fmtDuration(allocatedSeconds)}`
    : fmtDuration(seconds);
}

/**
 * How far the class has got (labs and exams): one card per section — seats
 * whose furthest section it is, seats that have completed it, the time
 * allocated, and the average time of those who completed it (marked final
 * once everyone has moved on) — plus a final "Complete" card. Seats are placed
 * by their furthest section, so reviewing an earlier one doesn't move them
 * back. Optional / wrap-up sections are tagged and don't count towards
 * progress.
 *
 * @param {object} props
 * @param {object} props.data session detail (section_distribution, participants, complete_count)
 * @param {(s: object) => import('react').ReactNode} props.meta per-card detail line
 * @param {string} [props.doneLabel] label for the final card
 */
export default function SectionFlow({ data, meta, doneLabel = 'Complete' }) {
  const total = data.participants.length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return (
    <div className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Where everyone got to</h2>
        <span className="muted small">
          {total} registered · {data.complete_count} {doneLabel.toLowerCase()}
        </span>
      </div>
      <ol className="flow" aria-label="Seats per section">
        {data.section_distribution.map((s) => (
          <li
            className={`flow__card ${s.seats_here ? 'flow__card--busy' : ''} ${s.optional ? 'flow__card--optional' : ''}`}
            key={s.index}
            title={`${s.seats_here} got this far · ${s.seats_past} completed${s.optional ? ' · optional: not counted in progress' : ''}`}
          >
            <div className="flow__top">
              <span className="dist__index">{s.index + 1}</span>
              <span className="flow__title">{s.title}</span>
              {s.optional && <span className="tag tag--optional">optional</span>}
            </div>
            <div className="flow__num">
              {s.seats_here}
              <span className="flow__num-label">here</span>
            </div>
            <div className="flow__bar" aria-hidden="true">
              <span className="flow__bar-past" style={{ width: `${pct(s.seats_past)}%` }} />
              <span className="flow__bar-here" style={{ width: `${pct(s.seats_here)}%` }} />
            </div>
            <div className="flow__meta muted small">
              {meta(s)} · {s.seats_past} done
            </div>
            <div className="flow__time small">
              <span title="Time allocated to this section">
                <Icon name="clock" size={11} /> {s.minutes ? `${s.minutes} min` : 'no time set'}
              </span>
              {s.avg_seconds != null && (
                <span
                  className={
                    s.minutes && s.avg_seconds > s.minutes * 60 ? 'text-warn' : 'flow__avg'
                  }
                  title={
                    s.final
                      ? 'Average time of the whole class (everyone has moved on)'
                      : `Average of the ${s.completed_count} who have finished it so far`
                  }
                >
                  avg {fmtDuration(s.avg_seconds)}
                  {s.final ? '' : ` (${s.completed_count})`}
                </span>
              )}
            </div>
          </li>
        ))}
        <li className="flow__card flow__card--done" title={doneLabel}>
          <div className="flow__top">
            <span className="dist__index dist__index--done">
              <Icon name="check" size={13} />
            </span>
            <span className="flow__title">{doneLabel}</span>
          </div>
          <div className="flow__num">
            {data.complete_count}
            <span className="flow__num-label">done</span>
          </div>
          <div className="flow__bar" aria-hidden="true">
            <span className="flow__bar-done" style={{ width: `${pct(data.complete_count)}%` }} />
          </div>
          <div className="flow__meta muted small">{pct(data.complete_count)}% of the class</div>
        </li>
      </ol>
    </div>
  );
}
