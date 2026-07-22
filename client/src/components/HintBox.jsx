import { useState } from 'react';
import Markdown from './Markdown.jsx';
import Icon from './Icon.jsx';

/**
 * Progressive-disclosure hint. Hides the answer behind a click to encourage
 * critical thinking before the hint is revealed.
 */
export default function HintBox({ label, text }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`hint ${open ? 'hint--open' : ''}`}>
      <button
        type="button"
        className="hint__toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="hint" size={16} className="hint__icon" />
        <span className="hint__label">{label || 'Hint'}</span>
        <Icon name="chevronDown" size={16} className={`hint__caret ${open ? 'is-open' : ''}`} />
      </button>
      {open && (
        <div className="hint__body">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  );
}
