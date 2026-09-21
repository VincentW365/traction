'use client';

/**
 * CR-2026-106 — "Send booking link": the secure public booking URL plus the
 * wording to go with it. The link and the message come from the API
 * (`GET /appointments/booking-link`), which builds the URL from PUBLIC_APP_URL —
 * never from this browser's address.
 *
 * CR-2026-112 — this is a hand-off, not a notification: staff copy the message
 * and pass it on themselves. The one-tap WhatsApp and SMS links were removed
 * with the rest of the SMS surface; the API still returns those fields, which
 * this screen ignores.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api-client';
import { useSiteId } from '../hooks/use-site';

interface BookingLink {
  bookingUrl: string;
  message: string;
}

export function SendBookingLink({ phone, compact }: { phone?: string | null; compact?: boolean }) {
  const siteId = useSiteId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const q = useQuery<BookingLink>({
    queryKey: ['booking-link', siteId, phone ?? ''],
    queryFn: () => api.get<BookingLink>(`/appointments/booking-link?siteId=${encodeURIComponent(siteId)}${phone ? `&phone=${encodeURIComponent(phone)}` : ''}`),
    enabled: open && !!siteId,
  });

  return (
    <div className="relative" data-testid="send-booking-link">
      <button type="button" onClick={() => setOpen((o) => !o)} className={compact ? 'btn-secondary min-h-9 px-3 py-1 text-xs' : 'btn-secondary'}>
        Send booking link
      </button>
      {open && (
        <div className="absolute z-20 mt-2 w-80 max-w-[90vw] rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
          {q.isLoading && <p className="text-xs text-slate-500">Preparing the link…</p>}
          {q.isError && <p className="text-xs text-red-700">Could not load the booking link.</p>}
          {q.data && (
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Public booking link</p>
              <p className="break-all font-mono text-xs text-slate-700">{q.data.bookingUrl}</p>
              <p className="text-xs text-slate-600">{q.data.message}</p>
              {/* CR-2026-112 — the WhatsApp and SMS hand-off links were removed with
                  the rest of the SMS/WhatsApp surface. Staff copy the message and
                  send it however they normally reach that customer. */}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(q.data!.message);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    } catch {
                      /* clipboard unavailable */
                    }
                  }}
                  className="min-h-9 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
                >
                  {copied ? 'Copied' : 'Copy message'}
                </button>
              </div>
              <p className="text-[11px] text-slate-500">The customer identifies with their mobile + plate (or email); no login, no name-only matching.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
