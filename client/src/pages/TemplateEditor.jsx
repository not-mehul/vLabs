import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { formatDateTime } from '../lib/datetime.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import StepCard from '../components/StepCard.jsx';
import Icon from '../components/Icon.jsx';
import {
  templateToJson,
  templateToMarkdown,
  parseJsonTemplate,
  parseMarkdownTemplate,
  downloadFile,
  readTextFile,
  SAMPLE_MARKDOWN,
} from '../lib/templateFormat.js';

const BLANK_STEP = () => ({ type: 'desk', title: '', body: '', hints: [], checkpoint: null });
const BLANK_SECTION = (n = 1) => ({ title: `Section ${n}`, steps: [BLANK_STEP()] });

const NEW_TEMPLATE = () => ({
  title: '',
  description: '',
  variables: [
    { name: 'PORT_NUM', expression: 'seat' },
    { name: 'GATEWAY_IP', expression: "'192.168.1.' + (100 + seat)" },
  ],
  content: [BLANK_SECTION(1)],
});

const slug = (s) => (s || 'lab').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* --------------------------- Variable editor ---------------------------- */

function VariableEditor({ variables, onChange }) {
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
          + Add variable
        </button>
      </div>
      <p className="muted small">
        Formulas run per seat. <code>seat</code> is the participant's number. Use
        arithmetic and string concatenation, e.g.{' '}
        <code>'192.168.1.' + (100 + seat)</code>. Reference these as{' '}
        <code>{'{{ NAME }}'}</code> in step bodies. <code>{'{{ SEAT_ID }}'}</code>{' '}
        is always available.
      </p>
      {variables.length === 0 && <p className="muted small">No variables defined.</p>}
      {variables.map((v, i) => (
        <div className="var-row" key={i}>
          <input
            className="field__input mono"
            placeholder="NAME"
            value={v.name}
            onChange={(e) => update(i, 'name', e.target.value)}
          />
          <span className="var-row__eq">=</span>
          <input
            className="field__input mono"
            placeholder="expression"
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
          onClick={() => onChange([...hints, { label: '', text: '' }])}
        >
          + Hint
        </button>
      </div>
      {hints.map((h, i) => (
        <div className="hint-editor__row" key={i}>
          <input
            className="field__input"
            placeholder="Hint label (the clickable prompt)"
            value={h.label}
            onChange={(e) => update(i, 'label', e.target.value)}
          />
          <input
            className="field__input"
            placeholder="Hint text (revealed on click)"
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

function StepEditor({ step, index, total, onChange, onMove, onRemove }) {
  const set = (patch) => onChange({ ...step, ...patch });
  const hasCheckpoint = Boolean(step.checkpoint);
  return (
    <div className="step-editor">
      <div className="step-editor__head">
        <span className="step-editor__num">Step {index + 1}</span>
        <div className="step-editor__type">
          <button
            type="button"
            className={`chip ${step.type === 'desk' ? 'chip--active' : ''}`}
            onClick={() => set({ type: 'desk' })}
          >
            <Icon name="desk" size={15} /> Desk
          </button>
          <button
            type="button"
            className={`chip ${step.type === 'computer' ? 'chip--active' : ''}`}
            onClick={() => set({ type: 'computer' })}
          >
            <Icon name="computer" size={15} /> Computer
          </button>
        </div>
        <div className="step-editor__move">
          <button type="button" className="btn btn--xs btn--icon btn--ghost" disabled={index === 0} onClick={() => onMove(index, -1)} aria-label="Move step up"><Icon name="arrowUp" size={14} /></button>
          <button type="button" className="btn btn--xs btn--icon btn--ghost" disabled={index === total - 1} onClick={() => onMove(index, 1)} aria-label="Move step down"><Icon name="arrowDown" size={14} /></button>
          <button type="button" className="btn btn--xs btn--danger-ghost" onClick={() => onRemove(index)}><Icon name="trash" size={13} /> Delete</button>
        </div>
      </div>

      <input
        className="field__input step-editor__title"
        placeholder="Step title"
        value={step.title}
        onChange={(e) => set({ title: e.target.value })}
      />
      <textarea
        className="field__input step-editor__body"
        placeholder="Step body (Markdown supported). Use {{ VARIABLE }} placeholders."
        rows={5}
        value={step.body}
        onChange={(e) => set({ body: e.target.value })}
      />

      <HintEditor hints={step.hints} onChange={(hints) => set({ hints })} />

      <div className="checkpoint-editor">
        <label className="switch">
          <input
            type="checkbox"
            checked={hasCheckpoint}
            onChange={(e) =>
              set({ checkpoint: e.target.checked ? { prompt: '', placeholder: '', answer: '' } : null })
            }
          />
          <span>Add a checkpoint (gates the next section once cleared)</span>
        </label>
        {hasCheckpoint && (
          <div className="checkpoint-editor__fields">
            <input className="field__input" placeholder="Prompt shown to participant" value={step.checkpoint.prompt} onChange={(e) => set({ checkpoint: { ...step.checkpoint, prompt: e.target.value } })} />
            <input className="field__input" placeholder="Input placeholder (optional)" value={step.checkpoint.placeholder} onChange={(e) => set({ checkpoint: { ...step.checkpoint, placeholder: e.target.value } })} />
            <input className="field__input mono" placeholder="Expected answer (may use {{ VARIABLES }})" value={step.checkpoint.answer} onChange={(e) => set({ checkpoint: { ...step.checkpoint, answer: e.target.value } })} />
            <p className="muted small">The answer is validated server-side and never sent to participants.</p>
          </div>
        )}
      </div>
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
    setSteps(section.steps.length > 1 ? section.steps.filter((_, idx) => idx !== i) : section.steps);

  return (
    <div className="section-editor">
      <div className="section-editor__head">
        <span className="section-editor__badge">Section {index + 1}</span>
        <input
          className="field__input section-editor__title"
          placeholder="Section title"
          value={section.title}
          onChange={(e) => onChange({ ...section, title: e.target.value })}
        />
        <div className="step-editor__move">
          <button type="button" className="btn btn--xs btn--icon btn--ghost" disabled={index === 0} onClick={() => onMove(index, -1)} aria-label="Move section up"><Icon name="arrowUp" size={14} /></button>
          <button type="button" className="btn btn--xs btn--icon btn--ghost" disabled={index === total - 1} onClick={() => onMove(index, 1)} aria-label="Move section down"><Icon name="arrowDown" size={14} /></button>
          <button type="button" className="btn btn--xs btn--danger-ghost" disabled={total === 1} onClick={() => onRemove(index)}><Icon name="trash" size={13} /> Delete section</button>
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

      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSteps([...section.steps, BLANK_STEP()])}>
        + Add step to this section
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
      setError(err.message);
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
          <input className="field__input" type="number" min="1" value={seat} onChange={(e) => setSeat(e.target.value)} />
        </label>
        <button type="button" className="btn btn--sm btn--primary" onClick={run} disabled={busy}>
          {busy ? 'Rendering…' : 'Render preview'}
        </button>
      </div>

      {error && <p className="form__error">{error}</p>}

      {result && (
        <>
          <div className="preview__context">
            <span className="editor-label">Resolved variables for seat #{result.seat_id}</span>
            <div className="preview__vars">
              {Object.entries(result.context).map(([k, v]) => (
                <span className="tag" key={k}><code>{k}</code> = <code>{String(v)}</code></span>
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
                  step={{ ...step, checkpoint: step.checkpoint ? { ...step.checkpoint, completed: false } : undefined }}
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
      const parsed = /\.json$/i.test(file.name) ? parseJsonTemplate(text) : parseMarkdownTemplate(text);
      onImport(parsed);
      setMsg(`Imported "${file.name}"`);
    } catch (err) {
      setMsg(`Import failed: ${err.message}`);
    }
    setTimeout(() => setMsg(''), 4000);
  }

  return (
    <div className="io-bar">
      <input ref={fileRef} type="file" accept=".md,.markdown,.json,text/markdown,application/json" hidden onChange={handleFile} />
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => fileRef.current?.click()}><Icon name="upload" size={16} /> Import file</button>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => downloadFile(`${slug(tpl.title)}.md`, templateToMarkdown(tpl), 'text/markdown')}><Icon name="download" size={16} /> Export .md</button>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => downloadFile(`${slug(tpl.title)}.json`, templateToJson(tpl), 'application/json')}><Icon name="download" size={16} /> Export .json</button>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => downloadFile('sample-lab.md', SAMPLE_MARKDOWN, 'text/markdown')}>Download sample</button>
      {msg && <span className="io-bar__msg">{msg}</span>}
    </div>
  );
}

/* ------------------------------- Editor --------------------------------- */

export default function TemplateEditor() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const { call } = useInstructorApi();

  const [tpl, setTpl] = useState(isNew ? NEW_TEMPLATE() : null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [audit, setAudit] = useState([]);

  const loadAudit = useCallback(() => {
    if (isNew) return;
    call((tok) => api.getTemplateAudit(tok, id))
      .then(setAudit)
      .catch(() => {});
  }, [call, id, isNew]);

  useEffect(() => {
    if (isNew) return;
    (async () => {
      try {
        const t = await call((tok) => api.getTemplate(tok, id));
        setTpl(coerce(t));
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
    patch({ content: tpl.content.length > 1 ? tpl.content.filter((_, idx) => idx !== i) : tpl.content });

  async function handleSave() {
    setSaving(true);
    setError('');
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
      call((t) => api.getTemplateAudit(t, saved.id)).then(setAudit).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <PortalShell><p className="muted">Loading template…</p></PortalShell>;
  if (!tpl) return <PortalShell><p className="form__error">{error || 'Template not found.'}</p></PortalShell>;

  return (
    <PortalShell>
      <div className="page-head page-head--row">
        <div>
          <button className="linkback" onClick={() => navigate('/instructor/templates')}><Icon name="chevronLeft" size={15} /> Templates</button>
          <h1>{isNew ? 'New template' : 'Edit template'}</h1>
        </div>
        <div className="page-head__actions">
          <button className="btn btn--ghost" onClick={() => setShowPreview((s) => !s)}>{showPreview ? 'Hide preview' : 'Preview'}</button>
          <button className="btn btn--primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save template'}</button>
        </div>
      </div>

      <ImportExport tpl={tpl} onImport={(parsed) => setTpl(coerce(parsed))} />

      {error && <p className="form__error">{error}</p>}

      <div className={`editor-grid ${showPreview ? 'editor-grid--split' : ''}`}>
        <div className="editor-col">
          <section className="editor-section">
            <label className="field">
              <span className="field__label">Title</span>
              <input className="field__input" value={tpl.title} onChange={(e) => patch({ title: e.target.value })} placeholder="e.g. Network Bench Setup" />
            </label>
            <label className="field">
              <span className="field__label">Description</span>
              <input className="field__input" value={tpl.description} onChange={(e) => patch({ description: e.target.value })} placeholder="Short summary shown in the template list" />
            </label>
          </section>

          <VariableEditor variables={tpl.variables} onChange={(variables) => patch({ variables })} />

          <div className="editor-section__head">
            <h3>Sections</h3>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => patch({ content: [...tpl.content, BLANK_SECTION(tpl.content.length + 1)] })}>
              + Add section
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

      {!isNew && audit.length > 0 && (
        <section className="editor-section audit">
          <div className="editor-section__head">
            <h3>Change history</h3>
            <span className="muted small">Read-only audit log</span>
          </div>
          <ul className="audit__list">
            {audit.map((a) => (
              <li className="audit__item" key={a.id}>
                <span className={`audit__action audit__action--${a.action}`}>{a.action}</span>
                <span className="audit__who">{a.instructor_username}</span>
                {a.version != null && <span className="audit__ver muted">v{a.version}</span>}
                <span className="audit__when muted">{formatDateTime(a.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PortalShell>
  );
}

/** Coerce a template from the API/import into the editor's mutable shape. */
function coerce(t) {
  return {
    title: t.title || '',
    description: t.description || '',
    variables: t.variables || [],
    content: (t.content || []).map((s) => ({
      title: s.title || '',
      steps: (s.steps || []).map((st) => ({ hints: [], checkpoint: null, ...st })),
    })),
  };
}
