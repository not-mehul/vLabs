import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import Icon from '../components/Icon.jsx';

const MIN_LENGTH = 10;

/**
 * Instructor account page: change password. A successful change rotates the
 * account's token version server-side, which signs out every other browser
 * holding an older instructor token; this tab continues on the fresh token
 * returned by the API.
 */
export default function Account() {
  const { instructor, replaceToken } = useAuth();
  const { call } = useInstructorApi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setDone(false);
    if (next.length < MIN_LENGTH) {
      setError(`New password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError('New password and confirmation do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await call((t) => api.changePassword(t, current, next));
      replaceToken(res.token, res.instructor);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(err.message || 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PortalShell>
      <div className="page-head">
        <h1>Account</h1>
        <p className="muted">
          Signed in as <strong>{instructor?.username || '…'}</strong>.
        </p>
      </div>

      <div className="panel account-panel">
        <h2 className="panel__title">
          <Icon name="key" size={16} /> Change password
        </h2>
        {instructor?.must_change_password && (
          <div className="banner banner--warn" role="status">
            This account still uses the default bootstrap password from the repository.
            Set a new one now.
          </div>
        )}
        <form className="form account-form" onSubmit={handleSubmit}>
          <label className="field">
            <span className="field__label">Current password</span>
            <input
              className="field__input"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span className="field__label">New password</span>
            <input
              className="field__input"
              type="password"
              autoComplete="new-password"
              minLength={MIN_LENGTH}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
            <span className="muted small">At least {MIN_LENGTH} characters. A short sentence works well.</span>
          </label>
          <label className="field">
            <span className="field__label">Confirm new password</span>
            <input
              className="field__input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>

          {error && <p className="form__error" role="alert">{error}</p>}
          {done && (
            <div className="banner banner--success" role="status">
              Password updated. Other signed-in browsers will need to sign in again.
            </div>
          )}

          <button type="submit" className="btn btn--primary" disabled={busy}>
            <Icon name="save" size={16} /> {busy ? 'Saving…' : 'Update password'}
          </button>
        </form>
      </div>
    </PortalShell>
  );
}
