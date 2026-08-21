/**
 * The access token lasts 15 minutes. A tab left alone for longer than that used to come
 * back dead: every request 401'd, and the next mount's `/auth/me` failure wiped the
 * stored tokens and dropped the user at the login screen.
 *
 * A refresh token was being stored the whole time, and the API has always had
 * /auth/refresh — nothing ever called it. These tests pin the behaviour that closes
 * that gap, and the two ways it could regress into something worse: signing out on a
 * network blip, or stampeding the refresh endpoint when a screen full of queries all
 * expire at once.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const ACCESS = 'access-token-1';
const REFRESHED = 'access-token-2';
const REFRESH = 'refresh-token-1';

/** Minimal sessionStorage, since jsdom is not configured for this package. */
function installSessionStorage() {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  vi.stubGlobal('window', { location: { protocol: 'http:', hostname: 'localhost' } });
  vi.stubGlobal('sessionStorage', mock);
  return store;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

async function freshClient() {
  vi.resetModules();
  const session = await import('../lib/session');
  const client = await import('../lib/api-client');
  return { session, client };
}

let store: Map<string, string>;

beforeEach(() => {
  store = installSessionStorage();
  store.set('bsop_token', ACCESS);
  store.set('bsop_refresh', REFRESH);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an expired access token is refreshed transparently', () => {
  it('refreshes and retries, so the caller never sees the expiry', async () => {
    const fetchMock = vi
      .fn()
      // The original request, with the token that has just expired.
      .mockResolvedValueOnce(jsonResponse(401, { message: 'Unauthorized' }))
      // The refresh.
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: REFRESHED }))
      // The retry.
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await freshClient();
    await expect(client.api.get('/queue')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/auth/refresh');
    // The retry must carry the NEW token, or it 401s again for the same reason.
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${REFRESHED}`);
  });

  it('stores the new access token so later requests use it directly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: REFRESHED }))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await freshClient();
    await client.api.get('/queue');

    expect(store.get('bsop_token')).toBe(REFRESHED);
  });

  it('keeps the refresh token when the response does not rotate it', async () => {
    // This API returns only { accessToken }. Overwriting the refresh token with
    // undefined would sign the user out at the next expiry.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: REFRESHED }))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await freshClient();
    await client.api.get('/queue');

    expect(store.get('bsop_refresh')).toBe(REFRESH);
  });

  it('does not retry more than once', async () => {
    // A 401 that survives a fresh token is a permissions problem, not an expiry.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: REFRESHED }))
      .mockResolvedValueOnce(jsonResponse(401, { message: 'Forbidden' }));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await freshClient();
    await expect(client.api.get('/queue')).rejects.toThrow(/Forbidden/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never tries to refresh the login or refresh calls themselves', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { message: 'Bad password' }));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await freshClient();
    await expect(client.api.post('/auth/login', {})).rejects.toThrow(/Bad password/);

    // One call, not a refresh loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('concurrent expiries share one refresh', () => {
  it('six simultaneous 401s produce one refresh, not six', async () => {
    // A dashboard with several live queries hits the expiry all at once. Six refreshes
    // would race, and on a rotating token five would be rejected — ending the session
    // the first one just saved.
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('/auth/refresh')) {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse(200, { accessToken: REFRESHED });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === `Bearer ${REFRESHED}`
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, {});
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await freshClient();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => client.api.get(`/thing-${i}`)),
    );

    expect(results).toHaveLength(6);
    expect(refreshCalls).toBe(1);
  });
});

describe('the session survives what is not an expiry', () => {
  it('a network failure during refresh leaves the tokens alone', async () => {
    // Losing connectivity is not the same as being signed out. Clearing here is what
    // turned a dropped Wi-Fi connection into a logout.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await freshClient();
    await expect(client.api.get('/queue')).rejects.toThrow();

    expect(store.get('bsop_token')).toBe(ACCESS);
    expect(store.get('bsop_refresh')).toBe(REFRESH);
  });

  it('a 500 from the API does not touch the session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { message: 'boom' }));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await freshClient();
    await expect(client.api.get('/queue')).rejects.toThrow(/boom/);

    expect(store.get('bsop_token')).toBe(ACCESS);
  });

  it('errors carry their status so callers can tell the difference', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, { message: 'unavailable' }));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await freshClient();
    await expect(client.api.get('/queue')).rejects.toMatchObject({ status: 503 });
  });
});

describe('a rejected refresh token ends the session, once', () => {
  it('clears the stored session and notifies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(401, { message: 'Invalid or expired refresh token' }));
    vi.stubGlobal('fetch', fetchMock);

    const { client, session } = await freshClient();
    const ended = vi.fn();
    session.onSessionEnded(ended);

    await expect(client.api.get('/queue')).rejects.toThrow();

    expect(store.get('bsop_token')).toBeUndefined();
    expect(store.get('bsop_refresh')).toBeUndefined();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('recovers the stored token when the page reloaded and memory was empty', async () => {
    // A full page load starts with no in-memory token. Reading the stored one keeps the
    // first request of every page from going out unauthenticated.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await freshClient();
    await client.api.get('/queue');

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${ACCESS}`);
  });
});
