import { useState } from 'react';
import Icon from './Icon.jsx';

/** A password field with a button to show or hide what has been typed. */
export default function PasswordInput({ className = 'field__input', ...props }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="password-input">
      <input {...props} className={className} type={shown ? 'text' : 'password'} />
      <button
        type="button"
        className="password-input__toggle"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        title={shown ? 'Hide password' : 'Show password'}
      >
        <Icon name={shown ? 'eyeOff' : 'eye'} size={16} />
      </button>
    </span>
  );
}
