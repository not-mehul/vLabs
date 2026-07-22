import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, participantSession } from '../api.js';
import { useContentProtection } from '../hooks/useContentProtection.js';
import StepCard from '../components/StepCard.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Icon from '../components/Icon.jsx';

function useCountdown(expiresAt) {
  const [remaining, setRemaining] = useState('');
  useEffect(() => {
    if (!expiresAt) return undefined;
    const tick = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (ms <= 0) return setRemaining('expired');
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return setRemaining(`${m}:${String(s).padStart(2, '0')}`);
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
  const resumed = location.state || participantSession.get();
  const { token, seatNumber, name, session } = resumed || {};

  useEffect(() => {
    if (token) participantSession.set({ token, seatNumber, name, session });
  }, [token, seatNumber, name, session]);

  useContentProtection(Boolean(token));

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(null);
  const [view, setView] = useState(0); // section index being viewed
  const [dir, setDir] = useState('next'); // animation direction
  const [finishedLocal, setFinishedLocal] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const initialisedRef = useRef(false);
  const reportedRef = useRef(-1);
  // Countdown uses the live expiry from /content (reflects instructor "+30").
  const remaining = useCountdown(data?.expires_at || session?.expires_at);

  useEffect(() => {
    if (!token) navigate('/', { replace: true });
  }, [token, navigate]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.content(token);
      setData(res);
      setError('');
      // Keep the persisted session's expiry fresh so resume shows the right time.
      participantSession.set({
        token,
        seatNumber,
        name,
        session: { ...session, expires_at: res.expires_at, section_count: res.total_sections },
      });
      // On first load, resume at the participant's last section.
      if (!initialisedRef.current) {
        initialisedRef.current = true;
        setView(Math.min(res.current_section || 0, res.unlocked_section));
      }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        participantSession.clear();
        setEnded({ reason: err.message });
      } else {
        setError(err.message || 'Could not load your lab.');
      }
    }
  }, [token, seatNumber, name, session]);

  useEffect(() => {
    if (!token) return undefined;
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [token, load]);

  // Report the section being viewed (drives analytics + progress high-water
  // mark), then refresh so the progress bar / Finish button update promptly.
  useEffect(() => {
    if (!data || reportedRef.current === view) return;
    reportedRef.current = view;
    api
      .reportProgress(token, view)
      .then(() => load())
      .catch(() => {});
  }, [view, data, token, load]);

  const handleCheckpoint = useCallback(
    async (sectionIndex, stepIndex, answer) => {
      const res = await api.submitCheckpoint(token, sectionIndex, stepIndex, answer);
      if (res.correct) {
        await load();
        return true;
      }
      return false;
    },
    [token, load],
  );

  const handleHintOpen = useCallback(
    (sectionIndex, stepIndex, hintIndex) => {
      api.recordHint(token, sectionIndex, stepIndex, hintIndex).catch(() => {});
    },
    [token],
  );

  const handleReveal = useCallback(
    async (sectionIndex, stepIndex) => {
      const res = await api.revealSolution(token, sectionIndex, stepIndex);
      return res.solution;
    },
    [token],
  );

  const handleFinish = useCallback(async () => {
    try {
      await api.finish(token);
    } catch {
      /* still show completion locally */
    }
    setFinishedLocal(true);
    window.scrollTo({ top: 0 });
  }, [token]);

  function goTo(next) {
    setDir(next > view ? 'next' : 'prev');
    setView(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function logout() {
    participantSession.clear();
    navigate('/', { replace: true });
  }

  if (ended) {
    return (
      <div className="ended-screen">
        <ThemeToggle className="theme-toggle--corner" />
        <div className="ended-card">
          <span className="ended-card__icon"><Icon name="lock" size={40} /></span>
          <h1>Session closed</h1>
          <p>{ended.reason}</p>
          <button className="btn btn--primary" onClick={() => navigate('/', { replace: true })}>
            Return to start
          </button>
        </div>
      </div>
    );
  }

  if (!token) return null;

  const total = data?.total_sections ?? session?.section_count ?? 0;
  const completed = data?.completed_sections ?? 0;
  const unlocked = data?.unlocked_section ?? 0;
  const section = data?.sections?.[view];
  const displayName = (data ? `${data.first_name} ${data.last_name}` : name) || '';
  const canPrev = view > 0;
  const canNext = view < unlocked && view < total - 1;
  const blockedByCheckpoint = section && !section.cleared && view >= unlocked;
  const isLast = view === total - 1;
  const allDone = completed >= total && total > 0;
  const finished = finishedLocal || data?.finished;

  // Completion screen: shown once the lab is finished (unless reviewing).
  if (finished && !reviewing) {
    return (
      <div className="ended-screen">
        <ThemeToggle className="theme-toggle--corner" />
        <div className="ended-card ended-card--done">
          <span className="ended-card__icon ended-card__icon--done">
            <Icon name="check-circle" size={44} strokeWidth={1.9} />
          </span>
          <h1>Lab complete</h1>
          <p>
            Nice work, {displayName || `#${seatNumber}`}. You finished all {total}{' '}
            section{total === 1 ? '' : 's'}.
          </p>
          <div className="ended-actions">
            <button className="btn btn--ghost" onClick={() => setReviewing(true)}>
              Review sections
            </button>
            <button className="btn btn--primary" onClick={logout}>
              Finish &amp; log out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lab">
      <div className="lab__header">
        <header className="lab__bar">
          <div className="lab__bar-left">
            <span className="lab__seat">#{seatNumber}</span>
            <span className="lab__name">{displayName}</span>
            <span className="lab__session">{session?.title}</span>
          </div>
          <div className="lab__bar-right">
            <span className={`lab__timer ${remaining === 'expired' ? 'is-warn' : ''}`}>
              <Icon name="clock" size={16} /> {remaining || '—'}
            </span>
            <ThemeToggle />
            <button className="theme-toggle" onClick={logout} aria-label="Exit session" title="Exit session">
              <Icon name="logout" size={18} />
            </button>
          </div>
        </header>

        {/* Section stepper — clear delineation of section boundaries */}
        <div className="stepper" role="tablist" aria-label="Sections">
          {Array.from({ length: total }).map((_, i) => {
            const state =
              i < completed ? 'done' : i === view ? 'current' : i <= unlocked ? 'open' : 'locked';
            return (
              <button
                key={i}
                className={`stepper__node stepper__node--${state}`}
                disabled={i > unlocked}
                onClick={() => goTo(i)}
                aria-current={i === view}
                title={`Section ${i + 1}`}
              >
                <span className="stepper__dot">
                {state === 'done' ? <Icon name="check" size={15} strokeWidth={2.25} /> : i + 1}
              </span>
              </button>
            );
          })}
        </div>

        <div className="lab__progress">
          <div className="lab__progress-track">
            <div
              className="lab__progress-fill"
              style={{ width: total ? `${(completed / total) * 100}%` : '0%' }}
            />
          </div>
          <span className="lab__progress-label">
            {completed} / {total} complete
          </span>
        </div>
      </div>

      <main className="lab__content">
        {error && <p className="form__error lab__error">{error}</p>}
        {!data && !error && <p className="lab__loading">Loading your lab…</p>}

        {section && (
          <div key={view} className={`section-view section-view--${dir}`}>
            <div className="section-head">
              <span className="section-head__eyebrow">
                Section {view + 1} of {total}
              </span>
              <h1 className="section-head__title">{section.title}</h1>
            </div>

            {section.steps.map((step) => (
              <StepCard
                key={step.index}
                step={step}
                sectionIndex={view}
                total={section.total_steps}
                onCheckpoint={handleCheckpoint}
                onHintOpen={handleHintOpen}
                onRevealSolution={handleReveal}
              />
            ))}

            <div className="section-nav">
              <button className="btn btn--ghost" disabled={!canPrev} onClick={() => goTo(view - 1)}>
                <Icon name="chevronLeft" size={17} /> Previous
              </button>

              {blockedByCheckpoint && (
                <span className="section-nav__hint">
                  <Icon name="lock" size={15} /> Complete the checkpoint to continue
                </span>
              )}

              {isLast && allDone ? (
                <button className="btn btn--primary" onClick={handleFinish}>
                  <Icon name="check-circle" size={17} /> Finish lab
                </button>
              ) : (
                <button className="btn btn--primary" disabled={!canNext} onClick={() => goTo(view + 1)}>
                  Next <Icon name="chevronRight" size={17} />
                </button>
              )}
            </div>
          </div>
        )}
      </main>

      <footer className="lab__footprint">
        Lab content is rendered in memory for your seat only — no files are saved
        to this device.
      </footer>
    </div>
  );
}
