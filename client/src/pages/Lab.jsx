import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, participantSession } from '../api.js';
import { useCountdown } from '../hooks/useCountdown.js';
import StepCard from '../components/StepCard.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Icon from '../components/Icon.jsx';

export default function Lab() {
  const location = useLocation();
  const navigate = useNavigate();

  // Resolve the resumed session ONCE. Calling participantSession.get() in the
  // render body returned a fresh object every render, which — because it was
  // a dependency of `load` — re-created the effect and refetched the manual on
  // every state change whenever router state was absent (i.e. on resume).
  const [resumed] = useState(() => location.state || participantSession.get());
  const { token, seatNumber, name, session } = resumed || {};

  useEffect(() => {
    if (token) participantSession.set({ token, seatNumber, name, session });
  }, [token, seatNumber, name, session]);

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(null);
  const [view, setView] = useState(0); // section index being viewed
  const [dir, setDir] = useState('next'); // animation direction
  const [finishedLocal, setFinishedLocal] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // Live expiry / finished flag refreshed by the lightweight status poll, so
  // the countdown reflects an instructor "+30" without re-pulling the manual.
  const [liveExpiry, setLiveExpiry] = useState(null);
  const [remoteFinished, setRemoteFinished] = useState(false);
  const [updatedNotice, setUpdatedNotice] = useState(false);
  const initialisedRef = useRef(false);
  const reportedRef = useRef(-1);
  const versionRef = useRef(null);
  const remaining = useCountdown(liveExpiry || data?.expires_at || session?.expires_at);

  useEffect(() => {
    if (!token) navigate('/', { replace: true });
  }, [token, navigate]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.content(token);
      setData(res);
      setLiveExpiry(res.expires_at);
      setError('');
      // Keep the persisted session's expiry fresh so resume shows the right time.
      participantSession.set({
        token,
        seatNumber,
        name,
        session: { ...session, expires_at: res.expires_at, section_count: res.total_sections },
      });
      const lastIndex = Math.max(res.total_sections - 1, 0);
      if (!initialisedRef.current) {
        // On first load, resume at the participant's last section.
        initialisedRef.current = true;
        setView(Math.min(res.current_section || 0, res.unlocked_section, lastIndex));
      } else {
        // After a pushed template update the manual may be shorter or a
        // section may have re-locked: never leave the view pointing at a
        // section that no longer exists or isn't unlocked.
        setView((v) => Math.min(v, res.unlocked_section, lastIndex));
      }
      if (versionRef.current !== null && versionRef.current !== res.template_version) {
        setUpdatedNotice(true);
      }
      versionRef.current = res.template_version;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        participantSession.clear();
        setEnded({ reason: err.message });
      } else {
        setError(err.message || 'Could not load your lab.');
      }
    }
  }, [token, seatNumber, name, session]);

  // Lightweight liveness poll: refreshes the countdown + finished flag,
  // detects session-end, and notices an instructor "push latest version"
  // (template_version change → reload the manual) without re-fetching the
  // whole manual every tick.
  const pollStatus = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.status(token);
      setLiveExpiry(res.expires_at);
      if (res.finished) setRemoteFinished(true);
      setError('');
      if (versionRef.current !== null && res.template_version !== versionRef.current) {
        load();
      }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        participantSession.clear();
        setEnded({ reason: err.message });
      }
    }
  }, [token, load]);

  useEffect(() => {
    if (!token) return undefined;
    load(); // full manual once on mount…
    const id = setInterval(pollStatus, 15000); // …then just poll liveness
    return () => clearInterval(id);
  }, [token, load, pollStatus]);

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
    setReviewing(false); // return to the completion screen
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
        <div className="ended-card" role="alert">
          <span className="ended-card__icon">
            <Icon name="lock" size={40} />
          </span>
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
  const finished = finishedLocal || data?.finished || remoteFinished;

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
            Nice work, {displayName || `#${seatNumber}`}. You finished all {total} section
            {total === 1 ? '' : 's'}.
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
            {finished && (
              <button className="btn btn--ghost btn--sm" onClick={() => setReviewing(false)}>
                <Icon name="check-circle" size={15} /> Summary
              </button>
            )}
            <span
              className={`lab__timer ${remaining === 'expired' ? 'is-warn' : ''}`}
              role="timer"
              aria-label="Time remaining"
            >
              <Icon name="clock" size={16} /> {remaining || '—'}
            </span>
            <ThemeToggle />
            <button
              className="theme-toggle"
              onClick={logout}
              aria-label="Exit session"
              title="Exit session"
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </header>

        {/* Section stepper — clear delineation of section boundaries. This is
            navigation between pages, not a tab set, so it is a list of buttons
            with aria-current="step" rather than role=tablist. */}
        <nav className="stepper" aria-label="Sections">
          {Array.from({ length: total }).map((_, i) => {
            const state =
              i < completed ? 'done' : i === view ? 'current' : i <= unlocked ? 'open' : 'locked';
            const label = `Section ${i + 1}${state === 'done' ? ' (complete)' : state === 'locked' ? ' (locked)' : ''}`;
            return (
              <button
                key={i}
                type="button"
                className={`stepper__node stepper__node--${state}`}
                disabled={i > unlocked}
                onClick={() => goTo(i)}
                aria-current={i === view ? 'step' : undefined}
                aria-label={label}
                title={label}
              >
                <span className="stepper__dot" aria-hidden="true">
                  {state === 'done' ? <Icon name="check" size={15} strokeWidth={2.25} /> : i + 1}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="lab__progress">
          <div
            className="lab__progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total || 0}
            aria-valuenow={completed}
            aria-label="Sections complete"
          >
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
        <div aria-live="polite">
          {error && <p className="form__error lab__error">{error}</p>}
          {updatedNotice && (
            <div className="banner banner--info lab__notice">
              <span>Your instructor updated this lab. The manual has been refreshed.</span>
              <button className="btn btn--xs btn--ghost" onClick={() => setUpdatedNotice(false)}>
                Dismiss
              </button>
            </div>
          )}
        </div>
        {!data && !error && <p className="lab__loading">Loading your lab…</p>}

        {section && (
          <div
            key={`${view}-${data?.template_version ?? 0}`}
            className={`section-view section-view--${dir}`}
          >
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
                <Icon name="chevronLeft" size={16} /> Previous
              </button>

              {blockedByCheckpoint && (
                <span className="section-nav__hint" role="status">
                  <Icon name="lock" size={14} /> Complete the checkpoint to continue
                </span>
              )}

              {isLast && allDone ? (
                <button className="btn btn--primary" onClick={handleFinish}>
                  <Icon name="check-circle" size={16} /> Finish lab
                </button>
              ) : (
                <button
                  className="btn btn--primary"
                  disabled={!canNext}
                  onClick={() => goTo(view + 1)}
                >
                  Next <Icon name="chevronRight" size={16} />
                </button>
              )}
            </div>
          </div>
        )}
      </main>

      <footer className="lab__footprint">
        Lab content is rendered in memory for your seat only — no files are saved to this device.
      </footer>
    </div>
  );
}
