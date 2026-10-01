import { useState } from 'react';
import Markdown from './Markdown.jsx';
import Icon from './Icon.jsx';

/**
 * Progressive-disclosure hint. Hides the answer behind a click to encourage
 * critical thinking. `onOpen` fires the first time it is expanded so the server
 * can record the hint as "taken" (which also gates the reveal-solution feature).
 */
export default function HintBox({ label, text, taken, onOpen }) {
  const [open, setOpen] = useState(false);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && onOpen) onOpen();
  }

  return (
    <div className={`hint ${open ? 'hint--open' : ''} ${taken ? 'hint--taken' : ''}`}>
      <button type="button" className="hint__toggle" aria-expanded={open} onClick={toggle}>
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
