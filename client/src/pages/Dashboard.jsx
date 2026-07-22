import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { downloadFile } from '../lib/templateFormat.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import Icon from '../components/Icon.jsx';

const slug = (s) => (s || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function StatusPill({ status }) {
  return <span className={`pill pill--${status}`}>{status}</span>;
}

function CreateSession({ templates, onCreated }) {
  const { call } = useInstructorApi();
  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = templateId && !busy;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!templateId) {
      setError('Choose a template.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await call((t) =>
        api.createSession(t, {
          template_id: Number(templateId),
          title,
          duration_minutes: Number(duration),
        }),
      );
      setTitle('');
      onCreated(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel create-session" onSubmit={handleSubmit}>
      <h2 className="panel__title">Launch a session</h2>
      {templates.length === 0 ? (
        <p className="muted">
          Create a template first, then launch a session from it.{' '}
          <Link to="/instructor/templates">Go to templates →</Link>
        </p>
      ) : (
        <div className="create-session__row">
          <label className="field">
            <span className="field__label">Template</span>
            <select
              className="field__input"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">Select…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} · v{t.version}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Label (optional)</span>
            <input
              className="field__input"
              placeholder="e.g. Morning cohort"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field field--narrow">
            <span className="field__label">Minutes</span>
            <input
              className="field__input"
              type="number"
              min="5"
              max="1440"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </label>
          <button className="btn btn--primary" disabled={!canSubmit}>
            {busy ? 'Launching…' : 'Launch'}
          </button>
        </div>
      )}
      {error && <p className="form__error">{error}</p>}
    </form>
  );
}

export default function Dashboard() {
  const { call } = useInstructorApi();
  const [sessions, setSessions] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [justCreated, setJustCreated] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        call((tok) => api.listSessions(tok)),
        call((tok) => api.listTemplates(tok)),
      ]);
      setSessions(s);
      setTemplates(t);
    } catch {
      /* handled by useInstructorApi on 401 */
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleDelete = useCallback(
    async (s) => {
      if (!window.confirm(`Delete session "${s.title}" (${s.room_code}) and its data?`)) return;
      try {
        await call((t) => api.deleteSession(t, s.id));
        refresh();
      } catch {
        /* 401 handled upstream */
      }
    },
    [call, refresh],
  );

  const handleExport = useCallback(
    async (s) => {
      const doc = await call((t) => api.exportSession(t, s.id));
      downloadFile(`${slug(doc.session.title)}.json`, JSON.stringify(doc, null, 2), 'application/json');
    },
    [call],
  );

  return (
    <PortalShell>
      <div className="page-head">
        <h1>Sessions</h1>
        <p className="muted">Launch live labs and monitor participants in real time.</p>
      </div>

      <CreateSession
        templates={templates}
        onCreated={(s) => {
          setJustCreated(s);
          refresh();
        }}
      />

      {justCreated && (
        <div className="banner banner--success">
          <div>
            <strong>Session live.</strong> Share this room code with participants:
          </div>
          <span className="roomcode">{justCreated.room_code}</span>
          <Link className="btn btn--sm" to={`/instructor/sessions/${justCreated.id}`}>
            Open monitor →
          </Link>
        </div>
      )}

      <div className="panel">
        <h2 className="panel__title">All sessions</h2>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="muted">No sessions yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Label</th>
                <th>Template</th>
                <th>Seats</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.room_code}</td>
                  <td>{s.title}</td>
                  <td className="muted">{s.template_title}</td>
                  <td>{s.participant_count}</td>
                  <td>
                    <StatusPill status={s.status} />
                  </td>
                  <td className="table__actions">
                    <Link className="btn btn--sm btn--ghost" to={`/instructor/sessions/${s.id}`}>
                      Monitor
                    </Link>
                    <button
                      className="btn btn--sm btn--ghost"
                      onClick={() => handleExport(s)}
                      title="Export session data (JSON)"
                    >
                      <Icon name="download" size={14} />
                    </button>
                    {s.status !== 'active' && (
                      <button
                        className="btn btn--sm btn--danger-ghost"
                        onClick={() => handleDelete(s)}
                        title="Delete session"
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </PortalShell>
  );
}
