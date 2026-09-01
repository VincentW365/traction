'use client';

/**
 * CR-2026-097 — the Visit Record.
 *
 * The authoritative historical record of one service-centre visit: everything
 * that happened — job sheet, inspections, photos, services, people, timestamps,
 * activity — reachable from the customer, the vehicle, the queue, and search.
 * Works for live visits AND pre-platform historical imports (which have no
 * queue ticket and therefore no queue-detail page).
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api, getToken } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../components/status-badge';

/* ---------- Types (shape of GET /visits/:id) ---------- */

interface VisitRecord {
  id: string;
  visitNumber: string | null;
  status: string;
  sourceType: string;
  notes: string | null;
  mileageIn: number | null;
  mileageOut: number | null;
  createdAt: string;
  customer: { id: string; customerNumber: string; firstName: string; lastName: string; phone: string | null; email: string | null };
  vehicle: { id: string; vehicleCode: string; plateNumber: string; make: string | null; model: string | null; modelYear: number | null; odometer: number | null };
  site: { name: string; code: string } | null;
  queueTicket: { ticketNumber: string; displayTicketNumber: string | null; displayStatus: string; queueRank: number | null; generatedAt: string } | null;
  appointment: { id: string; scheduledStartAt: string; status: string } | null;
  serviceOrders: Array<{
    id: string; status: string; startedAt: string | null; completedAt: string | null;
    items: Array<{ id: string; status: string; serviceType: { code: string; name: string } }>;
    assignments: Array<{
      id: string; isPrimary: boolean; status: string; assignedAt: string; endedAt: string | null;
      technician: { id: string; employeeCode: string; userAccount: { fullName: string } };
      resource: { code: string; name: string } | null;
      bay: { code: string } | null;
    }>;
  }>;
  inspections: Array<{
    id: string; inspectionNumber: string; kind: string; status: string;
    createdAt: string; completedAt: string | null; signedOffAt: string | null;
    skippedAt: string | null; skipReason: string | null;
    inspector: string | null;
    _count: { items: number; photos: number; recommendations: number };
  }>;
  maintenanceRecommendations: Array<{ id: string; serviceTypeCode: string; nextDueDate: string | null; nextDueOdometer: number | null; isDeterminable: boolean }>;
  derived: {
    arrivalAt: string | null; checkedInAt: string | null; workStartedAt: string | null; completedAt: string | null;
    durationMinutes: number | null;
    requestedServices: Array<{ code: string; name: string }>;
    orderServices: Array<{ code: string; name: string; itemStatus: string }>;
  };
  jobSheet: {
    id: string; jobSheetNumber: string | null; createdAt: string; updatedAt: string;
    hasSignature: boolean; updatedBy: string | null;
  } | null;
}

interface TimelineEvent { at: string; type: string; label: string; actor: string | null; detail: string | null }

interface FilesResponse {
  groups: Array<{
    source: string; sourceLabel: string;
    inspectionId?: string; inspectionNumber?: string;
    photos?: Array<{ id: string; caption: string | null; category: string; createdAt: string }>;
    jobSheetId?: string; hasSignature?: boolean; updatedAt?: string;
  }>;
}

/* ---------- Helpers ---------- */

const TABS = ['Overview', 'Job Sheet', 'Inspections', 'Photos & Files', 'Activity'] as const;
type Tab = (typeof TABS)[number];

