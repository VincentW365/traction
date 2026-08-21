'use client';

import { useState, useEffect, useCallback } from 'react';
import { api, setToken, ApiError } from '../lib/api-client';
import {
  clearSandboxMarkers,
  clearSession,
  getSandboxMarkers,
  getStoredAccessToken,
  onSessionEnded,
  storeSandboxMarkers,
  storeTokens,
} from '../lib/session';

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

// Where the session lives is owned by lib/session, because the API client needs the
// same keys to refresh an expired token. Two copies of them is how a refresh writes a
// token nothing else reads.

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


export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
    sandboxRunId: null,
    sandboxRole: null,
  });

  useEffect(() => {
    const stored = getStoredAccessToken();
    if (stored) {
      setToken(stored);
      // CR-2026-023 — restore the dev-sandbox markers across reloads (the JWT still
      // carries the sandboxRunId claim; sessionStorage mirrors it for the UI).
      const { runId: sandboxRunId, role: sandboxRole } = getSandboxMarkers();
      api.get<User>('/auth/me')
        .then((user) => setState({ user: withSandboxAccess(user, sandboxRunId), loading: false, error: null, sandboxRunId, sandboxRole }))
        .catch((err) => {
          // Only an actual rejection ends the session. This used to clear the tokens on
          // ANY failure, so a dropped connection or a restarting API signed the user
          // out — and, because the access token lasts 15 minutes, so did simply leaving
          // the tab alone. Expiry is now handled by the client's refresh; anything that
          // still reaches here and is not a 401/403 is a transport problem, and the
          // stored session must survive it.
          const status = err instanceof ApiError ? err.status : 0;
          if (status !== 401 && status !== 403) {
            setState({
              user: null,
              loading: false,
              error: 'Could not reach the server. Your session is still active — retry in a moment.',
              sandboxRunId,
              sandboxRole,
            });
            return;
          }
          clearSession();
          setToken(null);
          setState({ user: null, loading: false, error: null, sandboxRunId: null, sandboxRole: null });
        });
    } else {
      setState({ user: null, loading: false, error: null, sandboxRunId: null, sandboxRole: null });
    }
  }, []);

  // The API client ends the session when a refresh token is finally rejected, which can
  // happen in the middle of any request. Without this the UI would keep rendering as
  // though signed in while every call failed.
  useEffect(() => {
    return onSessionEnded(() => {
      setState({ user: null, loading: false, error: null, sandboxRunId: null, sandboxRole: null });
    });
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
      storeTokens(res.accessToken, res.refreshToken);
      // Normal login is NOT a sandbox session — never set sandboxRunId.
      clearSandboxMarkers();
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
      storeTokens(res.accessToken, res.refreshToken);
      const sandboxRunId = res.sandboxRunId ?? null;
      const sandboxRole = res.user?.roleCode ?? null;
      if (sandboxRunId) {
        if (sandboxRole) storeSandboxMarkers(sandboxRunId, sandboxRole);
      } else {
        clearSandboxMarkers();
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
    clearSession();
    setState({ user: null, loading: false, error: null, sandboxRunId: null, sandboxRole: null });
  }, []);

  return { ...state, login, devLogin, logout };
}
