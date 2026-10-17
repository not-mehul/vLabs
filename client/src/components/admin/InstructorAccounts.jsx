import { useCallback, useEffect, useState } from 'react';
import { api, copyToClipboard } from '../../api.js';
import { formatDateTime } from '../../lib/datetime.js';
import { useInstructorApi } from '../../hooks/useInstructorApi.js';
import Icon from '../Icon.jsx';
import PasswordInput from '../PasswordInput.jsx';

const MIN_LENGTH = 10;

/** Shows a one-time temporary password with a copy button. */
export function TemporaryPassword({ username, password, onDismiss }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="banner banner--success temp-pw" role="status">
      <div>
        <strong>Temporary password for {username}</strong> — shown once. Share it privately; they
        will be asked to choose their own after signing in.
        <div className="temp-pw__row">
          <code className="temp-pw__code">{password}</code>
          <button
            type="button"
            className="btn btn--xs btn--ghost"
            onClick={async () => {
              if (await copyToClipboard(password)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      {onDismiss && (
        <button type="button" className="btn btn--xs btn--ghost" onClick={onDismiss}>
          Done
        </button>
      )}
    </div>
  );
}

/** Username + optional password fields shared by both add-instructor forms. */
export function NewInstructorFields({ username, setUsername, password, setPassword }) {
  return (
    <>
      <label className="field">
        <span className="field__label">New username</span>
        <input
          className="field__input"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="e.g. jsmith"
          maxLength={64}
          required
        />
        <span className="muted small">Letters, digits, dot, dash or underscore.</span>
      </label>
      <label className="field">
        <span className="field__label">Password (optional)</span>
        <PasswordInput
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Leave empty to generate a temporary one"
          minLength={password ? MIN_LENGTH : undefined}
        />
        <span className="muted small">
          At least {MIN_LENGTH} characters. Either way they are asked to set their own at first
          sign-in.
        </span>
      </label>
    </>
  );
}

/**
 * Admin page: the instructor accounts (reset a colleague's password, which
 * issues a one-time temporary password and signs them out everywhere, or
 * remove an account, whose sessions move to you) and a form to add one.
 * Every instructor may manage accounts.
 */
export default function InstructorAccounts() {
  const { call } = useInstructorApi();
  const [list, setList] = useState([]);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState(null); // { username, password }
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setList(await call((t) => api.listInstructors(t)));
    } catch (err) {
      setError(err.message);
    }
  }, [call]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function add(e) {
    e.preventDefault();
    setError('');
    setIssued(null);
    setBusy(true);
    try {
      const res = await call((t) =>
        api.createInstructor(t, { username: username.trim(), password }),
      );
      if (res.temporary_password) {
        setIssued({ username: res.instructor.username, password: res.temporary_password });
      } else {
        setIssued({ username: res.instructor.username, password: null });
      }
      setUsername('');
      setPassword('');
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function reset(i) {
    if (
      !window.confirm(
        `Reset the password for "${i.username}"?\n\nThey are signed out everywhere and get a new temporary password.`,
      )
    )
      return;
    setError('');
    try {
      const res = await call((t) => api.resetInstructorPassword(t, i.id));
      setIssued({ username: i.username, password: res.temporary_password });
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(i) {
    const sessions = i.session_count
      ? `\n\nTheir ${i.session_count} session(s), including participant data, will move to your account.`
      : '';
    if (!window.confirm(`Remove instructor "${i.username}"?${sessions}`)) return;
    setError('');
    try {
      await call((t) => api.removeInstructor(t, i.id));
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      {error && (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}
      {issued &&
        (issued.password ? (
          <TemporaryPassword
            username={issued.username}
            password={issued.password}
            onDismiss={() => setIssued(null)}
          />
        ) : (
          <div className="banner banner--success" role="status">
            Added <strong>{issued.username}</strong> with the password you chose.
          </div>
        ))}

      <div className="split">
        <section className="panel" aria-labelledby="instructors-title">
          <h2 className="panel__title" id="instructors-title">
            <Icon name="user" size={16} /> Instructors
          </h2>
          <p className="muted small">
            Everyone here can sign in to the portal, run sessions and edit the shared templates.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th className="col--md">Password</th>
                  <th className="col--sm">Sessions</th>
                  <th className="col--lg">Added</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id}>
                    <td className="table__primary">
                      {i.username}
                      {i.is_me && <span className="tag">you</span>}
                    </td>
                    <td className="col--md muted small">
                      {i.must_change_password ? (
                        <span className="text-warn">temporary</span>
                      ) : (
                        `changed ${formatDateTime(i.password_changed_at)}`
                      )}
                    </td>
                    <td className="col--sm">
                      {i.session_count}
                      {i.active_session_count > 0 && (
                        <>
                          {' · '}
                          <span className="status-live">{i.active_session_count} live</span>
                        </>
                      )}
                    </td>
                    <td className="col--lg muted">{formatDateTime(i.created_at)}</td>
                    <td className="table__actions">
                      {!i.is_me && (
                        <>
                          <button
                            className="btn btn--sm btn--icon btn--ghost"
                            onClick={() => reset(i)}
                            title="Reset password"
                            aria-label={`Reset password for ${i.username}`}
                          >
                            <Icon name="key" size={16} />
                          </button>
                          <button
                            className="btn btn--sm btn--icon btn--danger-ghost"
                            onClick={() => remove(i)}
                            title="Remove instructor"
                            aria-label={`Remove ${i.username}`}
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <form className="panel form" onSubmit={add} aria-labelledby="add-instructor-title">
          <h2 className="panel__title" id="add-instructor-title">
            <Icon name="plus" size={16} /> Add an instructor
          </h2>
          <NewInstructorFields
            username={username}
            setUsername={setUsername}
            password={password}
            setPassword={setPassword}
          />
          <button type="submit" className="btn btn--primary" disabled={busy || !username.trim()}>
            <Icon name="plus" size={15} /> {busy ? 'Adding…' : 'Add instructor'}
          </button>
        </form>
      </div>
    </>
  );
}
