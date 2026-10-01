import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, instructorToken } from '../api.js';

const AuthContext = createContext(null);

/** Holds the instructor session for the authoring / monitoring portal. */
export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => instructorToken.get());
  const [instructor, setInstructor] = useState(null);

  const login = useCallback(async (username, password) => {
    const res = await api.login(username, password);
    instructorToken.set(res.token);
    setToken(res.token);
    setInstructor(res.instructor);
    return res;
  }, []);

  const logout = useCallback(() => {
    instructorToken.clear();
    setToken(null);
    setInstructor(null);
  }, []);

  /** Swap in a freshly issued token (e.g. after a password change). */
  const replaceToken = useCallback((nextToken, nextInstructor) => {
    instructorToken.set(nextToken);
    setToken(nextToken);
    if (nextInstructor) setInstructor(nextInstructor);
  }, []);

  // On a portal refresh the token survives in sessionStorage but the
  // instructor profile doesn't; re-fetch it so the "change your password"
  // nudge and username are available. A revoked/expired token is dropped.
  useEffect(() => {
    if (!token || instructor) return;
    let cancelled = false;
    api
      .me(token)
      .then((res) => {
        if (!cancelled) setInstructor(res.instructor);
      })
      .catch((err) => {
        if (!cancelled && err && err.status === 401) logout();
      });
    return () => {
      cancelled = true;
    };
  }, [token, instructor, logout]);

  return (
    <AuthContext.Provider value={{ token, instructor, login, logout, setInstructor, replaceToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
