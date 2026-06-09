'use client';

import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';

interface AvailabilityRecord {
  id: string;
  technicianId: string;
  date: string;
  shiftStart: string;
  shiftEnd: string;
  status: string;
  notes: string | null;
  technician: {
    id: string;
    employeeCode: string;
    userAccount: { fullName: string };
  };
}

interface TechnicianBasic {
  id: string;
  employeeCode: string;
  userAccount: { id: string; fullName: string; email: string | null };
}

const STATUS_COLORS: Record<string, string> = {
  AVAILABLE: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  ON_BREAK: 'bg-amber-100 text-amber-800 border-amber-300',
  OFF_FLOOR: 'bg-slate-100 text-slate-600 border-slate-300',
  ABSENT: 'bg-red-100 text-red-800 border-red-300',
};

function getWeekDates(baseDate: string): string[] {
  const d = new Date(`${baseDate}T12:00:00`);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);

  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(monday);
    dt.setDate(monday.getDate() + i);
    dates.push(dt.toISOString().split('T')[0]);
  }
  return dates;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function AvailabilityCalendarPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const today = new Date().toISOString().split('T')[0];
  const [weekBase, setWeekBase] = useState(today);
  const weekDates = getWeekDates(weekBase);

  const [editingCell, setEditingCell] = useState<{ techId: string; date: string } | null>(null);
  const [editShiftStart, setEditShiftStart] = useState('08:00');
  const [editShiftEnd, setEditShiftEnd] = useState('17:00');
  const [editStatus, setEditStatus] = useState('AVAILABLE');
  const [editNotes, setEditNotes] = useState('');

  // Load technicians
  const techQuery = useQuery<TechnicianBasic[]>({
    queryKey: ['technicians', siteId],
    queryFn: () => api.get(`/technicians?siteId=${siteId}`),
  });

  // Load availability
  const availQuery = useQuery<AvailabilityRecord[]>({
    queryKey: ['availability', siteId, weekDates[0], weekDates[6]],
    queryFn: () =>
      api.get(`/availability?siteId=${siteId}&startDate=${weekDates[0]}&endDate=${weekDates[6]}`),
  });

  const upsertMutation = useMutation({
    mutationFn: (data: any) => api.post('/availability', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['availability'] });
      setEditingCell(null);
    },
  });

  function prevWeek() {
    const d = new Date(`${weekBase}T12:00:00`);
    d.setDate(d.getDate() - 7);
    setWeekBase(d.toISOString().split('T')[0]);
  }

  function nextWeek() {
    const d = new Date(`${weekBase}T12:00:00`);
    d.setDate(d.getDate() + 7);
    setWeekBase(d.toISOString().split('T')[0]);
  }

  function goThisWeek() {
    setWeekBase(today);
  }

  const lookupAvail = useCallback(
    (techId: string, date: string) => {
      return availQuery.data?.find(
        (a) => a.technicianId === techId && a.date.startsWith(date),
      );
    },
    [availQuery.data],
  );

  function openEdit(techId: string, date: string) {
    const existing = lookupAvail(techId, date);
    setEditShiftStart(existing?.shiftStart ?? '08:00');
    setEditShiftEnd(existing?.shiftEnd ?? '17:00');
    setEditStatus(existing?.status ?? 'AVAILABLE');
    setEditNotes(existing?.notes ?? '');
    setEditingCell({ techId, date });
  }

  function saveEdit() {
    if (!editingCell) return;
    upsertMutation.mutate({
      technicianId: editingCell.techId,
      date: editingCell.date,
      shiftStart: editShiftStart,
      shiftEnd: editShiftEnd,
      status: editStatus,
      notes: editNotes || undefined,
    });
  }

  const technicians = techQuery.data ?? [];

  return (
    <div className="page-container">
      <PageHeader
        title="Availability Calendar"
        subtitle={`Week of ${new Date(weekDates[0] + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Admin' },
          { label: 'Availability' },
        ]}
        actions={
          <div className="flex items-center gap-1">
            <button onClick={prevWeek} className="p-1.5 rounded-md border border-slate-200 hover:bg-slate-50" title="Previous week">
              <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button onClick={goThisWeek} className="px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50">
              This Week
            </button>
            <button onClick={nextWeek} className="p-1.5 rounded-md border border-slate-200 hover:bg-slate-50" title="Next week">
              <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
        }
      />

      {(techQuery.isLoading || availQuery.isLoading) && <LoadingState message="Loading availability..." />}

      {technicians.length > 0 && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="table-header">
                  <th className="w-40">Technician</th>
                  {weekDates.map((date, i) => {
                    const isToday = date === today;
                    return (
                      <th key={date} className={isToday ? 'bg-blue-50' : ''}>
                        <div className="text-center">
                          <div>{DAY_NAMES[i]}</div>
                          <div className={`text-[10px] font-normal ${isToday ? 'text-blue-600' : 'text-slate-400'}`}>
                            {new Date(date + 'T12:00:00').getDate()}
                          </div>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {technicians.map((tech) => (
                  <tr key={tech.id} className="table-row">
                    <td className="font-medium">
                      <div className="text-xs font-bold font-mono text-slate-700">{tech.employeeCode}</div>
                      <div className="text-[10px] text-slate-500 truncate">{tech.userAccount.fullName}</div>
                    </td>
                    {weekDates.map((date) => {
                      const avail = lookupAvail(tech.id, date);
                      const isToday = date === today;
                      return (
                        <td
                          key={date}
                          className={`text-center cursor-pointer hover:bg-slate-50 ${isToday ? 'bg-blue-50/30' : ''}`}
                          onClick={() => openEdit(tech.id, date)}
                        >
                          {avail ? (
                            <div className={`inline-block rounded px-2 py-1 text-[10px] font-semibold border ${STATUS_COLORS[avail.status] ?? STATUS_COLORS.AVAILABLE}`}>
                              <div>{avail.status.replace(/_/g, ' ')}</div>
                              <div className="font-normal text-[9px] opacity-75">
                                {avail.shiftStart}–{avail.shiftEnd}
                              </div>
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-300">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editingCell && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="card w-96 p-5">
            <h3 className="text-sm font-semibold text-slate-900 mb-4">
              Set Availability — {editingCell.date}
            </h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="input-label">Start</label>
                  <input type="time" value={editShiftStart} onChange={(e) => setEditShiftStart(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="input-label">End</label>
                  <input type="time" value={editShiftEnd} onChange={(e) => setEditShiftEnd(e.target.value)} className="input-field" />
                </div>
              </div>
              <div>
                <label className="input-label">Status</label>
                <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className="input-field">
                  <option value="AVAILABLE">Available</option>
                  <option value="ON_BREAK">On Break</option>
                  <option value="OFF_FLOOR">Off Floor</option>
                  <option value="ABSENT">Absent</option>
                </select>
              </div>
              <div>
                <label className="input-label">Notes</label>
                <input type="text" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} className="input-field" placeholder="Optional" />
              </div>
              {upsertMutation.isError && (
                <p className="text-xs text-red-600">Failed to save availability.</p>
              )}
              <div className="flex items-center gap-2 pt-2">
                <button onClick={saveEdit} disabled={upsertMutation.isPending} className="btn-primary text-xs">
                  {upsertMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setEditingCell(null)} className="btn-secondary text-xs">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
