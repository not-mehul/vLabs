import { useState } from 'react';
import Icon from './Icon.jsx';

/**
 * State checkpoint. The participant must enter a validation string to unlock the
 * next section. Validation happens server-side — the expected answer is never in
 * the client bundle or network payload.
 *
 * Once every hint on the step has been taken, `solutionAvailable` turns on and a
 * "Reveal solution" control lets the participant fetch the answer (server-gated
 * on all hints being taken). The revealed answer pre-fills the input.
 */
export default function Checkpoint({
  prompt,
  placeholder,
  completed,
  solution: initialSolution,
  solutionAvailable,
  onReveal,
  onSubmit,
}) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('idle'); // idle | checking | wrong
  const [error, setError] = useState('');
  const [solution, setSolution] = useState(initialSolution || '');
  const [revealing, setRevealing] = useState(false);

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
    } catch (err) {
      setStatus('wrong');
      setError(err.message || 'Could not verify. Try again.');
    }
  }

  async function handleReveal() {
    if (revealing) return;
    setRevealing(true);
    try {
      const sol = await onReveal();
      if (sol) {
        setSolution(sol);
        setValue(sol);
      }
    } catch (err) {
      setError(err.message || 'Could not reveal the solution.');
    } finally {
      setRevealing(false);
    }
  }

  return (
    <form className="checkpoint" onSubmit={handleSubmit}>
      <div className="checkpoint__lock"><Icon name="lock" size={18} /></div>
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
          <button type="submit" className="btn btn--primary" disabled={status === 'checking' || !value.trim()}>
            {status === 'checking' ? 'Checking…' : 'Unlock'}
          </button>
        </div>
        {error && <p className="checkpoint__error">{error}</p>}

        {solution ? (
          <p className="checkpoint__solution">
            <Icon name="hint" size={14} /> Solution: <code>{solution}</code>
          </p>
        ) : (
          solutionAvailable && (
            <button type="button" className="checkpoint__reveal" onClick={handleReveal} disabled={revealing}>
              {revealing ? 'Revealing…' : 'Stuck? Reveal the solution'}
            </button>
          )
        )}
      </div>
    </form>
  );
}