function fmtDT(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtT(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? `${window.location.protocol}//${window.location.hostname}:3001/api/v1`;
}

function kindLabel(kind: string): string {
  return kind === 'PRE_INSPECTION' ? 'Pre-Inspection' : 'Vehicle Inspection';
}

/* ---------- Photo (authenticated fetch → object URL) ---------- */

function VisitPhoto({ inspectionId, photoId, caption }: { inspectionId: string; photoId: string; caption: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    fetch(`${apiBase()}/inspections/${inspectionId}/photos/${photoId}/file`, {
      headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && alive) { objectUrl = URL.createObjectURL(b); setUrl(objectUrl); }
      })
      .catch(() => {});
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [inspectionId, photoId]);

  return (
    <>
      <button type="button" onClick={() => url && setFull(true)} className="block w-full">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={caption ?? 'Visit photo'} className="w-full h-28 object-cover rounded-md border border-slate-200" />
        ) : (
          <div className="w-full h-28 rounded-md bg-slate-100 animate-pulse" />
        )}
        {caption && <p className="text-[11px] text-slate-500 mt-0.5 truncate text-left">{caption}</p>}
      </button>
      {full && url && (
        <div className="fixed inset-0 z-50 bg-slate-900/80 flex items-center justify-center p-4" onClick={() => setFull(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={caption ?? ''} className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  );
}

/* ---------- Page ---------- */

export default function VisitRecordPage() {
  const params = useParams();
  const visitId = params.id as string;
  const [tab, setTab] = useState<Tab>('Overview');
  // CR-2026-102 §8 — links adapt to the role: technicians get the
  // technician-safe vehicle view and no Customer Directory navigation.
  const { user } = useAuth();
  const isTechnician = user?.roleCode === 'TECHNICIAN';

  const q = useQuery<VisitRecord>({
    queryKey: ['visit-record', visitId],
    queryFn: () => api.get(`/visits/${visitId}`),
    enabled: !!visitId,
  });

  const timelineQ = useQuery<TimelineEvent[]>({
    queryKey: ['visit-timeline', visitId],
    queryFn: () => api.get(`/visits/${visitId}/timeline`),
    enabled: !!visitId && tab === 'Activity',
  });

  const filesQ = useQuery<FilesResponse>({
    queryKey: ['visit-files', visitId],
    queryFn: () => api.get(`/visits/${visitId}/files`),
    enabled: !!visitId && tab === 'Photos & Files',
  });

  if (q.isLoading) {
    return (
      <div className="page-container"><LoadingState message="Loading visit record..." /></div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="page-container">
        <PageHeader title="Visit Record" breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Visit' }]} />
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">{q.error instanceof Error ? q.error.message : 'Visit not found.'}</p>
        </div>
      </div>
    );
  }

  const v = q.data;
  const customerName = `${v.customer.firstName} ${v.customer.lastName}`;
  const vehicleLabel = [v.vehicle.modelYear, v.vehicle.make, v.vehicle.model].filter(Boolean).join(' ') || v.vehicle.plateNumber;
  const number = v.visitNumber ?? '—';
  const allAssignments = v.serviceOrders.flatMap((o) => o.assignments);
  const performedServices = v.derived.orderServices;
  const findingsCount = v.inspections.reduce((n, i) => n + i._count.recommendations, 0);

  return (
    <div className="page-container">
      <PageHeader
        title={`Visit ${number}`}
        subtitle={`${customerName} · ${vehicleLabel} · ${v.vehicle.plateNumber}`}
        breadcrumbs={[
          { label: 'Customers', href: '/customers' },
          { label: customerName, href: `/customers/${v.customer.id}` },
          { label: v.vehicle.plateNumber, href: `/vehicles/${v.vehicle.id}` },
          { label: `Visit ${number}` },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={v.status} />
            {v.sourceType === 'HISTORICAL_IMPORT' && (
              <span className="badge bg-slate-100 text-slate-600 text-[10px]" title="Imported from pre-platform records">Historical</span>
            )}
          </div>
        }
      />

      {/* Header facts */}
      <div className="card mb-4">
        <div className="card-body grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-3 text-sm">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Customer</p>
            {isTechnician ? (
              <p className="font-medium text-slate-900">{customerName}</p>
            ) : (
              <Link href={`/customers/${v.customer.id}`} className="font-medium text-blue-600 hover:underline">{customerName}</Link>
            )}
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Vehicle</p>
            <Link
              href={isTechnician ? `/technician/vehicles/${v.vehicle.id}` : `/vehicles/${v.vehicle.id}`}
              className="font-medium text-blue-600 hover:underline"
            >
              {vehicleLabel}
            </Link>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Plate</p>
            <p className="font-mono font-medium text-slate-900">{v.vehicle.plateNumber}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Visit date</p>
            <p className="text-slate-700">{fmtDT(v.derived.checkedInAt ?? v.derived.arrivalAt ?? v.createdAt).split(',').slice(0, 2).join(',')}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Checked in</p>
            <p className="text-slate-700">{fmtT(v.derived.checkedInAt ?? v.derived.arrivalAt)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Completed</p>
            <p className="text-slate-700">{fmtT(v.derived.completedAt)}</p>
          </div>
        </div>
      </div>

      {/* Section tabs — horizontally scrollable on small screens */}
      <div className="flex gap-1 mb-4 overflow-x-auto border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3.5 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t ? 'border-blue-600 text-blue-700 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t}
            {t === 'Inspections' && v.inspections.length > 0 && (
              <span className="ml-1.5 badge bg-slate-100 text-slate-600 text-[10px]">{v.inspections.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ---------------- Overview ---------------- */}
      {tab === 'Overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Services */}
          <div className="card">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Services</h2></div>
            <div className="card-body space-y-3">
              {v.derived.requestedServices.length > 0 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Requested</p>
                  <div className="flex flex-wrap gap-1.5">
                    {v.derived.requestedServices.map((s, i) => (
                      <span key={i} className="badge bg-slate-100 text-slate-700">{s.name}</span>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Performed</p>
                {performedServices.length === 0 ? (
                  <p className="text-sm text-slate-500">No work-order services recorded.</p>
                ) : (
                  <div className="space-y-1">
                    {performedServices.map((s, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-slate-700">{s.name}</span>
                        <StatusBadge status={s.itemStatus} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {(v.mileageIn != null || v.mileageOut != null) && (
                <p className="text-xs text-slate-500">
                  Mileage: {v.mileageIn?.toLocaleString() ?? '—'} in{v.mileageOut != null ? ` · ${v.mileageOut.toLocaleString()} out` : ''}
                </p>
              )}
            </div>
          </div>

          {/* Timing & performance */}
          <div className="card">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Timing</h2></div>
            <div className="card-body">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <dt className="text-slate-500">Arrival</dt><dd className="text-right text-slate-700">{fmtDT(v.derived.arrivalAt)}</dd>
                <dt className="text-slate-500">Checked in</dt><dd className="text-right text-slate-700">{fmtDT(v.derived.checkedInAt)}</dd>
                <dt className="text-slate-500">Work started</dt><dd className="text-right text-slate-700">{fmtDT(v.derived.workStartedAt)}</dd>
                <dt className="text-slate-500">Completed</dt><dd className="text-right text-slate-700">{fmtDT(v.derived.completedAt)}</dd>
                {v.derived.durationMinutes != null && (
                  <>
                    <dt className="text-slate-500">Work duration</dt>
                    <dd className="text-right font-medium text-slate-900">
                      {Math.floor(v.derived.durationMinutes / 60) > 0 ? `${Math.floor(v.derived.durationMinutes / 60)}h ` : ''}
                      {v.derived.durationMinutes % 60}m
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </div>

          {/* Queue & team */}
          <div className="card">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Queue &amp; Team</h2></div>
            <div className="card-body space-y-3 text-sm">
              {v.queueTicket ? (
                <p className="text-slate-700">
                  Ticket <span className="font-mono font-medium">{v.queueTicket.ticketNumber}</span>
                  {v.queueTicket.displayTicketNumber && <span className="text-slate-400"> · shown as {v.queueTicket.displayTicketNumber}</span>}
                </p>
              ) : (
                <p className="text-slate-500">No queue ticket (pre-platform visit).</p>
              )}
              {allAssignments.length === 0 ? (
                <p className="text-slate-500">No technician assignments recorded.</p>
              ) : (
                <div className="space-y-1.5">
                  {allAssignments.map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-2">
                      <span className="text-slate-700">
                        {a.technician.userAccount.fullName}
                        <span className="text-slate-400 text-xs"> {a.technician.employeeCode}</span>
                        {!a.isPrimary && <span className="badge bg-slate-100 text-slate-500 text-[10px] ml-1.5">assist</span>}
                      </span>
                      <span className="text-xs text-slate-500">{a.resource?.name ?? a.resource?.code ?? a.bay?.code ?? ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Findings & recommendations */}
          <div className="card">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Findings &amp; Recommendations</h2></div>
            <div className="card-body space-y-2 text-sm">
              {findingsCount === 0 && v.maintenanceRecommendations.length === 0 ? (
                <p className="text-slate-500">No findings or recommendations recorded.</p>
              ) : (
                <>
                  {v.inspections.filter((i) => i._count.recommendations > 0).map((i) => (
                    <div key={i.id} className="flex items-center justify-between gap-2">
                      <span className="text-slate-700">{kindLabel(i.kind)} — {i._count.recommendations} finding{i._count.recommendations === 1 ? '' : 's'}</span>
                      <button onClick={() => setTab('Inspections')} className="text-xs text-blue-600 hover:underline">View</button>
                    </div>
                  ))}
                  {v.maintenanceRecommendations.map((r) => (
                    <p key={r.id} className="text-slate-600 text-xs">
                      Next due: <span className="font-mono">{r.serviceTypeCode}</span>
                      {r.nextDueDate ? ` · ${new Date(r.nextDueDate).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                      {r.nextDueOdometer != null ? ` · ${r.nextDueOdometer.toLocaleString()} mi` : ''}
                    </p>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Notes — progressive disclosure */}
          {v.notes && (
            <details className="card lg:col-span-2">
              <summary className="card-header cursor-pointer text-sm font-semibold text-slate-700 select-none">Visit Notes</summary>
              <div className="card-body"><p className="text-sm text-slate-700 whitespace-pre-wrap">{v.notes}</p></div>
            </details>
          )}
        </div>
      )}

      {/* ---------------- Job Sheet ---------------- */}
      {tab === 'Job Sheet' && (
        <div className="card">
          <div className="card-body">
            {v.jobSheet ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    Job Sheet {v.jobSheet.jobSheetNumber ?? ''}
                    {v.jobSheet.hasSignature && <span className="badge bg-emerald-50 text-emerald-700 text-[10px] ml-2">Signed</span>}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Last saved {fmtDT(v.jobSheet.updatedAt)}{v.jobSheet.updatedBy ? ` by ${v.jobSheet.updatedBy}` : ''}
                  </p>
                </div>
                <Link href={`/inspections/job-sheet/${v.id}`} className="btn-primary text-sm">Open Job Sheet</Link>
              </div>
            ) : (
              <div className="text-center py-6">
                <p className="text-sm text-slate-500 mb-3">No job sheet has been saved for this visit.</p>
                <Link href={`/inspections/job-sheet/${v.id}`} className="btn-secondary text-sm">Open Blank Job Sheet</Link>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------------- Inspections ---------------- */}
      {tab === 'Inspections' && (
        <div className="space-y-3">
          {v.inspections.length === 0 && (
            <div className="card p-6 text-center"><p className="text-sm text-slate-500">No inspections were recorded for this visit.</p></div>
          )}
          {v.inspections.map((i) => (
            <div key={i.id} className="card">
              <div className="card-body flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {kindLabel(i.kind)}
                    <span className="font-mono text-xs text-blue-600 ml-2">{i.inspectionNumber}</span>
                    <span className="ml-2"><StatusBadge status={i.status} /></span>
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {i.completedAt ? `Completed ${fmtT(i.completedAt)}` : i.skippedAt ? `Skipped${i.skipReason ? ` — ${i.skipReason}` : ''}` : `Started ${fmtT(i.createdAt)}`}
                    {i.inspector ? ` by ${i.inspector}` : ''}
                    {' · '}
                    {i._count.items > 0 ? `${i._count.items} checks · ` : ''}
                    {i._count.recommendations} observation{i._count.recommendations === 1 ? '' : 's'} · {i._count.photos} image{i._count.photos === 1 ? '' : 's'}
                  </p>
                </div>
                <Link href={`/inspections/${i.id}`} className="btn-secondary text-sm">View Inspection</Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------------- Photos & Files ---------------- */}
      {tab === 'Photos & Files' && (
        <div className="space-y-4">
          {filesQ.isLoading && <LoadingState message="Loading files..." />}
          {filesQ.data && filesQ.data.groups.length === 0 && (
            <div className="card p-6 text-center"><p className="text-sm text-slate-500">No photos or files were captured during this visit.</p></div>
          )}
          {filesQ.data?.groups.map((g, gi) => (
            <div key={gi} className="card">
              <div className="card-header flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">
                  {g.sourceLabel}
                  {g.inspectionNumber && <span className="font-mono text-xs text-slate-400 ml-2">{g.inspectionNumber}</span>}
                </h2>
                {g.inspectionId && <Link href={`/inspections/${g.inspectionId}`} className="text-xs text-blue-600 hover:underline">Open source record</Link>}
                {g.source === 'JOB_SHEET' && <Link href={`/inspections/job-sheet/${v.id}`} className="text-xs text-blue-600 hover:underline">Open job sheet</Link>}
              </div>
              <div className="card-body">
                {g.photos && g.photos.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                    {g.photos.map((p) => (
                      <VisitPhoto key={p.id} inspectionId={g.inspectionId!} photoId={p.id} caption={p.caption ?? p.category.replace(/_/g, ' ').toLowerCase()} />
                    ))}
                  </div>
                ) : g.hasSignature ? (
                  <p className="text-sm text-slate-600">Customer signature on file — view it on the job sheet.</p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------------- Activity ---------------- */}
      {tab === 'Activity' && (
        <div className="card">
          <div className="card-body">
            {timelineQ.isLoading && <LoadingState message="Loading activity..." />}
            {timelineQ.data && timelineQ.data.length === 0 && (
              <p className="text-sm text-slate-500">No recorded activity.</p>
            )}
            {timelineQ.data && timelineQ.data.length > 0 && (
              <ol className="relative border-l border-slate-200 ml-2 space-y-4">
                {timelineQ.data.map((e, i) => (
                  <li key={i} className="ml-4">
                    <span className={`absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full border-2 border-white ${
                      e.type.startsWith('INSPECTION') ? 'bg-indigo-400'
                        : e.type.startsWith('JOB_SHEET') ? 'bg-amber-400'
                          : e.type === 'NOTIFICATION' ? 'bg-cyan-400'
                            : e.type.startsWith('TECH') ? 'bg-emerald-400'
                              : 'bg-slate-300'
                    }`} />
                    <p className="text-sm text-slate-800">{e.label}</p>
                    <p className="text-xs text-slate-400">
                      {fmtDT(e.at)}
                      {e.actor ? ` · ${e.actor}` : ''}
                      {e.detail ? ` · ${e.detail}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
