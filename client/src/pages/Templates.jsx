import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { formatDateTime } from '../lib/datetime.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import Icon from '../components/Icon.jsx';

export default function Templates() {
  const { call } = useInstructorApi();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      setTemplates(await call((t) => api.listTemplates(t, { includeArchived: true })));
    } catch {
      /* 401 handled upstream */
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(action, okMessage) {
    setError('');
    setNotice('');
    try {
      await call(action);
      if (okMessage) setNotice(okMessage);
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  function handleArchive(t) {
    const live = t.active_session_count
      ? `\n\n${t.active_session_count} live session(s) keep running on their own copy of the content.`
      : '';
    if (
      !window.confirm(
        `Archive "${t.title}"?\n\nIt will be hidden from this list and from the session launcher. Nothing is deleted — you can restore it later.${live}`,
      )
    ) {
      return;
    }
    run((tok) => api.deleteTemplate(tok, t.id), `Archived "${t.title}".`);
  }

  function handleRestore(t) {
    run((tok) => api.restoreTemplate(tok, t.id), `Restored "${t.title}".`);
  }

  function handleDeleteForever(t) {
    const sessions = t.session_count
      ? `${t.session_count} past session(s) were launched from it; they keep their own copy of the content and their analytics, but will no longer link back to this template.`
      : 'No sessions were launched from it.';
    if (
      !window.confirm(
        `Permanently delete "${t.title}"?\n\nThis cannot be undone. ${sessions}\n\nThe change history is kept.`,
      )
    ) {
      return;
    }
    const typed = window.prompt(`Type DELETE to permanently remove "${t.title}":`);
    if (typed !== 'DELETE') return;
    run((tok) => api.deleteTemplate(tok, t.id, { permanent: true }), `Deleted "${t.title}".`);
  }

  const visible = templates.filter((t) => showArchived || !t.archived_at);
  const archivedCount = templates.filter((t) => t.archived_at).length;

  return (
    <PortalShell>
      <div className="page-head page-head--row">
        <div>
          <h1>Templates</h1>
          <p className="muted">
            Master lab manuals with per-seat variables. Shared by all instructors.
          </p>
        </div>
        <div className="page-head__actions">
          {archivedCount > 0 && (
            <button className="btn btn--ghost" onClick={() => setShowArchived((s) => !s)}>
              <Icon name="history" size={16} />{' '}
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </button>
          )}
          <button
            className="btn btn--primary"
            onClick={() => navigate('/instructor/templates/new')}
          >
            <Icon name="plus" size={16} /> New template
          </button>
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

      <div className="panel">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="muted">
            {templates.length === 0
              ? 'No templates yet. Create your first one.'
              : 'No active templates.'}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Sections</th>
                <th>Steps</th>
                <th>Version</th>
                <th>Sessions</th>
                <th>Updated</th>
                <th>Last edited by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const archived = Boolean(t.archived_at);
                return (
                  <tr key={t.id} className={archived ? 'row--archived' : ''}>
                    <td>
                      <div className="table__primary">
                        {t.title}
                        {archived && <span className="tag tag--archived">Archived</span>}
                      </div>
                      {t.description && <div className="muted small">{t.description}</div>}
                    </td>
                    <td>{t.section_count}</td>
                    <td>{t.step_count}</td>
                    <td>v{t.version}</td>
                    <td className="muted">
                      {t.session_count}
                      {t.active_session_count > 0 && (
                        <span className="status-live"> · {t.active_session_count} live</span>
                      )}
                    </td>
                    <td className="muted">{formatDateTime(t.updated_at)}</td>
                    <td className="muted">{t.updated_by || '—'}</td>
                    <td className="table__actions">
                      <button
                        className="btn btn--sm btn--icon btn--ghost"
                        onClick={() => navigate(`/instructor/templates/${t.id}`)}
                        title="Edit template"
                        aria-label={`Edit ${t.title}`}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                      {archived ? (
                        <>
                          <button
                            className="btn btn--sm btn--icon btn--ghost"
                            onClick={() => handleRestore(t)}
                            title="Restore template"
                            aria-label={`Restore ${t.title}`}
                          >
                            <Icon name="undo" size={16} />
                          </button>
                          <button
                            className="btn btn--sm btn--icon btn--danger-ghost"
                            onClick={() => handleDeleteForever(t)}
                            disabled={t.active_session_count > 0}
                            title={
                              t.active_session_count > 0
                                ? 'End its live sessions before deleting permanently'
                                : 'Delete permanently'
                            }
                            aria-label={`Delete ${t.title} permanently`}
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn btn--sm btn--icon btn--danger-ghost"
                          onClick={() => handleArchive(t)}
                          title="Archive template"
                          aria-label={`Archive ${t.title}`}
                        >
                          <Icon name="trash" size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted small">
        Archiving hides a template without deleting it. Permanent deletion is available on archived
        templates; sessions already launched from a template always keep their own copy.
      </p>
    </PortalShell>
  );
}
