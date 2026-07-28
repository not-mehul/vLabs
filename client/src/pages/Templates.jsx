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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setTemplates(await call((t) => api.listTemplates(t)));
    } catch {
      /* 401 handled upstream */
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleDelete(id, title) {
    if (!window.confirm(`Delete template "${title}"? This cannot be undone.`)) return;
    setError('');
    try {
      await call((t) => api.deleteTemplate(t, id));
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <PortalShell>
      <div className="page-head page-head--row">
        <div>
          <h1>Templates</h1>
          <p className="muted">Master lab manuals with per-seat variables.</p>
        </div>
        <button
          className="btn btn--primary"
          onClick={() => navigate('/instructor/templates/new')}
        >
          <Icon name="plus" size={16} /> New template
        </button>
      </div>

      {error && <p className="form__error">{error}</p>}

      <div className="panel">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : templates.length === 0 ? (
          <p className="muted">No templates yet. Create your first one.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Sections</th>
                <th>Steps</th>
                <th>Version</th>
                <th>Updated</th>
                <th>Last edited by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div className="table__primary">{t.title}</div>
                    {t.description && <div className="muted small">{t.description}</div>}
                  </td>
                  <td>{t.section_count}</td>
                  <td>{t.step_count}</td>
                  <td>v{t.version}</td>
                  <td className="muted">{formatDateTime(t.updated_at)}</td>
                  <td className="muted">{t.updated_by || '—'}</td>
                  <td className="table__actions">
                    <button
                      className="btn btn--sm btn--icon btn--ghost"
                      onClick={() => navigate(`/instructor/templates/${t.id}`)}
                      title="Edit template"
                      aria-label="Edit template"
                    >
                      <Icon name="edit" size={16} />
                    </button>
                    <button
                      className="btn btn--sm btn--icon btn--danger-ghost"
                      onClick={() => handleDelete(t.id, t.title)}
                      title="Delete template"
                      aria-label="Delete template"
                    >
                      <Icon name="trash" size={16} />
                    </button>
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
