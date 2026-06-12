'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';

// Resolve the API base URL at call time (browser-safe): explicit env override,
// else derive from the current host so a LAN device calls the same host:3001
// (not its own localhost); SSR fallback → localhost. Not a frozen module value.
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

interface DisplayBoard {
  siteId: string;
  siteName: string;
  generatedAt: string;
  inQueue: { ticketNumber: string; position: number | null }[];
  inService: { ticketNumber: string; bay: string | null }[];
  ready: { ticketNumber: string }[];
}

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export default function DisplayBoardPage() {
  const params = useParams();
  const token = params.token as string;
  const clock = useClock();

  const { data, isLoading, error, refetch } = useQuery<DisplayBoard>({
    queryKey: ['display-board', token],
    queryFn: async () => {
      const res = await fetch(`${resolveApiBaseUrl()}/display/${token}`);
      if (!res.ok) {
        if (res.status === 404) throw new Error('INVALID');
        throw new Error('Failed to load board');
      }
      return res.json();
    },
    refetchInterval: 10000, // polling safety net; socket pushes instant updates
    retry: false,
  });

  // Live updates: subscribe to the queue gateway and refetch on recompute.
  const siteId = data?.siteId;
  useEffect(() => {
    if (!siteId) return;
    let socket: Socket | undefined;
    try {
      socket = io(`${resolveSocketUrl()}/queue`, {
        query: { siteId },
        transports: ['websocket'],
        reconnection: true,
      });
      socket.on('queue:updated', () => refetch());
    } catch {
      // socket is an enhancement only — polling still keeps the board fresh
    }
    return () => {
      socket?.disconnect();
    };
  }, [siteId, refetch]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="flex items-center gap-4 text-slate-400">
          <div className="w-8 h-8 border-4 border-slate-700 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-xl">Loading service board…</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    const invalid = (error as Error)?.message === 'INVALID';
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="text-2xl font-bold text-slate-200 mb-2">
            {invalid ? 'Display board unavailable' : 'Unable to load the board'}
          </div>
          <p className="text-slate-400">
            {invalid
              ? 'This display link is invalid. Please contact the front desk.'
              : 'Reconnecting…'}
          </p>
        </div>
      </div>
    );
  }

  const updatedTime = clock
    ? clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const queueRanked = data.inQueue.filter((i) => i.position != null).length;

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-5 border-b border-slate-700/60 shrink-0">
        <div className="flex items-center gap-4">
          <img src="/brand-mark.png" alt="" className="h-9 w-auto object-contain" />
          <div>
            <div className="text-2xl font-bold tracking-tight">{data.siteName}</div>
            <div className="text-sm text-slate-400">Service Status</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-4xl font-bold tabular-nums">{updatedTime}</div>
          <div className="flex items-center justify-end gap-2 text-xs text-slate-400 mt-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </div>
        </div>
      </header>

      {/* Columns */}
      <div className="flex-1 grid grid-cols-3 gap-px bg-slate-700/40 overflow-hidden">
        <BoardColumn
          title="In Queue"
          accent="text-blue-300"
          count={data.inQueue.length}
          empty="No vehicles waiting"
        >
          {data.inQueue.map((item) => (
            <Row key={item.ticketNumber} ticket={item.ticketNumber} accent="text-blue-300">
              {item.position != null ? (
                <div className="text-right">
                  <div className="text-3xl font-bold text-slate-200 tabular-nums">#{item.position}</div>
                  <div className="text-sm text-slate-500">of {queueRanked}</div>
                </div>
              ) : (
                <div className="text-lg text-slate-500">Holding</div>
              )}
            </Row>
          ))}
        </BoardColumn>

        <BoardColumn
          title="In Service"
          accent="text-amber-300"
          count={data.inService.length}
          empty="No active jobs"
        >
          {data.inService.map((item) => (
            <Row key={item.ticketNumber} ticket={item.ticketNumber} accent="text-amber-300">
              <div className="text-2xl font-semibold text-amber-200">
                {item.bay ?? 'Called'}
              </div>
            </Row>
          ))}
        </BoardColumn>

        <BoardColumn
          title="Ready for Pickup"
          accent="text-emerald-300"
          count={data.ready.length}
          empty="Nothing ready yet"
        >
          {data.ready.map((item) => (
            <Row key={item.ticketNumber} ticket={item.ticketNumber} accent="text-emerald-300" highlight>
              <svg className="w-9 h-9 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </Row>
          ))}
        </BoardColumn>
      </div>

      {/* Footer */}
      <footer className="px-8 py-3 text-center text-sm text-slate-500 border-t border-slate-700/60 shrink-0">
        Find your ticket number — given to you at check-in. Updates automatically.
      </footer>
    </div>
  );
}

function BoardColumn({
  title,
  accent,
  count,
  empty,
  children,
}: {
  title: string;
  accent: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="bg-slate-900 flex flex-col overflow-hidden">
      <div className="px-6 py-4 flex items-baseline justify-between shrink-0">
        <h2 className={`text-xl font-bold uppercase tracking-wider ${accent}`}>{title}</h2>
        <span className="text-lg font-semibold text-slate-500 tabular-nums">{count}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {count === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-600 text-lg">{empty}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function Row({
  ticket,
  accent,
  children,
  highlight,
}: {
  ticket: string;
  accent: string;
  children: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-xl px-5 py-4 ${
        highlight ? 'bg-emerald-500/10 ring-1 ring-emerald-500/30' : 'bg-slate-800/70'
      }`}
    >
      <div className={`text-4xl font-extrabold tabular-nums ${accent}`}>{ticket}</div>
      {children}
    </div>
  );
}
