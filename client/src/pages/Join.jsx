import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';

/**
 * Participant entry point. Collects the 6-digit room code + seat ID, joins the
 * session, and hands the participant token to the Lab view via router state
 * (kept in memory, never persisted to disk).
 */
export default function Join() {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = useState('');
  const [seatId, setSeatId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!/^\d{6}$/.test(roomCode)) {
      setError('Room code must be 6 digits.');
      return;
    }
    if (!seatId.trim()) {
      setError('Enter your seat ID.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.join(roomCode, seatId.trim());
      navigate('/lab', {
        replace: true,
        state: { token: res.token, seatId: res.seat_id, session: res.session },
      });
    } catch (err) {
      setError(err.message || 'Could not join. Check your code and seat ID.');
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <Link to="/" className="brand brand--sm">
          <span className="brand__mark">v</span>
          <span className="brand__name">Labs</span>
        </Link>
        <h1 className="auth-card__title">Join a session</h1>
        <p className="auth-card__sub">
          Enter the code shown on the instructor's screen.
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

          <label className="field">
            <span className="field__label">Seat ID</span>
            <input
              className="field__input"
              autoComplete="off"
              placeholder="e.g. 7"
              value={seatId}
              onChange={(e) => setSeatId(e.target.value)}
            />
          </label>

          {error && <p className="form__error">{error}</p>}

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Joining…' : 'Enter lab'}
          </button>
        </form>
      </div>
    </div>
  );
}
