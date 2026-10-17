import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { formatDateTime } from '../lib/datetime.js';
import { rowLink, stopRowClick } from '../lib/rowLink.js';
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

  function handleDuplicate(t) {
    run(
      (tok) => api.duplicateTemplate(tok, t.id),
      `Duplicated "${t.title}" as "${t.title} (copy)".`,
    );
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
            Labs and exams, written in vLabs Template Studio: opening one here edits it in the
            Studio. To work without the server, download the offline Studio and import its package
            here later. Shared by all instructors.
          </p>
        </div>
        <div className="page-head__actions">
          {archivedCount > 0 && (
            <button className="btn btn--ghost" onClick={() => setShowArchived((s) => !s)}>
              <Icon name="history" size={16} />{' '}
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </button>
          )}
          <a
            className="btn btn--ghost"
            href="/studio/vlabs_template_studio.html"
            download
            title="vLabs Template Studio as one file that works offline"
          >
            <Icon name="download" size={16} /> Offline Studio
          </a>
          <button
            className="btn btn--ghost"
            onClick={() => navigate('/instructor/templates/new-lab')}
          >
            <Icon name="plus" size={16} /> New lab
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => navigate('/instructor/templates/new-exam')}
          >
            <Icon name="plus" size={16} /> New exam
          </button>
          <button
            className="btn btn--primary"
            onClick={() => navigate('/instructor/templates/new')}
          >
            <Icon name="upload" size={16} /> Import
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
          <div className="table-wrap">
            <table className="table table--clickable">
              <thead>
                <tr>
                  <th>Title</th>
                  <th className="col--sm">Sections</th>
                  <th className="col--sm" title="Steps (labs) or questions (exams)">
                    Items
                  </th>
                  <th className="col--md">Version</th>
                  <th>Sessions</th>
                  <th className="col--lg">Updated</th>
                  <th className="col--lg">Last edited by</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => {
                  const archived = Boolean(t.archived_at);
                  return (
                    <tr
                      key={t.id}
                      className={archived ? 'row--archived' : ''}
                      {...rowLink(navigate, `/instructor/templates/${t.id}`)}
                      aria-label={`Open ${t.title}`}
                    >
                      <td>
                        <div className="table__primary">
                          <span className={`kind kind--${t.kind || 'lab'}`}>
                            {t.kind === 'exam' ? 'Exam' : 'Lab'}
                          </span>
                          {t.title}
                          {archived && <span className="tag tag--archived">Archived</span>}
                        </div>
                        {t.description && <div className="muted small">{t.description}</div>}
                      </td>
                      <td className="col--sm">{t.section_count}</td>
                      <td className="col--sm">
                        {t.kind === 'exam' ? (
                          <span title={`${t.total_points} points`}>{t.question_count} q</span>
                        ) : (
                          t.step_count
                        )}
                      </td>
                      <td className="col--md">v{t.version}</td>
                      <td className="muted">
                        {t.session_count}
                        {t.active_session_count > 0 && (
                          <span className="status-live"> · {t.active_session_count} live</span>
                        )}
                      </td>
                      <td className="muted col--lg">{formatDateTime(t.updated_at)}</td>
                      <td className="muted col--lg cell--nowrap">{t.updated_by || '—'}</td>
                      <td className="table__actions" {...stopRowClick}>
                        <button
                          className="btn btn--sm btn--icon btn--ghost"
                          onClick={() => handleDuplicate(t)}
                          title="Duplicate template"
                          aria-label={`Duplicate ${t.title}`}
                        >
                          <Icon name="copy" size={16} />
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
          </div>
        )}
      </div>
      <p className="muted small">
        Archiving hides a template without deleting it. Permanent deletion is available on archived
        templates; sessions already launched from a template always keep their own copy.
      </p>
    </PortalShell>
  );
}
