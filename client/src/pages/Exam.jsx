import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, participantSession } from '../api.js';
import { useCountdown } from '../hooks/useCountdown.js';
import ExamQuestion from '../components/ExamQuestion.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Icon from '../components/Icon.jsx';

const isAnswered = (v) =>
  v !== undefined &&
  v !== null &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === 'string' && v.trim() === '');

/** Debounce for typed answers; choices save immediately. */
const TYPE_DELAY_MS = 800;

/**
 * Participant exam. Every question is available from the start (no gating),
 * one section per page. Answers save as they are given; the participant is
 * never told whether an answer is right. Submitting locks the exam.
 */
export default function Exam() {
  const location = useLocation();
  const navigate = useNavigate();
  const [resumed] = useState(() => location.state || participantSession.get());
  const { token, seatNumber, name, session } = resumed || {};

  const [data, setData] = useState(null);
  const [answers, setAnswers] = useState({});
  const [saveState, setSaveState] = useState({}); // key → saving | saved | error
  const [view, setView] = useState(0); // section index, or 'review'
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [liveExpiry, setLiveExpiry] = useState(null);
  const timers = useRef({});
  const pending = useRef({}); // key → latest unsaved value
  const remaining = useCountdown(liveExpiry || data?.expires_at || session?.expires_at);

  useEffect(() => {
    if (!token) navigate('/', { replace: true });
  }, [token, navigate]);

  const handleAuthError = useCallback(
    (err) => {
      if (err instanceof ApiError && err.code === 'WRONG_KIND') {
        navigate('/lab', { replace: true, state: resumed });
        return true;
      }
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        participantSession.clear();
        setEnded({ reason: err.message });
        return true;
      }
      return false;
    },
    [navigate, resumed],
  );

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.exam(token);
      setData(res);
      setLiveExpiry(res.expires_at);
      setSubmitted(res.submitted);
      // Keep anything typed but not yet saved.
      setAnswers({ ...res.answers, ...pending.current });
      setError('');
      participantSession.set({
        token,
        seatNumber,
        name,
        session: { ...session, kind: 'exam', expires_at: res.expires_at },
      });
    } catch (err) {
      if (!handleAuthError(err)) setError(err.message || 'Could not load your exam.');
    }
  }, [token, seatNumber, name, session, handleAuthError]);

  useEffect(() => {
    load();
  }, [load]);

  // Liveness: countdown refresh, session end, submission from elsewhere.
  useEffect(() => {
    if (!token) return undefined;
    const id = setInterval(async () => {
      try {
        const st = await api.status(token);
        setLiveExpiry(st.expires_at);
        if (st.submitted) setSubmitted(true);
        if (data && st.template_version !== data.template_version) load();
      } catch (err) {
        handleAuthError(err);
      }
    }, 15000);
    return () => clearInterval(id);
  }, [token, data, load, handleAuthError]);

  const save = useCallback(
    async (key, value) => {
      setSaveState((s) => ({ ...s, [key]: 'saving' }));
      try {
        await api.saveAnswer(token, key, value);
        if (pending.current[key] === value) delete pending.current[key];
        setSaveState((s) => ({ ...s, [key]: 'saved' }));
      } catch (err) {
        if (handleAuthError(err)) return;
        if (err instanceof ApiError && err.code === 'SUBMITTED') {
          setSubmitted(true);
          return;
        }
        setSaveState((s) => ({ ...s, [key]: 'error' }));
        // Retry once the network comes back.
        clearTimeout(timers.current[key]);
        timers.current[key] = setTimeout(() => {
          if (key in pending.current) save(key, pending.current[key]);
        }, 4000);
      }
    },
    [token, handleAuthError],
  );

  const change = useCallback(
    (key, value, { immediate = false } = {}) => {
      setAnswers((a) => ({ ...a, [key]: value }));
      pending.current[key] = value;
      clearTimeout(timers.current[key]);
      if (immediate) save(key, value);
      else timers.current[key] = setTimeout(() => save(key, value), TYPE_DELAY_MS);
    },
    [save],
  );

  // Flush pending typed answers when leaving the page.
  useEffect(() => {
    const t = timers.current;
    return () => Object.values(t).forEach(clearTimeout);
  }, []);

  async function flushAll() {
    const entries = Object.entries(pending.current);
    for (const [k] of entries) clearTimeout(timers.current[k]);
    await Promise.all(entries.map(([k, v]) => save(k, v)));
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await flushAll();
      await api.submitExam(token);
      setSubmitted(true);
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (!handleAuthError(err)) setError(err.message || 'Could not submit. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function goTo(next) {
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
          <p>{ended.reason} Answers you gave before it closed were saved.</p>
          <button className="btn btn--primary" onClick={() => navigate('/', { replace: true })}>
            Return to start
          </button>
        </div>
      </div>
    );
  }
  if (!token) return null;

  const displayName = (data ? `${data.first_name} ${data.last_name}` : name) || '';
  const sections = data?.sections || [];
  const allQuestions = sections.flatMap((s) => s.questions);
  const answeredCount = allQuestions.filter((q) => isAnswered(answers[q.key])).length;
  const total = allQuestions.length;

  if (submitted) {
    return (
      <div className="ended-screen">
        <ThemeToggle className="theme-toggle--corner" />
        <div className="ended-card ended-card--done">
          <span className="ended-card__icon ended-card__icon--done">
            <Icon name="check-circle" size={44} strokeWidth={1.9} />
          </span>
          <h1>Exam submitted</h1>
          <p>
            Thank you, {displayName || `#${seatNumber}`}. Your answers ({answeredCount} of {total})
            have been recorded. Your instructor will share results.
          </p>
          <div className="ended-actions">
            <button className="btn btn--primary" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </div>
    );
  }

  const reviewing = view === 'review';
  const section = reviewing ? null : sections[view];
  const unanswered = allQuestions.filter((q) => !isAnswered(answers[q.key]));
  const unsaved = Object.values(saveState).some((s) => s === 'saving' || s === 'error');

  return (
    <div className="lab exam">
      <div className="lab__header">
        <header className="lab__bar">
          <div className="lab__bar-left">
            <span className="lab__seat">#{seatNumber}</span>
            <span className="lab__name">{displayName}</span>
            <span className="lab__session">{data?.title || session?.title}</span>
          </div>
          <div className="lab__bar-right">
            <span
              className={`lab__timer ${remaining === 'expired' ? 'is-warn' : ''}`}
              role="timer"
              aria-label="Time remaining"
            >
              <Icon name="clock" size={16} /> <span>{remaining || '—'}</span>
            </span>
            <ThemeToggle />
            <button
              className="theme-toggle"
              onClick={logout}
              aria-label="Exit session"
              title="Exit (your answers are saved)"
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </header>

        <nav className="stepper" aria-label="Exam sections">
          {sections.map((s, i) => {
            const done = s.questions.every((q) => isAnswered(answers[q.key]));
            const state = i === view ? 'current' : done ? 'done' : 'open';
            return (
              <button
                key={i}
                type="button"
                className={`stepper__node stepper__node--${state}`}
                onClick={() => goTo(i)}
                aria-current={i === view ? 'step' : undefined}
                aria-label={`Section ${i + 1}${done ? ' (all answered)' : ''}`}
                title={s.title}
              >
                <span className="stepper__dot" aria-hidden="true">
                  {done && i !== view ? <Icon name="check" size={15} strokeWidth={2.25} /> : i + 1}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className={`stepper__node stepper__node--${reviewing ? 'current' : 'open'}`}
            onClick={() => goTo('review')}
            aria-current={reviewing ? 'step' : undefined}
            aria-label="Review and submit"
            title="Review and submit"
          >
            <span className="stepper__dot" aria-hidden="true">
              <Icon name="check-circle" size={15} />
            </span>
          </button>
        </nav>

        <div className="lab__progress">
          <div
            className="lab__progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={answeredCount}
            aria-label="Questions answered"
          >
            <div
              className="lab__progress-fill"
              style={{ width: total ? `${(answeredCount / total) * 100}%` : '0%' }}
            />
          </div>
          <span className="lab__progress-label">
            {answeredCount} / {total} answered
          </span>
        </div>
      </div>

      <main className="lab__content">
        {error && <p className="form__error lab__error">{error}</p>}
        {!data && !error && <p className="lab__loading">Loading your exam…</p>}

        {section && (
          <div key={view} className="section-view section-view--next">
            <div className="section-head">
              <span className="section-head__eyebrow">
                Section {view + 1} of {sections.length}
              </span>
              <h1 className="section-head__title">{section.title}</h1>
            </div>
            {section.questions.map((q) => (
              <ExamQuestion
                key={q.key}
                q={q}
                value={answers[q.key]}
                saveState={saveState[q.key]}
                onChange={(v, opts) => change(q.key, v, opts)}
              />
            ))}
            <div className="section-nav">
              <button className="btn btn--ghost" disabled={view === 0} onClick={() => goTo(view - 1)}>
                <Icon name="chevronLeft" size={16} /> Previous
              </button>
              {view < sections.length - 1 ? (
                <button className="btn btn--primary" onClick={() => goTo(view + 1)}>
                  Next <Icon name="chevronRight" size={16} />
                </button>
              ) : (
                <button className="btn btn--primary" onClick={() => goTo('review')}>
                  Review &amp; submit <Icon name="chevronRight" size={16} />
                </button>
              )}
            </div>
          </div>
        )}

        {reviewing && data && (
          <div className="section-view section-view--next">
            <div className="section-head">
              <span className="section-head__eyebrow">Final step</span>
              <h1 className="section-head__title">Review &amp; submit</h1>
            </div>
            <div className="panel exam-review">
              <p>
                You have answered <strong>{answeredCount}</strong> of <strong>{total}</strong>{' '}
                questions.
              </p>
              {unanswered.length > 0 && (
                <div className="banner banner--warn" role="status">
                  <span>
                    <strong>Unanswered:</strong>{' '}
                    {unanswered.map((q, i) => {
                      const si = sections.findIndex((s) => s.questions.includes(q));
                      return (
                        <span key={q.key}>
                          <button
                            type="button"
                            className="linklike"
                            onClick={() => {
                              goTo(si);
                              setTimeout(
                                () =>
                                  document
                                    .getElementById(`q-${q.key}`)
                                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
                                120,
                              );
                            }}
                          >
                            Q{q.number}
                          </button>
                          {i < unanswered.length - 1 ? ', ' : ''}
                        </span>
                      );
                    })}
                  </span>
                </div>
              )}
              <p className="muted small">
                Once submitted your answers are final and cannot be changed. Your answers are saved
                as you go, so you can also leave this page and come back before submitting.
              </p>
              <div className="section-nav">
                <button className="btn btn--ghost" onClick={() => goTo(sections.length - 1)}>
                  <Icon name="chevronLeft" size={16} /> Back to questions
                </button>
                <button
                  className="btn btn--primary"
                  disabled={submitting}
                  onClick={() => {
                    const msg = unanswered.length
                      ? `${unanswered.length} question${unanswered.length === 1 ? ' is' : 's are'} unanswered. Submit anyway? Your answers cannot be changed afterwards.`
                      : 'Submit your exam? Your answers cannot be changed afterwards.';
                    if (window.confirm(msg)) handleSubmit();
                  }}
                >
                  <Icon name="check-circle" size={16} />{' '}
                  {submitting ? 'Submitting…' : unsaved ? 'Save & submit' : 'Submit exam'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="lab__footprint">
        Answers save automatically to the server — nothing is stored on this device.
      </footer>
    </div>
  );
}
