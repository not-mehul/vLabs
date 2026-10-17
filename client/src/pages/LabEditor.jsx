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
  blankStep,
  blankSection,
  LIMITS,
} from '../../../shared/template-schema.js';

const TYPE_LABEL = { desk: 'Hands-on', computer: 'Workstation', info: 'Read' };

const BLANK_LAB = () =>
  normaliseTemplate({ title: '', description: '', variables: [], content: [blankSection(1)] });

const BLANK_CHECKPOINT = () => ({
  prompt: '',
  placeholder: '',
  mode: 'exact',
  answer: '',
  answers: [],
  pattern: '',
  capture: '',
});

const move = (arr, i, d) => {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/** Move up / move down / remove buttons for a section or step. */
function Tools({ what, canUp, canDown, canRemove, onMove, onRemove }) {
  return (
    <span className="qedit__tools">
      <button
        type="button"
        className="btn btn--xs btn--icon btn--ghost"
        disabled={!canUp}
        onClick={() => onMove(-1)}
        aria-label={`Move ${what} up`}
      >
        <Icon name="arrowUp" size={13} />
      </button>
      <button
        type="button"
        className="btn btn--xs btn--icon btn--ghost"
        disabled={!canDown}
        onClick={() => onMove(1)}
        aria-label={`Move ${what} down`}
      >
        <Icon name="arrowDown" size={13} />
      </button>
      <button
        type="button"
        className="btn btn--xs btn--icon btn--danger-ghost"
        disabled={!canRemove}
        onClick={onRemove}
        aria-label={`Remove ${what}`}
      >
        <Icon name="trash" size={13} />
      </button>
    </span>
  );
}

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

/**
 * One step: type, text, hints, solution and checkpoint. `edit(fn)` mutates a
 * draft copy of the step (see LabEditor's `update`).
 */
function StepEditor({ st, label, canUp, canDown, canRemove, onMove, onRemove, edit }) {
  const cp = st.checkpoint;
  const setCp = (fn) => edit((s) => fn(s.checkpoint));
  return (
    <div className="typo-step">
      <div className="typo-step__head">
        <span className={`card__kind card__kind--${st.type}`}>
          <Icon name={st.type} size={13} />
        </span>
        <select
          className="field__input field__input--sm"
          value={st.type}
          onChange={(e) => edit((s) => (s.type = e.target.value))}
          aria-label={`${label} type`}
        >
          {Object.entries(TYPE_LABEL).map(([t, l]) => (
            <option key={t} value={t}>
              {l}
            </option>
          ))}
        </select>
        <span className="muted small">{label}</span>
        <Tools
          what="step"
          canUp={canUp}
          canDown={canDown}
          canRemove={canRemove}
          onMove={onMove}
          onRemove={onRemove}
        />
      </div>
      <Text
        label="Title"
        value={st.title}
        max={LIMITS.stepTitle}
        onChange={(v) => edit((s) => (s.title = v))}
      />
      <Text
        label="Body (Markdown)"
        value={st.body}
        multiline
        max={LIMITS.body}
        onChange={(v) => edit((s) => (s.body = v))}
      />
      {st.type === 'info' ? (
        <p className="muted small">Read steps have no hints, solution or checkpoint.</p>
      ) : (
        <>
          {st.hints.map((h, hi) => (
            <div className="typo-pair typo-pair--hint" key={hi}>
              <Text
                label={`Hint ${hi + 1} label`}
                value={h.label}
                max={LIMITS.hintLabel}
                onChange={(v) => edit((s) => (s.hints[hi].label = v))}
              />
              <Text
                label={`Hint ${hi + 1} text`}
                value={h.text}
                multiline
                max={LIMITS.hintText}
                onChange={(v) => edit((s) => (s.hints[hi].text = v))}
              />
              <button
                type="button"
                className="btn btn--xs btn--icon btn--danger-ghost"
                onClick={() => edit((s) => s.hints.splice(hi, 1))}
                aria-label={`Remove hint ${hi + 1}`}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
          <Text
            label="Solution (optional, Markdown)"
            value={st.solution}
            multiline
            max={LIMITS.solution}
            onChange={(v) => edit((s) => (s.solution = v))}
          />
          {cp ? (
            <div className="typo-checkpoint">
              <div className="typo-step__head">
                <span className="editor-label">
                  <Icon name="lock" size={12} /> Checkpoint
                </span>
                <select
                  className="field__input field__input--sm"
                  value={cp.mode}
                  onChange={(e) => setCp((c) => (c.mode = e.target.value))}
                  aria-label="Checkpoint type"
                >
                  <option value="exact">Exact answer</option>
                  <option value="pattern">Pattern (format only)</option>
                </select>
                <button
                  type="button"
                  className="btn btn--xs btn--ghost qedit__tools"
                  onClick={() => edit((s) => (s.checkpoint = null))}
                >
                  <Icon name="close" size={12} /> Remove checkpoint
                </button>
              </div>
              <Text
                label="Prompt"
                value={cp.prompt}
                max={LIMITS.prompt}
                onChange={(v) => setCp((c) => (c.prompt = v))}
              />
              <Text
                label="Input placeholder"
                value={cp.placeholder}
                max={LIMITS.placeholder}
                onChange={(v) => setCp((c) => (c.placeholder = v))}
              />
              {cp.mode === 'pattern' ? (
                <div className="typo-pair">
                  <Text
                    label="Pattern (e.g. XXXX.XXXX.XXXX)"
                    mono
                    value={cp.pattern}
                    max={LIMITS.pattern}
                    onChange={(v) => setCp((c) => (c.pattern = v))}
                  />
                  <Text
                    label="Save as variable (optional)"
                    mono
                    value={cp.capture}
                    max={LIMITS.captureName}
                    onChange={(v) => setCp((c) => (c.capture = v))}
                  />
                </div>
              ) : (
                <>
                  <Text
                    label="Answer"
                    mono
                    value={cp.answer}
                    max={LIMITS.answer}
                    onChange={(v) => setCp((c) => (c.answer = v))}
                  />
                  {cp.answers.map((a, ai) => (
                    <div className="typo-pair typo-pair--alt" key={ai}>
                      <Text
                        label={`Also accepted ${ai + 1}`}
                        mono
                        value={a}
                        max={LIMITS.answer}
                        onChange={(v) => setCp((c) => (c.answers[ai] = v))}
                      />
                      <button
                        type="button"
                        className="btn btn--xs btn--icon btn--danger-ghost"
                        onClick={() => setCp((c) => c.answers.splice(ai, 1))}
                        aria-label={`Remove accepted answer ${ai + 1}`}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          ) : null}
          <div className="qedit__add">
            <button
              type="button"
              className="btn btn--xs btn--ghost"
              disabled={st.hints.length >= LIMITS.hintsPerStep}
              onClick={() => edit((s) => s.hints.push({ label: '', text: '' }))}
            >
              <Icon name="plus" size={12} /> Hint
            </button>
            {!cp && (
              <button
                type="button"
                className="btn btn--xs btn--ghost"
                onClick={() => edit((s) => (s.checkpoint = BLANK_CHECKPOINT()))}
              >
                <Icon name="plus" size={12} /> Checkpoint
              </button>
            )}
            {cp?.mode === 'exact' && (
              <button
                type="button"
                className="btn btn--xs btn--ghost"
                disabled={cp.answers.length >= LIMITS.altAnswers}
                onClick={() => setCp((c) => c.answers.push(''))}
              >
                <Icon name="plus" size={12} /> Accepted answer
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Does any text in this step contain the search term? */
function stepMatches(step, term) {
  if (!term) return true;
  return JSON.stringify(step).toLowerCase().includes(term);
}

/**
 * Lab editor. Labs are normally authored in vLabs Template Studio and
 * imported here (.zip package, .md or .json): id "new" is that import page.
 * The editor can also build a lab from scratch (id "new-lab") and change any
 * lab's structure: sections, steps and their types, hints, solutions,
 * checkpoints and variables, as well as all of its text.
 */
export default function LabEditor({ id, initial }) {
  const isBlank = id === 'new-lab';
  const isNew = id === 'new' || isBlank;
  const navigate = useNavigate();
  const { call } = useInstructorApi();
  const fileRef = useRef(null);

  const [tpl, setTpl] = useState(
    initial ? normaliseTemplate(initial) : isBlank ? BLANK_LAB() : null,
  );
  const [meta, setMeta] = useState({
    archived_at: initial?.archived_at ?? null,
    version: initial?.version ?? null,
  });
  const [dirty, setDirty] = useState(isBlank);
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
      const { kind, template, images: pkgImages, source } = await readStudioFile(file);
      if (kind === 'exam' && !isNew) {
        setError(
          `"${file.name}" is an exam, not a lab. Import it from Templates → Import, or into an exam.`,
        );
        return;
      }
      if (
        (!isNew || (isBlank && tpl.title.trim())) &&
        tpl &&
        !window.confirm(`Replace this lab's content with "${file.name}"?`)
      ) {
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
      if (kind === 'exam') {
        // An exam from the Studio: continue in the exam editor with it loaded.
        navigate('/instructor/templates/new-exam', {
          state: {
            imported: template,
            notice: `Imported exam ${file.name} (${source}).${notes.length ? ` Images: ${notes.join(', ')}.` : ''} Review, then Save.`,
          },
        });
        return;
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
  // A checkpoint with nothing to check would be dropped silently on save.
  const emptyCheckpoints = useMemo(
    () =>
      tpl
        ? tpl.content.flatMap((sec, si) =>
            sec.steps
              .map((st, sti) => ({ st, at: `${si + 1}.${sti + 1}` }))
              .filter(
                ({ st }) =>
                  st.type !== 'info' &&
                  st.checkpoint &&
                  !String(
                    st.checkpoint.mode === 'pattern' ? st.checkpoint.pattern : st.checkpoint.answer,
                  ).trim(),
              )
              .map(({ at }) => at),
          )
        : [],
    [tpl],
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
            {isBlank ? 'New lab' : isNew ? 'Import from Template Studio' : tpl?.title || 'Lab'}
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
          Labs are best written in <strong>vLabs Template Studio</strong> and imported here (its{' '}
          <code>.zip</code> package includes the images; <code>.md</code> and <code>.json</code>{' '}
          work too). You can also build or change a lab on this page: sections, steps, hints,
          solutions, checkpoints and variables.
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
          <span className="muted small">Lab or exam · .zip package · .md · .json</span>
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
          {emptyCheckpoints.length > 0 && (
            <div className="banner banner--warn" role="status">
              <span>
                <strong>Checkpoint without an answer:</strong> step {emptyCheckpoints.join(', ')}.
                Give it an answer (or a pattern), or it is left out when you save.
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
                <Icon name="upload" size={15} />{' '}
                {isBlank ? 'Import' : isNew ? 'Choose another file' : 'Re-import'}
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
                const setSec = (fn) => update((t) => fn(t.content[si]));
                return (
                  <details className="typo-section" key={si} open={Boolean(term) || si === 0}>
                    <summary className="typo-section__head">
                      <span className="dist__index">{si + 1}</span>
                      <span className="typo-section__title">{sec.title || 'Untitled section'}</span>
                      <span className="muted small">
                        {sec.steps.length} step{sec.steps.length === 1 ? '' : 's'}
                      </span>
                    </summary>
                    <div className="typo-section__tools">
                      <Tools
                        what="section"
                        canUp={si > 0}
                        canDown={si < tpl.content.length - 1}
                        canRemove={tpl.content.length > 1}
                        onMove={(d) => update((t) => (t.content = move(t.content, si, d)))}
                        onRemove={() =>
                          window.confirm(`Remove section ${si + 1} and its steps?`) &&
                          update((t) => t.content.splice(si, 1))
                        }
                      />
                    </div>
                    <Text
                      label="Section title"
                      value={sec.title}
                      max={LIMITS.sectionTitle}
                      onChange={(v) => setSec((s) => (s.title = v))}
                    />
                    <MinutesField
                      value={sec.minutes}
                      onChange={(v) => setSec((s) => (s.minutes = v))}
                    />
                    {steps.map(({ st, sti }) => (
                      <StepEditor
                        key={sti}
                        st={st}
                        label={`Step ${si + 1}.${sti + 1}`}
                        canUp={sti > 0}
                        canDown={sti < sec.steps.length - 1}
                        canRemove={sec.steps.length > 1}
                        onMove={(d) => setSec((s) => (s.steps = move(s.steps, sti, d)))}
                        onRemove={() => setSec((s) => s.steps.splice(sti, 1))}
                        edit={(fn) => setSec((s) => fn(s.steps[sti]))}
                      />
                    ))}
                    {!term && (
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        disabled={sec.steps.length >= LIMITS.stepsPerSection}
                        onClick={() => setSec((s) => s.steps.push(blankStep()))}
                      >
                        <Icon name="plus" size={14} /> Add step
                      </button>
                    )}
                  </details>
                );
              })}

              {!term && (
                <button
                  type="button"
                  className="btn btn--ghost btn--block"
                  disabled={tpl.content.length >= LIMITS.sections}
                  onClick={() => update((t) => t.content.push(blankSection(t.content.length + 1)))}
                >
                  <Icon name="plus" size={15} /> Add section
                </button>
              )}

              {!term && (
                <details className="typo-section" open={isBlank && tpl.variables.length > 0}>
                  <summary className="typo-section__head">
                    <Icon name="settings" size={15} />
                    <span className="typo-section__title">Variables</span>
                    <span className="muted small">{tpl.variables.length} formulas</span>
                  </summary>
                  <p className="muted small">
                    Per-seat values used as <code>{'{{ NAME }}'}</code> in any text. See the
                    template guide for formulas.
                  </p>
                  {tpl.variables.map((v, vi) => (
                    <div className="typo-pair typo-pair--var" key={vi}>
                      <Text
                        label="Name"
                        mono
                        value={v.name}
                        onChange={(val) => update((t) => (t.variables[vi].name = val))}
                      />
                      <Text
                        label="Formula"
                        mono
                        value={v.expression}
                        onChange={(val) => update((t) => (t.variables[vi].expression = val))}
                      />
                      <button
                        type="button"
                        className="btn btn--xs btn--icon btn--danger-ghost"
                        onClick={() => update((t) => t.variables.splice(vi, 1))}
                        aria-label={`Remove variable ${v.name || vi + 1}`}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn--xs btn--ghost"
                    disabled={tpl.variables.length >= LIMITS.variables}
                    onClick={() => update((t) => t.variables.push({ name: '', expression: '' }))}
                  >
                    <Icon name="plus" size={13} /> Add variable
                  </button>
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
