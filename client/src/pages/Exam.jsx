import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, participantSession, clockOffset } from '../api.js';
import { useCountdown } from '../hooks/useCountdown.js';
import ExamQuestion from '../components/ExamQuestion.jsx';
import Markdown from '../components/Markdown.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Icon from '../components/Icon.jsx';
import { sectionPages } from '../../../shared/exam-schema.js';

const isAnswered = (v) =>
  v !== undefined &&
  v !== null &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === 'string' && v.trim() === '');

/** Debounce for typed answers; choices save immediately. */
const TYPE_DELAY_MS = 800;

/**
 * Sessions launched before exams carried their own submit section get the
 * one every exam now ends with (shared/exam-schema.js), added here so the
 * page works the same for them. It is never reported to the server.
 */
function withSubmitSection(res) {
  if (res.submitted || res.submit_section >= 0) return res;
  const total = res.total_sections;
  const open = (res.unlocked_section ?? 0) >= total - 1;
  const submit = {
    index: total,
    type: 'submit',
    title: 'Review and submit',
    body: '',
    review: true,
    virtual: true,
  };
  return {
    ...res,
    total_sections: total + 1,
    unlocked_section: open ? total : res.unlocked_section,
    sections: open ? [...res.sections, submit] : res.sections,
  };
}

/** True when every tick of a checklist is ticked (always, for anything else). */
const ticked = (it, answers) => (it?.tasks || []).every((t) => answers[t.key] === true);

/** True when an item lets the participant move on: answered, or all ticked. */
const itemDone = (it, answers) => (it.key ? isAnswered(answers[it.key]) : ticked(it, answers));

/** The questions of a delivered section (they carry their answer key). */
const questionsOf = (s) => (s?.items || []).filter((it) => it.key);

/** True when a section lets the participant move on: every question answered and box ticked. */
const sectionDone = (s, answers) =>
  s.type !== 'submit' && (s.items || []).every((it) => itemDone(it, answers));

/** True when a section has a checklist with a box still to tick. */
const openChecklist = (s, answers) => (s?.items || []).some((it) => !ticked(it, answers));

/** A section's pages: lists of its items (see sectionPages). */
const pagesOf = (s) => sectionPages(s?.items).map((page) => page.map((ii) => s.items[ii]));

/**
 * The page to open for a link from the review: the one holding `key`, else
 * the first page with a box to tick, else the first page.
 */
const pageFor = (s, answers, key) => {
  const pages = pagesOf(s);
  const at = key
    ? pages.findIndex((page) => page.some((it) => it.key === key))
    : pages.findIndex((page) => page.some((it) => !ticked(it, answers)));
  return Math.max(at, 0);
};

/** Header badge for the autosave state of every answer together. */
const SAVE_BADGE = {
  saving: ['cloud-up', 'Saving…'],
  saved: ['cloud', 'Saved'],
  error: ['cloud-off', 'Not saved, retrying'],
};

/**
 * Participant exam, one section at a time. Sections unlock like a lab's: the
 * next section opens once every question in this one is answered and every
 * checklist item ticked (the server decides and only sends unlocked
 * sections; unticking an item locks what follows again); earlier sections
 * stay open to revisit. A section is shown a page at a time: each
 * Informational or Checklist item starts a page and the questions after it
 * join it; a page's questions are answered and boxes ticked before the next
 * page. The exam ends with its submit section. Answers save as they are given, shown once in the header;
 * the participant is never told whether an answer is right. Submitting is
 * final — the exam is no longer shown afterwards, not even for review.
 */
