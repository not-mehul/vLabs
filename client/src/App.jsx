import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Landing from './pages/Landing.jsx';
import Join from './pages/Join.jsx';
import Lab from './pages/Lab.jsx';
import InstructorLogin from './pages/InstructorLogin.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Templates from './pages/Templates.jsx';
import TemplateEditor from './pages/TemplateEditor.jsx';
import SessionMonitor from './pages/SessionMonitor.jsx';

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
    <Routes>
      <Route path="/" element={<Landing />} />

      {/* Participant portal */}
      <Route path="/join" element={<Join />} />
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
  );
}
