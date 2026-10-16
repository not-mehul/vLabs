import { useId } from 'react';
import Markdown from './Markdown.jsx';
import Icon from './Icon.jsx';

export const QUESTION_LABEL = {
  single: 'Choose one',
  multiple: 'Choose all that apply',
  truefalse: 'True or false',
  short: 'Short answer',
  long: 'Written answer',
};

const LETTER = (i) => String.fromCharCode(65 + i);

/**
 * One exam question for the participant. Renders the input for its type and
 * reports changes upward; saving (and debouncing for text) is the page's job.
 * Nothing here knows the correct answer — the server never sends it.
 *
 * To support a new question type, add a branch below (and the type in
 * shared/exam-schema.js).
 */
export default function ExamQuestion({ q, value, onChange, disabled, saveState }) {
  const id = useId();
  const answered =
    value !== undefined &&
    value !== null &&
    !(Array.isArray(value) && value.length === 0) &&
    !(typeof value === 'string' && value.trim() === '');

  let input = null;
  if (q.type === 'single' || q.type === 'multiple') {
    const multi = q.type === 'multiple';
    const chosen = new Set(multi ? value || [] : value == null ? [] : [value]);
    input = (
      <div className="choices" role={multi ? 'group' : 'radiogroup'} aria-labelledby={`${id}-p`}>
        {q.options.map((o, i) => {
          const on = chosen.has(i);
          return (
            <label key={i} className={`choice ${on ? 'choice--on' : ''}`}>
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={`${id}-opt`}
                checked={on}
                disabled={disabled}
                onChange={() => {
                  if (!multi) return onChange(i, { immediate: true });
                  const next = new Set(chosen);
                  if (on) next.delete(i);
                  else next.add(i);
                  onChange(
                    [...next].sort((a, b) => a - b),
                    { immediate: true },
                  );
                }}
              />
              <span className="choice__letter" aria-hidden="true">
                {LETTER(i)}
              </span>
              <span className="choice__text">
                <Markdown>{o}</Markdown>
              </span>
            </label>
          );
        })}
      </div>
    );
  } else if (q.type === 'truefalse') {
    input = (
      <div className="tf" role="radiogroup" aria-labelledby={`${id}-p`}>
        {[
          [true, 'True'],
          [false, 'False'],
        ].map(([v, label]) => (
          <label key={label} className={`choice choice--tf ${value === v ? 'choice--on' : ''}`}>
            <input
              type="radio"
              name={`${id}-tf`}
              checked={value === v}
              disabled={disabled}
              onChange={() => onChange(v, { immediate: true })}
            />
            <span className="choice__text">{label}</span>
          </label>
        ))}
      </div>
    );
  } else if (q.type === 'short') {
    input = (
      <input
        className="field__input exam__text"
        type="text"
        aria-labelledby={`${id}-p`}
        maxLength={500}
        autoComplete="off"
        spellCheck="false"
        placeholder="Type your answer"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onChange(e.target.value, { immediate: true })}
      />
    );
  } else if (q.type === 'long') {
    input = (
      <textarea
        className="field__input exam__text exam__text--long"
        aria-labelledby={`${id}-p`}
        rows={6}
        maxLength={10000}
        placeholder="Write your answer"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onChange(e.target.value, { immediate: true })}
      />
    );
  }

  return (
    <article className={`qcard ${answered ? 'qcard--answered' : ''}`} id={`q-${q.key}`}>
      <header className="qcard__head">
        <span className="qcard__num">Question {q.number}</span>
        <span className="qcard__type">{QUESTION_LABEL[q.type] || q.type}</span>
        <span className="qcard__pts">
          {q.points} pt{q.points === 1 ? '' : 's'}
        </span>
        <span className={`qcard__save qcard__save--${saveState || 'idle'}`} aria-live="polite">
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'saved' && (
            <>
              <Icon name="check" size={12} /> Saved
            </>
          )}
          {saveState === 'error' && 'Not saved — retrying'}
        </span>
      </header>
      <div className="qcard__prompt" id={`${id}-p`}>
        <Markdown>{q.prompt}</Markdown>
      </div>
      {input}
      {!disabled && answered && (q.type === 'single' || q.type === 'truefalse') && (
        <button
          type="button"
          className="btn btn--xs btn--ghost qcard__clear"
          onClick={() => onChange(null, { immediate: true })}
        >
          Clear answer
        </button>
      )}
    </article>
  );
}
