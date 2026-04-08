'use client';

import { useState, useEffect, useCallback } from 'react';
import { api, setToken } from '../lib/api-client';

interface User {
  id: string;
  email: string | null;
  fullName: string;
  roleCode: string;
  siteId: string | null;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const stored = typeof window !== 'undefined'
      ? sessionStorage.getItem('bsop_token')
      : null;
    if (stored) {
      setToken(stored);
      api.get<User>('/auth/me')
        .then((user) => setState({ user, loading: false, error: null }))
        .catch(() => {
          sessionStorage.removeItem('bsop_token');
          setToken(null);
          setState({ user: null, loading: false, error: null });
        });
    } else {
      setState({ user: null, loading: false, error: null });
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.post<{
        accessToken: string;
        refreshToken: string;
        user: User;
      }>('/auth/login', { email, password });
      setToken(res.accessToken);
      sessionStorage.setItem('bsop_token', res.accessToken);
      sessionStorage.setItem('bsop_refresh', res.refreshToken);
      setState({ user: res.user, loading: false, error: null });
    } catch (e) {
      setState({
        user: null,
        loading: false,
        error: e instanceof Error ? e.message : 'Login failed',
      });
    }
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    sessionStorage.removeItem('bsop_token');
    sessionStorage.removeItem('bsop_refresh');
    setState({ user: null, loading: false, error: null });
  }, []);

  return { ...state, login, logout };
}
