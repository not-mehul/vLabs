import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Join from './pages/Join.jsx';
import Lab from './pages/Lab.jsx';

// The instructor portal is a separate audience from participants (the bulk of
// traffic), so lazy-load it into its own chunk — a participant never downloads
// the editor / monitor / markdown tooling.
const InstructorLogin = lazy(() => import('./pages/InstructorLogin.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Templates = lazy(() => import('./pages/Templates.jsx'));
const TemplateEditor = lazy(() => import('./pages/TemplateEditor.jsx'));
const SessionMonitor = lazy(() => import('./pages/SessionMonitor.jsx'));

/** Gate instructor-only routes behind a token. */
function RequireInstructor({ children }) {
  const { token } = useAuth();
  const location = useLocation();
  if (!token) {
    return <Navigate to="/instructor/login" replace state={{ from: location }} />;
  }
  return children;
}

export default function App() {
  return (
    <Suspense fallback={<div className="route-loading">Loading…</div>}>
      <Routes>
      {/* Participant registration is the default landing page. */}
      <Route path="/" element={<Join />} />
      <Route path="/join" element={<Navigate to="/" replace />} />
      <Route path="/lab" element={<Lab />} />

      {/* Instructor portal */}
      <Route path="/instructor/login" element={<InstructorLogin />} />
      <Route
        path="/instructor"
        element={
          <RequireInstructor>
            <Dashboard />
          </RequireInstructor>
        }
      />
      <Route
        path="/instructor/templates"
        element={
          <RequireInstructor>
            <Templates />
          </RequireInstructor>
        }
      />
      <Route
        path="/instructor/templates/:id"
        element={
          <RequireInstructor>
            <TemplateEditor />
          </RequireInstructor>
        }
      />
      <Route
        path="/instructor/sessions/:id"
        element={
          <RequireInstructor>
            <SessionMonitor />
          </RequireInstructor>
        }
      />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
