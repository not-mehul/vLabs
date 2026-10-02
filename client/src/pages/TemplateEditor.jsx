import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { formatDateTime } from '../lib/datetime.js';
import { slug } from '../lib/format.js';
import { downloadFile, readTextFile } from '../lib/files.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import StepCard from '../components/StepCard.jsx';
import Icon from '../components/Icon.jsx';
import {
  templateToJson,
  templateToMarkdown,
  parseJsonTemplate,
  parseMarkdownTemplate,
  SAMPLE_MARKDOWN,
} from '../lib/templateFormat.js';
import {
  normaliseTemplate,
  blankStep,
  blankSection,
  findUnknownPlaceholders,
  findMissingImages,
  maskExample,
  LIMITS,
} from '../../../shared/template-schema.js';

const NEW_TEMPLATE = () =>
  normaliseTemplate({
    title: '',
    description: '',
    variables: [
      { name: 'PORT_NUM', expression: 'seat' },
      { name: 'GATEWAY_IP', expression: "'192.168.1.' + (100 + seat)" },
    ],
    content: [blankSection(1)],
  });

/** Coerce a template from the API/import/history into the editor's shape. */
const coerce = (t) => normaliseTemplate(t);

/* --------------------------- Variable editor ---------------------------- */

function VariableEditor({ variables, onChange, functions }) {
  const update = (i, key, val) =>
    onChange(variables.map((v, idx) => (idx === i ? { ...v, [key]: val } : v)));
  return (
    <section className="editor-section">
      <div className="editor-section__head">
        <h3>Variables</h3>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => onChange([...variables, { name: '', expression: '' }])}
        >
          <Icon name="plus" size={15} /> Add variable
        </button>
      </div>
      <p className="muted small">
        Formulas run per participant. <code>seat</code> is their number, <code>first_name</code> and{' '}
        <code>last_name</code> are their registered names. Use arithmetic and string concatenation,
        e.g. <code>'192.168.1.' + (100 + seat)</code> or{' '}
        <code>slug(first_name) + '.' + slug(last_name)</code>. Reference these as{' '}
        <code>{'{{ NAME }}'}</code> in step bodies. <code>{'{{ SEAT_ID }}'}</code>,{' '}
        <code>{'{{ FIRST_NAME }}'}</code>, <code>{'{{ LAST_NAME }}'}</code> and{' '}
        <code>{'{{ FULL_NAME }}'}</code> are always available. Later formulas can reference earlier
        ones. Values entered at pattern checkpoints can also be saved as variables for the steps
        that follow (see the checkpoint settings).
      </p>
      {functions.length > 0 && (
        <p className="muted small">
          Helpers:{' '}
          {functions.map((f, i) => (
            <span key={f}>
              <code>{f}()</code>
              {i < functions.length - 1 ? ', ' : ''}
            </span>
          ))}
          . For example <code>'S' + pad(seat, 2)</code> → <code>S07</code>,{' '}
          <code>hex(seat + 15)</code> → <code>16</code>.
        </p>
      )}
      {variables.length === 0 && <p className="muted small">No variables defined.</p>}
      {variables.map((v, i) => (
        <div className="var-row" key={i}>
          <input
            className="field__input mono"
            placeholder="NAME"
            aria-label={`Variable ${i + 1} name`}
            value={v.name}
            onChange={(e) => update(i, 'name', e.target.value)}
          />
          <span className="var-row__eq">=</span>
          <input
            className="field__input mono"
            placeholder="expression"
            aria-label={`Variable ${i + 1} formula`}
            value={v.expression}
            onChange={(e) => update(i, 'expression', e.target.value)}
          />
          <button
            type="button"
            className="btn btn--sm btn--icon btn--danger-ghost"
            onClick={() => onChange(variables.filter((_, idx) => idx !== i))}
            aria-label="Remove variable"
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      ))}
    </section>
  );
}

/* ----------------------------- Hint editor ------------------------------ */

