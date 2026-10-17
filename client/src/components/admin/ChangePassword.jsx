import { useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useInstructorApi } from '../../hooks/useInstructorApi.js';
import Icon from '../Icon.jsx';
import PasswordInput from '../PasswordInput.jsx';

const MIN_LENGTH = 10;

/**
 * Admin page: change your own password. A successful change rotates the
 * account's token version server-side, which signs out every other browser
 * holding an older instructor token; this tab continues on the fresh token
 * returned by the API.
 */
export default function ChangePassword() {
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
    <section className="panel admin-grid__password" id="password" aria-labelledby="password-title">
      <h2 className="panel__title" id="password-title">
        <Icon name="key" size={16} /> Your password
      </h2>
      <p className="muted small">
        Signed in as <strong>{instructor?.username || '…'}</strong>.
      </p>
      {instructor?.must_change_password && (
        <div className="banner banner--warn" role="status">
          This account still uses a temporary password (the bootstrap password, or one set by
          another instructor). Set your own now.
        </div>
      )}
      <form className="form account-form" onSubmit={handleSubmit}>
        <label className="field">
          <span className="field__label">Current password</span>
          <PasswordInput
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span className="field__label">New password</span>
          <PasswordInput
            autoComplete="new-password"
            minLength={MIN_LENGTH}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
          <span className="muted small">
            At least {MIN_LENGTH} characters. A short sentence works well.
          </span>
        </label>
        <label className="field">
          <span className="field__label">Confirm new password</span>
          <PasswordInput
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </label>

        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        {done && (
          <div className="banner banner--success" role="status">
            Password updated. Other signed-in browsers will need to sign in again.
          </div>
        )}

        <button type="submit" className="btn btn--primary" disabled={busy}>
          <Icon name="save" size={16} /> {busy ? 'Saving…' : 'Update password'}
        </button>
      </form>
    </section>
  );
}
