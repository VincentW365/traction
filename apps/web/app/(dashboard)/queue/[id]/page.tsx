'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { PageHeader } from '../../../../components/page-header';
import { LoadingState } from '../../../../components/loading-state';
import { StatusBadge } from '../../../../components/status-badge';

interface TicketDetail {
  id: string;
  ticketNumber: string;
  checkinSequence: number;
  queueRank: number | null;
  displayStatus: string;
  blockedReason: string | null;
  readyForDispatch: boolean;
  overrideActive: boolean;
  overrideReasonCode: string | null;
  generatedAt: string;
  lastRankedAt: string | null;
  serviceVisit: {
    id: string;
    sourceType: string;
    status: string;
    arrivalAt: string | null;
    checkedInAt: string | null;
    mileageIn: number | null;
    oilBrandRequested: string | null;
    oilGradeRequested: string | null;
    partsReadiness: string;
    customer: { id: string; firstName: string; lastName: string; phone: string };
    vehicle: { id: string; plateNumber: string; make: string | null; model: string | null };
    appointment: {
      id: string;
      scheduledStartAt: string;
      services: Array<{ serviceType: { name: string; code: string } }>;
    } | null;
  };
  queueEvents: Array<{
    id: string;
    eventType: string;
    positionBefore: number | null;
    positionAfter: number | null;
    reasonCode: string | null;
    createdAt: string;
  }>;
}

export default function QueueTicketDetailPage() {
  const params = useParams();
  const ticketId = params.id as string;

  const { data: ticket, isLoading, error } = useQuery<TicketDetail>({
    queryKey: ['queue-ticket', ticketId],
    queryFn: () => api.get(`/queue-tickets/${ticketId}`),
    enabled: !!ticketId,
    refetchInterval: 10000,
  });

  if (isLoading) {
    return (
      <div className="page-container">
        <LoadingState message="Loading ticket detail..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <PageHeader
          title="Queue Ticket"
          breadcrumbs={[
            { label: 'Queue Board', href: '/queue' },
            { label: 'Error' },
          ]}
        />
        <div className="card">
          <div className="card-body">
            <div className="flex items-center gap-3 text-red-700">
              <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">{(error as Error).message}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!ticket) return null;

  const sv = ticket.serviceVisit;
  const services = sv.appointment?.services?.map((s) => s.serviceType.name).join(', ') ?? 'Walk-in service';

  return (
    <div className="page-container">
      <PageHeader
        title={ticket.ticketNumber}
        breadcrumbs={[
          { label: 'Queue Board', href: '/queue' },
          { label: ticket.ticketNumber },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={ticket.displayStatus} />
            {ticket.queueRank != null && (
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-800 text-sm font-bold">
                #{ticket.queueRank}
              </span>
            )}
          </div>
        }
      />

      {/* Alert Cards */}
      {ticket.blockedReason && (
        <div className="card mb-4 border-red-200 bg-red-50">
          <div className="card-body">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-red-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-red-800">Blocked</p>
                <p className="text-sm text-red-700">{ticket.blockedReason}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {ticket.overrideActive && (
        <div className="card mb-4 border-amber-200 bg-amber-50">
          <div className="card-body">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-amber-800">Override Active</p>
                <p className="text-sm text-amber-700">{ticket.overrideReasonCode}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Info Card */}
      <div className="card mb-6">
        <div className="card-header">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Ticket Details</h2>
            <span className="text-xs text-slate-500">
              Checked in {ticket.generatedAt ? new Date(ticket.generatedAt).toLocaleTimeString() : '--'}
            </span>
          </div>
        </div>
        <div className="card-body">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
            <div>
              <div className="input-label">Customer</div>
              <p className="text-sm font-medium">
                <Link href={`/customers/${sv.customer.id}`} className="text-blue-600 hover:underline">
                  {sv.customer.firstName} {sv.customer.lastName}
                </Link>
              </p>
            </div>
            <div>
              <div className="input-label">Phone</div>
              <p className="text-sm font-medium text-slate-900">{sv.customer.phone}</p>
            </div>
            <div>
              <div className="input-label">Vehicle</div>
              <p className="text-sm font-medium">
                <Link href={`/vehicles/${sv.vehicle.id}`} className="text-blue-600 hover:underline">
                  {sv.vehicle.plateNumber}
                </Link>
                <span className="text-slate-500 ml-1.5">
                  {[sv.vehicle.make, sv.vehicle.model].filter(Boolean).join(' ')}
                </span>
              </p>
            </div>
            <div>
              <div className="input-label">Source</div>
              <p className="text-sm font-medium text-slate-900">
                {sv.sourceType === 'APPOINTMENT' ? 'Appointment' : 'Walk-In'}
              </p>
            </div>
            <div>
              <div className="input-label">Services</div>
              <p className="text-sm font-medium text-slate-900">{services}</p>
            </div>
            <div>
              <div className="input-label">Parts Readiness</div>
              <p className="text-sm font-medium text-slate-900">{sv.partsReadiness.replace(/_/g, ' ')}</p>
            </div>
            {sv.mileageIn != null && (
              <div>
                <div className="input-label">Mileage In</div>
                <p className="text-sm font-medium text-slate-900">{sv.mileageIn.toLocaleString()}</p>
              </div>
            )}
            {sv.oilBrandRequested && (
              <div>
                <div className="input-label">Oil Requested</div>
                <p className="text-sm font-medium text-slate-900">
                  {sv.oilBrandRequested} {sv.oilGradeRequested ?? ''}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Event History Table */}
      <div className="table-container">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Event History</h2>
        </div>
        {ticket.queueEvents.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No events recorded.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="table-header">
                <th>Time</th>
                <th>Event</th>
                <th>Position</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {ticket.queueEvents.map((evt) => (
                <tr key={evt.id} className="table-row">
                  <td className="text-slate-500 whitespace-nowrap">
                    {new Date(evt.createdAt).toLocaleTimeString()}
                  </td>
                  <td className="font-medium text-slate-900">
                    {evt.eventType.replace(/_/g, ' ')}
                  </td>
                  <td className="text-slate-600">
                    {evt.positionBefore != null && (
                      <>
                        {evt.positionBefore}
                        {evt.positionAfter != null && (
                          <>
                            <span className="mx-1 text-slate-400">&rarr;</span>
                            {evt.positionAfter}
                          </>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    {evt.reasonCode && (
                      <span className="badge bg-slate-100 text-slate-600">{evt.reasonCode}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
