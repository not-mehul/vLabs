import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, participantSession } from '../api.js';
import { useContentProtection } from '../hooks/useContentProtection.js';
import StepCard from '../components/StepCard.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

function useCountdown(expiresAt) {
  const [remaining, setRemaining] = useState('');
  useEffect(() => {
    if (!expiresAt) return undefined;
    const tick = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (ms <= 0) {
        setRemaining('expired');
        return;
      }
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setRemaining(`${m}:${String(s).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return remaining;
}

export default function Lab() {
  const location = useLocation();
  const navigate = useNavigate();
  // Resume path: fall back to the persisted session so a participant who closed
  // their browser lands straight back in the lab.
  const resumed = location.state || participantSession.get();
  const { token, seatNumber, name, session } = resumed || {};

  // Keep the persisted copy fresh (e.g. when arriving via router state).
  useEffect(() => {
    if (token) participantSession.set({ token, seatNumber, name, session });
  }, [token, seatNumber, name, session]);

  useContentProtection(Boolean(token));

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(null); // { reason }
  const currentStepRef = useRef(-1);
  const remaining = useCountdown(session?.expires_at);

  // Redirect out if arrived without a token (e.g. direct URL / refresh).
  useEffect(() => {
    if (!token) navigate('/join', { replace: true });
  }, [token, navigate]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.steps(token);
      setData(res);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        // Session ended/expired/invalid — the stored token is now useless.
        participantSession.clear();
        setEnded({ reason: err.message });
      } else {
        setError(err.message || 'Could not load your lab steps.');
      }
    }
  }, [token]);

  // Initial load + polling to pick up newly unlocked steps / session end.
  useEffect(() => {
    if (!token) return undefined;
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [token, load]);

  // Report which step is in view (drives instructor analytics).
  const reportProgress = useCallback(
    (index) => {
      if (index === currentStepRef.current) return;
      currentStepRef.current = index;
      api.reportProgress(token, index).catch(() => {});
    },
    [token],
  );

  // Observe cards; report the top-most visible step.
  useEffect(() => {
    if (!data || !data.steps.length) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) {
          const idx = Number(visible.target.getAttribute('data-index'));
          reportProgress(idx);
        }
      },
      { threshold: 0.4 },
    );
    document.querySelectorAll('[data-index]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [data, reportProgress]);

  const handleCheckpoint = useCallback(
    async (stepIndex, answer) => {
      const res = await api.submitCheckpoint(token, stepIndex, answer);
      if (res.correct) {
        await load(); // reveal the next step
        return true;
      }
      return false;
    },
    [token, load],
  );

  if (ended) {
    return (
      <div className="ended-screen">
        <ThemeToggle className="theme-toggle--corner" />
        <div className="ended-card">
          <span className="ended-card__icon" aria-hidden="true">🔒</span>
          <h1>Session closed</h1>
          <p>{ended.reason}</p>
          <button className="btn btn--primary" onClick={() => navigate('/join', { replace: true })}>
            Join another session
          </button>
        </div>
      </div>
    );
  }

  if (!token) return null;

  const total = data?.total_steps ?? session?.step_count ?? 0;
  const unlocked = data ? data.unlocked_through + 1 : 0;
  const displayName = (data ? `${data.first_name} ${data.last_name}` : name) || '';

  return (
    <div className="lab">
      <header className="lab__bar">
        <div className="lab__bar-left">
          <span className="lab__seat">#{seatNumber}</span>
          <span className="lab__name">{displayName}</span>
          <span className="lab__session">{session?.title}</span>
        </div>
        <div className="lab__bar-right">
          <span className={`lab__timer ${remaining === 'expired' ? 'is-warn' : ''}`}>
            <span aria-hidden="true">⏱</span> {remaining || '—'}
          </span>
          <ThemeToggle />
        </div>
      </header>

      <div className="lab__progress">
        <div
          className="lab__progress-fill"
          style={{ width: total ? `${(unlocked / total) * 100}%` : '0%' }}
        />
        <span className="lab__progress-label">
          {unlocked} / {total} steps unlocked
        </span>
      </div>

      <main className="lab__content">
        {error && <p className="form__error lab__error">{error}</p>}
        {!data && !error && <p className="lab__loading">Loading your lab…</p>}

        {data &&
          data.steps.map((step) => (
            <div data-index={step.index} key={step.index}>
              <StepCard step={step} total={total} onCheckpoint={handleCheckpoint} />
            </div>
          ))}

        {data && data.unlocked_through < total - 1 && (
          <div className="lab__locked">
            <span aria-hidden="true">🔒</span> Clear the checkpoint above to
            reveal the remaining {total - unlocked} step
            {total - unlocked === 1 ? '' : 's'}.
          </div>
        )}

        {data && data.unlocked_through === total - 1 && (
          <div className="lab__done">🎉 You've reached the end of the lab.</div>
        )}
      </main>

      <footer className="lab__footprint">
        Lab content is rendered in memory for your seat only — no files are
        saved to this device.
      </footer>
    </div>
  );
}
