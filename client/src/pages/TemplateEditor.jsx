import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import { useTheme } from '../context/ThemeContext.jsx';
import PortalShell from '../components/PortalShell.jsx';
import Icon from '../components/Icon.jsx';
import ChangeHistory from '../components/editor/ChangeHistory.jsx';

/** The Studio page the app ships (built from client/studio, see build.mjs). */
const STUDIO_URL = `/studio/index.html?host=vlabs&v=${__APP_VERSION__}`;

const NEW_IDS = new Set(['new', 'new-lab', 'new-exam']);

/**
 * /instructor/templates/:id — labs and exams are edited in vLabs Template
 * Studio, framed here (the same Studio that is also published as a single
 * offline file). The Studio edits; this page loads and saves through the API,
 * keeps versions and the change history, and stores library images:
 *   new       → a blank lab with the Studio's Import dialog open
 *   new-lab   → a blank lab
 *   new-exam  → a blank exam
 *   <id>      → that template (its kind is fixed)
 * The protocol between the two is described in client/studio/src/host.js.
 */
export default function TemplateEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { call } = useInstructorApi();
  const { theme } = useTheme();
  const frameRef = useRef(null);

  const isNew = NEW_IDS.has(id);
  // After the first save of a new template the URL changes to its id; the
  // Studio already shows it, so that change must not reload it.
  const createdRef = useRef(null);

  const [record, setRecord] = useState(null); // the stored template (null while new)
  const [loadError, setLoadError] = useState('');
  const [studioReady, setStudioReady] = useState(false);
  const [current, setCurrent] = useState(null); // { kind, template } as the Studio has it
  const [baseline, setBaseline] = useState(''); // JSON of what was last loaded or saved
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState([]);
  const [notice, setNotice] = useState('');
  const [images, setImages] = useState([]);
  const [audit, setAudit] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  const post = useCallback((type, data = {}) => {
    frameRef.current?.contentWindow?.postMessage(
      { source: 'vlabs-app', type, ...data },
      window.location.origin,
    );
  }, []);

  /* ------------------------------- Loading ------------------------------- */

  useEffect(() => {
    if (isNew || createdRef.current === id) return undefined;
    let cancelled = false;
    setRecord(null);
    setLoadError('');
    call((t) => api.getTemplate(t, id))
      .then((t) => !cancelled && setRecord(t))
      .catch((err) => !cancelled && setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [call, id, isNew]);

  const loadImages = useCallback(
    () =>
      call((t) => api.listImages(t))
        .then((r) => {
          setImages(r.images || []);
          return r.images || [];
        })
        .catch(() => []),
    [call],
  );
  const loadAudit = useCallback(
    (tid) => {
      if (!tid || NEW_IDS.has(String(tid))) return;
      call((t) => api.getTemplateAudit(t, tid))
        .then(setAudit)
        .catch(() => {});
    },
    [call],
  );
  useEffect(() => {
    loadAudit(id);
  }, [id, loadAudit]);

  // Hand the template to the Studio once both are ready.
  const opened = useRef(null);
  useEffect(() => {
    if (!studioReady || (!isNew && !record)) return;
    const key = isNew ? id : `t${record.id}`;
    if (opened.current === key || createdRef.current === id) return;
    opened.current = key;
    loadImages().then((imgs) => {
      const kind = isNew ? (id === 'new-exam' ? 'exam' : 'lab') : record.kind;
      post('load', {
        kind,
        template: isNew ? null : record, // null: the Studio starts a new one
        images: imgs,
        kindLocked: isNew ? null : record.kind,
        reason: 'open',
      });
      if (id === 'new') post('open-import');
    });
  }, [studioReady, record, isNew, id, post, loadImages]);

  useEffect(() => {
    if (studioReady) post('theme', { dark: theme === 'dark' });
  }, [studioReady, theme, post]);

  /* ------------------------------- Saving -------------------------------- */

  const dirty = Boolean(current) && JSON.stringify(current) !== baseline;
  const canSave = Boolean(current) && (dirty || isNew) && !saving;

  const saveRef = useRef(null);
  saveRef.current = async (snap) => {
    if (!snap || saving) return;
    setSaving(true);
    setError('');
    setErrorDetails([]);
    setNotice('');
    try {
      const payload = {
        ...snap.template,
        kind: snap.kind,
        // Refused with VERSION_CONFLICT if a colleague saved in the meantime.
        expected_version: isNew ? undefined : record?.version,
      };
      const saved = isNew
        ? await call((t) => api.createTemplate(t, payload))
        : await call((t) => api.updateTemplate(t, record.id, payload));
      setRecord(saved);
      setBaseline(JSON.stringify(snap));
      setCurrent(snap);
      post('saved', { version: saved.version });
      if (isNew) {
        createdRef.current = String(saved.id);
        opened.current = `t${saved.id}`;
        navigate(`/instructor/templates/${saved.id}`, { replace: true });
      }
      loadAudit(saved.id);
    } catch (err) {
      setError(err.details ? 'vLabs did not save it. Please fix the following:' : err.message);
      setErrorDetails(err.details || []);
    } finally {
      setSaving(false);
    }
  };

  /* --------------------------- Image library ----------------------------- */

  const uploadImages = useCallback(
    async (files) => {
      const notes = [];
      const clashes = [];
      for (const file of files) {
        try {
          const r = await call((t) => api.uploadImage(t, file));
          notes.push(`uploaded ${r.name}`);
        } catch (err) {
          if (err.code === 'IMAGE_EXISTS') clashes.push({ file, existing: err.existing });
          else notes.push(`${file.name}: ${err.message}`);
        }
      }
      // The library is shared: say which other templates a replacement changes.
      const others = new Map();
      for (const c of clashes) {
        for (const t of c.existing?.templates || []) {
          if (t.id !== record?.id) others.set(t.id, t.title);
        }
      }
      const affects = others.size
        ? `\n\nThis also changes ${others.size === 1 ? 'another template' : `${others.size} other templates`} that use${others.size === 1 ? 's' : ''} ${clashes.length === 1 ? 'it' : 'them'}:\n${[
            ...others.values(),
          ]
            .slice(0, 8)
            .map((t) => `• ${t}`)
            .join(
              '\n',
            )}${others.size > 8 ? `\n… and ${others.size - 8} more` : ''}\n\nTo keep theirs, cancel and rename your file first.`
        : '';
      if (
        clashes.length &&
        window.confirm(
          `${clashes.length} image(s) already exist in the library (${clashes.map((c) => c.file.name).join(', ')}).\n\nReplace them?${affects}`,
        )
      ) {
        for (const { file } of clashes) {
          try {
            await call((t) => api.uploadImage(t, file, { replace: true }));
            notes.push(`replaced ${file.name}`);
          } catch (err) {
            notes.push(`${file.name}: ${err.message}`);
          }
        }
      } else if (clashes.length) {
        notes.push(`kept existing ${clashes.map((c) => c.file.name).join(', ')}`);
      }
      const imgs = await loadImages();
      const failed = notes.some((n) => n.includes(': '));
      post('images', {
        images: imgs,
        note: `Images: ${notes.join(', ')}`,
        tone: failed ? 'error' : 'success',
      });
    },
    [call, loadImages, post, record],
  );

  const deleteImage = useCallback(
    async (name) => {
      const img = images.find((i) => i.name.toLowerCase() === String(name).toLowerCase());
      if (!img) return;
      try {
        const refs = await call((t) => api.imageReferences(t, img.id));
        const used = [
          ...refs.templates.map((t) => `${t.archived ? 'archived ' : ''}template "${t.title}"`),
          ...refs.sessions.map((x) => `active session "${x.title}"`),
        ];
        if (used.length) {
          window.alert(
            `"${img.name}" is still used by ${used.join(', ')}. Remove the references first.`,
          );
          return;
        }
        if (!window.confirm(`Delete "${img.name}" from the library? Every template shares it.`))
          return;
        await call((t) => api.deleteImage(t, img.id));
        post('images', { images: await loadImages(), note: `Deleted ${img.name}` });
      } catch (err) {
        post('images', { images, note: err.message, tone: 'error' });
      }
    },
    [call, images, loadImages, post],
  );

  /* ------------------------------ Messages ------------------------------- */

  const handlers = useRef({});
  handlers.current = {
    ready: () => setStudioReady(true),
    loaded: (msg) => {
      const snap = { kind: msg.kind, template: msg.template };
      setCurrent(snap);
      if (msg.reason === 'open') setBaseline(JSON.stringify(snap));
    },
    change: (msg) => setCurrent({ kind: msg.kind, template: msg.template }),
    save: (msg) => {
      const snap = { kind: msg.kind, template: msg.template };
      setCurrent(snap);
      saveRef.current(snap);
    },
    'upload-images': (msg) => uploadImages(msg.files || []),
    'delete-image': (msg) => deleteImage(msg.name),
  };
  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const msg = event.data;
      if (!msg || msg.source !== 'vlabs-studio') return;
      handlers.current[msg.type]?.(msg);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Unsaved work: ask before the tab closes.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function leave() {
    if (dirty && !window.confirm('Leave without saving your changes?')) return;
    navigate('/instructor/templates');
  }

  async function handleRestore() {
    try {
      const t = await call((tok) => api.restoreTemplate(tok, record.id));
      setRecord((r) => ({ ...r, archived_at: t.archived_at, version: t.version }));
      loadAudit(record.id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function revert(entry) {
    try {
      const { snapshot } = await call((t) => api.getTemplateVersion(t, record.id, entry.id));
      post('load', {
        kind: record.kind,
        template: snapshot,
        images,
        kindLocked: record.kind,
        reason: 'revert',
      });
      setShowHistory(false);
      setNotice(`Loaded v${entry.version} into the Studio. Save to apply it as a new version.`);
    } catch (err) {
      setError(err.message);
    }
  }

  const kind = current?.kind || record?.kind || (id === 'new-exam' ? 'exam' : 'lab');
  const title = current?.template?.title || record?.title || '';
  const heading = isNew
    ? id === 'new'
      ? 'Import a template'
      : `New ${kind === 'exam' ? 'exam' : 'lab'}`
    : title || (kind === 'exam' ? 'Exam' : 'Lab');
  const status = useMemo(() => {
    if (saving) return 'Saving…';
    if (!current) return 'Opening…';
    if (isNew) return 'Not saved yet';
    return dirty ? 'Unsaved changes' : 'All changes saved';
  }, [saving, current, isNew, dirty]);

  if (loadError) {
    return (
      <PortalShell>
        <p className="form__error">{loadError}</p>
      </PortalShell>
    );
  }

  return (
    <PortalShell fill>
      <div className="page-head page-head--row studio-head">
        <div>
          <button className="linkback" onClick={leave}>
            <Icon name="chevronLeft" size={15} /> Templates
          </button>
          <h1>
            <span className={`kind kind--${kind}`}>{kind === 'exam' ? 'Exam' : 'Lab'}</span>{' '}
            {heading}
            {record?.version != null && <span className="muted small"> · v{record.version}</span>}
          </h1>
        </div>
        <div className="page-head__actions">
          <span className={`muted small studio-head__status${dirty ? ' is-dirty' : ''}`}>
            {status}
          </span>
          {!isNew && (
            <button className="btn btn--ghost" onClick={() => setShowHistory(true)}>
              <Icon name="history" size={16} /> History
            </button>
          )}
          <button
            className="btn btn--primary"
            onClick={() => post('flush-save')}
            disabled={!canSave}
            title="Save to vLabs (Ctrl+S)"
          >
            <Icon name="save" size={16} /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {record?.archived_at && (
        <div className="banner banner--warn" role="status">
          <span>
            <strong>This template is archived.</strong> It is hidden from the session launcher.
          </span>
          <button className="btn btn--sm btn--ghost" onClick={handleRestore}>
            <Icon name="undo" size={14} /> Restore
          </button>
        </div>
      )}
      {notice && (
        <div className="banner banner--success" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="form__error" role="alert">
          {error}
          {errorDetails.length > 0 && (
            <ul className="error-list">
              {errorDetails.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <iframe
        ref={frameRef}
        className="studio-frame"
        src={STUDIO_URL}
        title="vLabs Template Studio"
      />

      {showHistory && (
        <div className="drawer-root">
          <div className="drawer__scrim" onClick={() => setShowHistory(false)} aria-hidden="true" />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label="Change history">
            <header className="drawer__head">
              <div className="drawer__title">
                <h2>Change history</h2>
                <span className="muted small">
                  {audit.length} {audit.length === 1 ? 'entry' : 'entries'}
                </span>
              </div>
              <button
                className="btn btn--sm btn--icon btn--ghost"
                onClick={() => setShowHistory(false)}
                aria-label="Close"
              >
                <Icon name="close" size={16} />
              </button>
            </header>
            <div className="drawer__body">
              {audit.length ? (
                <ChangeHistory audit={audit} onRevert={revert} />
              ) : (
                <p className="muted small">No history yet.</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </PortalShell>
  );
}
