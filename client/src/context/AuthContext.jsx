import { createContext, useContext, useState, useCallback } from 'react';
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

  return (
    <AuthContext.Provider value={{ token, instructor, login, logout, setInstructor }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
