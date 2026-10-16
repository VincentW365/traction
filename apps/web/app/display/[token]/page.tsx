'use client';

import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import { fmtEtaWindow, type EtaWindow, type PublicEta } from '../../../lib/eta-format';

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

/**
 * CR-2026-118 §5 — the lobby screen leads with the licence plate.
 *
 * A customer in the waiting area recognises their car, not a ticket number they
 * were handed twenty minutes ago. Every row now carries `plate` (already
 * normalised, and masked if management has asked for that) and the plate is the
 * largest thing on the card; the ticket number stays underneath as the tie-break.
 * `plate` is null when nothing is recorded — the card says so rather than
 * inventing one — and `showPlates` is false when management has switched plates
 * off, in which case the ticket number leads again.
 *
 * The three lanes are the three customer-facing states. Quality Check is shown by
 * name in the In Service lane: a car that has been worked on and is being checked
 * is neither "waiting" nor "ready", and the old "finishing up" wording hid that.
 *
 * Each lane shows about five rows — the directive's figure for a 32-inch screen at
 * seating distance — and cycles through the rest slowly rather than scrolling.
 */
interface DisplayBoard {
  siteId: string;
  siteName: string;
  timezone: string; // site-anchored; drives the header clock/date (CR-2026-079)
  generatedAt: string;
  showPlates: boolean;
  totalInQueue: number;
  // CR-2026-105b — each card carries the public-safe estimate (times + ON_TIME/DELAYED only).
  inQueue: ({ ticketNumber: string; plate: string | null; position: number | null } & PublicEta)[];
  inService: ({ ticketNumber: string; plate: string | null; bay: string | null; stage: 'IN_SERVICE' | 'QC' } & PublicEta)[];
  ready: { ticketNumber: string; plate: string | null }[];
}

/**
 * Rows per lane before the lane starts cycling. CR-2026-124 — this is now the
 * STARTING figure only: each lane measures how many of its cards actually fit
 * the height it has (see `useFittedRows`) and pages by that, so the last card
 * is never half off the bottom of the screen. The directive's five remains the
 * figure a 32-inch screen at 1080p comes to.
 */
const ROWS_PER_PAGE = 5;
const ROWS_PER_PAGE_MAX = 8;
/** How long each page of a lane stays up. Slow on purpose — this is read, not watched. */
const PAGE_MS = 9000;

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
    setI(0);
    if (length <= 1) return;
    const id = setInterval(() => setI((prev) => (prev + 1) % length), intervalMs);
    return () => clearInterval(id);
  }, [length, intervalMs]);
  return i;
}

/**
 * CR-2026-118 §5 — which page of a lane is showing. A lane with more vehicles
 * than fit cycles through them a page at a time; one that fits does nothing.
 */
function useLanePage<T>(items: T[], rowsPerPage: number): { page: T[]; pageIndex: number; pageCount: number; from: number; to: number } {
  const rows = Math.max(1, rowsPerPage);
  const pageCount = Math.max(1, Math.ceil(items.length / rows));
  const pageIndex = useRotatingIndex(pageCount, PAGE_MS);
  const safeIndex = Math.min(pageIndex, pageCount - 1);
  const from = safeIndex * rows;
  const page = items.slice(from, from + rows);
  return { page, pageIndex: safeIndex, pageCount, from: items.length ? from + 1 : 0, to: from + page.length };
}

/**
 * CR-2026-124 — how many cards fit the lane's body. Measured from the first
 * card (every card in a lane is the same height by construction: the estimate
 * table is always rendered, with "to follow" where there is no time yet) and
 * the body's height and gap, re-measured whenever the screen or the list
 * changes. A 1080p screen comes to five; a taller one shows more, a smaller
 * one fewer — and the last card is never cut off.
 */
