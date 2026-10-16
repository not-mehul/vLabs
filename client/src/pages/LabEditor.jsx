import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { slug } from '../lib/format.js';
import { downloadFile } from '../lib/files.js';
import { templateToJson, templateToMarkdown } from '../lib/templateFormat.js';
import { readStudioFile, uploadPackageImages } from '../lib/studioPackage.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import Icon from '../components/Icon.jsx';
import LabPreview from '../components/editor/LabPreview.jsx';
import ImageLibrary from '../components/editor/ImageLibrary.jsx';
import ChangeHistory from '../components/editor/ChangeHistory.jsx';
import MinutesField from '../components/editor/MinutesField.jsx';
import {
  normaliseTemplate,
  findUnknownPlaceholders,
  findMissingImages,
  LIMITS,
} from '../../../shared/template-schema.js';

const TYPE_LABEL = { desk: 'Hands-on', computer: 'Workstation', info: 'Read' };

/** Text input / textarea that grows with its content. */
function Text({ label, value, onChange, multiline, mono, max }) {
  const rows = multiline
    ? Math.min(18, Math.max(2, String(value || '').split('\n').length + 1))
    : 1;
  const props = {
    className: `field__input ${mono ? 'mono' : ''}`,
    value: value ?? '',
    maxLength: max,
    onChange: (e) => onChange(e.target.value),
    spellCheck: !mono,
  };
  return (
    <label className="field field--compact">
      <span className="field__label">{label}</span>
      {multiline ? <textarea rows={rows} {...props} /> : <input {...props} />}
    </label>
  );
}

/** Does any text in this step contain the search term? */
function stepMatches(step, term) {
  if (!term) return true;
  return JSON.stringify(step).toLowerCase().includes(term);
}

/**
 * Minimal lab editor. Labs are authored in vLabs Template Studio and imported
 * here (.zip package, .md or .json); this page only corrects TEXT — titles,
 * bodies, hints, solutions, checkpoint prompts/answers, formula expressions.
 * Structure (sections, steps, types, which checkpoints exist, variable names)
 * is read-only: restructure in the Studio and re-import.
 */
