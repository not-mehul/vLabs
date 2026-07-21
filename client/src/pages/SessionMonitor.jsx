import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';

function fmtDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Highlight seats that appear stuck (long time on a step). */
function stuckClass(seconds) {
  if (seconds >= 15 * 60) return 'row--stuck';
  if (seconds >= 8 * 60) return 'row--slow';
  return '';
}

export default function SessionMonitor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { call } = useInstructorApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  async function terminate() {
    if (!window.confirm('End this session now? All participant access will be revoked immediately.')) return;
    setBusy(true);
    try {
      await call((t) => api.terminateSession(t, id));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function extend() {
    setBusy(true);
    try {
      await call((t) => api.extendSession(t, id, 30));
      await refresh();
    } finally {
      setBusy(false);
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

  return (
    <PortalShell>
      <button className="linkback" onClick={() => navigate('/instructor')}>
        ← Sessions
      </button>

      <div className="monitor-head">
        <div>
          <h1>{data.title}</h1>
          <p className="muted">
            {data.template_title} · {data.step_count} steps
          </p>
        </div>
        <div className="monitor-head__code">
          <span className="editor-label">Room code</span>
          <span className="roomcode roomcode--xl">{data.room_code}</span>
          <span className={`pill pill--${data.status}`}>{data.status}</span>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <span className="stat__num">{data.participants.length}</span>
          <span className="stat__label">Seats joined</span>
        </div>
        <div className="stat">
          <span className="stat__num">{activeSeats}</span>
          <span className="stat__label">Active now</span>
        </div>
        <div className="stat">
          <span className="stat__num">
            {data.participants.length
              ? Math.round(
                  data.participants.reduce((a, p) => a + p.progress_pct, 0) /
                    data.participants.length,
                )
              : 0}
            %
          </span>
          <span className="stat__label">Avg progress</span>
        </div>
        <div className="monitor-head__actions">
          {active && (
            <>
              <button className="btn btn--ghost btn--sm" onClick={extend} disabled={busy}>
                +30 min
              </button>
              <button className="btn btn--danger btn--sm" onClick={terminate} disabled={busy}>
                End session
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="form__error">{error}</p>}

      <div className="panel">
        <h2 className="panel__title">Step distribution</h2>
        <div className="dist">
          {data.step_distribution.map((s) => {
            const pct = data.participants.length
              ? (s.seats_here / data.participants.length) * 100
              : 0;
            return (
              <div className="dist__row" key={s.index}>
                <span className="dist__label">
                  <span className="dist__kind" aria-hidden="true">
                    {s.type === 'computer' ? '💻' : '🛠️'}
                  </span>
                  {s.index + 1}. {s.title}
                  {s.has_checkpoint && <span className="dist__lock" title="Checkpoint">🔒</span>}
                </span>
                <div className="dist__bar">
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
                <th>Seat</th>
                <th>Current step</th>
                <th>Progress</th>
                <th>Time on step</th>
                <th>Checkpoints</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.participants.map((p) => (
                <tr key={p.id} className={stuckClass(p.seconds_on_current_step)}>
                  <td className="mono">{p.seat_id}</td>
                  <td>
                    {p.current_step + 1}
                    <span className="muted"> / {data.step_count}</span>
                  </td>
                  <td>
                    <div className="minibar">
                      <div className="minibar__fill" style={{ width: `${p.progress_pct}%` }} />
                    </div>
                  </td>
                  <td className={p.seconds_on_current_step >= 15 * 60 ? 'text-warn' : ''}>
                    {fmtDuration(p.seconds_on_current_step)}
                  </td>
                  <td>{p.completed_checkpoints.length}</td>
                  <td className="muted">
                    {p.seconds_since_seen < 90
                      ? 'active'
                      : `${fmtDuration(p.seconds_since_seen)} ago`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small legend">
          <span className="dot dot--slow" /> 8+ min on a step ·{' '}
          <span className="dot dot--stuck" /> 15+ min (may need help)
        </p>
      </div>
    </PortalShell>
  );
}
