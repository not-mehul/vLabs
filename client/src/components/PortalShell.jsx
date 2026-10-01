import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import Icon from './Icon.jsx';

/** Chrome for the instructor portal: top nav + account + logout. */
export default function PortalShell({ children }) {
  const { logout, instructor } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  function handleLogout() {
    logout();
    navigate('/instructor/login', { replace: true });
  }

  const onAccountPage = location.pathname === '/instructor/account';

  return (
    <div className="portal">
      <a className="skip-link" href="#portal-main">Skip to content</a>
      <header className="portal__nav">
        <Link to="/instructor" className="brand brand--sm">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">vLabs</span>
          <span className="brand__tag">Instructor</span>
        </Link>
        <nav className="portal__links" aria-label="Primary">
          <NavLink to="/instructor" end className="portal__link">
            Sessions
          </NavLink>
          <NavLink to="/instructor/templates" className="portal__link">
            Templates
          </NavLink>
          <NavLink to="/instructor/account" className="portal__link">
            Account
          </NavLink>
        </nav>
        <div className="portal__actions">
          {instructor?.username && (
            <span className="portal__user muted small" title="Signed in as">
              {instructor.username}
            </span>
          )}
          <ThemeToggle />
          <button className="btn btn--ghost btn--sm" onClick={handleLogout}>
            <Icon name="logout" size={15} /> Sign out
          </button>
        </div>
      </header>
      {instructor?.must_change_password && !onAccountPage && (
        <div className="banner banner--warn portal__banner" role="status">
          <span>
            <strong>You are using the default bootstrap password.</strong> Change it before
            running this in front of a class.
          </span>
          <Link className="btn btn--sm btn--primary" to="/instructor/account">
            Change password
          </Link>
        </div>
      )}
      <main id="portal-main" className="portal__main">{children}</main>
    </div>
  );
}