function useFittedRows(ref: RefObject<HTMLDivElement | null>, itemCount: number): number {
  const [rows, setRows] = useState(ROWS_PER_PAGE);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (itemCount === 0) return;
      const first = el.firstElementChild as HTMLElement | null;
      if (!first) return;
      const cs = getComputedStyle(el);
      const gap = parseFloat(cs.rowGap) || 0;
      const inner = el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      const card = first.getBoundingClientRect().height;
      if (card <= 0 || inner <= 0) return;
      const fit = Math.floor((inner + gap) / (card + gap));
      setRows(Math.max(1, Math.min(ROWS_PER_PAGE_MAX, fit)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, itemCount]);
  return rows;
}

/**
 * CR-2026-105b / CR-2026-124 — the customer-facing estimate on a card, as a
 * small table rather than a line of prose: labels in a fixed left column, times
 * right-aligned in tabular figures, so every card on the board lines up and a
 * long range can never push the licence plate onto a second line. Times only,
 * in the site's zone, as a range when the estimate is uncertain.
 *
 * §5.6C — no reliable estimate: no time is invented. The row still renders, and
 * says "to follow", so cards in a lane keep one height (which is what lets the
 * lane measure its paging from a single card).
 */
function EtaTable({ item, tz, rows }: { item: PublicEta; tz: string; rows: Array<'start' | 'completion'> }) {
  const delayed = item.publicState === 'DELAYED';
  const cell = (w: EtaWindow | null) => (w ? fmtEtaWindow(w, item.showRange, tz) : null);
  const stats = rows.map((r) => ({
    key: r,
    // A delayed card's completion is a revised figure, and the label says so.
    label: r === 'start' ? 'Est. start' : delayed ? 'Updated est.' : 'Est. completion',
    value: cell(r === 'start' ? item.estimatedStart : item.estimatedCompletion),
  }));
  // Side by side, label over value: the pair reads as one line of facts, and
  // the two columns sit in the same place on every card in the lane.
  return (
    <div
      className={`mt-[clamp(0.4rem,0.6vw,0.75rem)] grid border-t border-white/10 pt-[clamp(0.35rem,0.5vw,0.65rem)] gap-x-[clamp(0.75rem,1.2vw,1.4rem)] ${
        stats.length > 1 ? 'grid-cols-2' : 'grid-cols-1'
      }`}
    >
      {stats.map((s) => (
        <div key={s.key} className="min-w-0">
          <div className="whitespace-nowrap text-[clamp(0.6rem,0.8vw,0.95rem)] font-medium uppercase tracking-wider text-slate-400">
            {s.label}
          </div>
          <div
            className={`whitespace-nowrap text-[clamp(0.9rem,1.25vw,1.5rem)] leading-tight tabular-nums ${
              s.value ? `font-bold ${delayed ? 'text-amber-200' : 'text-slate-100'}` : 'font-normal text-slate-500'
            }`}
          >
            {s.value ?? 'to follow'}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The amber word, inline where a lane's status sits. Never a reason — this is the lobby. */
function Delayed() {
  return <span className="font-semibold uppercase tracking-wider text-amber-300">Delayed</span>;
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
  const showPlates = data.showPlates !== false;

  return (
    <div className="relative h-screen overflow-hidden bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white flex flex-col">
      {/* CR-2026-124 — `h-screen`, not `min-h-screen`: exactly the screen, never
          taller, so the lanes measure the height they really have and the footer
          stays on screen. */}
      {/* Faint automotive watermark — premium, not busy */}
      <GearWatermark className="pointer-events-none absolute -right-24 -top-24 h-[42rem] w-[42rem] text-white/[0.02]" />
      <GearWatermark className="pointer-events-none absolute -left-32 bottom-[-6rem] h-[30rem] w-[30rem] text-white/[0.015]" />

      {/* Header */}
      <header className="relative flex items-center justify-between gap-6 px-[clamp(1.5rem,3vw,3.5rem)] py-[clamp(0.75rem,1.2vw,1.5rem)] border-b border-white/10 shrink-0">
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
              Live Service Status
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[clamp(1.9rem,3.1vw,3.75rem)] font-bold tabular-nums leading-none">
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
      <main className="relative flex-1 min-h-0 grid grid-cols-3 gap-[clamp(0.75rem,1.4vw,1.5rem)] p-[clamp(0.75rem,1.6vw,1.75rem)] overflow-hidden">
        {/*
          CR-2026-124 — one card shape in every lane: the plate on its own line on
          top with the short status beside it, the times underneath in a table.
          Nothing on the right of the plate is ever wide enough to wrap it.
        */}
        <Lane
          title="Waiting"
          subtitle="Waiting to be serviced"
          items={data.inQueue}
          keyOf={(item) => item.ticketNumber}
          accent={ACCENTS.blue}
          icon={<ClockIcon />}
          empty="No vehicles waiting"
          renderItem={(item) => (
            <VehicleCard
              plate={item.plate}
              ticket={item.ticketNumber}
              showPlates={showPlates}
              accent={ACCENTS.blue}
              status={
                // One short line, always, so every card in the lane is the same
                // height and the ticket number beside the plate never gives way:
                // the place in line (the lane header already says "Waiting"), and
                // "Delayed" when it applies.
                // Stacked, not side by side: two short lines fit inside the plate's
                // own height, so a delayed card is no taller and the ticket number
                // beside the plate keeps its room.
                <div className="flex flex-col items-end gap-[0.2em] whitespace-nowrap text-[clamp(0.75rem,1vw,1.2rem)] leading-tight">
                  {item.position != null ? (
                    <span className="rounded-md bg-blue-500/15 px-[0.55em] py-[0.1em] font-bold tabular-nums text-blue-200">
                      #{item.position} of {data.totalInQueue}
                    </span>
                  ) : (
                    <span className="font-semibold uppercase tracking-wider text-slate-500">Holding</span>
                  )}
                  {item.publicState === 'DELAYED' && <Delayed />}
                </div>
              }
            >
              <EtaTable item={item} tz={data.timezone} rows={['start', 'completion']} />
            </VehicleCard>
          )}
        />

        <Lane
          title="In Service"
          subtitle="Being worked on now"
          items={data.inService}
          keyOf={(item) => item.ticketNumber}
          accent={ACCENTS.amber}
          icon={<WrenchIcon />}
          empty="No active jobs"
          renderItem={(item) => (
            <VehicleCard
              plate={item.plate}
              ticket={item.ticketNumber}
              showPlates={showPlates}
              accent={ACCENTS.amber}
              status={
                // §5.6B — Quality Check is its own, honest status: worked on, being
                // checked, not yet ready. It replaces the position on the one status
                // line; "In Service" itself is what the lane header says.
                <div className="flex flex-col items-end gap-[0.2em] whitespace-nowrap text-[clamp(0.75rem,1vw,1.2rem)] font-semibold uppercase leading-tight tracking-wider">
                  {item.stage === 'QC' ? (
                    // Allowed to break into its two words: two short lines fit inside
                    // the plate's height, and the ticket number keeps its room.
                    <span className="max-w-[7em] whitespace-normal rounded-md bg-amber-500/15 px-[0.55em] py-[0.1em] text-center text-amber-200">
                      Quality Check
                    </span>
                  ) : (
                    <span className="text-amber-300/80">{item.bay ? item.bay : 'Being worked on'}</span>
                  )}
                  {item.publicState === 'DELAYED' && <Delayed />}
                </div>
              }
            >
              <EtaTable item={item} tz={data.timezone} rows={['completion']} />
            </VehicleCard>
          )}
        />

        <Lane
          title="Ready"
          subtitle="Ready for collection"
          items={data.ready}
          keyOf={(item) => item.ticketNumber}
          accent={ACCENTS.emerald}
          icon={<CheckBadgeIcon />}
          empty="Nothing ready yet"
          renderItem={(item) => (
            <VehicleCard
              plate={item.plate}
              ticket={item.ticketNumber}
              showPlates={showPlates}
              accent={ACCENTS.emerald}
              highlight
              status={
                <svg
                  className="w-[clamp(2rem,3vw,3.25rem)] h-[clamp(2rem,3vw,3.25rem)] text-emerald-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              }
            >
              <div className="mt-[clamp(0.4rem,0.6vw,0.75rem)] border-t border-emerald-400/20 pt-[clamp(0.35rem,0.5vw,0.65rem)] text-[clamp(0.85rem,1.15vw,1.3rem)] font-bold uppercase tracking-wider text-emerald-300">
                Ready for collection
              </div>
            </VehicleCard>
          )}
        />
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
        <p className="mt-1 text-[clamp(0.75rem,1vw,1.1rem)] font-medium text-slate-500">
          {showPlates ? (
            <>Find your <span className="text-slate-300">licence plate</span> on this board. Your ticket number is shown beside it.</>
          ) : (
            <>Find your <span className="text-slate-300">ticket number</span> on this board — it was given to you at check-in.</>
          )}{' '}
          The board updates by itself as your vehicle moves through service.
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
  /** CR-2026-124 — the plate badge's border and fill. */
  plate: string;
};

const ACCENTS = {
  blue: {
    text: 'text-blue-300',
    strip: 'from-blue-400/70 to-blue-500/0',
    iconBg: 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-400/25',
    countBg: 'bg-blue-500/15 text-blue-200',
    ring: 'ring-white/5',
    plate: 'border-blue-300/40 bg-blue-400/10',
  },
  amber: {
    text: 'text-amber-300',
    strip: 'from-amber-400/70 to-amber-500/0',
    iconBg: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/25',
    countBg: 'bg-amber-500/15 text-amber-200',
    ring: 'ring-white/5',
    plate: 'border-amber-300/40 bg-amber-400/10',
  },
  emerald: {
    text: 'text-emerald-300',
    strip: 'from-emerald-400/70 to-emerald-500/0',
    iconBg: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/25',
    countBg: 'bg-emerald-500/15 text-emerald-200',
    ring: 'ring-emerald-500/20',
    plate: 'border-emerald-300/40 bg-emerald-400/10',
  },
} satisfies Record<string, Accent>;

/**
 * CR-2026-124 — a lane owns its paging. It measures how many of its own cards
 * fit (`useFittedRows`), pages by that, and cycles. The page only hands it the
 * list and how to draw one card.
 */
function Lane<T>({
  title,
  subtitle,
  items,
  keyOf,
  renderItem,
  accent,
  icon,
  empty,
}: {
  title: string;
  subtitle: string;
  items: T[];
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  accent: Accent;
  icon: ReactNode;
  empty: string;
}) {
  const count = items.length;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rows = useFittedRows(bodyRef, count);
  const paging = useLanePage(items, rows);
  return (
    <section className="relative flex flex-col overflow-hidden rounded-2xl bg-slate-900/50 ring-1 ring-white/5 shadow-2xl shadow-black/40 backdrop-blur-sm">
      {/* Accent strip */}
      <div className={`h-1 w-full bg-gradient-to-r ${accent.strip}`} />

      <div className="flex items-center gap-[clamp(0.6rem,1vw,1rem)] px-[clamp(1rem,1.6vw,1.75rem)] pt-[clamp(0.7rem,1vw,1.2rem)] pb-[clamp(0.6rem,0.85vw,1rem)]">
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

      {/* A flex column with a real gap (not margins), so the fit measurement can
          read the gap back from computed style. */}
      <div
        ref={bodyRef}
        className="flex-1 overflow-hidden flex flex-col gap-[clamp(0.5rem,0.8vw,0.85rem)] px-[clamp(0.6rem,1vw,1.1rem)] pb-[clamp(0.6rem,1vw,1.1rem)]"
      >
        {count === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-slate-600">
            <span className="opacity-40">{icon}</span>
            <span className="text-[clamp(0.95rem,1.3vw,1.4rem)]">{empty}</span>
          </div>
        ) : (
          paging.page.map((item) => <Fragment key={keyOf(item)}>{renderItem(item)}</Fragment>)
        )}
      </div>

      {/* CR-2026-118 §5 — more vehicles than fit: say which page is up, and cycle. */}
      {paging.pageCount > 1 && (
        <div className="flex items-center justify-between px-[clamp(1rem,1.6vw,1.75rem)] py-[clamp(0.4rem,0.7vw,0.8rem)] border-t border-white/5 text-[clamp(0.7rem,0.95vw,1.05rem)] text-slate-400 tabular-nums">
          <span>
            Showing {paging.from}–{paging.to} of {count}
          </span>
          <span className="flex items-center gap-1.5" aria-label={`Page ${paging.pageIndex + 1} of ${paging.pageCount}`}>
            {Array.from({ length: paging.pageCount }, (_, i) => (
              <span
                key={i}
                className={`inline-block h-2 w-2 rounded-full ${i === paging.pageIndex ? 'bg-slate-200' : 'bg-slate-600'}`}
              />
            ))}
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * CR-2026-118 §5 / CR-2026-124 — one vehicle on the board.
 *
 * The licence plate is the largest thing on the card and it is ALWAYS one line:
 * it is drawn as a plate — a bordered badge in a fixed-width face, upper-case,
 * never wrapped — on the top row, with only the short status beside it. The
 * estimate (or the ready line) goes UNDER the plate at full width, so nothing
 * to its right is ever wide enough to break it. Before this the status and the
 * times sat beside the plate and squeezed "7777 XY" onto two lines.
 *
 * No plate recorded → the card says so and the ticket number carries the row.
 */
function VehicleCard({
  plate,
  ticket,
  showPlates,
  accent,
  status,
  children,
  highlight,
}: {
  plate: string | null;
  ticket: string;
  showPlates: boolean;
  accent: Accent;
  /** The short status beside the plate: a word, a position, a tick. */
  status: ReactNode;
  /** The full-width row under the plate: the estimate table, or the ready line. */
  children: ReactNode;
  highlight?: boolean;
}) {
  const hasPlate = showPlates && !!plate;
  return (
    <div
      className={`rounded-xl px-[clamp(0.9rem,1.4vw,1.6rem)] py-[clamp(0.55rem,0.85vw,1rem)] ring-1 ${
        highlight ? 'bg-emerald-500/10 ring-emerald-500/30' : `bg-slate-800/60 ${accent.ring}`
      }`}
    >
      <div className="flex items-center justify-between gap-[clamp(0.6rem,1vw,1.2rem)]">
        {/* The plate (or the ticket, when there is no plate) with the ticket number
            beside it on the same baseline — one row, so the card stays short. The
            ticket text gives way first; the plate never does. */}
        <div className="flex min-w-0 items-baseline gap-[clamp(0.5rem,0.8vw,1rem)]">
          {hasPlate ? (
            <div
              className={`shrink-0 whitespace-nowrap rounded-md border-2 ${accent.plate} px-[0.4em] py-[0.08em] font-mono text-[clamp(1.35rem,2.05vw,2.75rem)] font-black leading-none tracking-[0.06em] tabular-nums ${accent.text}`}
              aria-label={`Licence plate ${plate}`}
            >
              {plate}
            </div>
          ) : (
            <div
              className={`shrink-0 whitespace-nowrap text-[clamp(1.35rem,2.05vw,2.75rem)] font-extrabold leading-none tracking-wide tabular-nums ${accent.text}`}
              aria-label={`Ticket ${ticket}`}
            >
              {ticket}
            </div>
          )}
          {showPlates && (
            <div
              className={`min-w-0 truncate text-[clamp(0.75rem,0.95vw,1.1rem)] font-medium tabular-nums ${
                hasPlate ? 'text-slate-400' : 'italic text-slate-500'
              }`}
            >
              {hasPlate ? `Ticket ${ticket}` : 'No plate recorded'}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">{status}</div>
      </div>
      {children}
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
