import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { usePolling } from '../hooks/usePolling.js';
import { fmtDuration, excerpt } from '../lib/format.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import Icon from './Icon.jsx';
import { timeRowClass, timeAgainst } from './SectionFlow.jsx';

const STEP_TYPE = { desk: 'Hands-on', computer: 'Workstation', info: 'Read' };

function Stat({ value, label, warn, title }) {
  return (
    <div className="stat" title={title}>
      <span className={`stat__num ${warn ? 'text-warn' : ''}`}>{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

/** Participants table inside the drawer; a row opens that participant. */
function Seats({ rows, allocated, onOpen, empty, showViewing }) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table table--clickable table--compact">
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              tabIndex={0}
              className={timeRowClass(r.time_status)}
              onClick={() => onOpen(r.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen(r.id)}
            >
              <td className="col--seat">
                <span className="seat-num">{r.seat_number}</span>
              </td>
              <td>
                {r.name}
                {showViewing && !r.viewing_now && (
                  <span className="muted small"> · reviewing an earlier section</span>
                )}
              </td>
              <td className="num num--time">{timeAgainst(r.seconds, allocated)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Slide-over for one section of a live session (labs and exams): time
 * allocated vs. the class's actual times (average, median, fastest, slowest),
 * who is on it right now, who completed it and how long they took, who has not
 * reached it, and — for labs — hints, solutions and checkpoint results per
 * step; for exams — results per question. Live-refreshes.
 */
export default function SectionDrawer({ sessionId, index, onClose, onParticipant, onQuestion }) {
  const { call } = useInstructorApi();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(
    async (isCurrent) => {
      try {
        const res = await call((t) => api.getSection(t, sessionId, index));
        if (!isCurrent()) return;
        setD(res);
        setError('');
      } catch (err) {
        if (isCurrent()) setError(err.message);
      }
    },
    [call, sessionId, index],
  );
  usePolling(load, 5000);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.classList.add('has-drawer');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('has-drawer');
    };
  }, [onClose]);

  const t = d?.timing;
  const avgOver = d && d.allocated_seconds && t.avg_seconds > d.allocated_seconds;

  return (
    <div className="drawer-root">
      <div className="drawer__scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer drawer--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Section details"
      >
        <header className="drawer__head">
          {d ? (
            <div>
              <div className="drawer__title">
                <span className="dist__index">{d.index + 1}</span>
                <h2>{d.title}</h2>
                {d.optional && <span className="tag tag--optional">optional</span>}
              </div>
              <p className="muted small">
                {d.kind === 'exam'
                  ? `${d.question_count} question${d.question_count === 1 ? '' : 's'}`
                  : `${d.step_count} step${d.step_count === 1 ? '' : 's'}`}{' '}
                · <Icon name="clock" size={11} />{' '}
                {d.minutes ? `${d.minutes} min allocated` : 'no time allocated'}
                {d.optional && ' · not counted in progress'}
              </p>
            </div>
          ) : (
            <h2>Loading…</h2>
          )}
          <button className="btn btn--icon btn--ghost" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>

        {error && <p className="form__error">{error}</p>}

        {d && (
          <div className="drawer__body">
            <div className="stat-row stat-row--compact">
              <Stat value={d.here_count} label="Here now" />
              <Stat
                value={
                  <>
                    {d.completed_count}
                    <span className="muted">/{d.participant_count}</span>
                  </>
                }
                label="Completed"
              />
              <Stat value={d.minutes ? `${d.minutes}m` : '—'} label="Time allocated" />
              <Stat
                value={t.avg_seconds != null ? fmtDuration(t.avg_seconds) : '—'}
                label={t.avg_final ? 'Average (final)' : 'Average so far'}
                warn={avgOver}
                title={
                  t.avg_seconds == null
                    ? 'Nobody has completed this section yet'
                    : t.avg_final
                      ? 'Everyone has moved past this section'
                      : `Based on the ${t.timed_count} who have completed it`
                }
              />
            </div>

            <section className="drawer__section">
              <h3>Time on this section</h3>
              <dl className="kv">
                <div>
                  <dt>Median</dt>
                  <dd>{t.median_seconds != null ? fmtDuration(t.median_seconds) : '—'}</dd>
                </div>
                <div>
                  <dt>Fastest</dt>
                  <dd>{t.fastest_seconds != null ? fmtDuration(t.fastest_seconds) : '—'}</dd>
                </div>
                <div>
                  <dt>Slowest</dt>
                  <dd>{t.slowest_seconds != null ? fmtDuration(t.slowest_seconds) : '—'}</dd>
                </div>
                <div>
                  <dt>Took longer than allocated</dt>
                  <dd className={t.over_allocation_count ? 'text-warn' : ''}>
                    {d.allocated_seconds ? `${t.over_allocation_count} of ${t.timed_count}` : '—'}
                  </dd>
                </div>
                <div>
                  <dt>On it now: nearing / over</dt>
                  <dd className={t.here_over_count ? 'text-warn' : ''}>
                    {t.here_near_count} / {t.here_over_count}
                  </dd>
                </div>
              </dl>
              <p className="muted small">
                Break time is never counted.{' '}
                {d.allocated_seconds
                  ? 'Amber from 80 % of the allocation, red once it is exceeded.'
                  : 'No allocation: amber from 8 min, red after 15 min.'}
              </p>
            </section>

            <section className="drawer__section">
              <h3>On this section now ({d.here_count})</h3>
              <Seats
                rows={d.here}
                allocated={d.allocated_seconds}
                onOpen={onParticipant}
                showViewing
                empty="Nobody is working on this section right now."
              />
            </section>

            <section className="drawer__section">
              <h3>Completed ({d.completed_count})</h3>
              <Seats
                rows={d.completed}
                allocated={d.allocated_seconds}
                onOpen={onParticipant}
                empty="Nobody has completed this section yet."
              />
            </section>

            {d.not_reached_count > 0 && (
              <section className="drawer__section">
                <h3>Not reached yet ({d.not_reached_count})</h3>
                <div className="chips">
                  {d.not_reached.map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      className="tag tag--button"
                      onClick={() => onParticipant(p.id)}
                      title={`Furthest: section ${p.furthest_section + 1}`}
                    >
                      {p.seat_number} · {p.name}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {d.kind === 'lab' && (
              <section className="drawer__section">
                <h3>Steps</h3>
                <ol className="steplist">
                  {d.steps.map((s) => (
                    <li key={s.key} className="steplist__item">
                      <div className="steplist__head">
                        <span className={`card__kind card__kind--${s.type}`}>
                          {STEP_TYPE[s.type] || s.type}
                        </span>
                        <span className="muted small">
                          {d.index + 1}.{s.index + 1}
                        </span>
                        <strong>{s.title}</strong>
                      </div>
                      <div className="steplist__facts muted small">
                        {s.hint_count > 0 ? (
                          <span>
                            <Icon name="hint" size={12} /> {s.hint_count} hint
                            {s.hint_count === 1 ? '' : 's'} ·{' '}
                            {s.hint_opens
                              ? `opened ${s.hint_opens}× by ${s.hint_participants} participant${s.hint_participants === 1 ? '' : 's'}`
                              : 'none opened'}
                          </span>
                        ) : (
                          <span>No hints</span>
                        )}
                        {s.solutions_revealed > 0 && (
                          <span className="text-warn">
                            <Icon name="key" size={12} /> solution revealed by{' '}
                            {s.solutions_revealed}
                          </span>
                        )}
                      </div>
                      {s.checkpoint && (
                        <div className="steplist__cp">
                          <p className="small">
                            <Icon name="lock" size={12} /> {s.checkpoint.prompt}
                            {s.checkpoint.mode === 'pattern' && (
                              <span className="muted"> · pattern</span>
                            )}
                          </p>
                          <p className="small">
                            <strong>{s.checkpoint.cleared_count}</strong>
                            <span className="muted">/{d.participant_count} cleared</span> ·{' '}
                            <span className={s.checkpoint.wrong_attempts ? 'text-warn' : ''}>
                              {s.checkpoint.wrong_attempts} wrong attempt
                              {s.checkpoint.wrong_attempts === 1 ? '' : 's'}
                            </span>
                            {s.checkpoint.participants_with_wrong > 0 && (
                              <span className="muted">
                                {' '}
                                by {s.checkpoint.participants_with_wrong}
                              </span>
                            )}
                          </p>
                          {s.checkpoint.common_wrong.length > 0 && (
                            <div className="chips">
                              <span className="muted small">Common wrong answers:</span>
                              {s.checkpoint.common_wrong.map((w) => (
                                <span className="tag" key={w.answer}>
                                  <code>{w.answer}</code> ×{w.count}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {d.kind === 'exam' && (
              <section className="drawer__section">
                <h3>Questions</h3>
                <div className="table-wrap">
                  <table className="table table--clickable table--compact">
                    <thead>
                      <tr>
                        <th className="col--seat">Q</th>
                        <th>Question</th>
                        <th>Answered</th>
                        <th>Correct</th>
                        <th>To mark</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.questions.map((q) => (
                        <tr
                          key={q.key}
                          tabIndex={0}
                          onClick={() => onQuestion?.(q.key)}
                          onKeyDown={(e) =>
                            (e.key === 'Enter' || e.key === ' ') && onQuestion?.(q.key)
                          }
                        >
                          <td className="col--seat">
                            <span className="seat-num">{q.number}</span>
                          </td>
                          <td>
                            {excerpt(q.prompt, 70)}
                            <div className="muted small">{q.type_label}</div>
                          </td>
                          <td className="num">
                            {q.answered}/{d.participant_count}
                          </td>
                          <td className="num">{q.graded ? `${q.correct_pct}%` : '—'}</td>
                          <td className={`num ${q.pending ? 'text-warn' : ''}`}>
                            {q.pending || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
