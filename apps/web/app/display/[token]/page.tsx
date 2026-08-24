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
  timezone: string; // site-anchored; drives the header clock/date (CR-2026-079)
  generatedAt: string;
  totalInQueue: number;
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

// Format a Date in the site's timezone, degrading gracefully if the TZ string
// is unknown to the runtime (falls back to the browser's local zone).
function formatInTz(
  date: Date,
  timeZone: string | undefined,
  opts: Intl.DateTimeFormatOptions,
): string {
  try {
    return date.toLocaleString([], timeZone ? { ...opts, timeZone } : opts);
  } catch {
    return date.toLocaleString([], opts);
  }
}

// CR-2026-082 — static, PII-free service tips that rotate on the lobby display.
// No customer data — general service-centre guidance only.
const SERVICE_TIPS = [
  'Regular oil changes keep your engine running smoothly.',
  'Check your tire pressure monthly for safer, more efficient driving.',
  'Rotating your tires extends their life and improves handling.',
  'Ask our advisors about your vehicle’s maintenance schedule.',
  'A healthy battery helps prevent unexpected breakdowns.',
  'Wheel alignment improves safety and reduces tire wear.',
  'Keeping up with routine service protects your vehicle’s value.',
  'Thank you for choosing Bert’s Auto Parts Service Centre.',
];

// Advance through a list on a fixed interval (no-op for 0/1 items).
function useRotatingIndex(length: number, intervalMs: number): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (length <= 1) return;
    const id = setInterval(() => setI((prev) => (prev + 1) % length), intervalMs);
    return () => clearInterval(id);
  }, [length, intervalMs]);
  return i;
}

