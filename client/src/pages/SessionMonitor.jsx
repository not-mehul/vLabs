import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, copyToClipboard } from '../api.js';
import { downloadFile } from '../lib/files.js';
import { slug, fmtDuration, participantsToCsv } from '../lib/format.js';
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

export default function SessionMonitor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { call } = useInstructorApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const remaining = useCountdown(data?.status === 'active' ? data?.expires_at : null, { hours: true });

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
    if (!window.confirm('Delete this session and all its participant data? This cannot be undone.')) return;
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
        downloadFile(`${base}.csv`, participantsToCsv(doc.participants), 'text/csv');
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
              <span className="tag tag--archived" title="The master template was deleted; this session runs on its own copy.">
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
          <button className="btn btn--ghost btn--sm" onClick={() => exportData('csv')} disabled={busy}>
            <Icon name="download" size={16} /> CSV
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => exportData('json')} disabled={busy}>
            <Icon name="download" size={16} /> JSON
          </button>
          {!active && (
            <button className="btn btn--danger-ghost btn--sm" onClick={remove} disabled={busy}>
              <Icon name="trash" size={16} /> Delete
            </button>
          )}
        </div>
      </div>

      {error && <p className="form__error" role="alert">{error}</p>}
      {notice && <div className="banner banner--success" role="status">{notice}</div>}

      <div className="panel">
        <h2 className="panel__title">Section distribution</h2>
        <div className="dist">
          {data.section_distribution.map((s) => {
            const pct = data.participants.length
              ? (s.seats_here / data.participants.length) * 100
              : 0;
            return (
              <div className="dist__row" key={s.index}>
                <span className="dist__label">
                  <span className="dist__index">{s.index + 1}</span>
                  {s.title}
                  <span className="dist__meta">{s.step_count} steps</span>
                  {s.has_checkpoint && (
                    <span className="dist__lock" title="Has a checkpoint"><Icon name="lock" size={14} /></span>
                  )}
                </span>
                <div className="dist__bar" role="img" aria-label={`${s.seats_here} seats on section ${s.index + 1}`}>
                  <div className="dist__bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="dist__count">{s.seats_here}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <h2 className="panel__title">Participants</h2>
        {data.participants.length === 0 ? (
          <p className="muted">No participants have joined yet. Share code {data.room_code}.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Participant</th>
                <th>Section</th>
                <th>Progress</th>
                <th>Hints</th>
                <th>Time on section</th>
                <th>Total time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.participants.map((p) => (
                <tr key={p.id} className={p.finished ? 'row--done' : stuckClass(p.seconds_on_current_section)}>
                  <td className="mono seat-num">{p.seat_number}</td>
                  <td className="table__primary">{p.name}</td>
                  <td>
                    {p.current_section + 1}
                    <span className="muted"> / {data.section_count}</span>
                  </td>
                  <td>
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
                  </td>
                  <td className={p.solutions_revealed > 0 ? 'text-warn' : 'muted'}>
                    {p.hints_taken}
                    {p.solutions_revealed > 0 ? ` · ${p.solutions_revealed} sol` : ''}
                  </td>
                  <td className={p.seconds_on_current_section >= 15 * 60 && !p.finished ? 'text-warn' : ''}>
                    {p.finished ? '—' : fmtDuration(p.seconds_on_current_section)}
                  </td>
                  <td className="muted">{fmtDuration(p.total_seconds)}</td>
                  <td>
                    {p.finished ? (
                      <span className="pill pill--active"><Icon name="check" size={14} /> Finished</span>
                    ) : p.seconds_since_seen < 90 ? (
                      <span className="status-live"><span className="dot dot--live" /> active</span>
                    ) : (
                      <span className="muted">{fmtDuration(p.seconds_since_seen)} ago</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small legend">
          <span className="dot dot--slow" /> 8+ min on a section ·{' '}
          <span className="dot dot--stuck" /> 15+ min (may need help)
        </p>
      </div>
    </PortalShell>
  );
}
