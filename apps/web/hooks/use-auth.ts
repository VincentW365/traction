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
  // CR-2026-023 — set ONLY for dev-login sandbox sessions (null for normal login).
  sandboxRunId: string | null;
  sandboxRole: string | null;
}

// sessionStorage keys (survive page reload within the tab session)
const TOKEN_KEY = 'bsop_token';
const REFRESH_KEY = 'bsop_refresh';
const SANDBOX_RUN_KEY = 'bsop_sandbox_run_id';
const SANDBOX_ROLE_KEY = 'bsop_sandbox_role';

/**
 * CR-2026-047 — dev sandbox sessions get FULL feature access for testing. The
 * frontend gates features by roleCode, and no single role is a superset (e.g. the
 * technician "My Work" page is technician-only), so we present an effective role of
 * ADMIN for gating during a sandbox session. The actually-selected role is kept in
 * `sandboxRole` for display (banner/footer). Temporary + dev-only: only dev-login
 * sets sandboxRunId, and the API independently grants full permissions for the same
 * session. Real logins are unaffected.
 */
function withSandboxAccess(user: User, sandboxRunId: string | null): User {
  return sandboxRunId ? { ...user, roleCode: 'ADMIN' } : user;
}

/** Forget any dev-sandbox session markers (normal login + logout). */
function clearSandbox() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(SANDBOX_RUN_KEY);
  sessionStorage.removeItem(SANDBOX_ROLE_KEY);
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
    sandboxRunId: null,
    sandboxRole: null,
  });

  useEffect(() => {
    const stored = typeof window !== 'undefined'
      ? sessionStorage.getItem(TOKEN_KEY)
      : null;
    if (stored) {
      setToken(stored);
      // CR-2026-023 — restore the dev-sandbox markers across reloads (the JWT still
      // carries the sandboxRunId claim; sessionStorage mirrors it for the UI).
      const sandboxRunId = sessionStorage.getItem(SANDBOX_RUN_KEY);
      const sandboxRole = sessionStorage.getItem(SANDBOX_ROLE_KEY);
      api.get<User>('/auth/me')
        .then((user) => setState({ user: withSandboxAccess(user, sandboxRunId), loading: false, error: null, sandboxRunId, sandboxRole }))
        .catch(() => {
          sessionStorage.removeItem(TOKEN_KEY);
          clearSandbox();
          setToken(null);
          setState({ user: null, loading: false, error: null, sandboxRunId: null, sandboxRole: null });
        });
    } else {
      setState({ user: null, loading: false, error: null, sandboxRunId: null, sandboxRole: null });
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
      sessionStorage.setItem(TOKEN_KEY, res.accessToken);
      sessionStorage.setItem(REFRESH_KEY, res.refreshToken);
      // Normal login is NOT a sandbox session — never set sandboxRunId.
      clearSandbox();
      setState({ user: res.user, loading: false, error: null, sandboxRunId: null, sandboxRole: null });
    } catch (e) {
      setState({
        user: null,
        loading: false,
        error: e instanceof Error ? e.message : 'Login failed',
        sandboxRunId: null,
        sandboxRole: null,
      });
    }
  }, []);

  // CR-2026-022 — dev-only one-click login. Stores the same session as login(),
  // plus (CR-2026-023) the ephemeral sandbox run id returned by the API.
  const devLogin = useCallback(async (role: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.post<{
        accessToken: string;
        refreshToken: string;
        user: User;
        sandboxRunId?: string;
      }>('/auth/dev-login', { role });
      setToken(res.accessToken);
      sessionStorage.setItem(TOKEN_KEY, res.accessToken);
      sessionStorage.setItem(REFRESH_KEY, res.refreshToken);
      const sandboxRunId = res.sandboxRunId ?? null;
      const sandboxRole = res.user?.roleCode ?? null;
      if (sandboxRunId) {
        sessionStorage.setItem(SANDBOX_RUN_KEY, sandboxRunId);
        if (sandboxRole) sessionStorage.setItem(SANDBOX_ROLE_KEY, sandboxRole);
      } else {
        clearSandbox();
      }
      setState({ user: withSandboxAccess(res.user, sandboxRunId), loading: false, error: null, sandboxRunId, sandboxRole });
    } catch (e) {
      setState({
        user: null,
        loading: false,
        error: e instanceof Error ? e.message : 'Dev login failed',
        sandboxRunId: null,
        sandboxRole: null,
      });
    }
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
    clearSandbox();
    setState({ user: null, loading: false, error: null, sandboxRunId: null, sandboxRole: null });
  }, []);

  return { ...state, login, devLogin, logout };
}
