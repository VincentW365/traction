'use client';

interface WeekDay {
  date: string;
  dayName: string;
  operatingHours: { open: string; close: string } | null;
  appointmentCount: number;
  walkInCount: number;
  completedCount: number;
  blockedCount: number;
  resourceUtilization: number;
  isToday: boolean;
  isClosed: boolean;
}

interface Props {
  days: WeekDay[];
  onSelectDay: (date: string) => void;
}

export function WeekView({ days, onSelectDay }: Props) {
  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-7 divide-x divide-slate-200">
        {days.map((day) => {
          const isOverCapacity = day.resourceUtilization >= 85;
          const isNearCapacity = day.resourceUtilization >= 60;

          return (
            <button
              key={day.date}
              onClick={() => !day.isClosed && onSelectDay(day.date)}
              disabled={day.isClosed}
              className={`p-3 text-left transition-colors ${
                day.isToday ? 'bg-blue-50 ring-1 ring-inset ring-blue-200' :
                day.isClosed ? 'bg-slate-50 opacity-60 cursor-default' :
                'hover:bg-slate-50'
              }`}
            >
              {/* Day name + date */}
              <div className="mb-2">
                <div className={`text-[10px] font-semibold uppercase tracking-wider ${day.isToday ? 'text-blue-600' : 'text-slate-400'}`}>
                  {day.dayName.slice(0, 3)}
                </div>
                <div className={`text-lg font-bold ${day.isToday ? 'text-blue-700' : 'text-slate-900'}`}>
                  {new Date(day.date + 'T12:00:00').getDate()}
                </div>
              </div>

              {day.isClosed ? (
                <div className="text-[10px] text-slate-400 font-medium">Closed</div>
              ) : (
                <>
                  {/* Counts */}
                  <div className="space-y-1 mb-2">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-slate-500">Appts</span>
                      <span className="font-semibold text-slate-700">{day.appointmentCount}</span>
                    </div>
                    {day.completedCount > 0 && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-500">Done</span>
                        <span className="font-semibold text-slate-500">{day.completedCount}</span>
                      </div>
                    )}
                    {day.blockedCount > 0 && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-red-500">Blocked</span>
                        <span className="font-semibold text-red-600">{day.blockedCount}</span>
                      </div>
                    )}
                  </div>

                  {/* Utilization bar */}
                  <div>
                    <div className="flex items-center justify-between text-[9px] mb-0.5">
                      <span className="text-slate-400">Capacity</span>
                      <span className={`font-semibold ${isOverCapacity ? 'text-red-600' : isNearCapacity ? 'text-amber-600' : 'text-slate-500'}`}>
                        {day.resourceUtilization}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          isOverCapacity ? 'bg-red-500' : isNearCapacity ? 'bg-amber-400' : 'bg-emerald-400'
                        }`}
                        style={{ width: `${Math.min(100, day.resourceUtilization)}%` }}
                      />
                    </div>
                  </div>

                  {/* Warning */}
                  {isOverCapacity && (
                    <div className="mt-1.5 text-[9px] text-red-600 font-medium">Near capacity</div>
                  )}

                  {/* Hours */}
                  {day.operatingHours && (
                    <div className="mt-1.5 text-[9px] text-slate-400">
                      {day.operatingHours.open}–{day.operatingHours.close}
                    </div>
                  )}
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