function HintEditor({ hints, onChange }) {
  const update = (i, key, val) =>
    onChange(hints.map((h, idx) => (idx === i ? { ...h, [key]: val } : h)));
  return (
    <div className="hint-editor">
      <div className="editor-section__head">
        <span className="editor-label">Hints (collapsible)</span>
        <button
          type="button"
          className="btn btn--xs btn--ghost"
          disabled={hints.length >= LIMITS.hintsPerStep}
          onClick={() => onChange([...hints, { label: '', text: '' }])}
        >
          <Icon name="plus" size={13} /> Hint
        </button>
      </div>
      {hints.map((h, i) => (
        <div className="hint-editor__row" key={i}>
          <input
            className="field__input"
            placeholder="Hint label (the clickable prompt)"
            aria-label={`Hint ${i + 1} label`}
            value={h.label}
            onChange={(e) => update(i, 'label', e.target.value)}
          />
          <textarea
            className="field__input hint-editor__text"
            placeholder="Hint text — Markdown supported (bullets, links…)"
            aria-label={`Hint ${i + 1} text`}
            rows={2}
            value={h.text}
            onChange={(e) => update(i, 'text', e.target.value)}
          />
          <button
            type="button"
            className="btn btn--xs btn--icon btn--danger-ghost"
            onClick={() => onChange(hints.filter((_, idx) => idx !== i))}
            aria-label="Remove hint"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------- Step editor ------------------------------ */

const STEP_TYPE_CHIPS = [
  { type: 'desk', icon: 'desk', label: 'Desk' },
  { type: 'computer', icon: 'computer', label: 'Computer' },
  { type: 'info', icon: 'info', label: 'Info' },
];

const EMPTY_CHECKPOINT = {
  prompt: '',
  placeholder: '',
  mode: 'exact',
  answer: '',
  answers: [],
  pattern: '',
  capture: '',
};

function StepEditor({ step, index, total, onChange, onMove, onRemove }) {
  const set = (patch) => onChange({ ...step, ...patch });
  const setCp = (patch) =>
    set({ checkpoint: { ...EMPTY_CHECKPOINT, ...step.checkpoint, ...patch } });
  const isInfo = step.type === 'info';
  const hasCheckpoint = Boolean(step.checkpoint) && !isInfo;
  const cp = { ...EMPTY_CHECKPOINT, ...(step.checkpoint || {}) };
  const isPattern = cp.mode === 'pattern';
  // Alternatives are edited as one-per-line text; kept as a string while
  // typing so a trailing newline doesn't get eaten by normalisation.
  const altText = (cp.answers || []).join('\n');
  const example = isPattern ? maskExample(cp.pattern) : '';
  // Switching to Info drops task-only fields; keep them in the object until
  // the author saves (normalisation strips them) so flipping back is painless.
  return (
    <div className="step-editor">
      <div className="step-editor__head">
        <span className="step-editor__num">Step {index + 1}</span>
        <div className="step-editor__type" role="group" aria-label="Step type">
          {STEP_TYPE_CHIPS.map((c) => (
            <button
              key={c.type}
              type="button"
              className={`chip ${step.type === c.type ? 'chip--active' : ''}`}
              aria-pressed={step.type === c.type}
              title={
                c.type === 'info'
                  ? 'Context only — no hints, solution or checkpoint'
                  : `${c.label} task`
              }
              onClick={() => set({ type: c.type })}
            >
              <Icon name={c.icon} size={15} /> {c.label}
            </button>
          ))}
        </div>
        <div className="step-editor__move">
          <button
            type="button"
            className="btn btn--xs btn--icon btn--ghost"
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
            aria-label="Move step up"
          >
            <Icon name="arrowUp" size={14} />
          </button>
          <button
            type="button"
            className="btn btn--xs btn--icon btn--ghost"
            disabled={index === total - 1}
            onClick={() => onMove(index, 1)}
            aria-label="Move step down"
          >
            <Icon name="arrowDown" size={14} />
          </button>
          <button
            type="button"
            className="btn btn--xs btn--danger-ghost"
            disabled={total === 1}
            onClick={() => onRemove(index)}
          >
            <Icon name="trash" size={13} /> Delete
          </button>
        </div>
      </div>

      <input
        className="field__input step-editor__title"
        placeholder="Step title"
        aria-label={`Step ${index + 1} title`}
        value={step.title}
        onChange={(e) => set({ title: e.target.value })}
      />
      <textarea
        className="field__input step-editor__body"
        placeholder={
          isInfo
            ? 'Context for the participant (Markdown supported). Use {{ VARIABLE }} placeholders.'
            : 'Step body (Markdown supported). Use {{ VARIABLE }} placeholders.'
        }
        aria-label={`Step ${index + 1} body`}
        rows={5}
        value={step.body}
        onChange={(e) => set({ body: e.target.value })}
      />

      {isInfo && (
        <p className="muted small">
          <Icon name="info" size={13} /> Informational step: shown as context to read. It has no
          hints, solution or checkpoint and never blocks progress.
        </p>
      )}

      {!isInfo && <HintEditor hints={step.hints} onChange={(hints) => set({ hints })} />}

      {!isInfo && (
        <label className="field solution-editor">
          <span className="field__label">
            <Icon name="key" size={14} /> Solution (Markdown — optional)
          </span>
          <textarea
            className="field__input step-editor__body"
            rows={4}
            placeholder="Optional walkthrough. Markdown supported — bullet points, links, etc. Revealed to a participant once they open every hint on this step."
            value={step.solution || ''}
            onChange={(e) => set({ solution: e.target.value })}
          />
        </label>
      )}

      {!isInfo && (
        <div className="checkpoint-editor">
          <label className="switch">
            <input
              type="checkbox"
              checked={hasCheckpoint}
              onChange={(e) =>
                set({ checkpoint: e.target.checked ? { ...EMPTY_CHECKPOINT } : null })
              }
            />
            <span>Add a checkpoint (gates the next section once cleared)</span>
          </label>
          {hasCheckpoint && (
            <div className="checkpoint-editor__fields">
              <label className="field">
                <span className="field__label">Prompt</span>
                <input
                  className="field__input"
                  placeholder="Prompt shown to participant"
                  value={cp.prompt}
                  onChange={(e) => setCp({ prompt: e.target.value })}
                />
              </label>

              <div className="step-editor__type" role="group" aria-label="Answer type">
                <button
                  type="button"
                  className={`chip ${!isPattern ? 'chip--active' : ''}`}
                  aria-pressed={!isPattern}
                  onClick={() => setCp({ mode: 'exact' })}
                >
                  <Icon name="check" size={14} /> Exact value
                </button>
                <button
                  type="button"
                  className={`chip ${isPattern ? 'chip--active' : ''}`}
                  aria-pressed={isPattern}
                  title="For values you can't know in advance, e.g. a serial number"
                  onClick={() => setCp({ mode: 'pattern' })}
                >
                  <Icon name="key" size={14} /> Matches a format
                </button>
              </div>

              {!isPattern ? (
                <>
                  <div className="field-row">
                    <label className="field">
                      <span className="field__label">Input placeholder</span>
                      <input
                        className="field__input"
                        placeholder="optional"
                        value={cp.placeholder}
                        onChange={(e) => setCp({ placeholder: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">Expected answer</span>
                      <input
                        className="field__input mono"
                        placeholder="may use {{ VARIABLES }}"
                        value={cp.answer}
                        onChange={(e) => setCp({ answer: e.target.value })}
                      />
                    </label>
                  </div>
                  <label className="field">
                    <span className="field__label">Also accept (one per line, optional)</span>
                    <textarea
                      className="field__input mono"
                      rows={2}
                      placeholder={'e.g. {{ HOST_IP }}/24'}
                      value={altText}
                      onChange={(e) => setCp({ answers: e.target.value.split('\n') })}
                      onBlur={(e) =>
                        setCp({
                          answers: e.target.value
                            .split('\n')
                            .map((a) => a.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                  <p className="muted small">
                    Answers are validated server-side (whitespace and case are forgiven) and never
                    sent to the browser.
                  </p>
                </>
              ) : (
                <>
                  <div className="field-row">
                    <label className="field">
                      <span className="field__label">Format (mask)</span>
                      <input
                        className="field__input mono"
                        placeholder="e.g. XXXX.XXXX.XXXX"
                        value={cp.pattern}
                        onChange={(e) => setCp({ pattern: e.target.value })}
                        aria-describedby={`mask-help-${index}`}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">Input placeholder</span>
                      <input
                        className="field__input"
                        placeholder={example ? `e.g. ${example}` : 'optional'}
                        value={cp.placeholder}
                        onChange={(e) => setCp({ placeholder: e.target.value })}
                      />
                    </label>
                  </div>
                  <p className="muted small" id={`mask-help-${index}`}>
                    <code>9</code> digit · <code>A</code>/<code>a</code> letter (stored upper/lower)
                    · <code>X</code>/<code>x</code> letter or digit · <code>?</code> any character ·{' '}
                    <code>*</code> anything · other letters/digits must match · punctuation and
                    spaces are optional separators that are restored in the stored value.
                    {cp.pattern ? (
                      example ? (
                        <>
                          {' '}
                          Accepts e.g. <code>{example}</code> (also without separators, any case).
                        </>
                      ) : (
                        <span className="text-warn"> This mask is not valid yet.</span>
                      )
                    ) : null}
                  </p>
                </>
              )}

              <label className="field">
                <span className="field__label">
                  Save the entered value as a variable for later steps (optional)
                </span>
                <input
                  className="field__input mono"
                  placeholder="e.g. SERIAL  →  then use {{ SERIAL }} in the following steps"
                  value={cp.capture}
                  onChange={(e) => setCp({ capture: e.target.value.trim() })}
                />
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------- Section editor ---------------------------- */

function SectionEditor({ section, index, total, onChange, onMove, onRemove }) {
  const setSteps = (steps) => onChange({ ...section, steps });
  const updateStep = (i, step) => setSteps(section.steps.map((s, idx) => (idx === i ? step : s)));
  const moveStep = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= section.steps.length) return;
    const next = [...section.steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };
  const removeStep = (i) =>
    setSteps(
      section.steps.length > 1 ? section.steps.filter((_, idx) => idx !== i) : section.steps,
    );

  return (
    <div className="section-editor">
      <div className="section-editor__head">
        <span className="section-editor__badge">Section {index + 1}</span>
        <input
          className="field__input section-editor__title"
          placeholder="Section title"
          aria-label={`Section ${index + 1} title`}
          value={section.title}
          onChange={(e) => onChange({ ...section, title: e.target.value })}
        />
        <div className="step-editor__move">
          <button
            type="button"
            className="btn btn--xs btn--icon btn--ghost"
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
            aria-label="Move section up"
          >
            <Icon name="arrowUp" size={14} />
          </button>
          <button
            type="button"
            className="btn btn--xs btn--icon btn--ghost"
            disabled={index === total - 1}
            onClick={() => onMove(index, 1)}
            aria-label="Move section down"
          >
            <Icon name="arrowDown" size={14} />
          </button>
          <button
            type="button"
            className="btn btn--xs btn--danger-ghost"
            disabled={total === 1}
            onClick={() => onRemove(index)}
          >
            <Icon name="trash" size={13} /> Delete section
          </button>
        </div>
      </div>

      {section.steps.map((step, i) => (
        <StepEditor
          key={i}
          step={step}
          index={i}
          total={section.steps.length}
          onChange={(s) => updateStep(i, s)}
          onMove={moveStep}
          onRemove={removeStep}
        />
      ))}

      <button
        type="button"
        className="btn btn--sm btn--ghost"
        disabled={section.steps.length >= LIMITS.stepsPerSection}
        onClick={() => setSteps([...section.steps, blankStep()])}
      >
        <Icon name="plus" size={15} /> Add step
      </button>
    </div>
  );
}

/* ------------------------------ Preview --------------------------------- */

function Preview({ id, draft }) {
  const { call } = useInstructorApi();
  const [seat, setSeat] = useState(7);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const previewId = id === 'new' ? 0 : id;
      const res = await call((t) => api.previewTemplate(t, previewId, Number(seat), draft));
      setResult(res);
    } catch (err) {
      setError(err.details ? err.details.join('\n') : err.message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [call, id, seat, draft]);

  return (
    <div className="preview">
      <div className="preview__controls">
        <label className="field field--narrow">
          <span className="field__label">Preview seat #</span>
          <input
            className="field__input"
            type="number"
            min="1"
            max="9999"
            value={seat}
            onChange={(e) => setSeat(e.target.value)}
          />
        </label>
        <button type="button" className="btn btn--sm btn--primary" onClick={run} disabled={busy}>
          <Icon name="eye" size={15} /> {busy ? 'Rendering…' : 'Render preview'}
        </button>
      </div>

      {error && <pre className="form__error preview__error">{error}</pre>}

      {result && (
        <>
          <div className="preview__context">
            <span className="editor-label">Resolved variables for seat #{result.seat_id}</span>
            <div className="preview__vars">
              {Object.entries(result.context).map(([k, v]) => (
                <span className="tag" key={k}>
                  <code>{k}</code> = <code>{String(v)}</code>
                </span>
              ))}
            </div>
          </div>
          {result.sections.map((sec) => (
            <div key={sec.index} className="preview__section">
              <div className="section-head section-head--compact">
                <span className="section-head__eyebrow">Section {sec.index + 1}</span>
                <h3 className="section-head__title">{sec.title}</h3>
              </div>
              {sec.steps.map((step) => (
                <StepCard
                  key={step.index}
                  step={{
                    ...step,
                    checkpoint: step.checkpoint
                      ? { ...step.checkpoint, completed: false }
                      : undefined,
                  }}
                  sectionIndex={sec.index}
                  total={sec.total_steps}
                  onCheckpoint={() => Promise.resolve(false)}
                />
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ----------------------------- Image library ---------------------------- */

const fmtBytes = (n) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`;

/**
 * Instance-wide image library. Markdown references an image by file name:
 * `![caption](rack.png)`. Uploads go straight to /api/images; an existing
 * name asks before being replaced. `missing` lists names the current draft
 * references that are not in the library yet (typically after a .md import).
 */
function ImageLibrary({ images, missing, onChange }) {
  const { call } = useInstructorApi();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState('');

  async function uploadFiles(files) {
    if (!files.length) return;
    setBusy(true);
    const notes = [];
    for (const file of files) {
      try {
        try {
          const r = await call((tok) => api.uploadImage(tok, file));
          notes.push(`Uploaded ${r.name}`);
        } catch (err) {
          if (err.code === 'IMAGE_EXISTS') {
            if (
              window.confirm(
                `"${err.existing?.name || file.name}" already exists. Replace it everywhere it is used?`,
              )
            ) {
              const r = await call((tok) => api.uploadImage(tok, file, { replace: true }));
              notes.push(`Replaced ${r.name}`);
            } else {
              notes.push(`Skipped ${file.name}`);
            }
          } else {
            throw err;
          }
        }
      } catch (err) {
        notes.push(`${file.name}: ${err.message}`);
      }
    }
    setMsg(notes.join(' · '));
    setBusy(false);
    onChange();
    setTimeout(() => setMsg(''), 6000);
  }

  async function remove(img) {
    try {
      const refs = await call((tok) => api.imageReferences(tok, img.id));
      const used = [
        ...refs.templates.map((t) => `template "${t.title}"`),
        ...refs.sessions.map((x) => `active session "${x.title}"`),
      ];
      if (used.length) {
        window.alert(
          `"${img.name}" is still used by ${used.join(', ')}. Remove the references first.`,
        );
        return;
      }
      if (!window.confirm(`Delete "${img.name}" from the library?`)) return;
      await call((tok) => api.deleteImage(tok, img.id));
      onChange();
    } catch (err) {
      setMsg(err.message);
    }
  }

  async function copySnippet(img) {
    const snippet = `![${img.name.replace(/\.[^.]+$/, '')}](${img.name})`;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(img.id);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      window.prompt('Copy this Markdown:', snippet);
    }
  }

  return (
    <section
      className="editor-section"
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        uploadFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
      }}
    >
      <div className="editor-section__head">
        <h3>
          <Icon name="image" size={16} /> Images
        </h3>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="upload" size={15} /> {busy ? 'Uploading…' : 'Upload images'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            uploadFiles([...e.target.files]);
            e.target.value = '';
          }}
        />
      </div>
      <p className="muted small">
        PNG, JPEG, GIF or WebP up to {fmtBytes(LIMITS.imageBytes)} each. Reference an image by its
        file name in any step body, hint or solution: <code>{'![caption](rack.png)'}</code>. The
        library is shared by every template on this instance; replacing a file updates it
        everywhere. Drag files anywhere onto this panel to upload.
      </p>
      {missing.length > 0 && (
        <div className="banner banner--warn" role="status">
          <span>
            <strong>
              {missing.length} referenced image{missing.length > 1 ? 's are' : ' is'} not in the
              library:
            </strong>{' '}
            {missing.map((m, i) => (
              <span key={m.name}>
                <code>{m.name}</code> <span className="muted">({m.where})</span>
                {i < missing.length - 1 ? ', ' : ''}
              </span>
            ))}
            . Upload files with exactly these names (folders are ignored) — saving is refused until
            every referenced image exists.
          </span>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="upload" size={15} /> Upload missing
          </button>
        </div>
      )}
      {msg && <p className="muted small io-bar__msg">{msg}</p>}
      {images.length === 0 ? (
        <p className="muted small">No images uploaded yet.</p>
      ) : (
        <ul className="imglib">
          {images.map((img) => (
            <li className="imglib__item" key={img.id}>
              <a href={img.url} target="_blank" rel="noreferrer" className="imglib__thumb">
                <img src={img.url} alt={img.name} loading="lazy" />
              </a>
              <div className="imglib__meta">
                <code className="imglib__name" title={img.name}>
                  {img.name}
                </code>
                <span className="muted small">
                  {fmtBytes(img.size)}
                  {img.width && img.height ? ` · ${img.width}×${img.height}` : ''}
                </span>
              </div>
              <div className="imglib__actions">
                <button
                  type="button"
                  className="btn btn--xs btn--ghost"
                  onClick={() => copySnippet(img)}
                  title="Copy Markdown snippet"
                >
                  <Icon name={copied === img.id ? 'check' : 'copy'} size={13} />{' '}
                  {copied === img.id ? 'Copied' : 'Markdown'}
                </button>
                <button
                  type="button"
                  className="btn btn--xs btn--icon btn--danger-ghost"
                  onClick={() => remove(img)}
                  aria-label={`Delete ${img.name}`}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------- Toolbar -------------------------------- */

function ImportExport({ tpl, onImport }) {
  const fileRef = useRef(null);
  const [msg, setMsg] = useState('');

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await readTextFile(file);
      const parsed = /\.json$/i.test(file.name)
        ? parseJsonTemplate(text)
        : parseMarkdownTemplate(text);
      onImport(parsed);
      setMsg(`Imported "${file.name}"`);
    } catch (err) {
      setMsg(`Import failed: ${err.message}`);
    }
    setTimeout(() => setMsg(''), 4000);
  }

  return (
    <div className="io-bar">
      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.json,text/markdown,application/json"
        hidden
        onChange={handleFile}
      />
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={() => fileRef.current?.click()}
      >
        <Icon name="upload" size={16} /> Import file
      </button>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={() =>
          downloadFile(`${slug(tpl.title, 'lab')}.md`, templateToMarkdown(tpl), 'text/markdown')
        }
      >
        <Icon name="download" size={16} /> Export .md
      </button>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={() =>
          downloadFile(`${slug(tpl.title, 'lab')}.json`, templateToJson(tpl), 'application/json')
        }
      >
        <Icon name="download" size={16} /> Export .json
      </button>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={() => downloadFile('sample-lab.md', SAMPLE_MARKDOWN, 'text/markdown')}
      >
        Download sample
      </button>
      {msg && (
        <span className="io-bar__msg" role="status">
          {msg}
        </span>
      )}
    </div>
  );
}

/* --------------------------- Change history ----------------------------- */

const stepsOf = (content) => (content || []).reduce((n, s) => n + (s.steps || []).length, 0);

/** Human-readable summary of what changed between two snapshots. */
function describeChanges(prev, curr) {
  if (!prev) return ['Initial version'];
  const changes = [];
  if (prev.title !== curr.title) changes.push(`Title changed to “${curr.title}”`);
  if (prev.description !== curr.description) changes.push('Description edited');
  if (JSON.stringify(prev.variables) !== JSON.stringify(curr.variables)) {
    changes.push(
      `Variables updated (${(prev.variables || []).length} → ${(curr.variables || []).length})`,
    );
  }
  const ps = prev.content || [];
  const cs = curr.content || [];
  if (ps.length !== cs.length) changes.push(`Sections ${ps.length} → ${cs.length}`);
  if (stepsOf(ps) !== stepsOf(cs)) changes.push(`Steps ${stepsOf(ps)} → ${stepsOf(cs)}`);
  const n = Math.min(ps.length, cs.length);
  for (let i = 0; i < n; i += 1) {
    if (ps[i].title !== cs[i].title) changes.push(`Section ${i + 1} renamed to “${cs[i].title}”`);
    else if (JSON.stringify(ps[i]) !== JSON.stringify(cs[i]))
      changes.push(`Section ${i + 1} edited`);
  }
  return changes.length ? changes : ['No content changes'];
}

const LIFECYCLE_LABEL = {
  archived: 'Template archived',
  restored: 'Template restored',
  deleted: 'Template deleted',
};

function ChangeHistory({ audit, onRevert }) {
  // Only content versions ("created"/"updated") participate in diffing.
  const versions = audit.filter(
    (a) => a.snapshot && (a.action === 'created' || a.action === 'updated'),
  );
  return (
    <ul className="audit__list">
      {audit.map((a) => {
        let changes;
        if (LIFECYCLE_LABEL[a.action]) {
          changes = [LIFECYCLE_LABEL[a.action]];
        } else {
          const idx = versions.indexOf(a);
          const prev = idx >= 0 ? versions[idx + 1]?.snapshot : null; // the older version
          changes = describeChanges(prev, a.snapshot || {});
        }
        return (
          <li className="audit__item" key={a.id}>
            <div className="audit__row">
              <span className={`audit__action audit__action--${a.action}`}>{a.action}</span>
              {a.version != null && <span className="audit__ver">v{a.version}</span>}
              <span className="audit__who">{a.instructor_username}</span>
              <span className="audit__when muted">{formatDateTime(a.at)}</span>
              {onRevert && a.snapshot && a.action !== 'deleted' && (
                <button
                  className="btn btn--xs btn--ghost audit__revert"
                  onClick={() => onRevert(a)}
                >
                  <Icon name="undo" size={13} /> Revert
                </button>
              )}
            </div>
            <ul className="audit__changes">
              {changes.map((c, ci) => (
                <li key={ci}>{c}</li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------- Editor --------------------------------- */

export default function TemplateEditor() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const { call } = useInstructorApi();

  const [tpl, setTpl] = useState(isNew ? NEW_TEMPLATE() : null);
  const [meta, setMeta] = useState({ archived_at: null, version: null });
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState([]);
  const [showPreview, setShowPreview] = useState(false);
  const [audit, setAudit] = useState([]);
  const [tab, setTab] = useState('content'); // content | settings
  const [revertNote, setRevertNote] = useState('');
  const [functions, setFunctions] = useState([]);
  const [images, setImages] = useState([]);

  const loadImages = useCallback(() => {
    call((tok) => api.listImages(tok))
      .then((r) => setImages(r.images || []))
      .catch(() => {});
  }, [call]);
  useEffect(() => {
    loadImages();
  }, [loadImages]);

  function handleRevert(entry) {
    setTpl(coerce(entry.snapshot));
    setRevertNote(`Loaded v${entry.version} — review and Save to apply as a new version.`);
    setTab('content');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const loadAudit = useCallback(() => {
    if (isNew) return;
    call((tok) => api.getTemplateAudit(tok, id))
      .then(setAudit)
      .catch(() => {});
  }, [call, id, isNew]);

  useEffect(() => {
    call((tok) => api.templateFunctions(tok))
      .then((r) => setFunctions(r.functions || []))
      .catch(() => {});
  }, [call]);

  useEffect(() => {
    if (isNew) return;
    (async () => {
      try {
        const t = await call((tok) => api.getTemplate(tok, id));
        setTpl(coerce(t));
        setMeta({ archived_at: t.archived_at, version: t.version });
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
    loadAudit();
  }, [id, isNew, call, loadAudit]);

  const patch = (p) => setTpl((prev) => ({ ...prev, ...p }));

  const updateSection = (i, section) =>
    patch({ content: tpl.content.map((s, idx) => (idx === i ? section : s)) });
  const moveSection = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= tpl.content.length) return;
    const next = [...tpl.content];
    [next[i], next[j]] = [next[j], next[i]];
    patch({ content: next });
  };
  const removeSection = (i) =>
    patch({
      content: tpl.content.length > 1 ? tpl.content.filter((_, idx) => idx !== i) : tpl.content,
    });

  // Live authoring check: the same rule the server enforces, surfaced while
  // typing so a typo like {{ HOST_IPP }} is caught before Save.
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

  async function handleSave() {
    setSaving(true);
    setError('');
    setErrorDetails([]);
    try {
      const payload = {
        title: tpl.title,
        description: tpl.description,
        variables: tpl.variables.filter((v) => v.name.trim()),
        content: tpl.content,
      };
      const saved = isNew
        ? await call((t) => api.createTemplate(t, payload))
        : await call((t) => api.updateTemplate(t, id, payload));
      navigate(`/instructor/templates/${saved.id}`, { replace: true });
      setTpl(coerce(saved));
      setMeta({ archived_at: saved.archived_at, version: saved.version });
      setRevertNote('');
      call((t) => api.getTemplateAudit(t, saved.id))
        .then(setAudit)
        .catch(() => {});
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

  if (loading)
    return (
      <PortalShell>
        <p className="muted">Loading template…</p>
      </PortalShell>
    );
  if (!tpl)
    return (
      <PortalShell>
        <p className="form__error">{error || 'Template not found.'}</p>
      </PortalShell>
    );

  return (
    <PortalShell>
      <div className="page-head page-head--row">
        <div>
          <button className="linkback" onClick={() => navigate('/instructor/templates')}>
            <Icon name="chevronLeft" size={15} /> Templates
          </button>
          <h1>
            {isNew ? 'New template' : 'Edit template'}
            {meta.version != null && <span className="muted small"> · v{meta.version}</span>}
          </h1>
        </div>
        <div className="page-head__actions">
          {tab === 'content' && (
            <button className="btn btn--ghost" onClick={() => setShowPreview((s) => !s)}>
              <Icon name="eye" size={16} /> {showPreview ? 'Hide preview' : 'Preview'}
            </button>
          )}
          <button className="btn btn--primary" onClick={handleSave} disabled={saving}>
            <Icon name="save" size={16} /> {saving ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </div>

      {meta.archived_at && (
        <div className="banner banner--warn" role="status">
          <span>
            <strong>This template is archived.</strong> It is hidden from the session launcher; you
            can still edit it.
          </span>
          <button className="btn btn--sm btn--ghost" onClick={handleRestore}>
            <Icon name="undo" size={14} /> Restore
          </button>
        </div>
      )}

      {!isNew && (
        <p className="muted small">
          Saving creates a new version. Sessions already running keep the version they were launched
          with until you push the update from the session monitor.
        </p>
      )}

      <div className="tabs" role="tablist" aria-label="Editor sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'content'}
          className={`tab ${tab === 'content' ? 'tab--active' : ''}`}
          onClick={() => setTab('content')}
        >
          <Icon name="layers" size={15} /> Content
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'settings'}
          className={`tab ${tab === 'settings' ? 'tab--active' : ''}`}
          onClick={() => setTab('settings')}
        >
          <Icon name="settings" size={15} /> Settings
        </button>
      </div>

      {revertNote && <div className="banner banner--success">{revertNote}</div>}
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
      {unknown.length > 0 && (
        <div className="banner banner--warn" role="status">
          <span>
            <strong>Unknown placeholder{unknown.length > 1 ? 's' : ''}:</strong>{' '}
            {unknown.slice(0, 6).map((u, i) => (
              <span key={`${u.name}-${u.where}`}>
                <code>{`{{ ${u.name} }}`}</code>{' '}
                <span className="muted">
                  ({u.where}
                  {u.early ? ' — used before the checkpoint that captures it' : ''})
                </span>
                {i < Math.min(unknown.length, 6) - 1 ? ', ' : ''}
              </span>
            ))}
            {unknown.length > 6 ? ` and ${unknown.length - 6} more` : ''}. Declare the variable in
            Settings, fix the spelling, or move the reference after the capturing checkpoint —
            saving will be refused otherwise.
          </span>
        </div>
      )}

      {missingImages.length > 0 && tab === 'content' && (
        <div className="banner banner--warn" role="status">
          <span>
            <strong>Missing image{missingImages.length > 1 ? 's' : ''}:</strong>{' '}
            {missingImages.slice(0, 6).map((m, i) => (
              <span key={m.name}>
                <code>{m.name}</code> <span className="muted">({m.where})</span>
                {i < Math.min(missingImages.length, 6) - 1 ? ', ' : ''}
              </span>
            ))}
            {missingImages.length > 6 ? ` and ${missingImages.length - 6} more` : ''}. Upload them
            in Settings → Images (same file names) — saving will be refused otherwise.
          </span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setTab('settings')}
          >
            <Icon name="image" size={15} /> Open Images
          </button>
        </div>
      )}

      {tab === 'content' ? (
        <div className={`editor-grid ${showPreview ? 'editor-grid--split' : ''}`}>
          <div className="editor-col">
            <section className="editor-section">
              <label className="field">
                <span className="field__label">Title</span>
                <input
                  className="field__input"
                  value={tpl.title}
                  onChange={(e) => patch({ title: e.target.value })}
                  placeholder="e.g. Network Bench Setup"
                  maxLength={LIMITS.title}
                />
              </label>
              <label className="field">
                <span className="field__label">Description</span>
                <input
                  className="field__input"
                  value={tpl.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  placeholder="Short summary shown in the template list"
                  maxLength={LIMITS.description}
                />
              </label>
            </section>

            <div className="editor-section__head">
              <h3>Sections</h3>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={tpl.content.length >= LIMITS.sections}
                onClick={() =>
                  patch({ content: [...tpl.content, blankSection(tpl.content.length + 1)] })
                }
              >
                <Icon name="plus" size={15} /> Add section
              </button>
            </div>
            {tpl.content.map((section, i) => (
              <SectionEditor
                key={i}
                section={section}
                index={i}
                total={tpl.content.length}
                onChange={(s) => updateSection(i, s)}
                onMove={moveSection}
                onRemove={removeSection}
              />
            ))}
          </div>

          {showPreview && (
            <div className="editor-col editor-col--preview">
              <h3>Live preview</h3>
              <Preview id={id} draft={tpl} />
            </div>
          )}
        </div>
      ) : (
        <div className="editor-col">
          <section className="editor-section">
            <div className="editor-section__head">
              <h3>Import &amp; export</h3>
            </div>
            <ImportExport
              tpl={tpl}
              onImport={(parsed) => {
                const next = coerce(parsed);
                setTpl(next);
                // Stay on Settings when the import references images that
                // still need uploading; otherwise go straight to the content.
                const needsImages =
                  findMissingImages(
                    next,
                    images.map((i) => i.name),
                  ).length > 0;
                setTab(needsImages ? 'settings' : 'content');
              }}
            />
          </section>

          <VariableEditor
            variables={tpl.variables}
            functions={functions}
            onChange={(variables) => patch({ variables })}
          />

          <ImageLibrary images={images} missing={missingImages} onChange={loadImages} />

          {!isNew && (
            <section className="editor-section">
              <div className="editor-section__head">
                <h3>
                  <Icon name="history" size={16} /> Change history
                </h3>
                <span className="muted small">Read-only audit log</span>
              </div>
              {audit.length ? (
                <ChangeHistory audit={audit} onRevert={handleRevert} />
              ) : (
                <p className="muted small">No history yet.</p>
              )}
            </section>
          )}
        </div>
      )}
    </PortalShell>
  );
}