export default function DisplayBoardPage() {
  const params = useParams();
  const token = params.token as string;
  const clock = useClock();
  const tipIndex = useRotatingIndex(SERVICE_TIPS.length, 9000);

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
    staleTime: 8000, // data is fresh for 8s (socket updates within 1s typically)
    refetchInterval: 10000, // polling safety net; socket pushes instant updates
    retry: false,
  });

  // Live updates: subscribe to the queue gateway and refetch on recompute.
  const siteId = data?.siteId;
  const [socketConnected, setSocketConnected] = useState(true);
  useEffect(() => {
    if (!siteId) return;
    let socket: Socket | undefined;
    try {
      socket = io(`${resolveSocketUrl()}/queue`, {
        query: { siteId },
        transports: ['websocket'],
        reconnection: true,
      });
      socket.on('connect', () => setSocketConnected(true));
      socket.on('disconnect', () => setSocketConnected(false));
      socket.on('queue:updated', () => refetch());
    } catch (e) {
      // socket is an enhancement only — polling still keeps the board fresh
      console.warn('Socket.IO unavailable; using polling only', e);
    }
    return () => {
      socket?.disconnect();
    };
  }, [siteId, refetch]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
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
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-8">
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

  const timeStr = clock
    ? formatInTz(clock, data.timezone, { hour: '2-digit', minute: '2-digit' })
    : '';
  const dateStr = clock
    ? formatInTz(clock, data.timezone, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
    : '';

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white flex flex-col">
      {/* Faint automotive watermark — premium, not busy */}
      <GearWatermark className="pointer-events-none absolute -right-24 -top-24 h-[42rem] w-[42rem] text-white/[0.02]" />
      <GearWatermark className="pointer-events-none absolute -left-32 bottom-[-6rem] h-[30rem] w-[30rem] text-white/[0.015]" />

      {/* Header */}
      <header className="relative flex items-center justify-between gap-6 px-[clamp(1.5rem,3vw,3.5rem)] py-[clamp(1rem,1.8vw,2rem)] border-b border-white/10 shrink-0">
        <div className="flex items-center gap-[clamp(0.75rem,1.4vw,1.5rem)] min-w-0">
          <img
            src="/brand-mark.png"
            alt=""
            className="h-[clamp(2.25rem,3.6vw,4rem)] w-auto object-contain shrink-0"
          />
          <div className="min-w-0">
            <div className="text-[clamp(1.5rem,2.6vw,3rem)] font-bold tracking-tight leading-none truncate">
              {data.siteName}
            </div>
            <div className="mt-1 text-[clamp(0.7rem,1.1vw,1.15rem)] font-semibold uppercase tracking-[0.25em] text-blue-300/80">
              Live Service Queue
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[clamp(2rem,3.6vw,4.25rem)] font-bold tabular-nums leading-none">
            {timeStr}
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-2.5 text-[clamp(0.7rem,1vw,1.1rem)] text-slate-400">
            <span className="relative flex h-2.5 w-2.5" aria-label={socketConnected ? 'Connected' : 'Polling'}>
              {socketConnected && (
                <>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
                </>
              )}
              {!socketConnected && (
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
              )}
            </span>
            <span className="font-medium text-emerald-300">{socketConnected ? 'Live' : 'Polling'}</span>
            <span className="text-slate-600">·</span>
            <span>{dateStr}</span>
          </div>
        </div>
      </header>

      {/* Lanes */}
      <main className="relative flex-1 grid grid-cols-3 gap-[clamp(0.75rem,1.4vw,1.5rem)] p-[clamp(0.75rem,1.6vw,1.75rem)] overflow-hidden">
        <Lane
          title="In Queue"
          subtitle="Waiting to be called"
          count={data.inQueue.length}
          accent={ACCENTS.blue}
          icon={<ClockIcon />}
          empty="No vehicles waiting"
        >
          {data.inQueue.map((item) => (
            <TicketCard key={item.ticketNumber} ticket={item.ticketNumber} accent={ACCENTS.blue}>
              {item.position != null ? (
                <div className="text-right leading-none">
                  <div className="text-[clamp(1.75rem,3vw,3.5rem)] font-bold tabular-nums text-slate-100">
                    #{item.position}
                  </div>
                  <div className="mt-1 text-[clamp(0.75rem,1vw,1.1rem)] font-medium text-slate-400">
                    of {data.totalInQueue}
                  </div>
                </div>
              ) : (
                <div className="text-[clamp(1rem,1.4vw,1.5rem)] font-medium text-slate-500">Holding</div>
              )}
            </TicketCard>
          ))}
        </Lane>

        <Lane
          title="In Service"
          subtitle="Being worked on now"
          count={data.inService.length}
          accent={ACCENTS.amber}
          icon={<WrenchIcon />}
          empty="No active jobs"
        >
          {data.inService.map((item) => (
            <TicketCard key={item.ticketNumber} ticket={item.ticketNumber} accent={ACCENTS.amber}>
              <div className="text-right leading-none">
                {/* This lane is for vehicles already under work. "Called — please
                    proceed" belonged to the waiting lane's vocabulary and told a
                    customer whose car was on the lift to come forward for nothing. */}
                <div className="text-[clamp(1.1rem,1.8vw,2.1rem)] font-semibold text-amber-200">
                  {item.bay ?? 'In Workshop'}
                </div>
                <div className="mt-1 text-[clamp(0.7rem,0.95vw,1.05rem)] font-medium uppercase tracking-wider text-amber-400/70">
                  {item.bay ? 'Service Bay' : 'Vehicle being worked on'}
                </div>
              </div>
            </TicketCard>
          ))}
        </Lane>

        <Lane
          title="Ready"
          subtitle="Ready for pickup"
          count={data.ready.length}
          accent={ACCENTS.emerald}
          icon={<CheckBadgeIcon />}
          empty="Nothing ready yet"
        >
          {data.ready.map((item) => (
            <TicketCard
              key={item.ticketNumber}
              ticket={item.ticketNumber}
              accent={ACCENTS.emerald}
              highlight
            >
              <span className="flex items-center gap-2.5 text-[clamp(0.9rem,1.3vw,1.5rem)] font-bold uppercase tracking-wider text-emerald-300">
                <svg
                  className="w-[clamp(1.75rem,2.6vw,2.75rem)] h-[clamp(1.75rem,2.6vw,2.75rem)] text-emerald-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
                Ready
              </span>
            </TicketCard>
          ))}
        </Lane>
      </main>

      {/* Footer — rotating service tip over the persistent "watch the board" message */}
      <footer className="relative px-[clamp(1.5rem,3vw,3.5rem)] py-[clamp(0.6rem,1.1vw,1.25rem)] text-center border-t border-white/10 shrink-0">
        <div className="flex items-center justify-center gap-2.5 min-h-[clamp(1.5rem,2.2vw,2.5rem)]">
          <span className="text-blue-300/80 shrink-0">
            <WrenchIcon />
          </span>
          <p
            key={tipIndex}
            style={{ animation: 'displayTipFade 700ms ease-out' }}
            className="text-[clamp(0.95rem,1.35vw,1.6rem)] font-semibold text-slate-200"
          >
            {SERVICE_TIPS[tipIndex]}
          </p>
        </div>
        {/*
          CR-2026-086 — "Please listen for your ticket number" described a workflow
          this shop does not run: nobody calls numbers out loud. The board is the
          notification, so the copy now tells the customer to watch it.
        */}
        <p className="mt-1 text-[clamp(0.75rem,1vw,1.1rem)] font-medium text-slate-500">
          Find your <span className="text-slate-300">ticket number</span> on this board — it was given to
          you at check-in. The board updates by itself as your vehicle moves through service.
        </p>
      </footer>

      {/* Keyframe for the tip crossfade (scoped, self-contained) */}
      <style>{`@keyframes displayTipFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

type Accent = {
  text: string;
  strip: string;
  iconBg: string;
  countBg: string;
  ring: string;
};

const ACCENTS = {
  blue: {
    text: 'text-blue-300',
    strip: 'from-blue-400/70 to-blue-500/0',
    iconBg: 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-400/25',
    countBg: 'bg-blue-500/15 text-blue-200',
    ring: 'ring-white/5',
  },
  amber: {
    text: 'text-amber-300',
    strip: 'from-amber-400/70 to-amber-500/0',
    iconBg: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/25',
    countBg: 'bg-amber-500/15 text-amber-200',
    ring: 'ring-white/5',
  },
  emerald: {
    text: 'text-emerald-300',
    strip: 'from-emerald-400/70 to-emerald-500/0',
    iconBg: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/25',
    countBg: 'bg-emerald-500/15 text-emerald-200',
    ring: 'ring-emerald-500/20',
  },
} satisfies Record<string, Accent>;

function Lane({
  title,
  subtitle,
  count,
  accent,
  icon,
  empty,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  accent: Accent;
  icon: ReactNode;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="relative flex flex-col overflow-hidden rounded-2xl bg-slate-900/50 ring-1 ring-white/5 shadow-2xl shadow-black/40 backdrop-blur-sm">
      {/* Accent strip */}
      <div className={`h-1 w-full bg-gradient-to-r ${accent.strip}`} />

      <div className="flex items-center gap-[clamp(0.6rem,1vw,1rem)] px-[clamp(1rem,1.6vw,1.75rem)] pt-[clamp(0.9rem,1.4vw,1.5rem)] pb-[clamp(0.75rem,1.1vw,1.25rem)]">
        <span
          className={`flex h-[clamp(2.25rem,3vw,3.25rem)] w-[clamp(2.25rem,3vw,3.25rem)] items-center justify-center rounded-xl ${accent.iconBg}`}
        >
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <h2 className={`text-[clamp(1.15rem,1.9vw,2rem)] font-bold uppercase tracking-wider ${accent.text}`}>
            {title}
          </h2>
          <p className="text-[clamp(0.7rem,0.95vw,1.05rem)] text-slate-500">{subtitle}</p>
        </div>
        <span
          className={`rounded-lg px-[clamp(0.6rem,0.9vw,1rem)] py-[clamp(0.15rem,0.3vw,0.4rem)] text-[clamp(1.1rem,1.8vw,2rem)] font-bold tabular-nums ${accent.countBg}`}
        >
          {count}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-[clamp(0.6rem,1vw,1.1rem)] pb-[clamp(0.6rem,1vw,1.1rem)] space-y-[clamp(0.5rem,0.8vw,0.85rem)]">
        {count === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-slate-600">
            <span className="opacity-40">{icon}</span>
            <span className="text-[clamp(0.95rem,1.3vw,1.4rem)]">{empty}</span>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function TicketCard({
  ticket,
  accent,
  children,
  highlight,
}: {
  ticket: string;
  accent: Accent;
  children: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-[clamp(0.75rem,1.4vw,1.5rem)] rounded-xl px-[clamp(0.9rem,1.4vw,1.6rem)] py-[clamp(0.7rem,1.1vw,1.25rem)] ring-1 ${
        highlight
          ? 'bg-emerald-500/10 ring-emerald-500/30'
          : `bg-slate-800/60 ${accent.ring}`
      }`}
    >
      {/* min-w-0 + break-words lets long ticket numbers (e.g. QTK-BERT-01-20260707-0001)
          wrap cleanly instead of overflowing into the position block. */}
      <div className={`min-w-0 flex-1 text-[clamp(1.25rem,2vw,2.5rem)] font-extrabold tabular-nums leading-tight break-words ${accent.text}`}>
        {ticket}
      </div>
      <div className="shrink-0 text-right">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Icons (inline, currentColor)                                        */
/* ------------------------------------------------------------------ */

const ICON_CLASS = 'w-[clamp(1.35rem,1.9vw,2rem)] h-[clamp(1.35rem,1.9vw,2rem)]';

function ClockIcon() {
  return (
    <svg className={ICON_CLASS} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5v4.75l3 1.75" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg className={ICON_CLASS} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.9 6.1a4 4 0 00-5.4 5.1L4 16.7 7.3 20l5.5-5.5a4 4 0 005.1-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z"
      />
    </svg>
  );
}

function CheckBadgeIcon() {
  return (
    <svg className={ICON_CLASS} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function GearWatermark({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19.4 13a7.8 7.8 0 000-2l2.1-1.6a.5.5 0 00.1-.6l-2-3.5a.5.5 0 00-.6-.2l-2.5 1a7.3 7.3 0 00-1.7-1l-.4-2.6a.5.5 0 00-.5-.4h-4a.5.5 0 00-.5.4l-.4 2.6a7.3 7.3 0 00-1.7 1l-2.5-1a.5.5 0 00-.6.2l-2 3.5a.5.5 0 00.1.6L4.6 11a7.8 7.8 0 000 2l-2.1 1.6a.5.5 0 00-.1.6l2 3.5a.5.5 0 00.6.2l2.5-1a7.3 7.3 0 001.7 1l.4 2.6a.5.5 0 00.5.4h4a.5.5 0 00.5-.4l.4-2.6a7.3 7.3 0 001.7-1l2.5 1a.5.5 0 00.6-.2l2-3.5a.5.5 0 00-.1-.6L19.4 13zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z" />
    </svg>
  );
}
