import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, ApiError, participantSession } from '../api.js';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Icon from '../components/Icon.jsx';

/**
 * Participant entry point. Registers by 6-digit room code + first/last name;
 * the server assigns an ascending seat number. If a previous session token is
 * stored locally AND still valid, a "resume" banner lets a participant who
 * closed their browser jump straight back in. If that session has since been
 * ended/expired/deleted by the instructor, the stored session is cleared so it
 * never shows here.
 */
export default function Join() {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stored, setStored] = useState(() => participantSession.get());

  // Validate the stored session on mount; drop it if it's no longer live.
  // /status is the cheap liveness probe (no rendered content, no scrape-limit
  // cost) — /content used to be pulled here just to check the token.
  useEffect(() => {
    const s = participantSession.get();
    if (!s) return;
    api
      .status(s.token)
      .then((res) => {
        // Keep the resume banner's expiry fresh.
        participantSession.set({ ...s, session: { ...s.session, expires_at: res.expires_at } });
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          participantSession.clear();
          setStored(null);
        }
      });
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!/^\d{6}$/.test(roomCode)) {
      setError('Room code must be 6 digits.');
      return;
    }
    if (!firstName.trim() || !lastName.trim()) {
      setError('Enter your first and last name.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.join(roomCode, firstName.trim(), lastName.trim());
      const session = {
        token: res.token,
        seatNumber: res.seat_number,
        name: `${res.first_name} ${res.last_name}`,
        session: res.session,
      };
      participantSession.set(session);
      navigate('/lab', { replace: true, state: session });
    } catch (err) {
      setError(err.message || 'Could not join. Check your code and name.');
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <ThemeToggle className="theme-toggle--corner" />
      <div className="auth-card">
        <div className="brand brand--sm">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">vLabs</span>
        </div>

        {stored && (
          <button
            type="button"
            className="resume-banner"
            onClick={() => navigate('/lab', { replace: true, state: stored })}
          >
            <span className="resume-banner__icon">
              <Icon name="refresh" size={18} />
            </span>
            <span className="resume-banner__text">
              <strong>Welcome back, {stored.name}</strong>
              <span>
                Resume “{stored.session?.title}” as #{stored.seatNumber}
              </span>
            </span>
            <span className="resume-banner__cta">
              <Icon name="chevronRight" size={18} />
            </span>
          </button>
        )}

        <h1 className="auth-card__title">Join a session</h1>
        <p className="auth-card__sub">
          Enter the code from the instructor's screen and register your name.
        </p>

        <form onSubmit={handleSubmit} className="form" noValidate>
          <label className="field">
            <span className="field__label">Room code</span>
            <input
              className="field__input field__input--code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="123456"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span className="field__label">First name</span>
              <input
                className="field__input"
                autoComplete="given-name"
                placeholder="Ada"
                maxLength={60}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">Last name</span>
              <input
                className="field__input"
                autoComplete="family-name"
                placeholder="Lovelace"
                maxLength={60}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </label>
          </div>

          {error && (
            <p className="form__error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Registering…' : 'Register & enter lab'}
          </button>
        </form>

        <div className="auth-card__alt">
          <Link to="/instructor/login" className="auth-card__alt-link inline-link">
            Instructor sign in <Icon name="chevronRight" size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
}
