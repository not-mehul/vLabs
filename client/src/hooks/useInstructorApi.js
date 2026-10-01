import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { ApiError } from '../api.js';

/**
 * Returns a `call(fn)` helper that injects the instructor token and, on a 401,
 * clears the session and redirects to login. `fn` receives the token.
 */
export function useInstructorApi() {
  const { token, logout } = useAuth();
  const navigate = useNavigate();

  const call = useCallback(
    async (fn) => {
      try {
        return await fn(token);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
          navigate('/instructor/login', { replace: true });
        }
        throw err;
      }
    },
    [token, logout, navigate],
  );

  return { token, call };
}
