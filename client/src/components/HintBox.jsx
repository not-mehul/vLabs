import { useState } from 'react';
import Markdown from './Markdown.jsx';
import Icon from './Icon.jsx';

/**
 * One hint. Every hint on a step is listed with its label visible, and the
 * participant opens whichever one they want, in any order. The text stays
 * behind a click to encourage critical thinking; `onOpen` fires when it is
 * expanded so the server records it as viewed (all hints viewed unlocks the
 * step's solution).
 */
export default function HintBox({ label, text, taken, onOpen, number }) {
  const [open, setOpen] = useState(false);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && onOpen) onOpen();
  }

  return (
    <div className={`hint ${open ? 'hint--open' : ''} ${taken ? 'hint--taken' : ''}`}>
      <button type="button" className="hint__toggle" aria-expanded={open} onClick={toggle}>
        <span className="hint__num" aria-hidden="true">
          {number}
        </span>
        <span className="hint__label">{label || 'Hint'}</span>
        {taken && !open && (
          <span className="hint__seen" title="Viewed">
            <Icon name="check" size={13} /> Viewed
          </span>
        )}
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
