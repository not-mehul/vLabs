import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

/**
 * A button that opens a short list of actions (e.g. the monitor's downloads).
 * Closes on a choice, a click outside or Escape.
 *
 * @param {{label:string, icon?:string, disabled?:boolean,
 *          items:{label:string, hint?:string, onSelect:()=>void}[]}} props
 */
export default function Menu({ label, icon, items, disabled = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {icon && <Icon name={icon} size={15} />} {label} <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="menu__list" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="menu__item"
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              <span className="menu__label">{it.label}</span>
              {it.hint && <span className="menu__hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
