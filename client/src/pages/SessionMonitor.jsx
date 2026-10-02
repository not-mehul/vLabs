import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, copyToClipboard } from '../api.js';
import { downloadFile } from '../lib/files.js';
import { slug, fmtDuration, participantsToCsv, attemptsToCsv } from '../lib/format.js';
import { formatDateTime } from '../lib/datetime.js';
import { useCountdown } from '../hooks/useCountdown.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import Icon from '../components/Icon.jsx';

/** Highlight seats that appear stuck (long time on a section). */
function stuckClass(seconds) {
  if (seconds >= 15 * 60) return 'row--stuck';
  if (seconds >= 8 * 60) return 'row--slow';
  return '';
}

function CopyCode({ code }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (await copyToClipboard(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }
  return (
    <button className="roomcode roomcode--xl roomcode--copy" onClick={copy} title="Copy room code">
      <span>{code}</span>
      <span className="roomcode__copy">
        <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  );
}

function StatusPill({ p }) {
  if (p.complete) {
    return (
      <span
        className="pill pill--active"
        title={p.finished ? 'Pressed Finish' : 'All sections cleared (still reviewing)'}
      >
        <Icon name="check" size={14} /> Complete
      </span>
    );
  }
  if (p.seconds_since_seen < 90) {
    return (
      <span className="status-live">
        <span className="dot dot--live" /> active
      </span>
    );
  }
  return <span className="muted">{fmtDuration(p.seconds_since_seen)} ago</span>;
}

/**
 * Where the class is right now: one card per section (seats currently on it,
 * seats already past it) plus a final "Complete" card. Reads left to right as
 * the lab does, so a pile-up on one card is obvious at a glance.
 */
function SectionFlow({ data }) {
  const total = data.participants.length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return (
    <div className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Where everyone is</h2>
        <span className="muted small">
          {total} registered · {data.complete_count} complete
        </span>
      </div>
      <ol className="flow" aria-label="Seats per section">
        {data.section_distribution.map((s) => (
          <li
            className={`flow__card ${s.seats_here ? 'flow__card--busy' : ''}`}
            key={s.index}
            title={`${s.seats_here} here · ${s.seats_past} past`}
          >
            <div className="flow__top">
              <span className="dist__index">{s.index + 1}</span>
              <span className="flow__title">{s.title}</span>
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
              {s.step_count} step{s.step_count === 1 ? '' : 's'}
              {s.checkpoint_count ? (
                <span
                  title={`${s.checkpoint_count} checkpoint${s.checkpoint_count === 1 ? '' : 's'}`}
                >
                  {' '}
                  · <Icon name="lock" size={11} /> {s.checkpoint_count}
                </span>
              ) : (
                ' · no checkpoint'
              )}{' '}
              · {s.seats_past} past
            </div>
          </li>
        ))}
        <li className="flow__card flow__card--done" title="All sections cleared">
          <div className="flow__top">
            <span className="dist__index dist__index--done">
              <Icon name="check" size={13} />
            </span>
            <span className="flow__title">Complete</span>
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

/** Slide-over with one participant's answers, attempts, hints and timings. Live-refreshes. */
function ParticipantDrawer({ sessionId, participantId, sectionCount, onClose }) {
  const { call } = useInstructorApi();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await call((t) => api.getParticipant(t, sessionId, participantId));
        if (!cancelled) {
          setD(res);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [call, sessionId, participantId]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Dialog semantics on touch devices: the page behind must not scroll.
    document.body.classList.add('has-drawer');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('has-drawer');
    };
  }, [onClose]);

  const maxSectionSeconds = d ? Math.max(1, ...d.section_times.map((s) => s.seconds)) : 1;

  return (
    <div className="drawer-root">
      <div className="drawer__scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Participant details">
        <header className="drawer__head">
          {d ? (
            <div>
              <div className="drawer__title">
                <span className="mono seat-num">{d.seat_number}</span>
                <h2>{d.name}</h2>
                <StatusPill p={d} />
              </div>
              <p className="muted small">
                Joined {formatDateTime(d.joined_at)}
                {d.completed_at ? ` · completed ${formatDateTime(d.completed_at)}` : ''}
                {d.finished_at ? ` · pressed Finish ${formatDateTime(d.finished_at)}` : ''}
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
              <div className="stat">
                <span className="stat__num">{fmtDuration(d.total_seconds)}</span>
                <span className="stat__label">{d.complete ? 'Total time' : 'Elapsed'}</span>
              </div>
              <div className="stat">
                <span className="stat__num">
                  {d.completed_sections}
                  <span className="muted">/{sectionCount}</span>
                </span>
                <span className="stat__label">Sections</span>
              </div>
              <div className="stat">
                <span className="stat__num">{d.hints.length}</span>
                <span className="stat__label">Hints</span>
              </div>
              <div className="stat">
                <span className={`stat__num ${d.wrong_attempts ? 'text-warn' : ''}`}>
                  {d.wrong_attempts}
                </span>
                <span className="stat__label">Wrong attempts</span>
              </div>
            </div>

            <section className="drawer__section">
              <h3>Time per section</h3>
              <ul className="timebars">
                {d.section_times.map((s) => (
                  <li
                    key={s.index}
                    className={`timebars__row ${s.current ? 'timebars__row--current' : ''}`}
                  >
                    <span className="dist__index">{s.index + 1}</span>
                    <span className="timebars__title" title={s.title}>
                      {s.title}
                      {s.current && <span className="muted small"> · now</span>}
                    </span>
                    <span className="timebars__bar" aria-hidden="true">
                      <span
                        className={`timebars__fill ${s.cleared || s.index < d.max_section ? '' : 'timebars__fill--open'}`}
                        style={{ width: `${Math.round((s.seconds / maxSectionSeconds) * 100)}%` }}
                      />
                    </span>
                    <span
                      className={`timebars__val ${s.seconds >= 15 * 60 && s.current ? 'text-warn' : ''}`}
                    >
                      {s.seconds ? fmtDuration(s.seconds) : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="drawer__section">
              <h3>Checkpoints</h3>
              {d.checkpoints.length === 0 ? (
                <p className="muted small">This manual has no checkpoints.</p>
              ) : (
                <ol className="cplist">
                  {d.checkpoints.map((c) => (
                    <li
                      key={c.key}
                      className={`cplist__item ${c.cleared ? 'cplist__item--cleared' : ''}`}
                    >
                      <div className="cplist__head">
                        <span className={`cplist__state ${c.cleared ? 'cplist__state--ok' : ''}`}>
                          <Icon name={c.cleared ? 'check' : 'lock'} size={13} />
                        </span>
                        <span className="cplist__where">
                          <span className="muted small">
                            {c.section_index + 1}.{c.step_index + 1} · {c.section_title}
                          </span>
                          <strong>{c.step_title}</strong>
                        </span>
                        <span className="muted small cplist__count">
                          {c.attempt_count} attempt{c.attempt_count === 1 ? '' : 's'}
                        </span>
                      </div>
                      <p className="muted small cplist__prompt">{c.prompt}</p>
                      {c.cleared && (
                        <p className="cplist__answer">
                          <span className="muted small">Accepted</span>{' '}
                          <code>{c.accepted_answer ?? '—'}</code>
                          {c.capture && (
                            <span className="tag">
                              <code>{c.capture}</code>
                            </span>
                          )}
                          {c.cleared_at && (
                            <span className="muted small"> · {formatDateTime(c.cleared_at)}</span>
                          )}
                        </p>
                      )}
                      {c.wrong_attempts.length > 0 && (
                        <ul className="cplist__wrong">
                          {c.wrong_attempts.map((a, i) => (
                            <li key={i}>
                              <code>{a.answer || '(empty)'}</code>
                              <span className="muted small"> {formatDateTime(a.at)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="drawer__section">
              <h3>Hints &amp; solutions</h3>
              {d.hints.length === 0 && d.solutions.length === 0 ? (
                <p className="muted small">No hints opened, no solutions revealed.</p>
              ) : (
                <ul className="plainlist">
                  {d.hints.map((h) => (
                    <li key={h.key}>
                      <Icon name="hint" size={13} />{' '}
                      <span className="muted small">
                        {h.section_index + 1}.{h.step_index + 1}
                      </span>{' '}
                      {h.step_title} — <em>{h.label}</em>
                    </li>
                  ))}
                  {d.solutions.map((x) => (
                    <li key={`s-${x.key}`} className="text-warn">
                      <Icon name="key" size={13} />{' '}
                      <span className="muted small">
                        {x.section_index + 1}.{x.step_index + 1}
                      </span>{' '}
                      {x.step_title} — solution revealed
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {Object.keys(d.captured).length > 0 && (
              <section className="drawer__section">
                <h3>Captured values</h3>
                <div className="preview__vars">
                  {Object.entries(d.captured).map(([k, v]) => (
                    <span className="tag" key={k}>
                      <code>{k}</code> = <code>{String(v)}</code>
                    </span>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

export default function SessionMonitor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { call } = useInstructorApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null); // participant id open in the drawer
  const remaining = useCountdown(data?.status === 'active' ? data?.expires_at : null, {
    hours: true,
  });

  const refresh = useCallback(async () => {
    try {
      setData(await call((t) => api.getSession(t, id)));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [call, id]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function act(fn, { confirmText, okMessage } = {}) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await call(fn);
      if (okMessage) setNotice(okMessage);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const terminate = () =>
    act((t) => api.terminateSession(t, id), {
      confirmText: 'End this session now? All participant access will be revoked immediately.',
    });

  const extend = () => act((t) => api.extendSession(t, id, 30));

  const pushTemplate = () =>
    act((t) => api.pushTemplate(t, id), {
      confirmText:
        `Push template v${data.latest_template_version} to this live session?\n\n` +
        'Participants will see the updated manual within a few seconds. Progress is kept, ' +
        'but if sections or checkpoints were added, removed or reordered, some participants ' +
        'may move forwards or backwards to match the new structure.',
      okMessage: `Session updated to template v${data.latest_template_version}.`,
    });

  async function remove() {
    if (!window.confirm('Delete this session and all its participant data? This cannot be undone.'))
      return;
    setBusy(true);
    try {
      await call((t) => api.deleteSession(t, id));
      navigate('/instructor');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function exportData(format) {
    try {
      const doc = await call((t) => api.exportSession(t, id));
      const base = slug(doc.session.title, 'session');
      if (format === 'csv') {
        downloadFile(`${base}-participants.csv`, participantsToCsv(doc), 'text/csv');
      } else if (format === 'attempts') {
        downloadFile(`${base}-attempts.csv`, attemptsToCsv(doc), 'text/csv');
      } else {
        downloadFile(`${base}.json`, JSON.stringify(doc, null, 2), 'application/json');
      }
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) {
    return (
      <PortalShell>
        {error ? <p className="form__error">{error}</p> : <p className="muted">Loading…</p>}
      </PortalShell>
    );
  }

  const active = data.status === 'active';
  const activeSeats = data.participants.filter((p) => p.seconds_since_seen < 90).length;
  const avgProgress = data.participants.length
    ? Math.round(
        data.participants.reduce((a, p) => a + p.progress_pct, 0) / data.participants.length,
      )
    : 0;

  return (
    <PortalShell>
      <button className="linkback" onClick={() => navigate('/instructor')}>
        <Icon name="chevronLeft" size={15} /> Sessions
      </button>

      <div className="monitor-head">
        <div>
          <h1>{data.title}</h1>
          <p className="muted">
            {data.template_exists ? (
              <Link to={`/instructor/templates/${data.template_id}`} className="inline-link">
                {data.template_title}
              </Link>
            ) : (
              data.template_title
            )}{' '}
            · v{data.template_version} · {data.section_count} sections
            {!data.template_exists && (
              <span
                className="tag tag--archived"
                title="The master template was deleted; this session runs on its own copy."
              >
                template deleted
              </span>
            )}
            {data.template_exists && data.template_archived && (
              <span className="tag tag--archived">template archived</span>
            )}
          </p>
        </div>
        <div className="monitor-head__code">
          <span className="editor-label">Room code — click to copy</span>
          <CopyCode code={data.room_code} />
          <span className={`pill pill--${data.status}`}>{data.status}</span>
        </div>
      </div>

      {active && data.update_available && (
        <div className="banner banner--info" role="status">
          <span>
            <strong>Template v{data.latest_template_version} is available.</strong> This session is
            running v{data.template_version}. Participants keep seeing the version they started with
            until you push the update.
          </span>
          <button className="btn btn--sm btn--primary" onClick={pushTemplate} disabled={busy}>
            <Icon name="refresh" size={15} /> Push latest version
          </button>
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <span className="stat__num">{data.participants.length}</span>
          <span className="stat__label">Registered</span>
        </div>
        <div className="stat">
          <span className="stat__num">{activeSeats}</span>
          <span className="stat__label">Active now</span>
        </div>
        <div className="stat">
          <span className="stat__num">{avgProgress}%</span>
          <span className="stat__label">Avg progress</span>
        </div>
        <div className="stat">
          <span className={`stat__num ${remaining === 'expired' ? 'text-warn' : ''}`}>
            {active ? remaining || '—' : '—'}
          </span>
          <span className="stat__label">Time remaining</span>
        </div>
        <div className="monitor-head__actions">
          {active && (
            <>
              <button className="btn btn--ghost btn--sm" onClick={extend} disabled={busy}>
                <Icon name="clock" size={15} /> +30 min
              </button>
              <button className="btn btn--danger btn--sm" onClick={terminate} disabled={busy}>
                <Icon name="power" size={15} /> End session
              </button>
            </>
          )}
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => exportData('csv')}
            disabled={busy}
            title="One row per participant: progress, time per section, every checkpoint's answer and wrong attempts, hints, solutions"
          >
            <Icon name="download" size={16} /> CSV
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => exportData('attempts')}
            disabled={busy}
            title="One row per checkpoint submission (correct and incorrect), in time order"
          >
            <Icon name="download" size={16} /> Attempts CSV
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => exportData('json')}
            disabled={busy}
          >
            <Icon name="download" size={16} /> JSON
          </button>
          {!active && (
            <button className="btn btn--danger-ghost btn--sm" onClick={remove} disabled={busy}>
              <Icon name="trash" size={16} /> Delete
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <div className="banner banner--success" role="status">
          {notice}
        </div>
      )}

      <SectionFlow data={data} />

      <div className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Participants</h2>
          <span className="muted small">
            {data.complete_count} of {data.participants.length} complete · click a row for answers,
            attempts, hints and timings
          </span>
        </div>
        {data.participants.length === 0 ? (
          <p className="muted">No participants have joined yet. Share code {data.room_code}.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table--clickable">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Participant</th>
                  <th>Section</th>
                  <th className="col--sm">Progress</th>
                  <th>Time on section</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.participants.map((p) => (
                  <tr
                    key={p.id}
                    tabIndex={0}
                    className={`${p.complete ? 'row--done' : stuckClass(p.seconds_on_current_section)} ${
                      selected === p.id ? 'row--selected' : ''
                    }`}
                    onClick={() => setSelected(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(p.id);
                      }
                    }}
                    aria-label={`Open details for ${p.name}`}
                  >
                    <td className="mono seat-num">{p.seat_number}</td>
                    <td className="table__primary">{p.name}</td>
                    <td>
                      {p.complete ? (
                        <span className="muted">Done</span>
                      ) : (
                        <>
                          <span className="section-cell__num">
                            {p.current_section + 1}
                            <span className="muted"> / {data.section_count}</span>
                          </span>
                          <span className="section-cell__title muted small">
                            {data.section_distribution[p.current_section]?.title}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="col--sm">
                      <div className="progress-cell">
                        <div
                          className="minibar"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={p.progress_pct}
                          title={`${p.completed_sections}/${data.section_count} sections`}
                        >
                          <div className="minibar__fill" style={{ width: `${p.progress_pct}%` }} />
                        </div>
                        <span className="muted small">{p.progress_pct}%</span>
                      </div>
                    </td>
                    <td
                      className={
                        !p.complete && p.seconds_on_current_section >= 15 * 60 ? 'text-warn' : ''
                      }
                    >
                      {p.complete ? '—' : fmtDuration(p.seconds_on_current_section)}
                    </td>
                    <td>
                      <StatusPill p={p} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small legend">
          <span className="dot dot--slow" /> 8+ min on a section ·{' '}
          <span className="dot dot--stuck" /> 15+ min (may need help) ·{' '}
          <span className="dot dot--live" /> complete
        </p>
      </div>

      {selected != null && (
        <ParticipantDrawer
          sessionId={id}
          participantId={selected}
          sectionCount={data.section_count}
          onClose={() => setSelected(null)}
        />
      )}
    </PortalShell>
  );
}
