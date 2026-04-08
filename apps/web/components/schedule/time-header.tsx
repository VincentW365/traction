'use client';

interface Props {
  openMinutes: number;
  closeMinutes: number;
  pxPerMinute: number;
  labelColumnWidth: number;
}

export function TimeHeader({ openMinutes, closeMinutes, pxPerMinute, labelColumnWidth }: Props) {
  const totalMinutes = closeMinutes - openMinutes;
  const hours: number[] = [];

  // Generate hour marks from open to close
  const startHour = Math.ceil(openMinutes / 60);
  const endHour = Math.floor(closeMinutes / 60);
  for (let h = startHour; h <= endHour; h++) {
    hours.push(h);
  }

  return (
    <div className="flex sticky top-0 z-20 bg-slate-50 border-b border-slate-200">
      {/* Resource label spacer */}
      <div
        className="shrink-0 border-r border-slate-200 bg-slate-50"
        style={{ width: `${labelColumnWidth}px` }}
      />

      {/* Time markers */}
      <div className="relative" style={{ width: `${totalMinutes * pxPerMinute}px`, height: '28px' }}>
        {hours.map((h) => {
          const offsetMinutes = h * 60 - openMinutes;
          const left = offsetMinutes * pxPerMinute;
          const label = `${h.toString().padStart(2, '0')}:00`;
          return (
            <div key={h} className="absolute top-0 h-full" style={{ left: `${left}px` }}>
              <div className="absolute top-0 w-px h-full bg-slate-200" />
              <span className="absolute top-1 left-1 text-[10px] font-medium text-slate-500 select-none">
                {label}
              </span>
            </div>
          );
        })}

        {/* Half-hour ticks */}
        {hours.slice(0, -1).map((h) => {
          const offsetMinutes = h * 60 + 30 - openMinutes;
          if (offsetMinutes < 0 || offsetMinutes > totalMinutes) return null;
          const left = offsetMinutes * pxPerMinute;
          return (
            <div
              key={`half-${h}`}
              className="absolute top-3 w-px bg-slate-100"
              style={{ left: `${left}px`, height: 'calc(100% - 12px)' }}
            />
          );
        })}
      </div>
    </div>
  );
}
