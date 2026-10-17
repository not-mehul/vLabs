import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

export default function InstructorLogin() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Only ever back into the portal (never an outside or odd-looking path).
  const back = location.state?.from?.pathname;
  const from = /^\/instructor(\/|$)/.test(back || '') ? back : '/instructor';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(username.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message || 'Login failed.');
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
        <h1 className="auth-card__title">Instructor sign in</h1>
        <p className="auth-card__sub">Author templates and run live sessions.</p>

        <form onSubmit={handleSubmit} className="form">
          <label className="field">
            <span className="field__label">Username</span>
            <input
              className="field__input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field__label">Password</span>
            <PasswordInput
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <p className="form__error">{error}</p>}

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/* Deliberately discreet: adding an account needs an existing
            instructor's credentials anyway (see AddInstructor.jsx). */}
        <Link to="/instructor/add" className="auth-card__quiet-link">
          Add an instructor
        </Link>
      </div>
    </div>
  );
}
