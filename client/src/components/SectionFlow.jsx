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
 * The monitor's "Sections" panel (labs and exams): one compact card per
 * section with only the basics — how many participants are on it, whether it
 * is optional, and how many have completed it — plus a final "Complete" card.
 * Clicking a card opens the section drawer (SectionDrawer) with the timing,
 * averages and per-step / per-question detail. Seats are placed by their
 * furthest section, so reviewing an earlier one doesn't move them back.
 *
 * @param {object} props
 * @param {object} props.data session detail (section_distribution, participants, complete_count)
 * @param {(index: number) => void} props.onSelect open a section's drawer
 * @param {string} [props.doneLabel] label for the final card
 */
export default function SectionFlow({ data, onSelect, doneLabel = 'Complete' }) {
  const total = data.participants.length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return (
    <div className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Sections</h2>
        <span className="muted small">
          {total} participant{total === 1 ? '' : 's'} · click a section for timings and details
        </span>
      </div>
      <ol className="flow" aria-label="Sections">
        {data.section_distribution.map((s) => {
          const allDone = total > 0 && s.seats_past === total;
          return (
            <li key={s.index}>
              <button
                type="button"
                className={`flow__card flow__card--button ${s.seats_here ? 'flow__card--busy' : ''} ${s.optional ? 'flow__card--optional' : ''}`}
                onClick={() => onSelect(s.index)}
                aria-label={`Section ${s.index + 1}: ${s.title}. ${s.seats_here} here, ${s.seats_past} of ${total} completed${s.optional ? ', optional' : ''}. Show details`}
              >
                <span className="flow__top">
                  <span className={`dist__index ${allDone ? 'dist__index--done' : ''}`}>
                    {allDone ? <Icon name="check" size={12} /> : s.index + 1}
                  </span>
                  <span className="flow__title" title={s.title}>
                    {s.title}
                  </span>
                  {s.optional && <span className="tag tag--optional">optional</span>}
                </span>
                <span className="flow__num">
                  {s.seats_here}
                  <span className="flow__num-label">here</span>
                </span>
                <span className="flow__bar" aria-hidden="true">
                  <span className="flow__bar-past" style={{ width: `${pct(s.seats_past)}%` }} />
                  <span className="flow__bar-here" style={{ width: `${pct(s.seats_here)}%` }} />
                </span>
                <span className="flow__meta muted small">
                  {allDone ? (
                    <span className="text-success">Completed by everyone</span>
                  ) : (
                    `${s.seats_past} of ${total} completed`
                  )}
                </span>
              </button>
            </li>
          );
        })}
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
