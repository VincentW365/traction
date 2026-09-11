'use client';

/**
 * CR-2026-105b — staff pages subscribe to the queue gateway's `queue:updated` poke
 * and refresh their own (authorised) queries, instead of only polling. The socket
 * carries no payload and no PII — it is shared with the lobby display — so every
 * page simply refetches what it is already allowed to read.
 *
 * Polling stays as the fallback on every page; this only makes updates immediate.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';

function resolveApiBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001/api/v1`;
  }
  return 'http://localhost:3001/api/v1';
}

// Socket.IO namespaces live at the server root, not under the HTTP global prefix.
function resolveSocketUrl(): string {
  return resolveApiBaseUrl().replace(/\/api\/v\d+\/?$/, '');
}

/**
 * Subscribe to a site's queue updates. Returns whether the socket is connected
 * (false while falling back to polling). `siteId` may be undefined until known.
 */
export function useQueueSocket(siteId: string | null | undefined, onUpdate?: () => void): boolean {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!siteId) return;
    let socket: Socket | undefined;
    try {
      socket = io(`${resolveSocketUrl()}/queue`, {
        query: { siteId },
        transports: ['websocket'],
        reconnection: true,
      });
      socket.on('connect', () => setConnected(true));
      socket.on('disconnect', () => setConnected(false));
      socket.on('queue:updated', () => {
        // Every active query on the page refetches — board, dispatch, timing, KPI.
        void queryClient.invalidateQueries();
        onUpdateRef.current?.();
      });
    } catch {
      // Enhancement only — polling keeps the page fresh.
      setConnected(false);
    }
    return () => {
      socket?.disconnect();
    };
  }, [siteId, queryClient]);

  return connected;
}
