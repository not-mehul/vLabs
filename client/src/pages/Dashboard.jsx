import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { formatDateTime } from '../lib/datetime.js';
import { rowLink, stopRowClick } from '../lib/rowLink.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import Icon from '../components/Icon.jsx';
import DurationField from '../components/editor/DurationField.jsx';

/** Default session length by template kind, in minutes (a lab day, an exam hour). */
const DEFAULT_MINUTES = { lab: 8 * 60, exam: 60 };
const MAX_MINUTES = 24 * 60;

function StatusPill({ status }) {
  return <span className={`pill pill--${status}`}>{status}</span>;
}

function CreateSession({ templates, sessions, onCreated }) {
  const { call } = useInstructorApi();
  const [templateId, setTemplateId] = useState('');
  // Exams: the lab session whose seat numbers (and so per-seat values) to reuse.
  const [seatSource, setSeatSource] = useState('');
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(DEFAULT_MINUTES.lab);
  // Until the instructor changes the length, it follows the template's kind.
  const [durationTouched, setDurationTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = templateId && !busy;
  const isExam = templates.find((t) => String(t.id) === templateId)?.kind === 'exam';
  const labSessions = sessions.filter((s) => s.kind !== 'exam');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!templateId) {
      setError('Choose a template.');
      return;
    }
    if (!(duration >= 5)) {
      setError('A session must run for at least 5 minutes.');
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
          seat_source_session_id: isExam && seatSource ? Number(seatSource) : null,
        }),
      );
      setTitle('');
      setSeatSource('');
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
          <Link to="/instructor/templates" className="inline-link">
            Go to templates <Icon name="chevronRight" size={13} />
          </Link>
        </p>
      ) : (
        <div className="create-session__row">
          <label className="field">
            <span className="field__label">Template</span>
            <select
              className="field__input"
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                const t = templates.find((x) => String(x.id) === e.target.value);
                if (t && !durationTouched) setDuration(DEFAULT_MINUTES[t.kind || 'lab']);
              }}
            >
              <option value="">Select…</option>
              {[
                ['lab', 'Labs'],
                ['exam', 'Exams'],
              ].map(([kind, label]) => {
                const group = templates.filter((t) => (t.kind || 'lab') === kind);
                return group.length ? (
                  <optgroup key={kind} label={label}>
                    {group.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title} · v{t.version}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Label (optional)</span>
            <input
              className="field__input"
              placeholder="e.g. Morning cohort"
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          {isExam && (
            <label className="field">
              <span className="field__label">Seats from</span>
              <select
                className="field__input"
                value={seatSource}
                onChange={(e) => setSeatSource(e.target.value)}
              >
                <option value="">Join order</option>
                {labSessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} · {s.room_code} · {formatDateTime(s.created_at)} ·{' '}
                    {s.participant_count} joined
                  </option>
                ))}
              </select>
            </label>
          )}
          <DurationField
            label="Runs for"
            value={duration}
            max={MAX_MINUTES}
            onChange={(v) => {
              setDuration(v);
              setDurationTouched(true);
            }}
          />
          <button className="btn btn--primary" disabled={!canSubmit}>
            <Icon name="play" size={15} /> {busy ? 'Launching…' : 'Launch'}
          </button>
        </div>
      )}
      <p className="muted small">
        Sessions run for 8 hours (labs) or 1 hour (exams) unless you change it; use +30 min on the
        monitor to extend. The session takes a copy of the template at launch; later edits only
        reach it when you push them from the monitor.
        {isExam &&
          ' Seats from a lab: anyone whose name matches someone in that lab gets their lab seat, and so the same values; use Change seat on the monitor for typos.'}
      </p>
      {error && (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export default function Dashboard() {
  const { call } = useInstructorApi();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [justCreated, setJustCreated] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        call((tok) => api.listSessions(tok)),
        // Archived templates are excluded so they can't be launched.
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
      setError('');
      try {
        await call((t) => api.deleteSession(t, s.id));
        refresh();
      } catch (err) {
        setError(err.message);
      }
    },
    [call, refresh],
  );

  return (
    <PortalShell>
      <div className="page-head">
        <h1>Sessions</h1>
        <p className="muted">Launch live labs and exams and monitor participants in real time.</p>
      </div>

      <CreateSession
        templates={templates}
        sessions={sessions}
        onCreated={(s) => {
          setJustCreated(s);
          refresh();
        }}
      />

      {justCreated && (
        <div className="banner banner--success" role="status">
          <div>
            <strong>Session live.</strong> Share this room code with participants:
          </div>
          <span className="roomcode">{justCreated.room_code}</span>
          <Link className="btn btn--sm btn--primary" to={`/instructor/sessions/${justCreated.id}`}>
            Open monitor <Icon name="chevronRight" size={15} />
          </Link>
        </div>
      )}

      {error && (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}

      <div className="panel">
        <h2 className="panel__title">All sessions</h2>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="muted">No sessions yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table--clickable">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Label</th>
                  <th className="col--md">Template</th>
                  <th className="col--sm">Seats</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.id}
                    {...rowLink(navigate, `/instructor/sessions/${s.id}`)}
                    aria-label={`Open monitor for ${s.title}`}
                  >
                    <td className="mono">{s.room_code}</td>
                    <td>
                      {s.title}
                      {s.kind === 'exam' && <span className="tag tag--exam">exam</span>}
                    </td>
                    <td className="muted col--md">
                      {s.template_title}
                      <span className="small"> · v{s.template_version}</span>
                      {s.status === 'active' && s.update_available && (
                        <span
                          className="tag tag--update"
                          title={`Template v${s.latest_template_version} is available to push`}
                        >
                          update
                        </span>
                      )}
                    </td>
                    <td className="col--sm">{s.participant_count}</td>
                    <td>
                      <StatusPill status={s.status} />
                    </td>
                    <td className="table__actions" {...stopRowClick}>
                      {s.status !== 'active' && (
                        <button
                          className="btn btn--sm btn--icon btn--danger-ghost"
                          onClick={() => handleDelete(s)}
                          title="Delete session"
                          aria-label={`Delete ${s.title}`}
                        >
                          <Icon name="trash" size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PortalShell>
  );
}
