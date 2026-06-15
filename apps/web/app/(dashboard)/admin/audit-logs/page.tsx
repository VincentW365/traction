'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';
import { ExportMenu } from '../../../../components/ui/export-menu';
import type { ExportDocument } from '../../../../lib/export';

interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  reasonCode: string | null;
  notes: string | null;
  createdAt: string;
  actor?: { fullName: string } | null;
}

const ENTITY_TYPES = [
  'UserAccount',
  'ServiceVisit',
  'ServiceOrder',
  'QueueTicket',
  'Appointment',
  'Customer',
  'Vehicle',
  'Technician',
  'TechnicianSkill',
  'MechanicDayAvailability',
  'BusinessRuleConfig',
];

function toDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function AuditLogsPage() {
  const today = toDateString(new Date());
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);

  const logsQuery = useQuery<AuditLogEntry[]>({
    queryKey: ['audit-logs', entityType, action, dateFrom, dateTo],
    queryFn: () => {
      const params = new URLSearchParams();
      if (entityType) params.set('entityType', entityType);
      if (action) params.set('action', action);
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      return api.get(`/audit-logs?${params.toString()}`);
    },
  });

  const logs = logsQuery.data ?? [];

  const buildExport = (): ExportDocument | null => {
    if (!logsQuery.data) return null;
    return {
      title: 'Audit Logs',
      filename: `audit-logs_${dateFrom}_to_${dateTo}`,
      subtitle: 'System activity and change history',
      meta: [
        ['Range', `${dateFrom} to ${dateTo}`],
        ['Filters', [entityType && `Entity: ${entityType}`, action && `Action: ${action}`].filter(Boolean).join(' · ') || 'None'],
        ['Entries', String(logs.length)],
      ],
      sections: [
        {
          columns: ['Timestamp', 'Actor', 'Action', 'Entity', 'Entity ID', 'Reason', 'Notes'],
          rows: logs.map((log) => [
            new Date(log.createdAt).toLocaleString(),
            log.actor?.fullName ?? log.actorUserId ?? 'System',
            log.action,
            log.entityType,
            log.entityId ?? '',
            log.reasonCode ?? '',
            log.notes ?? '',
          ]),
        },
      ],
    };
  };

  return (
    <div className="page-container">
      <PageHeader
        title="Audit Logs"
        subtitle="System activity and change history"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Admin' },
          { label: 'Audit Logs' },
        ]}
        actions={<ExportMenu build={buildExport} disabled={!logsQuery.data} />}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <select
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className="input-field w-auto"
        >
          <option value="">All Entity Types</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input
          type="text"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Action filter..."
          className="input-field w-40"
        />
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="input-field w-auto"
        />
        <span className="text-xs text-slate-400">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="input-field w-auto"
        />
      </div>

      {logsQuery.isLoading && <LoadingState message="Loading audit logs..." />}

      {logsQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">
            {logsQuery.error instanceof Error && logsQuery.error.message.includes('403')
              ? 'Permission denied. Manager or Admin role required.'
              : 'Failed to load audit logs.'}
          </p>
        </div>
      )}

      {logs.length === 0 && logsQuery.isSuccess && (
        <EmptyState
          title="No audit logs found"
          description="Try adjusting your filters or date range."
        />
      )}

      {logs.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Timestamp</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Reason</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="table-row">
                  <td className="text-slate-500 whitespace-nowrap text-xs">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td className="text-slate-700 text-xs">
                    {log.actor?.fullName ?? log.actorUserId?.slice(0, 8) ?? 'System'}
                  </td>
                  <td>
                    <span className="badge bg-slate-100 text-slate-700 text-[10px]">
                      {log.action}
                    </span>
                  </td>
                  <td className="text-xs">
                    <span className="text-slate-600">{log.entityType}</span>
                    {log.entityId && (
                      <span className="text-slate-400 ml-1 font-mono text-[10px]">
                        {log.entityId.slice(0, 8)}...
                      </span>
                    )}
                  </td>
                  <td className="text-xs text-slate-500">
                    {log.reasonCode ?? '--'}
                  </td>
                  <td className="text-xs text-slate-400 max-w-xs truncate">
                    {log.notes ?? '--'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
