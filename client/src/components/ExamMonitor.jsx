import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { fmtDuration, excerpt } from '../lib/format.js';
import { formatDateTime } from '../lib/datetime.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import Markdown from './Markdown.jsx';
import Icon from './Icon.jsx';
import SectionFlow, { timeRowClass, timeAgainst } from './SectionFlow.jsx';
import SectionDrawer from './SectionDrawer.jsx';

const TYPE_LABEL = {
  single: 'Multiple choice',
  multiple: 'Select all',
  truefalse: 'True / false',
  short: 'Short answer',
  long: 'Long answer',
};

/** Correct / incorrect / needs marking / unanswered badge for one response. */
function Verdict({ r }) {
  if (!r.answered) return <span className="verdict verdict--none">Unanswered</span>;
  if (r.pending) return <span className="verdict verdict--pending">Needs marking</span>;
  return r.correct ? (
    <span className="verdict verdict--ok">
      <Icon name="check" size={12} /> Correct
    </span>
  ) : (
    <span className="verdict verdict--bad">
      <Icon name="close" size={12} /> Incorrect
    </span>
  );
}

/**
 * Manual marking: mark a response correct or incorrect (overriding the
 * automatic verdict), or clear the mark to fall back to it.
 */
function MarkControls({ r, onMark, busy }) {
  return (
    <div className="mark" role="group" aria-label="Mark this response">
      <button
        type="button"
        className={`btn btn--xs ${r.override === true ? 'btn--success' : 'btn--ghost'}`}
        onClick={() => onMark(true)}
        disabled={busy}
        aria-pressed={r.override === true}
      >
        <Icon name="check" size={12} /> Correct
      </button>
      <button
        type="button"
        className={`btn btn--xs ${r.override === false ? 'btn--danger' : 'btn--ghost'}`}
        onClick={() => onMark(false)}
        disabled={busy}
        aria-pressed={r.override === false}
      >
        <Icon name="close" size={12} /> Incorrect
      </button>
      {r.override !== null && (
        <button
          type="button"
          className="btn btn--xs btn--ghost"
          onClick={() => onMark(null)}
          disabled={busy}
          title={
            r.auto === null
              ? 'Remove the mark'
              : `Remove the mark (automatic verdict: ${r.auto ? 'correct' : 'incorrect'})`
          }
        >
          <Icon name="undo" size={12} /> Clear
        </button>
      )}
      {r.marked_by && (
        <span className="muted small">
          marked by {r.marked_by}
          {r.marked_at ? ` · ${formatDateTime(r.marked_at)}` : ''}
        </span>
      )}
    </div>
  );
}

/** Options list with the correct ones and the participant's choice highlighted. */
function OptionList({ options, correct, chosen }) {
  const correctSet = new Set(Array.isArray(correct) ? correct : correct == null ? [] : [correct]);
  const chosenSet = new Set(Array.isArray(chosen) ? chosen : chosen == null ? [] : [chosen]);
  return (
    <ol className="optlist">
      {options.map((o, i) => (
        <li
          key={i}
          className={`optlist__item ${correctSet.has(i) ? 'optlist__item--correct' : ''} ${
            chosenSet.has(i) ? 'optlist__item--chosen' : ''
          }`}
        >
          <span className="optlist__mark" aria-hidden="true">
            {String.fromCharCode(65 + i)}
          </span>
          <span className="optlist__text">
            <Markdown>{o}</Markdown>
          </span>
          {chosenSet.has(i) && <span className="tag">chosen</span>}
          {correctSet.has(i) && <span className="tag tag--done">correct</span>}
        </li>
      ))}
    </ol>
  );
}

/** Shared slide-over chrome. */
function Drawer({ label, onClose, head, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.classList.add('has-drawer');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('has-drawer');
    };
  }, [onClose]);
  return (
    <div className="drawer-root">
      <div className="drawer__scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer drawer--wide" role="dialog" aria-modal="true" aria-label={label}>
        <header className="drawer__head">
          {head}
          <button className="btn btn--icon btn--ghost" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}

