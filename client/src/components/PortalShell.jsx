import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import ThemeToggle from './ThemeToggle.jsx';

/** Chrome for the instructor portal: top nav + logout. */
export default function PortalShell({ children }) {
  const { logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/instructor/login', { replace: true });
  }

  return (
    <div className="portal">
      <header className="portal__nav">
        <Link to="/instructor" className="brand brand--sm">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">vLabs</span>
          <span className="brand__tag">Instructor</span>
        </Link>
        <nav className="portal__links">
          <NavLink to="/instructor" end className="portal__link">
            Sessions
          </NavLink>
          <NavLink to="/instructor/templates" className="portal__link">
            Templates
          </NavLink>
        </nav>
        <div className="portal__actions">
          <ThemeToggle />
          <button className="btn btn--ghost btn--sm" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="portal__main">{children}</main>
    </div>
  );
}
