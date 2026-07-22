import { useState } from 'react';
import Icon from './Icon.jsx';

/**
 * State checkpoint. The participant must enter a validation string to unlock the
 * next section. Validation happens server-side — the expected answer is never
 * present in the client bundle or network payload.
 */
export default function Checkpoint({ prompt, placeholder, completed, onSubmit }) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('idle'); // idle | checking | wrong
  const [error, setError] = useState('');

  if (completed) {
    return (
      <div className="checkpoint checkpoint--done">
        <span className="checkpoint__badge">
          <Icon name="check" size={16} /> Checkpoint cleared
        </span>
      </div>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!value.trim() || status === 'checking') return;
    setStatus('checking');
    setError('');
    try {
      const ok = await onSubmit(value.trim());
      if (!ok) {
        setStatus('wrong');
        setError('Not quite — check your work and try again.');
      }
      // On success the parent re-renders with completed=true.
    } catch (err) {
      setStatus('wrong');
      setError(err.message || 'Could not verify. Try again.');
    }
  }

  return (
    <form className="checkpoint" onSubmit={handleSubmit}>
      <div className="checkpoint__lock"><Icon name="lock" size={20} /></div>
      <div className="checkpoint__main">
        <label className="checkpoint__prompt" htmlFor="checkpoint-input">
          {prompt}
        </label>
        <div className="checkpoint__row">
          <input
            id="checkpoint-input"
            className={`checkpoint__input ${status === 'wrong' ? 'is-error' : ''}`}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck="false"
            placeholder={placeholder || 'Enter value to continue'}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (status === 'wrong') setStatus('idle');
            }}
          />
          <button
            type="submit"
            className="btn btn--primary"
            disabled={status === 'checking' || !value.trim()}
          >
            {status === 'checking' ? 'Checking…' : 'Unlock'}
          </button>
        </div>
        {error && <p className="checkpoint__error">{error}</p>}
      </div>
    </form>
  );
}
