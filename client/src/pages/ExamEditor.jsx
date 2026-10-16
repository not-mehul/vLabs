import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { slug } from '../lib/format.js';
import { downloadFile, readTextFile } from '../lib/files.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import Icon from '../components/Icon.jsx';
import ExamQuestion from '../components/ExamQuestion.jsx';
import ImageLibrary from '../components/editor/ImageLibrary.jsx';
import ChangeHistory from '../components/editor/ChangeHistory.jsx';
import {
  EXAM_LIMITS,
  QUESTION_TYPES,
  QUESTION_TYPE_NAMES,
  blankQuestion,
  normaliseExam,
  normaliseQuestion,
  examErrors,
  isManualQuestion,
} from '../../../shared/exam-schema.js';
import {
  parseExamMarkdown,
  examToMarkdown,
  SAMPLE_EXAM_MARKDOWN,
} from '../../../shared/exam-format.js';

const NEW_EXAM = () =>
  normaliseExam({
    title: '',
    description: '',
    content: [{ title: 'Section 1', questions: [blankQuestion('single')] }],
  });

const move = (arr, i, d) => {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/** Options with correct markers (radio for single choice, checkboxes for select-all). */
function OptionsEditor({ q, onChange }) {
  const multi = q.type === 'multiple';
  const isCorrect = (i) => (multi ? q.correct.includes(i) : q.correct === i);
  const setCorrect = (i) => {
    if (!multi) return onChange({ ...q, correct: i });
    const set = new Set(q.correct);
    if (set.has(i)) set.delete(i);
    else set.add(i);
    onChange({ ...q, correct: [...set].sort((a, b) => a - b) });
  };
  const remove = (i) => {
    const options = q.options.filter((_, k) => k !== i);
    const shift = (c) => (c > i ? c - 1 : c);
    const correct = multi
      ? q.correct.filter((c) => c !== i).map(shift)
      : q.correct === i
        ? null
        : shift(q.correct);
    onChange({ ...q, options, correct });
  };
  return (
    <div className="opts-editor">
      <span className="field__label">Options — mark the correct {multi ? 'ones' : 'one'}</span>
      {q.options.map((o, i) => (
        <div className={`opts-editor__row ${isCorrect(i) ? 'is-correct' : ''}`} key={i}>
          <label className="opts-editor__mark" title="Correct answer">
            <input
              type={multi ? 'checkbox' : 'radio'}
              checked={isCorrect(i)}
              onChange={() => setCorrect(i)}
              aria-label={`Option ${String.fromCharCode(65 + i)} is correct`}
            />
            {String.fromCharCode(65 + i)}
          </label>
          <input
            className="field__input"
            value={o}
            maxLength={EXAM_LIMITS.option}
            placeholder={`Option ${String.fromCharCode(65 + i)}`}
            onChange={(e) =>
              onChange({ ...q, options: q.options.map((x, k) => (k === i ? e.target.value : x)) })
            }
          />
          <button
            type="button"
            className="btn btn--xs btn--icon btn--danger-ghost"
            onClick={() => remove(i)}
            disabled={q.options.length <= 2}
            aria-label={`Remove option ${String.fromCharCode(65 + i)}`}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--xs btn--ghost"
        disabled={q.options.length >= EXAM_LIMITS.options}
        onClick={() => onChange({ ...q, options: [...q.options, ''] })}
      >
        <Icon name="plus" size={13} /> Add option
      </button>
    </div>
  );
}

function QuestionEditor({ q, number, onChange, onMove, onRemove, canUp, canDown }) {
  const changeType = (type) => {
    const fresh = blankQuestion(type);
    // Keep the prompt, points and (between choice types) the options.
    const keepOptions = QUESTION_TYPES[type].hasOptions && q.options.length >= 2;
    onChange(
      normaliseQuestion({
        ...fresh,
        prompt: q.prompt,
        points: q.points,
        ...(keepOptions ? { options: q.options } : {}),
      }),
    );
  };
  return (
    <div className="qedit">
      <div className="qedit__head">
        <span className="qedit__num">Q{number}</span>
        <select
          className="field__input field__input--sm"
          value={q.type}
          onChange={(e) => changeType(e.target.value)}
          aria-label="Question type"
        >
          {QUESTION_TYPE_NAMES.map((t) => (
            <option key={t} value={t}>
              {QUESTION_TYPES[t].label}
            </option>
          ))}
        </select>
        <label className="qedit__points">
          <input
            className="field__input field__input--sm"
            type="number"
            min="0"
            max={EXAM_LIMITS.maxPoints}
            step="0.5"
            value={q.points}
            onChange={(e) => onChange({ ...q, points: Number(e.target.value) })}
            aria-label="Points"
          />
          pts
        </label>
        {isManualQuestion(q) && (
          <span className="tag" title="Marked by hand in the session monitor">
            hand-marked
          </span>
        )}
        <span className="qedit__tools">
          <button
            type="button"
            className="btn btn--xs btn--icon btn--ghost"
            onClick={() => onMove(-1)}
            disabled={!canUp}
            aria-label="Move question up"
          >
            <Icon name="arrowUp" size={13} />
          </button>
          <button
            type="button"
            className="btn btn--xs btn--icon btn--ghost"
            onClick={() => onMove(1)}
            disabled={!canDown}
            aria-label="Move question down"
          >
            <Icon name="arrowDown" size={13} />
          </button>
          <button
            type="button"
            className="btn btn--xs btn--icon btn--danger-ghost"
            onClick={onRemove}
            aria-label="Remove question"
          >
            <Icon name="trash" size={13} />
          </button>
        </span>
      </div>
      <label className="field field--compact">
        <span className="field__label">Question (Markdown; images by library file name)</span>
        <textarea
          className="field__input"
          rows={Math.min(12, Math.max(2, q.prompt.split('\n').length + 1))}
          maxLength={EXAM_LIMITS.prompt}
          value={q.prompt}
          onChange={(e) => onChange({ ...q, prompt: e.target.value })}
        />
      </label>
      {QUESTION_TYPES[q.type].hasOptions && <OptionsEditor q={q} onChange={onChange} />}
      {q.type === 'truefalse' && (
        <div className="segmented" role="radiogroup" aria-label="Correct answer">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              className={`segmented__btn ${q.correct === v ? 'is-active' : ''}`}
              onClick={() => onChange({ ...q, correct: v })}
              aria-pressed={q.correct === v}
            >
              Correct answer: {v ? 'True' : 'False'}
            </button>
          ))}
        </div>
      )}
      {q.type === 'short' && (
        <label className="field field--compact">
          <span className="field__label">
            Accepted answers — one per line; case and spacing are ignored. Leave empty to mark by
            hand.
          </span>
          <textarea
            className="field__input mono"
            rows={Math.max(2, q.accepted.length + 1)}
            value={q.accepted.join('\n')}
            onChange={(e) =>
              onChange({
                ...q,
                accepted: e.target.value.split('\n').slice(0, EXAM_LIMITS.accepted),
              })
            }
          />
        </label>
      )}
      {q.type === 'long' && <p className="muted small">Long answers are always marked by hand.</p>}
    </div>
  );
}

/** Participant-view preview rendered by the server (library images resolved). */
function ExamPreview({ id, draft }) {
  const { call } = useInstructorApi();
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setRes(await call((t) => api.previewTemplate(t, id === 'new-exam' ? 0 : id, 1, draft)));
    } catch (err) {
      setError(err.details ? err.details.join('\n') : err.message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }, [call, id, draft]);
  let n = 0;
  return (
    <div className="preview">
      <button type="button" className="btn btn--sm btn--primary" onClick={run} disabled={busy}>
        <Icon name="eye" size={15} /> {busy ? 'Rendering…' : 'Render preview'}
      </button>
      {error && <pre className="form__error preview__error">{error}</pre>}
      {res?.sections?.map((sec) => (
        <div key={sec.index} className="preview__section">
          <div className="section-head section-head--compact">
            <span className="section-head__eyebrow">Section {sec.index + 1}</span>
            <h3 className="section-head__title">{sec.title}</h3>
          </div>
          {sec.questions.map((q) => {
            n += 1;
            return (
              <ExamQuestion
                key={q.index}
                q={{ ...q, key: `${sec.index}.${q.index}`, number: n }}
                value={undefined}
                disabled
                onChange={() => {}}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Exam authoring. Exams are a separate template kind (shared/exam-schema.js)
 * with their own Markdown format (shared/exam-format.js); the lab format is
 * not involved. Correct answers stay on the server — participants never see
 * them, and grading happens in the session monitor.
 */
export default function ExamEditor({ id, initial }) {
  const isNew = id === 'new-exam';
  const navigate = useNavigate();
  const { call } = useInstructorApi();
  const fileRef = useRef(null);
  const [tpl, setTpl] = useState(() => (initial ? normaliseExam(initial) : NEW_EXAM()));
  const [meta, setMeta] = useState({
    archived_at: initial?.archived_at ?? null,
    version: initial?.version ?? null,
  });
  const [dirty, setDirty] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState([]);
  const [notice, setNotice] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [images, setImages] = useState([]);
  const [audit, setAudit] = useState([]);

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

  const set = (next) => {
    setTpl(next);
    setDirty(true);
  };
  const setSection = (si, sec) =>
    set({ ...tpl, content: tpl.content.map((s, i) => (i === si ? sec : s)) });

  const problems = useMemo(() => examErrors(normaliseExam(tpl)), [tpl]);
  let counter = 0;

  async function handleImport(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await readTextFile(file);
      const parsed = /\.json$/i.test(file.name)
        ? normaliseExam(JSON.parse(text))
        : parseExamMarkdown(text);
      if (!window.confirm(`Replace this exam's content with "${file.name}"?`)) return;
      set(parsed);
      setNotice(`Imported ${file.name}. Review, then Save.`);
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
        ...normaliseExam(tpl),
        kind: 'exam',
        // Refused with VERSION_CONFLICT if a colleague saved in the meantime.
        expected_version: isNew ? undefined : meta.version,
      };
      const saved = isNew
        ? await call((t) => api.createTemplate(t, payload))
        : await call((t) => api.updateTemplate(t, id, payload));
      setTpl(normaliseExam(saved));
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
    } catch (err) {
      setError(err.message);
    }
  }

  const totalQ = tpl.content.reduce((n, s) => n + s.questions.length, 0);
  const totalPts = tpl.content.reduce(
    (n, s) => n + s.questions.reduce((m, q) => m + (Number(q.points) || 0), 0),
    0,
  );

  return (
    <PortalShell>
      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.json,text/markdown,application/json"
        hidden
        onChange={handleImport}
      />
      <div className="page-head page-head--row">
        <div>
          <button className="linkback" onClick={() => navigate('/instructor/templates')}>
            <Icon name="chevronLeft" size={15} /> Templates
          </button>
          <h1>
            {isNew ? 'New exam' : tpl.title || 'Exam'}
            {meta.version != null && <span className="muted small"> · v{meta.version}</span>}
          </h1>
          <p className="muted small">
            {totalQ} question{totalQ === 1 ? '' : 's'} · {totalPts} point
            {totalPts === 1 ? '' : 's'}
          </p>
        </div>
        <div className="page-head__actions">
          <button className="btn btn--ghost" onClick={() => setShowPreview((s) => !s)}>
            <Icon name="eye" size={16} /> {showPreview ? 'Hide preview' : 'Preview'}
          </button>
          <button className="btn btn--primary" onClick={handleSave} disabled={saving || !dirty}>
            <Icon name="save" size={16} /> {saving ? 'Saving…' : 'Save exam'}
          </button>
        </div>
      </div>

      {meta.archived_at && (
        <div className="banner banner--warn" role="status">
          <span>
            <strong>This exam is archived.</strong> It is hidden from the session launcher.
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
      {problems.length > 0 && !error && (
        <div className="banner banner--warn" role="status">
          <span>
            <strong>Before saving:</strong> {problems.slice(0, 4).join(' · ')}
            {problems.length > 4 ? ` · and ${problems.length - 4} more` : ''}
          </span>
        </div>
      )}

      <div className="toolbar">
        <span className="muted small">
          Correct answers are never sent to participants. Auto-graded: multiple choice, select-all,
          true/false, and short answers with accepted answers.
        </span>
        <div className="toolbar__actions">
          <button className="btn btn--sm btn--ghost" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={15} /> Import
          </button>
          <button
            className="btn btn--sm btn--ghost"
            onClick={() =>
              downloadFile(`${slug(tpl.title, 'exam')}.md`, examToMarkdown(tpl), 'text/markdown')
            }
          >
            <Icon name="download" size={15} /> .md
          </button>
          <button
            className="btn btn--sm btn--ghost"
            onClick={() =>
              downloadFile(
                `${slug(tpl.title, 'exam')}.json`,
                JSON.stringify(normaliseExam(tpl), null, 2),
                'application/json',
              )
            }
          >
            <Icon name="download" size={15} /> .json
          </button>
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => downloadFile('sample-exam.md', SAMPLE_EXAM_MARKDOWN, 'text/markdown')}
          >
            Sample .md
          </button>
        </div>
      </div>

      <div className={`editor-grid ${showPreview ? 'editor-grid--split' : ''}`}>
        <div className="editor-col">
          <section className="editor-section">
            <label className="field field--compact">
              <span className="field__label">Title</span>
              <input
                className="field__input"
                value={tpl.title}
                maxLength={EXAM_LIMITS.title}
                placeholder="e.g. Network Fundamentals — Unit Test"
                onChange={(e) => set({ ...tpl, title: e.target.value })}
              />
            </label>
            <label className="field field--compact">
              <span className="field__label">Description</span>
              <input
                className="field__input"
                value={tpl.description}
                maxLength={EXAM_LIMITS.description}
                placeholder="Shown in the template list"
                onChange={(e) => set({ ...tpl, description: e.target.value })}
              />
            </label>
          </section>

          {tpl.content.map((sec, si) => (
            <section className="editor-section" key={si}>
              <div className="editor-section__head">
                <span className="dist__index">{si + 1}</span>
                <input
                  className="field__input editor-section__title-input"
                  value={sec.title}
                  maxLength={EXAM_LIMITS.sectionTitle}
                  aria-label={`Section ${si + 1} title`}
                  onChange={(e) => setSection(si, { ...sec, title: e.target.value })}
                />
                <span className="qedit__tools">
                  <button
                    type="button"
                    className="btn btn--xs btn--icon btn--ghost"
                    disabled={si === 0}
                    onClick={() => set({ ...tpl, content: move(tpl.content, si, -1) })}
                    aria-label="Move section up"
                  >
                    <Icon name="arrowUp" size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--xs btn--icon btn--ghost"
                    disabled={si === tpl.content.length - 1}
                    onClick={() => set({ ...tpl, content: move(tpl.content, si, 1) })}
                    aria-label="Move section down"
                  >
                    <Icon name="arrowDown" size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--xs btn--icon btn--danger-ghost"
                    disabled={tpl.content.length <= 1}
                    onClick={() =>
                      window.confirm(`Remove section ${si + 1} and its questions?`) &&
                      set({ ...tpl, content: tpl.content.filter((_, i) => i !== si) })
                    }
                    aria-label="Remove section"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              </div>
              {sec.questions.map((q, qi) => {
                counter += 1;
                return (
                  <QuestionEditor
                    key={qi}
                    q={q}
                    number={counter}
                    canUp={qi > 0}
                    canDown={qi < sec.questions.length - 1}
                    onChange={(nq) =>
                      setSection(si, {
                        ...sec,
                        questions: sec.questions.map((x, k) => (k === qi ? nq : x)),
                      })
                    }
                    onMove={(d) =>
                      setSection(si, { ...sec, questions: move(sec.questions, qi, d) })
                    }
                    onRemove={() =>
                      setSection(si, {
                        ...sec,
                        questions: sec.questions.filter((_, k) => k !== qi),
                      })
                    }
                  />
                );
              })}
              <div className="qedit__add">
                {QUESTION_TYPE_NAMES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="btn btn--xs btn--ghost"
                    disabled={sec.questions.length >= EXAM_LIMITS.questionsPerSection}
                    onClick={() =>
                      setSection(si, { ...sec, questions: [...sec.questions, blankQuestion(t)] })
                    }
                  >
                    <Icon name="plus" size={12} /> {QUESTION_TYPES[t].label}
                  </button>
                ))}
              </div>
            </section>
          ))}

          <button
            type="button"
            className="btn btn--ghost btn--block"
            disabled={tpl.content.length >= EXAM_LIMITS.sections}
            onClick={() =>
              set({
                ...tpl,
                content: [
                  ...tpl.content,
                  { title: `Section ${tpl.content.length + 1}`, questions: [blankQuestion()] },
                ],
              })
            }
          >
            <Icon name="plus" size={15} /> Add section
          </button>

          <details className="typo-section">
            <summary className="typo-section__head">
              <Icon name="image" size={15} />
              <span className="typo-section__title">Images</span>
              <span className="muted small">{images.length} in library</span>
            </summary>
            <ImageLibrary images={images} missing={[]} onChange={loadImages} />
          </details>

          {!isNew && (
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
                    set(normaliseExam(entry.snapshot));
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
            <h3>Participant view</h3>
            <ExamPreview id={id} draft={{ ...normaliseExam(tpl), kind: 'exam' }} />
          </div>
        )}
      </div>
    </PortalShell>
  );
}
