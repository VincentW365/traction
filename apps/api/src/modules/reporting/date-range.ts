/**
 * CR-2026-100 — parse YYYY-MM-DD report bounds as the OPERATOR'S calendar day.
 *
 * The old pattern (`new Date('2026-09-01')` then `end.setHours(23,59,59,999)`)
 * mixed UTC parsing with a local-time mutation: west of UTC, `setHours` landed
 * on the PREVIOUS local day, so a single-day range covered only the first few
 * hours of the working day and "today" reports came back empty. Parsing the
 * components into local Dates yields exactly
 * [local 00:00:00.000 of startDate, local 23:59:59.999 of endDate] —
 * the range the person picking dates on the Reports page actually means.
 */
export function localDayRange(startDate: string, endDate: string): { start: Date; end: Date } {
  const [ys, ms, ds] = startDate.split('-').map(Number);
  const [ye, me, de] = endDate.split('-').map(Number);
  return {
    start: new Date(ys, ms - 1, ds, 0, 0, 0, 0),
    end: new Date(ye, me - 1, de, 23, 59, 59, 999),
  };
}
