import { useState } from 'react';
import Icon from './Icon.jsx';
import Markdown from './Markdown.jsx';

/**
 * Step-level solution. Sits below every hint on a step and mirrors the hint
 * affordance: once every hint has been opened (vacuously true when a step has
 * no hints) the participant may reveal an authored markdown walkthrough. The
 * solution text is fetched on demand — it never ships until revealed.
 *
 * @param {string} [solution] Pre-revealed markdown (present on resume).
 * @param {boolean} available Whether every hint on the step has been opened.
 * @param {() => Promise<string>} onReveal Fetches and returns the solution.
 */
export default function SolutionBox({ solution: initialSolution, available, onReveal }) {
  const [solution, setSolution] = useState(initialSolution || '');
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState('');

  async function handleReveal() {
    if (revealing) return;
    setRevealing(true);
    setError('');
    try {
      const sol = await onReveal();
      if (sol) setSolution(sol);
    } catch (err) {
      setError(err.message || 'Could not reveal the solution.');
    } finally {
      setRevealing(false);
    }
  }

  if (solution) {
    return (
      <div className="solution">
        <div className="solution__head">
          <Icon name="key" size={15} /> Solution
        </div>
        <div className="solution__body">
          <Markdown>{solution}</Markdown>
        </div>
      </div>
    );
  }

  if (!available) {
    return (
      <div className="solution-lock">
        <Icon name="lock" size={14} /> Open all hints to reveal the solution
      </div>
    );
  }

  return (
    <div className="solution-reveal">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={handleReveal}
        disabled={revealing}
      >
        <Icon name="key" size={15} /> {revealing ? 'Revealing…' : 'Reveal solution'}
      </button>
      {error && <p className="checkpoint__error">{error}</p>}
    </div>
  );
}
