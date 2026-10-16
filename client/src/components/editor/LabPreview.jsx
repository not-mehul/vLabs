import { useCallback, useState } from 'react';
import { api } from '../../api.js';
import { useInstructorApi } from '../../hooks/useInstructorApi.js';
import StepCard from '../StepCard.jsx';
import Icon from '../Icon.jsx';

/* ------------------------------ Preview --------------------------------- */

/** Render a lab draft for a chosen seat via the server (variables resolved). */
export default function LabPreview({ id, draft }) {
  const { call } = useInstructorApi();
  const [seat, setSeat] = useState(7);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const previewId = id === 'new' ? 0 : id;
      const res = await call((t) => api.previewTemplate(t, previewId, Number(seat), draft));
      setResult(res);
    } catch (err) {
      setError(err.details ? err.details.join('\n') : err.message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [call, id, seat, draft]);

  return (
    <div className="preview">
      <div className="preview__controls">
        <label className="field field--narrow">
          <span className="field__label">Preview seat #</span>
          <input
            className="field__input"
            type="number"
            min="1"
            max="9999"
            value={seat}
            onChange={(e) => setSeat(e.target.value)}
          />
        </label>
        <button type="button" className="btn btn--sm btn--primary" onClick={run} disabled={busy}>
          <Icon name="eye" size={15} /> {busy ? 'Rendering…' : 'Render preview'}
        </button>
      </div>

      {error && <pre className="form__error preview__error">{error}</pre>}

      {result && (
        <>
          <div className="preview__context">
            <span className="editor-label">Resolved variables for seat #{result.seat_id}</span>
            <div className="preview__vars">
              {Object.entries(result.context).map(([k, v]) => (
                <span className="tag" key={k}>
                  <code>{k}</code> = <code>{String(v)}</code>
                </span>
              ))}
            </div>
          </div>
          {result.sections.map((sec) => (
            <div key={sec.index} className="preview__section">
              <div className="section-head section-head--compact">
                <span className="section-head__eyebrow">Section {sec.index + 1}</span>
                <h3 className="section-head__title">{sec.title}</h3>
              </div>
              {sec.steps.map((step) => (
                <StepCard
                  key={step.index}
                  step={{
                    ...step,
                    checkpoint: step.checkpoint
                      ? { ...step.checkpoint, completed: false }
                      : undefined,
                  }}
                  sectionIndex={sec.index}
                  total={sec.total_steps}
                  onCheckpoint={() => Promise.resolve(false)}
                />
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
