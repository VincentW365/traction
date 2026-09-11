'use client';

/**
 * CR-2026-105c — slot picker shared by the booking wizard and the manage page.
 * Shows the NEXT AVAILABLE appointment first, then each day's open slots.
 * Pure presentation: the availability payload comes from the API's engine.
 */

import { fmtDayLabel, fmtTimeOnly, fmtWhen } from '../../lib/public-api';

export interface Slot {
  startAt: string;
  endAt: string;
  available: boolean;
}
export interface DayAvailability {
  date: string;
  closed: boolean;
  slots: Slot[];
  availableCount: number;
}
export interface Availability {
  plannedMinutes: number;
  timezone: string;
  nextAvailable: Slot | null;
  days: DayAvailability[];
}

export function SlotPicker({
  data,
  selected,
  onSelect,
}: {
  data: Availability;
  selected: Slot | null;
  onSelect: (slot: Slot) => void;
}) {
  const tz = data.timezone;
  const openDays = data.days.filter((d) => !d.closed && d.slots.length > 0);
  return (
    <div className="space-y-5">
      {data.nextAvailable ? (
        <div className="rounded-xl border-2 border-blue-600 bg-blue-50 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">Next available appointment</p>
          <p className="mt-1 text-xl font-bold text-slate-900">{fmtWhen(data.nextAvailable.startAt, tz)}</p>
          <p className="text-sm text-slate-600">About {data.plannedMinutes} minutes</p>
          <button
            type="button"
            onClick={() => onSelect(data.nextAvailable!)}
            className={`mt-3 w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
              selected?.startAt === data.nextAvailable.startAt ? 'bg-emerald-600 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {selected?.startAt === data.nextAvailable.startAt ? '✓ Selected' : 'Choose this time'}
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          No online appointments are available in this period. Please try a later date or call the service centre.
        </div>
      )}

      {openDays.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-semibold text-slate-800">Or pick another time</p>
          <div className="space-y-3">
            {openDays.map((d) => (
              <div key={d.date} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-800">{fmtDayLabel(d.date)}</span>
                  <span className="text-xs text-slate-500">{d.availableCount} open</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {d.slots.map((s) => {
                    const isSel = selected?.startAt === s.startAt;
                    return (
                      <button
                        key={s.startAt}
                        type="button"
                        disabled={!s.available}
                        onClick={() => onSelect(s)}
                        className={`rounded-md px-2.5 py-1.5 text-xs font-medium tabular-nums transition-colors ${
                          isSel
                            ? 'bg-emerald-600 text-white'
                            : s.available
                              ? 'bg-slate-100 text-slate-800 hover:bg-blue-100'
                              : 'bg-slate-50 text-slate-300 line-through cursor-not-allowed'
                        }`}
                      >
                        {fmtTimeOnly(s.startAt, tz)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
