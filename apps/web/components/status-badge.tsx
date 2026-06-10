'use client';

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  PENDING_RANK: { bg: 'bg-slate-100', text: 'text-slate-600', dot: 'bg-slate-400', label: 'Ranking' },
  WAITING: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500', label: 'Waiting' },
  CALLED: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500', label: 'Called' },
  IN_SERVICE: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500', label: 'In Service' },
  BLOCKED: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500', label: 'Blocked' },
  COMPLETED: { bg: 'bg-slate-50', text: 'text-slate-500', dot: 'bg-slate-400', label: 'Completed' },
  CANCELLED: { bg: 'bg-slate-50', text: 'text-slate-400', dot: 'bg-slate-300', label: 'Cancelled' },
  ABANDONED: { bg: 'bg-rose-50', text: 'text-rose-700', dot: 'bg-rose-500', label: 'Abandoned' },
  // Transport lifecycle (P2)
  REQUESTED: { bg: 'bg-slate-100', text: 'text-slate-600', dot: 'bg-slate-400', label: 'Requested' },
  CONFIRMATION_PENDING: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500', label: 'Confirming' },
  SCHEDULED: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500', label: 'Scheduled' },
  DRIVER_ASSIGNED: { bg: 'bg-indigo-50', text: 'text-indigo-700', dot: 'bg-indigo-500', label: 'Driver Assigned' },
  APPT_PROTECTED: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500', label: 'Protected' },
  APPT_LATE_SOFT: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500', label: 'Late' },
  WALKIN_STANDARD: { bg: 'bg-blue-50', text: 'text-blue-600', dot: 'bg-blue-500', label: 'Walk-In' },
  WALKIN_FASTTRACK: { bg: 'bg-violet-50', text: 'text-violet-700', dot: 'bg-violet-500', label: 'Fast Track' },
  BLOCKED_PARTS: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500', label: 'Parts' },
  BLOCKED_SKILL: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500', label: 'Skill' },
  MISSED_APPOINTMENT: { bg: 'bg-orange-50', text: 'text-orange-700', dot: 'bg-orange-500', label: 'Missed' },
  MANUAL_OVERRIDE: { bg: 'bg-violet-50', text: 'text-violet-700', dot: 'bg-violet-500', label: 'Override' },
  DRAFT: { bg: 'bg-slate-100', text: 'text-slate-600', dot: 'bg-slate-400', label: 'Draft' },
  CONFIRMED: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500', label: 'Confirmed' },
  CHECKED_IN: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500', label: 'Checked In' },
  IN_PROGRESS: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500', label: 'In Progress' },
  PAUSED: { bg: 'bg-orange-50', text: 'text-orange-700', dot: 'bg-orange-500', label: 'Paused' },
  QC: { bg: 'bg-indigo-50', text: 'text-indigo-700', dot: 'bg-indigo-500', label: 'QC' },
  WAITING_PARTS: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500', label: 'Wait Parts' },
  WAITING_CUSTOMER: { bg: 'bg-orange-50', text: 'text-orange-700', dot: 'bg-orange-500', label: 'Wait Customer' },
  READY_FOR_PICKUP: { bg: 'bg-green-50', text: 'text-green-700', dot: 'bg-green-500', label: 'Ready' },
  READY: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500', label: 'Ready' },
  PENDING: { bg: 'bg-slate-100', text: 'text-slate-600', dot: 'bg-slate-400', label: 'Pending' },
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const style = STATUS_STYLES[status] || {
    bg: 'bg-slate-100', text: 'text-slate-600', dot: 'bg-slate-400',
    label: status.replace(/_/g, ' '),
  };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${style.bg} ${style.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}
