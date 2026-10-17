import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { slug } from '../lib/format.js';
import { downloadFile } from '../lib/files.js';
import { readStudioFile, uploadPackageImages } from '../lib/studioPackage.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import Icon from '../components/Icon.jsx';
import ExamQuestion from '../components/ExamQuestion.jsx';
import Markdown from '../components/Markdown.jsx';
import ImageLibrary from '../components/editor/ImageLibrary.jsx';
import ChangeHistory from '../components/editor/ChangeHistory.jsx';
import MinutesField from '../components/editor/MinutesField.jsx';
import {
  EXAM_LIMITS,
  QUESTION_TYPES,
  ITEM_TYPES,
  ITEM_TYPE_NAMES,
  blankItem,
  blankSection,
  isQuestion,
  isSubmitSection,
  normaliseExam,
  normaliseQuestion,
  examErrors,
  isManualQuestion,
} from '../../../shared/exam-schema.js';
import { examToMarkdown, SAMPLE_EXAM_MARKDOWN } from '../../../shared/exam-format.js';
import { LIMITS, maskExample } from '../../../shared/template-schema.js';

// The submit section is added by normaliseExam.
const NEW_EXAM = () => normaliseExam({ title: '', description: '', content: [blankSection(1)] });

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

/** The boxes of a Checklist item: one line per thing the participant ticks. */
function TasksEditor({ tasks, onChange }) {
  return (
    <div className="opts-editor">
      <span className="field__label">
        Checklist: the participant ticks every item to move on (nobody approves it)
      </span>
      {tasks.map((t, i) => (
        <div className="opts-editor__row" key={i}>
          <span className="opts-editor__mark" aria-hidden="true">
            <Icon name="checklist" size={14} />
          </span>
          <input
            className="field__input"
            value={t}
            maxLength={EXAM_LIMITS.task}
            placeholder="e.g. My instructor has checked my cabling"
            aria-label={`Checklist item ${i + 1}`}
            onChange={(e) => onChange(tasks.map((x, k) => (k === i ? e.target.value : x)))}
          />
          <button
            type="button"
            className="btn btn--xs btn--icon btn--danger-ghost"
            onClick={() => onChange(tasks.filter((_, k) => k !== i))}
            aria-label={`Remove checklist item ${i + 1}`}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--xs btn--ghost"
        disabled={tasks.length >= EXAM_LIMITS.tasks}
        onClick={() => onChange([...tasks, ''])}
      >
        <Icon name="plus" size={13} /> Add item
      </button>
    </div>
  );
}

/**
 * Per-seat variables, as in labs: `NAME = formula`, used as {{ NAME }} in any
 * text of the exam (with the built-ins SEAT_ID, FIRST_NAME, LAST_NAME and
 * FULL_NAME).
 */
function VariablesEditor({ variables, onChange }) {
  const setVar = (i, v) => onChange(variables.map((x, k) => (k === i ? v : x)));
  return (
    <details className="typo-section" open={variables.length > 0}>
      <summary className="typo-section__head">
        <Icon name="settings" size={15} />
        <span className="typo-section__title">Variables</span>
        <span className="muted small">{variables.length} formulas</span>
      </summary>
      <p className="muted small">
        Per-seat values, exactly as in labs: write <code>{'{{ NAME }}'}</code> in any prompt,
        option, accepted answer, instructions or checklist item. Always available:{' '}
        <code>{'{{ SEAT_ID }}'}</code>, <code>{'{{ FIRST_NAME }}'}</code>,{' '}
        <code>{'{{ LAST_NAME }}'}</code>, <code>{'{{ FULL_NAME }}'}</code>. Formulas use{' '}
        <code>seat</code>, e.g. <code>{"'Store ' + (100 + seat)"}</code>. A short-answer question
        can also save the participant&apos;s answer as a variable for the sections after it.
      </p>
      {variables.map((v, i) => (
        <div className="typo-pair typo-pair--var" key={i}>
          <label className="field field--compact">
            <span className="field__label">Name</span>
            <input
              className="field__input mono"
              value={v.name}
              spellCheck={false}
              placeholder="STORE"
              onChange={(e) => setVar(i, { ...v, name: e.target.value })}
            />
          </label>
          <label className="field field--compact">
            <span className="field__label">Formula</span>
            <input
              className="field__input mono"
              value={v.expression}
              spellCheck={false}
              placeholder="100 + seat"
              onChange={(e) => setVar(i, { ...v, expression: e.target.value })}
            />
          </label>
          <button
            type="button"
            className="btn btn--xs btn--icon btn--danger-ghost"
            onClick={() => onChange(variables.filter((_, k) => k !== i))}
            aria-label={`Remove variable ${v.name || i + 1}`}
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--xs btn--ghost"
        disabled={variables.length >= LIMITS.variables}
        onClick={() => onChange([...variables, { name: '', expression: '' }])}
      >
        <Icon name="plus" size={13} /> Add variable
      </button>
    </details>
  );
}

/**
 * Change an item's type, keeping what carries over: the prompt and points
 * between questions (and the options between choice types), the title, text
 * and checklist between Informational and Checklist, and the text either way
 * between a step and a question.
 */
function retype(item, type) {
  const fresh = blankItem(type);
  const text = isQuestion(item) ? item.prompt : item.body;
  if (!isQuestion(fresh)) {
    return {
      ...fresh,
      title: item.title || '',
      body: text,
      ...(type === 'checklist' && item.tasks?.length ? { tasks: item.tasks } : {}),
    };
  }
  const keepOptions =
    QUESTION_TYPES[type].hasOptions && isQuestion(item) && item.options.length >= 2;
  return normaliseQuestion({
    ...fresh,
    prompt: text,
    points: isQuestion(item) ? item.points : fresh.points,
    ...(keepOptions ? { options: item.options } : {}),
  });
}

/** A short answer: exact accepted answers or a pattern, a placeholder and a capture. */
function ShortAnswerEditor({ q, onChange }) {
  const pattern = q.match === 'pattern';
  const example = pattern ? maskExample(q.pattern || '') : '';
  const setMode = (mode) => {
    const { match: _m, pattern: _p, ...rest } = q;
    onChange(mode === 'pattern' ? { ...rest, accepted: [], match: 'pattern', pattern: '' } : rest);
  };
  return (
    <>
      <div className="segmented" role="radiogroup" aria-label="How the answer is checked">
        {[
          ['exact', 'Exact answers'],
          ['pattern', 'Pattern (format only)'],
        ].map(([mode, label]) => {
          const on = (mode === 'pattern') === pattern;
          return (
            <button
              key={mode}
              type="button"
              className={`segmented__btn ${on ? 'is-active' : ''}`}
              onClick={() => !on && setMode(mode)}
              aria-pressed={on}
            >
              {label}
            </button>
          );
        })}
      </div>
      {pattern ? (
        <label className="field field--compact">
          <span className="field__label">
            Pattern, as in a lab checkpoint: <code>X</code> any letter or digit, <code>9</code> a
            digit, <code>A</code> a letter; other letters and digits must match as written, and
            punctuation may be left out
            {example && (
              <>
                {' '}
                (e.g. <code>{example}</code>)
              </>
            )}
          </span>
          <input
            className="field__input mono"
            value={q.pattern || ''}
            maxLength={LIMITS.pattern}
            spellCheck={false}
            placeholder="e.g. XXXX.XXXX.XXXX"
            onChange={(e) => onChange({ ...q, pattern: e.target.value })}
          />
        </label>
      ) : (
        <label className="field field--compact">
          <span className="field__label">
            Accepted answers, one per line; case and spacing are ignored. Leave empty to mark by
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
      <label className="field field--compact">
        <span className="field__label">Answer box placeholder (optional)</span>
        <input
          className="field__input"
          value={q.placeholder || ''}
          maxLength={LIMITS.placeholder}
          placeholder="Type your answer"
          onChange={(e) => {
            const { placeholder: _old, ...rest } = q;
            onChange(e.target.value ? { ...rest, placeholder: e.target.value } : rest);
          }}
        />
      </label>
    </>
  );
}

/**
 * One item of a section: an Informational or Checklist step, or a question.
 * Steps and questions are numbered separately within the section, as in the
 * messages that list what to fix.
 */
function ItemEditor({ si, item, label, onChange, onMove, onRemove, canUp, canDown, canRemove }) {
  const question = isQuestion(item);
  return (
    <div className={`qedit ${question ? '' : 'qedit--step'}`}>
      <div className="qedit__head">
        <span className="qedit__num">{label}</span>
        <select
          className="field__input field__input--sm"
          value={item.type}
          onChange={(e) => onChange(retype(item, e.target.value))}
          aria-label={`Section ${si + 1} ${label} type`}
        >
          {ITEM_TYPE_NAMES.map((t) => (
            <option key={t} value={t}>
              {ITEM_TYPES[t]}
            </option>
          ))}
        </select>
        {question && (
          <label className="qedit__points">
            <input
              className="field__input field__input--sm"
              type="number"
              min="0"
              max={EXAM_LIMITS.maxPoints}
              step="0.5"
              value={item.points}
              onChange={(e) => onChange({ ...item, points: Number(e.target.value) })}
              aria-label="Points"
            />
            pts
          </label>
        )}
        {question && isManualQuestion(item) && (
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
            aria-label={`Move ${label} up`}
          >
            <Icon name="arrowUp" size={13} />
          </button>
          <button
            type="button"
            className="btn btn--xs btn--icon btn--ghost"
            onClick={() => onMove(1)}
            disabled={!canDown}
            aria-label={`Move ${label} down`}
          >
            <Icon name="arrowDown" size={13} />
          </button>
          <button
            type="button"
            className="btn btn--xs btn--icon btn--danger-ghost"
            onClick={onRemove}
            disabled={!canRemove}
            aria-label={`Remove ${label}`}
          >
            <Icon name="trash" size={13} />
          </button>
        </span>
      </div>

      {!question && (
        <>
          <input
            className="field__input"
            value={item.title}
            maxLength={EXAM_LIMITS.itemTitle}
            placeholder="Title (optional)"
            aria-label={`Section ${si + 1} ${label} title`}
            onChange={(e) => onChange({ ...item, title: e.target.value })}
          />
          <label className="field field--compact">
            <span className="field__label">
              Instructions (Markdown; images by library file name)
              {item.type === 'checklist' ? ', optional' : ''}
            </span>
            <textarea
              className="field__input"
              rows={Math.min(12, Math.max(3, item.body.split('\n').length + 1))}
              maxLength={EXAM_LIMITS.body}
              value={item.body}
              placeholder={
                item.type === 'checklist'
                  ? 'e.g. Cable the switch to the router, then call your instructor over to check it.'
                  : 'e.g. Read the scenario below before you answer.'
              }
              onChange={(e) => onChange({ ...item, body: e.target.value })}
            />
          </label>
          {item.type === 'checklist' && (
            <TasksEditor tasks={item.tasks} onChange={(tasks) => onChange({ ...item, tasks })} />
          )}
        </>
      )}

      {question && (
        <label className="field field--compact">
          <span className="field__label">Question (Markdown; images by library file name)</span>
          <textarea
            className="field__input"
            rows={Math.min(12, Math.max(2, item.prompt.split('\n').length + 1))}
            maxLength={EXAM_LIMITS.prompt}
            value={item.prompt}
            onChange={(e) => onChange({ ...item, prompt: e.target.value })}
          />
        </label>
      )}
      {question && QUESTION_TYPES[item.type].hasOptions && (
        <OptionsEditor q={item} onChange={onChange} />
      )}
      {item.type === 'truefalse' && (
        <div className="segmented" role="radiogroup" aria-label="Correct answer">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              className={`segmented__btn ${item.correct === v ? 'is-active' : ''}`}
              onClick={() => onChange({ ...item, correct: v })}
              aria-pressed={item.correct === v}
            >
              Correct answer: {v ? 'True' : 'False'}
            </button>
          ))}
        </div>
      )}
      {item.type === 'short' && <ShortAnswerEditor q={item} onChange={onChange} />}
      {question && (item.type === 'short' || item.capture) && (
        <label className="field field--compact">
          <span className="field__label">
            Save the answer as a variable (optional): later sections can show it as{' '}
            <code>{`{{ ${item.capture || 'NAME'} }}`}</code>, and accept it as an answer
          </span>
          <input
            className="field__input mono"
            value={item.capture || ''}
            placeholder="e.g. ROUTER_IP"
            maxLength={LIMITS.captureName}
            onChange={(e) => {
              const { capture: _old, ...rest } = item;
              const name = e.target.value.trim();
              onChange(name ? { ...rest, capture: name } : rest);
            }}
          />
        </label>
      )}
      {item.type === 'long' && (
        <p className="muted small">Long answers are always marked by hand.</p>
      )}
    </div>
  );
}

/** The items of a section with the numbers shown on them ("Step 2", "Question 3"). */
function itemLabels(items) {
  let steps = 0;
  let questions = 0;
  return items.map((it) =>
    isQuestion(it) ? `Question ${(questions += 1)}` : `Step ${(steps += 1)}`,
  );
}

/** A step (Informational or Checklist) as the participant sees it. */
function StepView({ item }) {
  return (
    <div className="panel exam-info">
      {item.title && <h4 className="preview__step-title">{item.title}</h4>}
      {item.body && <Markdown>{item.body}</Markdown>}
      {item.tasks?.length > 0 && (
        <div className="exam-checklist">
          {item.tasks.map((t, ti) => (
            <label key={ti} className="choice exam-checklist__item">
              <input type="checkbox" disabled />
              <span className="choice__text">
                <Markdown>{t}</Markdown>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Participant-view preview rendered by the server (library images resolved). */
function ExamPreview({ id, draft }) {
  const { call } = useInstructorApi();
  const [seat, setSeat] = useState(7);
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setRes(
        await call((t) =>
          api.previewTemplate(t, id === 'new-exam' ? 0 : id, Number(seat) || 1, draft),
        ),
      );
    } catch (err) {
      setError(err.details ? err.details.join('\n') : err.message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }, [call, id, seat, draft]);
  let n = 0;
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
      {res?.context && (
        <div className="preview__context">
          <span className="editor-label">Resolved variables for seat #{res.seat_id}</span>
          <div className="preview__vars">
            {Object.entries(res.context).map(([k, v]) => (
              <span className="tag" key={k}>
                <code>{k}</code> = <code>{String(v)}</code>
              </span>
            ))}
          </div>
        </div>
      )}
      {res?.sections?.map((sec) => (
        <div key={sec.index} className="preview__section">
          <div className="section-head section-head--compact">
            <span className="section-head__eyebrow">
              {sec.type === 'submit' ? 'Final step' : `Section ${sec.index + 1}`}
            </span>
            <h3 className="section-head__title">{sec.title}</h3>
          </div>
          {sec.body && (
            <div className="panel">
              <Markdown>{sec.body}</Markdown>
            </div>
          )}
          {sec.type === 'submit' && (
            <p className="muted small">
              {sec.review
                ? 'Shows how many questions are answered and links to anything left, then the Submit button.'
                : 'Shows the Submit button only.'}
            </p>
          )}
          {(sec.items || []).map((it, ii) => {
            if (!isQuestion(it)) return <StepView key={ii} item={it} />;
            const qi = n;
            n += 1;
            return (
              <ExamQuestion
                key={ii}
                q={{ ...it, key: `${sec.index}.${qi}`, number: n }}
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
  const location = useLocation();
  // An exam imported from Templates → Import arrives in the navigation state.
  const imported = isNew ? location.state?.imported : null;
  const { call } = useInstructorApi();
  const fileRef = useRef(null);
  const [tpl, setTpl] = useState(() =>
    initial ? normaliseExam(initial) : imported ? normaliseExam(imported) : NEW_EXAM(),
  );
  const [meta, setMeta] = useState({
    archived_at: initial?.archived_at ?? null,
    version: initial?.version ?? null,
  });
  const [dirty, setDirty] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState([]);
  const [notice, setNotice] = useState(() => (imported ? location.state?.notice || '' : ''));
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

  async function handleImport(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { kind, template, images: pkgImages, source } = await readStudioFile(file);
      if (kind !== 'exam') {
        setError(`"${file.name}" is a lab, not an exam. Import it from Templates → Import.`);
        return;
      }
      if (!window.confirm(`Replace this exam's content with "${file.name}"?`)) return;
      let notes = [];
      if (pkgImages.length) {
        notes = await uploadPackageImages(api, call, pkgImages, (names) =>
          window.confirm(
            `${names.length} image(s) already exist in the library (${names.join(', ')}).\n\nReplace them with the package's versions? This updates every template that uses them.`,
          ),
        );
        loadImages();
      }
      set(normaliseExam(template));
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

  const questions = tpl.content.flatMap((s) => (s.items || []).filter(isQuestion));
  const totalQ = questions.length;
  const totalPts = questions.reduce((n, q) => n + (Number(q.points) || 0), 0);

  return (
    <PortalShell>
      <input
        ref={fileRef}
        type="file"
        accept=".zip,.md,.markdown,.json,application/zip,text/markdown,application/json"
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
          true/false, and short answers with accepted answers or a pattern.
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

          <VariablesEditor
            variables={tpl.variables}
            onChange={(variables) => set({ ...tpl, variables })}
          />

          {tpl.content.map((sec, si) => {
            const isSubmit = isSubmitSection(sec);
            const last = tpl.content.length - 1; // the submit section
            const items = sec.items || [];
            const labels = isSubmit ? [] : itemLabels(items);
            const setItems = (next) => setSection(si, { ...sec, items: next });
            return (
              <section
                className={`editor-section ${isSubmit ? 'editor-section--submit' : ''}`}
                key={si}
              >
                <div className="editor-section__head">
                  <span className="dist__index">
                    {isSubmit ? <Icon name="flag" size={13} /> : si + 1}
                  </span>
                  <input
                    className="field__input editor-section__title-input"
                    value={sec.title}
                    maxLength={EXAM_LIMITS.sectionTitle}
                    placeholder={isSubmit ? 'Review and submit' : ''}
                    aria-label={`Section ${si + 1} title`}
                    onChange={(e) => setSection(si, { ...sec, title: e.target.value })}
                  />
                  {isSubmit && <span className="tag tag--section-submit">Submit</span>}
                  {!isSubmit && (
                    <MinutesField
                      label="Minutes"
                      value={sec.minutes}
                      onChange={(v) => setSection(si, { ...sec, minutes: v })}
                    />
                  )}
                  {!isSubmit && (
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
                        disabled={si >= last - 1}
                        onClick={() => set({ ...tpl, content: move(tpl.content, si, 1) })}
                        aria-label="Move section down"
                      >
                        <Icon name="arrowDown" size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn btn--xs btn--icon btn--danger-ghost"
                        disabled={last <= 1}
                        onClick={() =>
                          window.confirm(`Remove section ${si + 1} and everything in it?`) &&
                          set({ ...tpl, content: tpl.content.filter((_, i) => i !== si) })
                        }
                        aria-label="Remove section"
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </span>
                  )}
                </div>

                {isSubmit && (
                  <label className="field field--compact">
                    <span className="field__label">
                      Text above the submit button (Markdown, optional)
                    </span>
                    <textarea
                      className="field__input"
                      rows={Math.min(12, Math.max(3, sec.body.split('\n').length + 1))}
                      maxLength={EXAM_LIMITS.body}
                      value={sec.body}
                      placeholder="e.g. Check every part before you hand in."
                      onChange={(e) => setSection(si, { ...sec, body: e.target.value })}
                    />
                  </label>
                )}

                {isSubmit && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={sec.review}
                      onChange={(e) => setSection(si, { ...sec, review: e.target.checked })}
                    />
                    <span>
                      Show a review first: how many questions are answered, with links to any
                      unanswered question or unfinished checklist. Untick for a plain submit button.
                    </span>
                  </label>
                )}

                {!isSubmit && (
                  <>
                    {items.map((it, ii) => (
                      <ItemEditor
                        key={ii}
                        si={si}
                        item={it}
                        label={labels[ii]}
                        canUp={ii > 0}
                        canDown={ii < items.length - 1}
                        canRemove={items.length > 1}
                        onChange={(next) => setItems(items.map((x, k) => (k === ii ? next : x)))}
                        onMove={(d) => setItems(move(items, ii, d))}
                        onRemove={() => setItems(items.filter((_, k) => k !== ii))}
                      />
                    ))}
                    <div className="qedit__add">
                      <span className="muted small">Add:</span>
                      {ITEM_TYPE_NAMES.map((t) => (
                        <button
                          key={t}
                          type="button"
                          className="btn btn--xs btn--ghost"
                          disabled={items.length >= EXAM_LIMITS.itemsPerSection}
                          onClick={() => setItems([...items, blankItem(t)])}
                        >
                          <Icon name="plus" size={12} /> {ITEM_TYPES[t]}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {si === last - 1 && (
                  <div className="section-add">
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      disabled={tpl.content.length > EXAM_LIMITS.sections}
                      onClick={() =>
                        set({
                          ...tpl,
                          content: [
                            ...tpl.content.slice(0, last),
                            blankSection(last + 1),
                            tpl.content[last],
                          ],
                        })
                      }
                    >
                      <Icon name="plus" size={14} /> Add section
                    </button>
                    <span className="muted small">before the submit step</span>
                  </div>
                )}
              </section>
            );
          })}

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
