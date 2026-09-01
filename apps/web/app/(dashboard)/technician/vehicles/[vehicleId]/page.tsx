'use client';

/**
 * CR-2026-102 — the technician-safe, read-only Vehicle Details view.
 *
 * Opened when a technician clicks a vehicle from Ticket Details / their jobs.
 * Backed by GET /vehicles/:id/operational — contextual access (their own
 * assignments only), enforced server-side. Vehicle + why it is here + current
 * jobs + inspections + history. No administrative controls exist on this page;
 * a wrong detail goes through Report Incorrect Information (the notes card).
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';
import { LoadingState } from '../../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../../components/status-badge';
import { VisitNotesCard } from '../../../../../components/visit-notes-card';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const VEHICLE_CLASS_LABEL: Record<string, string> = {
  SEDAN_CLASS: 'Sedan',
  SUV_CLASS: 'SUV',
  UNKNOWN_REQUIRES_REVIEW: 'Class not set',
};
const DECISION_LABEL: Record<string, { label: string; className: string }> = {
  PENDING: { label: 'authorization pending', className: 'text-amber-700' },
  APPROVED: { label: 'approved', className: 'text-emerald-700' },
  DECLINED: { label: 'declined', className: 'text-slate-400' },
  DEFERRED: { label: 'deferred', className: 'text-slate-400' },
};

interface TechnicianVehicleView {
  vehicle: {
    id: string;
    vehicleCode: string;
    plateNumber: string;
    vin: string | null;
    make: string | null;
    model: string | null;
    modelYear: number | null;
    color: string | null;
    odometer: number | null;
    serviceClass: string | null;
    fuelType: string | null;
    transmission: string | null;
    drivetrain: string | null;
    engineNo: string | null;
  };
  customer: { name: string; phone: string; serviceNotes: string | null };
  currentVisit: {
    serviceVisitId: string;
    visitNumber: string | null;
    status: string;
    sourceType: string;
    checkedInAt: string | null;
    mileageIn: number | null;
    concern: string | null;
    appointmentAt: string | null;
    queueTicketId: string | null;
    ticketNumber: string | null;
    jobs: Array<{ orderId: string; status: string; advisorNotes: string | null; services: string[]; technicians: string[] }>;
    inspections: Array<{ id: string; inspectionNumber: string; status: string; kind: string; createdAt: string }>;
  } | null;
  history: Array<{
    serviceVisitId: string;
    visitNumber: string | null;
    date: string;
    mileageIn: number | null;
    notes: string | null;
    services: string[];
    hadRework: boolean;
    hadPartsWait: boolean;
    inspections: Array<{
      id: string;
      inspectionNumber: string;
      status: string;
      date: string;
      comments: string | null;
      recommendations: Array<{ severity: string; description: string; customerDecision: string }>;
    }>;
  }>;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="input-label">{label}</div>
      <p className="text-sm font-medium text-slate-900">{value ?? '—'}</p>
    </div>
  );
}

export default function TechnicianVehiclePage() {
  const { vehicleId } = useParams<{ vehicleId: string }>();

  const q = useQuery<TechnicianVehicleView>({
    queryKey: ['technician-vehicle', vehicleId],
    queryFn: () => api.get(`/vehicles/${vehicleId}/operational`),
    enabled: !!vehicleId,
  });

  if (q.isLoading) {
    return (
      <div className="min-h-screen bg-slate-100 p-4">
        <div className="max-w-2xl mx-auto"><LoadingState message="Loading vehicle..." /></div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="min-h-screen bg-slate-100 p-4">
        <div className="max-w-2xl mx-auto space-y-3">
          <Link href="/technician" className="text-sm text-blue-700 hover:underline">← My Jobs</Link>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {q.error instanceof Error ? q.error.message : 'Could not load this vehicle.'}
          </div>
        </div>
      </div>
    );
  }

  const { vehicle, customer, currentVisit, history } = q.data;

  return (
    <div className="min-h-screen bg-slate-100 p-4">
      <div className="max-w-2xl mx-auto space-y-3">
        <Link href="/technician" className="text-sm text-blue-700 hover:underline">← My Jobs</Link>

        {/* Header — the vehicle, registration first (§14) */}
        <div className="card overflow-hidden">
          <div className="bg-slate-800 text-white px-5 py-4">
            <div className="text-3xl font-black font-mono tracking-wide">{vehicle.plateNumber}</div>
            <div className="text-sm text-slate-300 mt-0.5">
              {[vehicle.modelYear, vehicle.make, vehicle.model].filter(Boolean).join(' ')}
              {vehicle.serviceClass ? ` · ${VEHICLE_CLASS_LABEL[vehicle.serviceClass] ?? ''}` : ''}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {customer.name} · {customer.phone}
            </div>
          </div>
          <div className="card-body">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <Field label="Registration" value={<span className="font-mono">{vehicle.plateNumber}</span>} />
              <Field label="Vehicle type" value={vehicle.serviceClass ? (VEHICLE_CLASS_LABEL[vehicle.serviceClass] ?? '—') : 'Not set'} />
              <Field label="VIN / Chassis" value={vehicle.vin ? <span className="font-mono text-xs">{vehicle.vin}</span> : '—'} />
              <Field label="Engine no." value={vehicle.engineNo ?? '—'} />
              <Field label="Odometer" value={vehicle.odometer != null ? `${vehicle.odometer.toLocaleString()} mi` : '—'} />
              <Field label="Fuel" value={vehicle.fuelType ?? '—'} />
              <Field label="Transmission" value={vehicle.transmission ?? '—'} />
              <Field label="Drivetrain" value={vehicle.drivetrain ?? '—'} />
              <Field label="Colour" value={vehicle.color ?? '—'} />
              <Field label="Service Centre ID" value={<span className="font-mono text-xs">{vehicle.vehicleCode}</span>} />
            </div>
            {customer.serviceNotes && (
              <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
                <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Customer service notes</div>
                <p className="text-sm text-slate-800 mt-0.5">{customer.serviceNotes}</p>
              </div>
            )}
            {/* §3 — read-only by design: report, never edit. */}
            <p className="text-[11px] text-slate-400 mt-3">
              Vehicle records are maintained by the advisor. Spotted something wrong? Use “Add Note →
              Incorrect information” on the visit — it goes straight to them.
            </p>
          </div>
        </div>

        {/* Current visit — why is it here, what work, where (§1/§6) */}
        {currentVisit ? (
          <div className="card">
            <div className="card-header flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Current Visit</h2>
              <div className="flex items-center gap-2">
                {currentVisit.visitNumber && (
                  <span className="text-[11px] font-mono text-slate-400">{currentVisit.visitNumber}</span>
                )}
                <StatusBadge status={currentVisit.status} />
              </div>
            </div>
            <div className="card-body space-y-3">
              {currentVisit.concern && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-blue-800">Service request</div>
                  <p className="text-sm text-blue-900 mt-0.5">{currentVisit.concern}</p>
                </div>
              )}
              <p className="text-xs text-slate-500">
                {currentVisit.sourceType === 'APPOINTMENT'
                  ? `Appointment${currentVisit.appointmentAt ? ` · ${fmtTime(currentVisit.appointmentAt)}` : ''}`
                  : 'Walk-in'}
                {currentVisit.checkedInAt ? ` · checked in ${fmtTime(currentVisit.checkedInAt)}` : ''}
                {currentVisit.mileageIn != null ? ` · ${currentVisit.mileageIn.toLocaleString()} mi in` : ''}
              </p>

              {currentVisit.jobs.map((j) => (
                <div key={j.orderId} className="rounded-lg border border-slate-200 p-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-slate-900">{j.services.join(', ') || 'No services recorded'}</p>
                    <StatusBadge status={j.status} />
                  </div>
                  {j.technicians.length > 0 && (
                    <p className="text-[11px] text-slate-500">Technician: {j.technicians.join(', ')}</p>
                  )}
                  {j.advisorNotes && (
                    <p className="text-xs text-slate-600"><span className="font-semibold">Advisor note:</span> {j.advisorNotes}</p>
                  )}
                  <Link
                    href={`/technician/jobs/${j.orderId}`}
                    className="inline-block text-xs font-semibold text-blue-700 hover:underline"
                  >
                    Open job workspace →
                  </Link>
                </div>
              ))}

              <div className="grid grid-cols-2 gap-2">
                <Link
                  href={`/inspections/job-sheet/${currentVisit.serviceVisitId}`}
                  className="block text-center rounded-lg border border-blue-200 bg-blue-50 py-2.5 text-sm font-bold text-blue-800"
                >
                  VIEW JOB SHEET
                </Link>
                {currentVisit.inspections[0] ? (
                  <Link
                    href={`/inspections/${currentVisit.inspections[0].id}`}
                    className="block text-center rounded-lg border border-slate-200 py-2.5 text-sm font-bold text-slate-700"
                  >
                    INSPECTION
                    <span className="block text-[10px] font-mono font-normal text-slate-500">
                      {currentVisit.inspections[0].inspectionNumber}
                    </span>
                  </Link>
                ) : (
                  <div className="rounded-lg border border-slate-100 py-2.5 text-center text-xs text-slate-400">
                    No inspection yet
                  </div>
                )}
              </div>
              {currentVisit.queueTicketId && (
                <Link href={`/queue/${currentVisit.queueTicketId}`} className="block text-center text-xs text-blue-700 hover:underline">
                  Ticket details ({currentVisit.ticketNumber ?? '—'}) →
                </Link>
              )}
            </div>
          </div>
        ) : (
          <div className="card p-4 text-sm text-slate-500">No live visit for this vehicle right now.</div>
        )}

        {/* §10 — the vehicle IS the historical context */}
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Service History ({history.length})</h2>
          </div>
          <div className="card-body space-y-2">
            {history.length === 0 && <p className="text-xs text-slate-400">First recorded visit for this vehicle.</p>}
            {history.map((h) => (
              <div key={h.serviceVisitId} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">{fmtDate(h.date)}</span>
                  <span className="text-[11px] text-slate-400">
                    {h.mileageIn != null ? `${h.mileageIn.toLocaleString()} mi` : ''}
                    {h.visitNumber ? ` · ${h.visitNumber}` : ''}
                  </span>
                </div>
                <p className="text-sm text-slate-700 mt-0.5">{h.services.join(', ') || 'No services recorded'}</p>
                {h.notes && <p className="text-xs text-slate-500 italic mt-0.5">“{h.notes}”</p>}
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {h.hadRework && <span className="badge bg-red-50 text-red-700 text-[10px]">Came back for rework</span>}
                  {h.hadPartsWait && <span className="badge bg-amber-50 text-amber-700 text-[10px]">Waited for parts</span>}
                </div>
                {h.inspections.map((insp) => (
                  <div key={insp.id} className="mt-2 rounded border border-slate-100 bg-slate-50 px-2.5 py-1.5">
                    {/* Dates always visible — an old inspection must never read as current. */}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-mono font-semibold text-slate-600">{insp.inspectionNumber}</span>
                      <span className="text-[11px] text-slate-400">{fmtDate(insp.date)} · {insp.status}</span>
                    </div>
                    {insp.comments && <p className="text-xs text-slate-600 mt-0.5">{insp.comments}</p>}
                    {insp.recommendations.map((r, i) => {
                      const d = DECISION_LABEL[r.customerDecision] ?? DECISION_LABEL.PENDING;
                      return (
                        <p key={i} className="text-xs text-slate-600 mt-0.5">
                          • {r.description} <span className={d.className}>({d.label})</span>
                        </p>
                      );
                    })}
                  </div>
                ))}
                <Link href={`/visits/${h.serviceVisitId}`} className="inline-block text-[11px] text-blue-700 hover:underline mt-1.5">
                  Full visit record →
                </Link>
              </div>
            ))}
          </div>
        </div>

        {/* Findings / report-incorrect-info on the live visit */}
        {currentVisit && (
          <VisitNotesCard
            visitId={currentVisit.serviceVisitId}
            addableKinds={['TECHNICIAN', 'SAFETY', 'DATA_REPORT']}
            title="Notes & Findings"
          />
        )}
      </div>
    </div>
  );
}
