import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Icon from '../components/Icon.jsx';
import { NewInstructorFields, TemporaryPassword } from './Instructors.jsx';

/**
 * Add an instructor without signing in first. Reached only by URL
 * (/instructor/add) or the discreet link under the sign-in form — it is not
 * in any navigation. An EXISTING instructor's username and password authorise
 * the new account, so the page grants nothing on its own.
 */
export default function AddInstructor() {
  const [authUser, setAuthUser] = useState('');
  const [authPass, setAuthPass] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.createInstructor(null, {
        username: username.trim(),
        password,
        authorize: { username: authUser.trim(), password: authPass },
      });
      setDone({ username: res.instructor.username, password: res.temporary_password });
      setUsername('');
      setPassword('');
      setAuthPass('');
    } catch (err) {
      setError(err.message || 'Could not add the instructor.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <ThemeToggle className="theme-toggle--corner" />
      <div className="auth-card auth-card--wide">
        <Link to="/" className="brand brand--sm">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">vLabs</span>
        </Link>
        <h1 className="auth-card__title">Add an instructor</h1>
        <p className="auth-card__sub">
          An existing instructor authorises the new account with their own sign-in.
        </p>

        {done &&
          (done.password ? (
            <TemporaryPassword username={done.username} password={done.password} />
          ) : (
            <div className="banner banner--success" role="status">
              Added <strong>{done.username}</strong> with the password you chose.
            </div>
          ))}

        <form onSubmit={handleSubmit} className="form">
          <fieldset className="fieldset">
            <legend className="fieldset__legend">
              <Icon name="key" size={14} /> Authorised by
            </legend>
            <label className="field">
              <span className="field__label">Your username</span>
              <input
                className="field__input"
                autoComplete="username"
                value={authUser}
                onChange={(e) => setAuthUser(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span className="field__label">Your password</span>
              <input
                className="field__input"
                type="password"
                autoComplete="current-password"
                value={authPass}
                onChange={(e) => setAuthPass(e.target.value)}
                required
              />
            </label>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset__legend">
              <Icon name="user" size={14} /> New instructor
            </legend>
            <NewInstructorFields
              username={username}
              setUsername={setUsername}
              password={password}
              setPassword={setPassword}
            />
          </fieldset>

          {error && (
            <p className="form__error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Adding…' : 'Add instructor'}
          </button>
        </form>

        <div className="auth-card__alt">
          <Link to="/instructor/login" className="auth-card__alt-link inline-link">
            <Icon name="chevronLeft" size={14} /> Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
