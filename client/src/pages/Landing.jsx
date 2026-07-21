import { Link } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle.jsx';

export default function Landing() {
  return (
    <div className="landing">
      <ThemeToggle className="theme-toggle--corner" />
      <div className="landing__inner">
        <div className="brand brand--lg">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">vLabs</span>
        </div>
        <p className="landing__tagline">
          Dynamic, session-gated lab manuals. Personalised for every seat, live
          on every screen — no PDFs, no downloads.
        </p>

        <div className="landing__cards">
          <Link to="/join" className="portal-card portal-card--participant">
            <span className="portal-card__icon" aria-hidden="true">🎫</span>
            <h2>I'm a Participant</h2>
            <p>Register with your name and a 6-digit room code to get your seat.</p>
            <span className="portal-card__cta">Enter a session →</span>
          </Link>

          <Link to="/instructor" className="portal-card portal-card--instructor">
            <span className="portal-card__icon" aria-hidden="true">🎛️</span>
            <h2>I'm an Instructor</h2>
            <p>Author templates, launch sessions and monitor live progress.</p>
            <span className="portal-card__cta">Open the portal →</span>
          </Link>
        </div>

        <footer className="landing__foot">
          Secure lab delivery · Content rendered in-memory only
        </footer>
      </div>
    </div>
  );
}