/** Poll a loader every few seconds while a drawer is open. */
function usePolled(loader) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try {
      setD(await loader());
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [loader]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);
  return { d, error, reload };
}

/** One participant's whole exam: every question, their response, verdicts, marks. */
function ParticipantExamDrawer({ sessionId, participantId, active, onClose, onChanged }) {
  const { call } = useInstructorApi();
  const loader = useCallback(
    () => call((t) => api.getParticipant(t, sessionId, participantId)),
    [call, sessionId, participantId],
  );
  const { d, error, reload } = usePolled(loader);
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState('all');

  async function mark(key, correct) {
    setBusy(key);
    try {
      await call((t) => api.markResponse(t, sessionId, participantId, key, correct));
      await reload();
      onChanged();
    } finally {
      setBusy('');
    }
  }

  const [actionError, setActionError] = useState('');

  /** Seat-level actions (reopen / move device / remove), each confirmed first. */
  async function seatAction(kind) {
    const name = d?.name || 'this participant';
    const prompts = {
      reopen: `Reopen ${name}'s exam? They can change answers again until they resubmit.`,
      release: `Let ${name} continue on another device?\n\nTheir current device is signed out; the next time they join with the same name, on any device, they get their seat and answers back.`,
      remove: `Remove ${name} from this session?\n\nTheir answers and marks are deleted. This cannot be undone.`,
    };
    if (!window.confirm(prompts[kind])) return;
    setActionError('');
    try {
      if (kind === 'reopen') await call((t) => api.reopenExam(t, sessionId, participantId));
      if (kind === 'release') await call((t) => api.releaseSeat(t, sessionId, participantId));
      if (kind === 'remove') {
        await call((t) => api.removeParticipant(t, sessionId, participantId));
        onChanged();
        onClose();
        return;
      }
      await reload();
      onChanged();
    } catch (err) {
      setActionError(err.message);
    }
  }

  const shown = (d?.questions || []).filter((q) =>
    filter === 'pending' ? q.pending : filter === 'manual' ? q.manual : true,
  );

  return (
    <Drawer
      label="Participant exam"
      onClose={onClose}
      head={
        d ? (
          <div>
            <div className="drawer__title">
              <span className="seat-num">{d.seat_number}</span>
              <h2>{d.name}</h2>
              <span className={`pill pill--${d.submitted ? 'active' : 'ended'}`}>
                {d.submitted ? 'submitted' : 'in progress'}
              </span>
            </div>
            <p className="muted small">
              Joined {formatDateTime(d.joined_at)}
              {d.submitted_at ? ` · submitted ${formatDateTime(d.submitted_at)}` : ''}
            </p>
          </div>
        ) : (
          <h2>Loading…</h2>
        )
      }
    >
      {error && <p className="form__error">{error}</p>}
      {d && (
        <div className="drawer__body">
          <div className="stat-row stat-row--compact">
            <div className="stat">
              <span className="stat__num">
                {d.score}
                <span className="muted">/{d.max_score}</span>
              </span>
              <span className="stat__label">Score{d.fully_graded ? '' : ' (provisional)'}</span>
            </div>
            <div className="stat">
              <span className="stat__num">
                {d.answered}
                <span className="muted">/{d.question_count}</span>
              </span>
              <span className="stat__label">Answered</span>
            </div>
            <div className="stat">
              <span className={`stat__num ${d.pending_count ? 'text-warn' : ''}`}>
                {d.pending_count}
              </span>
              <span className="stat__label">To mark</span>
            </div>
            <div className="stat">
              <span className="stat__num">{fmtDuration(d.total_seconds)}</span>
              <span className="stat__label">{d.submitted ? 'Time taken' : 'Elapsed'}</span>
            </div>
          </div>

          <div className="drawer__actions">
            {active && d.submitted && (
              <button className="btn btn--sm btn--ghost" onClick={() => seatAction('reopen')}>
                <Icon name="undo" size={14} /> Reopen exam
              </button>
            )}
            {active && (
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => seatAction('release')}
                title="Their device died or they need to switch devices: lets them rejoin elsewhere"
              >
                <Icon name="refresh" size={14} /> Move to another device
              </button>
            )}
            <button className="btn btn--sm btn--danger-ghost" onClick={() => seatAction('remove')}>
              <Icon name="trash" size={14} /> Remove
            </button>
          </div>
          {actionError && <p className="form__error">{actionError}</p>}

          {d.section_times?.length > 0 && (
            <section className="drawer__section">
              <h3>Time per section</h3>
              <ul className="timebars">
                {d.section_times.map((t) => (
                  <li
                    key={t.index}
                    className={`timebars__row ${t.current ? 'timebars__row--current' : ''}`}
                  >
                    <span className={`dist__index ${t.done ? 'dist__index--done' : ''}`}>
                      {t.done ? <Icon name="check" size={12} /> : t.index + 1}
                    </span>
                    <span className="timebars__title" title={t.title}>
                      {t.title}
                      {t.current && <span className="muted small"> · viewing now</span>}
                    </span>
                    <span
                      className={`timebars__val ${t.minutes && t.seconds > t.minutes * 60 ? 'text-warn' : ''}`}
                    >
                      {t.seconds ? fmtDuration(t.seconds) : '—'}
                      {t.minutes ? <span className="muted"> / {t.minutes}m</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="segmented" role="group" aria-label="Filter questions">
            {[
              ['all', 'All'],
              ['pending', `To mark (${d.pending_count})`],
              ['manual', 'Hand-marked'],
            ].map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`segmented__btn ${filter === k ? 'is-active' : ''}`}
                onClick={() => setFilter(k)}
                aria-pressed={filter === k}
              >
                {label}
              </button>
            ))}
          </div>

          <ol className="qreview">
            {shown.map((q) => (
              <li
                key={q.key}
                className={`qreview__item ${q.pending ? 'qreview__item--pending' : ''}`}
              >
                <div className="qreview__head">
                  <span className="qreview__num">Q{q.number}</span>
                  <span className="muted small">
                    {q.section_title} · {TYPE_LABEL[q.type] || q.type} · {q.points} pt
                    {q.points === 1 ? '' : 's'}
                  </span>
                  <Verdict r={q} />
                </div>
                <div className="qreview__prompt">
                  <Markdown>{q.prompt}</Markdown>
                </div>
                {q.options.length > 0 ? (
                  <OptionList options={q.options} correct={q.correct_option} chosen={q.value} />
                ) : (
                  <div className="qreview__answer">
                    <span className="editor-label">Response</span>
                    {q.answered ? (
                      <p className={q.type === 'long' ? 'qreview__long' : ''}>{q.response}</p>
                    ) : (
                      <p className="muted">No answer</p>
                    )}
                    {q.expected && (
                      <p className="muted small">
                        Expected: <code>{q.expected}</code>
                      </p>
                    )}
                  </div>
                )}
                {q.answered && (
                  <MarkControls r={q} busy={busy === q.key} onMark={(v) => mark(q.key, v)} />
                )}
                {q.history.length > 1 && (
                  <details className="qreview__history">
                    <summary className="muted small">
                      Changed {q.history.length - 1} time{q.history.length === 2 ? '' : 's'}
                    </summary>
                    <ul>
                      {q.history.map((h, i) => (
                        <li key={i}>
                          <code>{h.response || '(cleared)'}</code>{' '}
                          <span className="muted small">{formatDateTime(h.at)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
            {shown.length === 0 && <p className="muted small">Nothing to show.</p>}
          </ol>
        </div>
      )}
    </Drawer>
  );
}

/** Every participant's response to one question — fastest way to hand-mark. */
function QuestionDrawer({ sessionId, questionKey, onClose, onChanged }) {
  const { call } = useInstructorApi();
  const loader = useCallback(
    () => call((t) => api.questionResponses(t, sessionId, questionKey)),
    [call, sessionId, questionKey],
  );
  const { d, error, reload } = usePolled(loader);
  const [busy, setBusy] = useState(null);

  async function mark(pid, correct) {
    setBusy(pid);
    try {
      await call((t) => api.markResponse(t, sessionId, pid, questionKey, correct));
      await reload();
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Drawer
      label="Question responses"
      onClose={onClose}
      head={
        d ? (
          <div>
            <div className="drawer__title">
              <span className="qreview__num">Q{d.number}</span>
              <h2>{TYPE_LABEL[d.type] || d.type}</h2>
              {d.manual && <span className="tag">hand-marked</span>}
            </div>
            <p className="muted small">
              {d.section_title} · {d.points} point{d.points === 1 ? '' : 's'}
            </p>
          </div>
        ) : (
          <h2>Loading…</h2>
        )
      }
    >
      {error && <p className="form__error">{error}</p>}
      {d && (
        <div className="drawer__body">
          <div className="qreview__prompt">
            <Markdown>{d.prompt}</Markdown>
          </div>
          {d.options.length > 0 && (
            <OptionList options={d.options} correct={d.correct_option} chosen={null} />
          )}
          {d.expected && (
            <p className="small">
              <span className="editor-label">Expected</span> <code>{d.expected}</code>
            </p>
          )}
          <ul className="resplist">
            {d.responses.map((r) => (
              <li key={r.participant_id} className="resplist__item">
                <div className="resplist__head">
                  <span className="seat-num">{r.seat_number}</span>
                  <strong>{r.name}</strong>
                  <Verdict r={r} />
                </div>
                {r.answered ? (
                  <p className={d.type === 'long' ? 'qreview__long' : 'resplist__answer'}>
                    {r.response}
                  </p>
                ) : (
                  <p className="muted small">No answer</p>
                )}
                {r.answered && (
                  <MarkControls
                    r={r}
                    busy={busy === r.participant_id}
                    onMark={(v) => mark(r.participant_id, v)}
                  />
                )}
              </li>
            ))}
            {d.responses.length === 0 && <p className="muted small">No participants yet.</p>}
          </ul>
        </div>
      )}
    </Drawer>
  );
}

/**
 * Monitor body for EXAM sessions: per-question statistics (click to mark every
 * response to a question) and per-participant scores (click for their whole
 * exam). Scores are provisional while hand-marked answers are outstanding.
 */
export default function ExamMonitor({ data, sessionId, onChanged }) {
  const [participant, setParticipant] = useState(null);
  const [question, setQuestion] = useState(null);
  const closeP = useCallback(() => setParticipant(null), []);
  const closeQ = useCallback(() => setQuestion(null), []);
  const [section, setSection] = useState(null);
  const closeS = useCallback(() => setSection(null), []);
  const fromSection = (open) => (value) => {
    setSection(null);
    open(value);
  };

  return (
    <>
      <SectionFlow data={data} doneLabel="Submitted" onSelect={setSection} />

      <div className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Questions</h2>
          <span className="muted small">Click a question to see and mark every response to it</span>
        </div>
        <div className="table-wrap">
          <table className="table table--clickable">
            <thead>
              <tr>
                <th className="col--seat">Q</th>
                <th>Question</th>
                <th className="col--md">Type</th>
                <th className="col--sm">Points</th>
                <th>Answered</th>
                <th>Correct</th>
                <th>To mark</th>
              </tr>
            </thead>
            <tbody>
              {data.questions.map((q) => (
                <tr
                  key={q.key}
                  tabIndex={0}
                  className={question === q.key ? 'row--selected' : ''}
                  onClick={() => setQuestion(q.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setQuestion(q.key);
                    }
                  }}
                  aria-label={`Open responses to question ${q.number}`}
                >
                  <td className="col--seat">
                    <span className="seat-num">{q.number}</span>
                  </td>
                  <td>
                    <span className="table__primary">{excerpt(q.prompt)}</span>
                    <span className="muted small section-cell__title">{q.section_title}</span>
                  </td>
                  <td className="col--md muted">{q.type_label}</td>
                  <td className="col--sm">{q.points}</td>
                  <td>
                    {q.answered}
                    <span className="muted">/{data.participants.length}</span>
                  </td>
                  <td>
                    {q.graded === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <div className="progress-cell">
                        <div className="minibar" aria-hidden="true">
                          <div className="minibar__fill" style={{ width: `${q.correct_pct}%` }} />
                        </div>
                        <span className="muted small">{q.correct_pct}%</span>
                      </div>
                    )}
                  </td>
                  <td className={q.pending ? 'text-warn' : 'muted'}>{q.pending || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Participants</h2>
          <span className="muted small">
            {data.submitted_count} of {data.participants.length} submitted · click a row for every
            answer
          </span>
        </div>
        {data.participants.length === 0 ? (
          <p className="muted">No participants have joined yet. Share code {data.room_code}.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table--clickable">
              <thead>
                <tr>
                  <th className="col--seat">#</th>
                  <th>Participant</th>
                  <th>Answered</th>
                  <th>Score</th>
                  <th>To mark</th>
                  <th title="Furthest section opened">Section</th>
                  <th title="Time on that section / time allocated (breaks excluded)">
                    Time on section
                  </th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.participants.map((p) => (
                  <tr
                    key={p.id}
                    tabIndex={0}
                    className={`${p.submitted ? 'row--done' : timeRowClass(p.time_status)} ${participant === p.id ? 'row--selected' : ''}`}
                    onClick={() => setParticipant(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setParticipant(p.id);
                      }
                    }}
                    aria-label={`Open exam for ${p.name}`}
                  >
                    <td className="col--seat">
                      <span className="seat-num">{p.seat_number}</span>
                    </td>
                    <td className="table__primary">{p.name}</td>
                    <td>
                      <div className="progress-cell">
                        <div className="minibar" aria-hidden="true">
                          <div
                            className="minibar__fill"
                            style={{
                              width: `${p.question_count ? Math.round((p.answered / p.question_count) * 100) : 0}%`,
                            }}
                          />
                        </div>
                        <span className="muted small">
                          {p.answered}/{p.question_count}
                        </span>
                      </div>
                    </td>
                    <td
                      title={p.fully_graded ? '' : 'Provisional: some answers still need marking'}
                    >
                      <strong>{p.score}</strong>
                      <span className="muted">/{p.max_score}</span>{' '}
                      <span className="muted small">
                        {p.score_pct}%{p.fully_graded ? '' : '*'}
                      </span>
                    </td>
                    <td className={p.pending_count ? 'text-warn' : 'muted'}>
                      {p.pending_count || '—'}
                    </td>
                    <td>
                      {p.submitted ? (
                        <span className="muted">Done</span>
                      ) : (
                        <span className="section-cell__num">
                          {p.furthest_section + 1}
                          <span className="muted"> / {data.section_count}</span>
                        </span>
                      )}
                    </td>
                    <td className={!p.submitted && p.time_status === 'over' ? 'text-warn' : ''}>
                      {p.submitted
                        ? fmtDuration(p.total_seconds)
                        : timeAgainst(p.seconds_on_furthest_section, p.allocated_seconds)}
                    </td>
                    <td>
                      {p.submitted ? (
                        <span className="pill pill--active">
                          <Icon name="check" size={13} /> Submitted
                        </span>
                      ) : p.seconds_since_seen < 90 ? (
                        <span className="status-live">
                          <span className="dot dot--live" /> answering
                        </span>
                      ) : (
                        <span className="muted">{fmtDuration(p.seconds_since_seen)} ago</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small legend">
          * provisional — short or long answers still need marking. Correct answers are never shown
          to participants.
        </p>
      </div>

      {section != null && (
        <SectionDrawer
          sessionId={sessionId}
          index={section}
          onClose={closeS}
          onParticipant={fromSection(setParticipant)}
          onQuestion={fromSection(setQuestion)}
        />
      )}
      {participant != null && (
        <ParticipantExamDrawer
          sessionId={sessionId}
          participantId={participant}
          active={data.status === 'active'}
          onClose={closeP}
          onChanged={onChanged}
        />
      )}
      {question != null && (
        <QuestionDrawer
          sessionId={sessionId}
          questionKey={question}
          onClose={closeQ}
          onChanged={onChanged}
        />
      )}
    </>
  );
}