export default function Exam() {
  const location = useLocation();
  const navigate = useNavigate();
  const [resumed] = useState(() => location.state || participantSession.get());
  const { token, seatNumber, name, session } = resumed || {};

  const [data, setData] = useState(null);
  const [answers, setAnswers] = useState({});
  const [saveState, setSaveState] = useState({}); // key → saving | saved | error
  const [view, setView] = useState(0); // section index
  const [pageOf, setPageOf] = useState({}); // section index → page shown
  // Sections opened so far: one with nothing to answer is only done once seen.
  const [visited, setVisited] = useState(() => new Set());
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [liveExpiry, setLiveExpiry] = useState(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [onBreak, setOnBreak] = useState(false);
  const initialisedRef = useRef(false);
  const reportedRef = useRef(-1);
  const unlockedRef = useRef(0);
  const captureKeys = useRef(new Set()); // questions whose answer later sections show
  const timers = useRef({});
  const pending = useRef({}); // key → latest unsaved value
  const remaining = useCountdown(liveExpiry || data?.expires_at || session?.expires_at, {
    offsetMs,
  });

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
      const res = withSubmitSection(await api.exam(token));
      setData(res);
      setLiveExpiry(res.expires_at);
      setOffsetMs(clockOffset(res.server_time));
      setOnBreak(Boolean(res.on_break));
      setSubmitted(res.submitted);
      setVisited((v) => new Set([...v, ...(res.visited_sections || [])]));
      unlockedRef.current = res.unlocked_section ?? 0;
      captureKeys.current = new Set(
        res.sections.flatMap((s) =>
          questionsOf(s)
            .filter((q) => q.capture)
            .map((q) => q.key),
        ),
      );
      if (!res.submitted) {
        const last = res.unlocked_section ?? 0;
        if (!initialisedRef.current) {
          // Resume on the section they were last on.
          initialisedRef.current = true;
          setView(Math.min(res.current_section ?? 0, last));
        } else {
          setView((v) => Math.min(v, last));
        }
      }
      // Keep anything typed but not yet saved.
      setAnswers({ ...res.answers, ...pending.current });
      setError('');
      participantSession.set({
        token,
        seatNumber: res.seat_number ?? seatNumber,
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
        setOffsetMs(clockOffset(st.server_time));
        setOnBreak(Boolean(st.on_break));
        if (st.submitted) setSubmitted(true);
        // A pushed template, or the instructor changed the seat (new values).
        if (
          data &&
          (st.template_version !== data.template_version ||
            (st.seat_number != null && st.seat_number !== data.seat_number))
        ) {
          load();
        }
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
        const res = await api.saveAnswer(token, key, value);
        if (pending.current[key] === value) delete pending.current[key];
        setSaveState((s) => ({ ...s, [key]: 'saved' }));
        // Answering the last open question of a section unlocks the next one
        // (fetch it: the server only sends unlocked sections); unticking a
        // checklist item locks what follows again. An answer saved as a
        // variable changes the text of the sections after it.
        if (res && res.unlocked_section !== unlockedRef.current) {
          unlockedRef.current = res.unlocked_section;
          load();
        } else if (captureKeys.current.has(key)) {
          load();
        }
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
    [token, handleAuthError, load],
  );

  // Report the section being viewed: drives time per section (breaks
  // excluded) and the instructor's view of where everyone is.
  useEffect(() => {
    if (data && !submitted) setVisited((v) => (v.has(view) ? v : new Set([...v, view])));
    if (!data || submitted || reportedRef.current === view) return;
    if (data.sections[view]?.virtual) return;
    reportedRef.current = view;
    api.examProgress(token, view).catch(() => {});
  }, [view, data, submitted, token]);

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

  // Flush typed answers still waiting for their debounce when the tab is
  // hidden or closed (keepalive requests outlive the page), and on unmount.
  useEffect(() => {
    if (!token) return undefined;
    const t = timers.current;
    const flushOnExit = () => {
      for (const [k, v] of Object.entries(pending.current)) {
        clearTimeout(t[k]);
        api.saveAnswerOnExit(token, k, v);
      }
    };
    const onVisibility = () => document.visibilityState === 'hidden' && flushOnExit();
    window.addEventListener('pagehide', flushOnExit);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushOnExit);
      document.removeEventListener('visibilitychange', onVisibility);
      Object.values(t).forEach(clearTimeout);
    };
  }, [token]);

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
  // The server's number wins: the instructor may have changed the seat.
  const seat = data?.seat_number ?? seatNumber;
  const sections = data?.sections || []; // unlocked sections only
  const totalSections = data?.total_sections ?? sections.length;
  // An unticked checklist locks every section after it straight away (the
  // server agrees once the untick is saved).
  const firstOpenChecklist = sections.findIndex((s) => openChecklist(s, answers));
  const unlocked =
    firstOpenChecklist >= 0
      ? Math.min(data?.unlocked_section ?? 0, firstOpenChecklist)
      : (data?.unlocked_section ?? 0);
  const allQuestions = sections.flatMap(questionsOf);
  const answeredCount = allQuestions.filter((q) => isAnswered(answers[q.key])).length;
  const total = data?.question_count ?? allQuestions.length;

  if (submitted) {
    return (
      <div className="ended-screen">
        <ThemeToggle className="theme-toggle--corner" />
        <div className="ended-card ended-card--done">
          <span className="ended-card__icon ended-card__icon--done">
            <Icon name="flag" size={40} strokeWidth={1.9} />
          </span>
          <h1>Exam completed</h1>
          <p>
            Thank you, {displayName || `#${seat}`}. Your exam is complete and your answers have been
            recorded.
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

  const section = sections[view];
  const sectionComplete = section ? sectionDone(section, answers) : false;
  const nextUnlocked = view < unlocked;
  // A section always opens on its first page (going back opens the last one).
  const pages = section?.type === 'submit' ? [] : pagesOf(section);
  const pageIndex = Math.max(Math.min(pageOf[view] ?? 0, pages.length - 1), 0);
  const page = pages[pageIndex] || [];
  const multiPage = pages.length > 1;
  const onLastPage = !multiPage || pageIndex === pages.length - 1;
  const pageDone = page.every((it) => itemDone(it, answers));
  const canNext = onLastPage ? nextUnlocked : pageDone;
  const showPage = (i) => {
    setPageOf((m) => ({ ...m, [view]: i }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const nextSection = sections[view + 1];
  const unanswered = allQuestions.filter((q) => !isAnswered(answers[q.key]));
  const unticked = sections.filter((s) => openChecklist(s, answers));
  const unsaved = Object.values(saveState).some((s) => s === 'saving' || s === 'error');
  const states = Object.values(saveState);
  const saveBadge = states.includes('error')
    ? 'error'
    : states.includes('saving')
      ? 'saving'
      : states.length
        ? 'saved'
        : null;

  function jumpTo(si, key) {
    setPageOf((m) => ({ ...m, [si]: pageFor(sections[si], answers, key) }));
    goTo(si);
    const anchor = key && `q-${key}`;
    if (!anchor) return;
    setTimeout(
      () =>
        document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      120,
    );
  }

  /** Back to the previous section, on its last page. */
  function goBack() {
    const prev = sections[view - 1];
    setPageOf((m) => ({ ...m, [view - 1]: Math.max(pagesOf(prev).length - 1, 0) }));
    goTo(view - 1);
  }

  return (
    <div className="lab exam">
      <div className="lab__header">
        <header className="lab__bar">
          <div className="lab__bar-left">
            <span className="lab__seat">#{seat}</span>
            <span className="lab__name">{displayName}</span>
            <span className="lab__session">{data?.title || session?.title}</span>
          </div>
          <div className="lab__bar-right">
            {saveBadge && (
              <span
                className={`save-badge save-badge--${saveBadge}`}
                role="status"
                aria-live="polite"
                title={
                  saveBadge === 'saved'
                    ? 'Your answers are saved on the server (this does not mean they are right)'
                    : undefined
                }
              >
                <Icon name={SAVE_BADGE[saveBadge][0]} size={16} />
                <span className="save-badge__label">{SAVE_BADGE[saveBadge][1]}</span>
              </span>
            )}
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
          {Array.from({ length: totalSections }).map((_, i) => {
            const s = sections[i];
            const locked = i > unlocked || !s;
            const submitStep = s?.type === 'submit' || i === totalSections - 1;
            // Answered and ticked, and opened: a section with nothing to
            // answer is not ticked off before the participant has seen it.
            const done = !locked && visited.has(i) && sectionDone(s, answers);
            const state = i === view ? 'current' : locked ? 'locked' : done ? 'done' : 'open';
            const what = 'complete';
            return (
              <button
                key={i}
                type="button"
                className={`stepper__node stepper__node--${state}`}
                disabled={locked}
                onClick={() => goTo(i)}
                aria-current={i === view ? 'step' : undefined}
                aria-label={
                  submitStep
                    ? s?.title || 'Submit'
                    : `Section ${i + 1}${done ? ` (${what})` : locked ? ' (locked)' : ''}`
                }
                title={s ? s.title : 'Locked: finish the sections before it'}
              >
                <span className="stepper__dot" aria-hidden="true">
                  {submitStep ? (
                    <Icon name="flag" size={14} />
                  ) : done && i !== view ? (
                    <Icon name="check" size={15} strokeWidth={2.25} />
                  ) : (
                    i + 1
                  )}
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
        {onBreak && (
          <div className="banner banner--info lab__notice" role="status">
            <span>
              <strong>Break.</strong> Your instructor has paused the class — time on this section
              isn&apos;t counted until the break ends.
            </span>
          </div>
        )}
        {error && <p className="form__error lab__error">{error}</p>}
        {!data && !error && <p className="lab__loading">Loading your exam…</p>}

        {section && section.type !== 'submit' && (
          <div key={view} className="section-view section-view--next">
            <div className="section-head">
              <span className="section-head__eyebrow">
                Section {section.index + 1} of {totalSections}
              </span>
              <h1 className="section-head__title">{section.title}</h1>
            </div>
            {multiPage && (
              <div className="exam-steps" aria-live="polite">
                <span>
                  Page {pageIndex + 1} of {pages.length}
                </span>
              </div>
            )}
            <div key={pageIndex} className="exam-page">
              {page.map((it, i) =>
                it.key ? (
                  <ExamQuestion
                    key={it.key}
                    q={it}
                    value={answers[it.key]}
                    onChange={(v, opts) => change(it.key, v, opts)}
                  />
                ) : (
                  <div key={`step-${i}`} className="panel exam-info">
                    {it.title && <h2 className="exam-steps__title">{it.title}</h2>}
                    {it.body && <Markdown>{it.body}</Markdown>}
                    {it.tasks?.length > 0 && (
                      <fieldset className="exam-checklist">
                        <legend className="exam-checklist__legend">
                          <Icon name="checklist" size={15} /> Tick each item once it is done
                        </legend>
                        {it.tasks.map((t) => {
                          const on = answers[t.key] === true;
                          return (
                            <label
                              key={t.key}
                              id={`task-${t.key}`}
                              className={`choice exam-checklist__item ${on ? 'choice--on' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={(e) => {
                                  // Stay on this page: ticking its last box must not move on.
                                  setPageOf((m) => ({ ...m, [view]: pageIndex }));
                                  change(t.key, e.target.checked ? true : null, {
                                    immediate: true,
                                  });
                                }}
                              />
                              <span className="choice__text">
                                <Markdown>{t.text}</Markdown>
                              </span>
                            </label>
                          );
                        })}
                      </fieldset>
                    )}
                  </div>
                ),
              )}
            </div>
            <div className="section-nav">
              <button
                className="btn btn--ghost"
                disabled={view === 0 && pageIndex <= 0}
                onClick={() => (multiPage && pageIndex > 0 ? showPage(pageIndex - 1) : goBack())}
              >
                <Icon name="chevronLeft" size={16} />{' '}
                {multiPage && pageIndex > 0 ? 'Previous page' : 'Previous'}
              </button>
              {!canNext && !(onLastPage && sectionComplete) && (
                <span className="section-nav__hint" role="status">
                  <Icon name="lock" size={14} />{' '}
                  {(onLastPage ? section.items : page).some((it) => !ticked(it, answers))
                    ? 'Tick every item to continue'
                    : 'Answer every question to continue'}
                </span>
              )}
              {!onLastPage ? (
                <button
                  className="btn btn--primary"
                  disabled={!canNext}
                  onClick={() => showPage(pageIndex + 1)}
                  title={canNext ? '' : 'Finish this page first'}
                >
                  Next page <Icon name="chevronRight" size={16} />
                </button>
              ) : (
                section.index < totalSections - 1 && (
                  <button
                    className="btn btn--primary"
                    disabled={!nextUnlocked}
                    onClick={() => goTo(section.index + 1)}
                    title={nextUnlocked ? '' : 'Finish this section first'}
                  >
                    {sectionComplete && !nextUnlocked
                      ? 'Saving…'
                      : nextSection?.type === 'submit'
                        ? nextSection.title || 'Submit'
                        : 'Next'}{' '}
                    <Icon name="chevronRight" size={16} />
                  </button>
                )
              )}
            </div>
          </div>
        )}

        {section && section.type === 'submit' && (
          <div key={view} className="section-view section-view--next">
            <div className="section-head">
              <span className="section-head__eyebrow">Final step</span>
              <h1 className="section-head__title">{section.title || 'Submit'}</h1>
            </div>
            <div className="panel exam-review">
              {section.body && <Markdown>{section.body}</Markdown>}
              {section.review && (
                <>
                  <p>
                    You have answered <strong>{answeredCount}</strong> of <strong>{total}</strong>{' '}
                    questions.
                  </p>
                  {unanswered.length > 0 && (
                    <div className="banner banner--warn" role="status">
                      <span>
                        <strong>Unanswered:</strong>{' '}
                        {unanswered.map((q, i) => (
                          <span key={q.key}>
                            <button
                              type="button"
                              className="linklike"
                              onClick={() =>
                                jumpTo(
                                  sections.findIndex((s) => questionsOf(s).includes(q)),
                                  q.key,
                                )
                              }
                            >
                              Q{q.number}
                            </button>
                            {i < unanswered.length - 1 ? ', ' : ''}
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
                  {unticked.length > 0 && (
                    <div className="banner banner--warn" role="status">
                      <span>
                        <strong>Checklist not complete:</strong>{' '}
                        {unticked.map((s, i) => (
                          <span key={s.index}>
                            <button
                              type="button"
                              className="linklike"
                              onClick={() => jumpTo(s.index)}
                            >
                              {s.title}
                            </button>
                            {i < unticked.length - 1 ? ', ' : ''}
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
                </>
              )}
              <div className="section-nav">
                <button className="btn btn--ghost" disabled={view === 0} onClick={goBack}>
                  <Icon name="chevronLeft" size={16} /> Previous
                </button>
                <button className="btn btn--primary" disabled={submitting} onClick={handleSubmit}>
                  <Icon name="flag" size={16} />{' '}
                  {submitting ? 'Submitting…' : unsaved ? 'Save & submit' : 'Submit'}
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
