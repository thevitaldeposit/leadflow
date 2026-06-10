import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../utils/api';

const AuthContext = createContext(null);

// Holds the logged-in user + business. On mount it asks the server who we are
// (the httpOnly cookie does the talking); a 401 simply means "not logged in".
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [business, setBusiness] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user, business } = await api.getMe();
      setUser(user);
      setBusiness(business);
    } catch {
      setUser(null);
      setBusiness(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (email, password) => {
    const { user, business } = await api.login(email, password);
    setUser(user);
    setBusiness(business);
    return user;
  }, []);

  // Create an account and log in in one step — the register response sets the
  // same httpOnly cookie as login and returns the new user + business, so we
  // flip to authenticated immediately (no extra getMe round-trip).
  const register = useCallback(async (payload) => {
    const { user, business } = await api.register(payload);
    setUser(user);
    setBusiness(business);
    return { user, business };
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* clear locally regardless */ }
    setUser(null);
    setBusiness(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, business, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
