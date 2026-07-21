import { useState } from 'react';
import Markdown from './Markdown.jsx';

/**
 * Progressive Disclosure component (spec §6). Hides the answer behind a click
 * to encourage critical thinking before the hint is revealed.
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
        <span className="hint__icon" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="hint__label">{label || 'Hint'}</span>
      </button>
      {open && (
        <div className="hint__body">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  );
}
