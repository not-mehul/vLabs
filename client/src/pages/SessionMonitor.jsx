import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, copyToClipboard } from '../api.js';
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

/** Live countdown to a session's expiry. */
function useCountdown(expiresAt) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!expiresAt) return undefined;
    const tick = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (ms <= 0) return setLabel('expired');
      const total = Math.floor(ms / 1000);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return setLabel(h > 0 ? `${h}h ${m}m` : `${m}:${String(s).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return label;
}

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
      <span className="roomcode__copy">{copied ? '✓ Copied' : '⧉ Copy'}</span>
    </button>
  );
}

export default function SessionMonitor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { call } = useInstructorApi();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const remaining = useCountdown(data?.status === 'active' ? data?.expires_at : null);

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
  const avgProgress = data.participants.length
    ? Math.round(
        data.participants.reduce((a, p) => a + p.progress_pct, 0) / data.participants.length,
      )
    : 0;

  return (
    <PortalShell>
      <button className="linkback" onClick={() => navigate('/instructor')}>
        ← Sessions
      </button>

      <div className="monitor-head">
        <div>
          <h1>{data.title}</h1>
          <p className="muted">
            {data.template_title} · {data.section_count} sections
          </p>
        </div>
        <div className="monitor-head__code">
          <span className="editor-label">Room code — click to copy</span>
          <CopyCode code={data.room_code} />
          <span className={`pill pill--${data.status}`}>{data.status}</span>
        </div>
      </div>

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
                  {s.has_checkpoint && <span className="dist__lock" title="Has a checkpoint">🔒</span>}
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
                <th>#</th>
                <th>Participant</th>
                <th>Section</th>
                <th>Progress</th>
                <th>Time on section</th>
                <th>Total time</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.participants.map((p) => (
                <tr key={p.id} className={stuckClass(p.seconds_on_current_section)}>
                  <td className="mono seat-num">{p.seat_number}</td>
                  <td className="table__primary">{p.name}</td>
                  <td>
                    {p.current_section + 1}
                    <span className="muted"> / {data.section_count}</span>
                  </td>
                  <td>
                    <div className="minibar" title={`${p.completed_sections}/${data.section_count} sections`}>
                      <div className="minibar__fill" style={{ width: `${p.progress_pct}%` }} />
                    </div>
                  </td>
                  <td className={p.seconds_on_current_section >= 15 * 60 ? 'text-warn' : ''}>
                    {fmtDuration(p.seconds_on_current_section)}
                  </td>
                  <td className="muted">{fmtDuration(p.total_seconds)}</td>
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
          <span className="dot dot--slow" /> 8+ min on a section ·{' '}
          <span className="dot dot--stuck" /> 15+ min (may need help)
        </p>
      </div>
    </PortalShell>
  );
}
