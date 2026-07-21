import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, participantSession } from '../api.js';
import ThemeToggle from '../components/ThemeToggle.jsx';

/**
 * Participant entry point. Registers by 6-digit room code + first/last name;
 * the server assigns an ascending seat number. If a previous session token is
 * stored locally, a "resume" banner lets a participant who closed their browser
 * jump straight back in.
 */
export default function Join() {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const stored = participantSession.get();

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
        <Link to="/" className="brand brand--sm">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">vLabs</span>
        </Link>

        {stored && (
          <button
            type="button"
            className="resume-banner"
            onClick={() => navigate('/lab', { replace: true, state: stored })}
          >
            <span className="resume-banner__icon" aria-hidden="true">↻</span>
            <span className="resume-banner__text">
              <strong>Welcome back, {stored.name}</strong>
              <span>Resume “{stored.session?.title}” as #{stored.seatNumber}</span>
            </span>
            <span className="resume-banner__cta">Resume →</span>
          </button>
        )}

        <h1 className="auth-card__title">Join a session</h1>
        <p className="auth-card__sub">
          Enter the code from the instructor's screen and register your name.
        </p>

        <form onSubmit={handleSubmit} className="form">
          <label className="field">
            <span className="field__label">Room code</span>
            <input
              className="field__input field__input--code"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              placeholder="123456"
              value={roomCode}
              onChange={(e) =>
                setRoomCode(e.target.value.replace(/\D/g, '').slice(0, 6))
              }
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
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </label>
          </div>

          {error && <p className="form__error">{error}</p>}

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Registering…' : 'Register & enter lab'}
          </button>
        </form>
      </div>
    </div>
  );
}