export default function LabEditor({ id, initial }) {
  const isNew = id === 'new';
  const navigate = useNavigate();
  const { call } = useInstructorApi();
  const fileRef = useRef(null);

  const [tpl, setTpl] = useState(initial ? normaliseTemplate(initial) : null);
  const [meta, setMeta] = useState({
    archived_at: initial?.archived_at ?? null,
    version: initial?.version ?? null,
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState([]);
  const [notice, setNotice] = useState('');
  const [images, setImages] = useState([]);
  const [audit, setAudit] = useState([]);
  const [showPreview, setShowPreview] = useState(false);
  const [find, setFind] = useState('');

  const loadImages = useCallback(() => {
    call((t) => api.listImages(t))
      .then((r) => setImages(r.images || []))
      .catch(() => {});
  }, [call]);
  const loadAudit = useCallback(() => {
    if (isNew) return;
    call((t) => api.getTemplateAudit(t, id))
      .then(setAudit)
      .catch(() => {});
  }, [call, id, isNew]);
  useEffect(() => {
    loadImages();
    loadAudit();
  }, [loadImages, loadAudit]);

  const update = (fn) => {
    setTpl((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  async function handleImport(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setErrorDetails([]);
    try {
      const { template, images: pkgImages, source } = await readStudioFile(file);
      if (!isNew && tpl && !window.confirm(`Replace this lab's content with "${file.name}"?`)) {
        return;
      }
      let notes = [];
      if (pkgImages.length) {
        notes = await uploadPackageImages(api, call, pkgImages, (names) =>
          window.confirm(
            `${names.length} image(s) already exist in the library (${names.join(', ')}).\n\nReplace them with the package's versions? This updates every lab that uses them.`,
          ),
        );
        loadImages();
      }
      setTpl(normaliseTemplate(template));
      setDirty(true);
      setNotice(
        `Imported ${file.name} (${source}).${notes.length ? ` Images: ${notes.join(', ')}.` : ''} Review, then Save.`,
      );
    } catch (err) {
      setError(`Import failed: ${err.message}`);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    setErrorDetails([]);
    try {
      const payload = {
        kind: 'lab',
        title: tpl.title,
        description: tpl.description,
        variables: tpl.variables,
        content: tpl.content,
        // Refused with VERSION_CONFLICT if a colleague saved in the meantime.
        expected_version: isNew ? undefined : meta.version,
      };
      const saved = isNew
        ? await call((t) => api.createTemplate(t, payload))
        : await call((t) => api.updateTemplate(t, id, payload));
      setTpl(normaliseTemplate(saved));
      setMeta({ archived_at: saved.archived_at, version: saved.version });
      setDirty(false);
      setNotice(`Saved as v${saved.version}.`);
      if (isNew) navigate(`/instructor/templates/${saved.id}`, { replace: true });
      else loadAudit();
    } catch (err) {
      setError(err.details ? 'Please fix the following before saving:' : err.message);
      setErrorDetails(err.details || []);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setSaving(false);
    }
  }

  async function handleRestore() {
    try {
      const t = await call((tok) => api.restoreTemplate(tok, id));
      setMeta({ archived_at: t.archived_at, version: t.version });
      loadAudit();
    } catch (err) {
      setError(err.message);
    }
  }

  const unknown = useMemo(() => (tpl ? findUnknownPlaceholders(tpl) : []), [tpl]);
  const missingImages = useMemo(
    () =>
      tpl
        ? findMissingImages(
            tpl,
            images.map((i) => i.name),
          )
        : [],
    [tpl, images],
  );
  const term = find.trim().toLowerCase();
  const matchCount = useMemo(
    () =>
      tpl && term
        ? tpl.content.reduce((n, s) => n + s.steps.filter((st) => stepMatches(st, term)).length, 0)
        : 0,
    [tpl, term],
  );

  const importInput = (
    <input
      ref={fileRef}
      type="file"
      accept=".zip,.md,.markdown,.json,application/zip,text/markdown,application/json"
      hidden
      onChange={handleImport}
    />
  );

  return (
    <PortalShell>
      {importInput}
      <div className="page-head page-head--row">
        <div>
          <button className="linkback" onClick={() => navigate('/instructor/templates')}>
            <Icon name="chevronLeft" size={15} /> Templates
          </button>
          <h1>
            {isNew ? 'Import a lab' : tpl?.title || 'Lab'}
            {meta.version != null && <span className="muted small"> · v{meta.version}</span>}
          </h1>
        </div>
        {tpl && (
          <div className="page-head__actions">
            <button className="btn btn--ghost" onClick={() => setShowPreview((s) => !s)}>
              <Icon name="eye" size={16} /> {showPreview ? 'Hide preview' : 'Preview'}
            </button>
            <button
              className="btn btn--primary"
              onClick={handleSave}
              disabled={saving || (!dirty && !isNew)}
            >
              <Icon name="save" size={16} /> {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      <div className="banner banner--info" role="note">
        <span>
          Labs are written in <strong>vLabs Template Studio</strong>. Import its <code>.zip</code>{' '}
          package (images included), <code>.md</code> or <code>.json</code> here. This page is for
          fixing small typos only — to add, remove or reorder sections, steps or checkpoints, export
          the lab, change it in the Studio and import it again.
        </span>
      </div>

      {meta.archived_at && (
        <div className="banner banner--warn" role="status">
          <span>
            <strong>This lab is archived.</strong> It is hidden from the session launcher.
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

      {!tpl ? (
        <button
          type="button"
          className="dropzone"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) handleImport({ target: { files: [f], value: '' } });
          }}
        >
          <span className="dropzone__icon">
            <Icon name="upload" size={20} />
          </span>
          <strong>Drop a Template Studio export here, or click to choose</strong>
          <span className="muted small">.zip package · .md · .json</span>
        </button>
      ) : (
        <>
          {unknown.length > 0 && (
            <div className="banner banner--warn" role="status">
              <span>
                <strong>Unknown placeholder{unknown.length > 1 ? 's' : ''}:</strong>{' '}
                {unknown
                  .slice(0, 6)
                  .map((u) => `{{ ${u.name} }} (${u.where})`)
                  .join(', ')}
                {unknown.length > 6 ? ` and ${unknown.length - 6} more` : ''}. Saving will be
                refused until fixed.
              </span>
            </div>
          )}
          {missingImages.length > 0 && (
            <div className="banner banner--warn" role="status">
              <span>
                <strong>Missing image{missingImages.length > 1 ? 's' : ''}:</strong>{' '}
                {missingImages.map((m) => m.name).join(', ')}. Upload them under Images below (same
                file names), or import the Studio <code>.zip</code> package.
              </span>
            </div>
          )}

          <div className="toolbar">
            <label className="toolbar__search">
              <Icon name="eye" size={14} />
              <input
                type="search"
                placeholder="Find text in steps…"
                value={find}
                onChange={(e) => setFind(e.target.value)}
                aria-label="Find text in steps"
              />
              {term && (
                <span className="muted small">
                  {matchCount} step{matchCount === 1 ? '' : 's'}
                </span>
              )}
            </label>
            <div className="toolbar__actions">
              <button className="btn btn--sm btn--ghost" onClick={() => fileRef.current?.click()}>
                <Icon name="upload" size={15} /> {isNew ? 'Choose another file' : 'Re-import'}
              </button>
              <button
                className="btn btn--sm btn--ghost"
                onClick={() =>
                  downloadFile(
                    `${slug(tpl.title, 'lab')}.md`,
                    templateToMarkdown(tpl),
                    'text/markdown',
                  )
                }
              >
                <Icon name="download" size={15} /> .md
              </button>
              <button
                className="btn btn--sm btn--ghost"
                onClick={() =>
                  downloadFile(
                    `${slug(tpl.title, 'lab')}.json`,
                    templateToJson(tpl),
                    'application/json',
                  )
                }
              >
                <Icon name="download" size={15} /> .json
              </button>
            </div>
          </div>

          <div className={`editor-grid ${showPreview ? 'editor-grid--split' : ''}`}>
            <div className="editor-col">
              {!term && (
                <section className="editor-section">
                  <Text
                    label="Title"
                    value={tpl.title}
                    max={LIMITS.title}
                    onChange={(v) => update((t) => (t.title = v))}
                  />
                  <Text
                    label="Description"
                    value={tpl.description}
                    max={LIMITS.description}
                    multiline
                    onChange={(v) => update((t) => (t.description = v))}
                  />
                </section>
              )}

              {tpl.content.map((sec, si) => {
                const steps = sec.steps
                  .map((st, sti) => ({ st, sti }))
                  .filter(({ st }) => stepMatches(st, term));
                if (term && !steps.length && !sec.title.toLowerCase().includes(term)) return null;
                return (
                  <details className="typo-section" key={si} open={Boolean(term) || si === 0}>
                    <summary className="typo-section__head">
                      <span className="dist__index">{si + 1}</span>
                      <span className="typo-section__title">{sec.title}</span>
                      <span className="muted small">
                        {sec.steps.length} step{sec.steps.length === 1 ? '' : 's'}
                      </span>
                    </summary>
                    <Text
                      label="Section title"
                      value={sec.title}
                      max={LIMITS.sectionTitle}
                      onChange={(v) => update((t) => (t.content[si].title = v))}
                    />
                    <MinutesField
                      value={sec.minutes}
                      onChange={(v) => update((t) => (t.content[si].minutes = v))}
                    />
                    {steps.map(({ st, sti }) => (
                      <div className="typo-step" key={sti}>
                        <div className="typo-step__head">
                          <span className={`card__kind card__kind--${st.type}`}>
                            {TYPE_LABEL[st.type]}
                          </span>
                          <span className="muted small">
                            Step {si + 1}.{sti + 1}
                          </span>
                        </div>
                        <Text
                          label="Title"
                          value={st.title}
                          max={LIMITS.stepTitle}
                          onChange={(v) => update((t) => (t.content[si].steps[sti].title = v))}
                        />
                        <Text
                          label="Body (Markdown)"
                          value={st.body}
                          multiline
                          max={LIMITS.body}
                          onChange={(v) => update((t) => (t.content[si].steps[sti].body = v))}
                        />
                        {st.hints.map((h, hi) => (
                          <div className="typo-pair" key={hi}>
                            <Text
                              label={`Hint ${hi + 1} label`}
                              value={h.label}
                              max={LIMITS.hintLabel}
                              onChange={(v) =>
                                update((t) => (t.content[si].steps[sti].hints[hi].label = v))
                              }
                            />
                            <Text
                              label={`Hint ${hi + 1} text`}
                              value={h.text}
                              multiline
                              max={LIMITS.hintText}
                              onChange={(v) =>
                                update((t) => (t.content[si].steps[sti].hints[hi].text = v))
                              }
                            />
                          </div>
                        ))}
                        {st.solution && (
                          <Text
                            label="Solution"
                            value={st.solution}
                            multiline
                            max={LIMITS.solution}
                            onChange={(v) => update((t) => (t.content[si].steps[sti].solution = v))}
                          />
                        )}
                        {st.checkpoint && (
                          <div className="typo-checkpoint">
                            <span className="editor-label">
                              <Icon name="lock" size={12} />{' '}
                              {st.checkpoint.mode === 'pattern' ? 'Pattern' : 'Exact'} checkpoint
                              {st.checkpoint.capture && (
                                <>
                                  {' '}
                                  · captures <code>{st.checkpoint.capture}</code>
                                </>
                              )}
                            </span>
                            <Text
                              label="Prompt"
                              value={st.checkpoint.prompt}
                              max={LIMITS.prompt}
                              onChange={(v) =>
                                update((t) => (t.content[si].steps[sti].checkpoint.prompt = v))
                              }
                            />
                            <Text
                              label="Input placeholder"
                              value={st.checkpoint.placeholder}
                              max={LIMITS.placeholder}
                              onChange={(v) =>
                                update((t) => (t.content[si].steps[sti].checkpoint.placeholder = v))
                              }
                            />
                            {st.checkpoint.mode === 'pattern' ? (
                              <Text
                                label="Pattern"
                                mono
                                value={st.checkpoint.pattern}
                                max={LIMITS.pattern}
                                onChange={(v) =>
                                  update((t) => (t.content[si].steps[sti].checkpoint.pattern = v))
                                }
                              />
                            ) : (
                              <>
                                <Text
                                  label="Answer"
                                  mono
                                  value={st.checkpoint.answer}
                                  max={LIMITS.answer}
                                  onChange={(v) =>
                                    update((t) => (t.content[si].steps[sti].checkpoint.answer = v))
                                  }
                                />
                                {st.checkpoint.answers.map((a, ai) => (
                                  <Text
                                    key={ai}
                                    label={`Also accepted ${ai + 1}`}
                                    mono
                                    value={a}
                                    max={LIMITS.answer}
                                    onChange={(v) =>
                                      update(
                                        (t) =>
                                          (t.content[si].steps[sti].checkpoint.answers[ai] = v),
                                      )
                                    }
                                  />
                                ))}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </details>
                );
              })}

              {!term && tpl.variables.length > 0 && (
                <details className="typo-section">
                  <summary className="typo-section__head">
                    <Icon name="settings" size={15} />
                    <span className="typo-section__title">Variables</span>
                    <span className="muted small">{tpl.variables.length} formulas</span>
                  </summary>
                  <p className="muted small">
                    Names are fixed; only the formula text can be corrected here.
                  </p>
                  {tpl.variables.map((v, vi) => (
                    <Text
                      key={vi}
                      label={v.name}
                      mono
                      value={v.expression}
                      onChange={(val) => update((t) => (t.variables[vi].expression = val))}
                    />
                  ))}
                </details>
              )}

              {!term && (
                <details className="typo-section" open={missingImages.length > 0}>
                  <summary className="typo-section__head">
                    <Icon name="image" size={15} />
                    <span className="typo-section__title">Images</span>
                    <span className="muted small">{images.length} in library</span>
                  </summary>
                  <ImageLibrary images={images} missing={missingImages} onChange={loadImages} />
                </details>
              )}

              {!term && !isNew && (
                <details className="typo-section">
                  <summary className="typo-section__head">
                    <Icon name="history" size={15} />
                    <span className="typo-section__title">Change history</span>
                    <span className="muted small">
                      {audit.length} {audit.length === 1 ? 'entry' : 'entries'}
                    </span>
                  </summary>
                  {audit.length ? (
                    <ChangeHistory
                      audit={audit}
                      onRevert={(entry) => {
                        setTpl(normaliseTemplate(entry.snapshot));
                        setDirty(true);
                        setNotice(`Loaded v${entry.version} — Save to apply it as a new version.`);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    />
                  ) : (
                    <p className="muted small">No history yet.</p>
                  )}
                </details>
              )}
            </div>

            {showPreview && (
              <div className="editor-col editor-col--preview">
                <h3>Live preview</h3>
                <LabPreview id={id} draft={tpl} />
              </div>
            )}
          </div>
        </>
      )}
    </PortalShell>
  );
}
