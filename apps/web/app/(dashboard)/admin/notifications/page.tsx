'use client';

/**
 * CR-2026-096 — Administration → Notifications.
 *
 * Managers edit the customer-facing message wording here — SMS bodies, email
 * subjects/bodies, and whether a notification type is enabled. Changes apply to
 * the next message sent; messages already sent keep the exact wording they went
 * out with. No code change or redeployment is ever needed for wording.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';

const REASON_LABELS: Record<string, string> = {
  SERVICE_DUE: 'Vehicle Due for Service',
  QUEUE_CHECKED_IN: 'Checked In',
  QUEUE_WORK_STARTED: 'Work Started',
  QUEUE_UPDATE: 'Service Update / Delay',
  PICKUP_READY: 'Ready for Pickup',
  CUSTOM: 'Custom Message',
};

const PLACEHOLDERS = [
  'customerFirstName', 'customerFullName', 'vehicleYear', 'vehicleMake', 'vehicleModel',
  'vehicleDescription', 'registrationNumber', 'ticketDisplayNumber', 'serviceDueDetails',
  'serviceDueDate', 'serviceDueMileage', 'lastServiceDate', 'currentMileage',
  'pickupDetails', 'staffEditableUpdate', 'businessName',
];

interface Template {
  id: string;
  key: string;
  reason: string;
  channel: 'SMS' | 'EMAIL' | string;
  name: string;
  subject: string | null;
  body: string;
  enabled: boolean;
  version: number;
  updatedAt: string;
  updatedBy: { fullName: string } | null;
}

export default function NotificationTemplatesPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const allowed = user?.roleCode === 'ADMIN';
  const [editKey, setEditKey] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const q = useQuery<Template[]>({
    queryKey: ['notification-templates'],
    queryFn: () => api.get('/notifications/templates'),
    enabled: allowed,
  });

  const saveMutation = useMutation<Template, unknown, { key: string; subject?: string | null; body?: string; enabled?: boolean }>({
    mutationFn: ({ key, ...patch }) => api.put(`/notifications/templates/${key}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-templates'] });
      setEditKey(null);
    },
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Notifications" subtitle="Message templates" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">Only Managers can edit notification templates.</p>
        </div>
      </div>
    );
  }

  const templates = q.data ?? [];
  const byReason = new Map<string, Template[]>();
  for (const t of templates) {
    if (!byReason.has(t.reason)) byReason.set(t.reason, []);
    byReason.get(t.reason)!.push(t);
  }

  const startEdit = (t: Template) => {
    setEditKey(t.key);
    setSubject(t.subject ?? '');
    setBody(t.body);
  };

  return (
    <div className="page-container">
      <PageHeader
        title="Notifications"
        subtitle="Customer message templates — changes apply immediately, no redeployment"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Notifications' },
        ]}
      />

      <div className="card mb-6 p-4 text-xs text-slate-600">
        <p className="font-medium text-slate-700 mb-1">Placeholders</p>
        <p className="mb-2">
          Wrap any of these in double braces and the system fills them in when the message is generated.
          A placeholder with no value is removed cleanly — the customer never sees broken text.
        </p>
        <div className="flex flex-wrap gap-1">
          {PLACEHOLDERS.map((p) => (
            <code key={p} className="bg-slate-100 rounded px-1.5 py-0.5 text-[11px]">{`{{${p}}}`}</code>
          ))}
        </div>
      </div>

      {q.isLoading && <LoadingState message="Loading templates..." />}

      {[...byReason.entries()].map(([reason, list]) => (
        <div key={reason} className="card mb-4">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">{REASON_LABELS[reason] ?? reason}</h2>
          </div>
          <div className="divide-y divide-slate-100">
            {list.map((t) => (
              <div key={t.key} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="badge bg-slate-100 text-slate-600 text-[10px]">{t.channel}</span>
                    <p className="text-sm font-medium text-slate-900">{t.name}</p>
                    <span className="text-[11px] text-slate-400">v{t.version}</span>
                    {!t.enabled && <span className="badge bg-red-50 text-red-600 text-[10px]">disabled</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => saveMutation.mutate({ key: t.key, enabled: !t.enabled })}
                      className="text-xs text-slate-500 hover:underline"
                    >
                      {t.enabled ? 'Disable' : 'Enable'}
                    </button>
                    {editKey === t.key ? (
                      <button onClick={() => setEditKey(null)} className="text-xs text-slate-500 hover:underline">Cancel</button>
                    ) : (
                      <button onClick={() => startEdit(t)} className="text-xs text-blue-600 hover:underline font-medium">Edit</button>
                    )}
                  </div>
                </div>

                {editKey === t.key ? (
                  <div className="space-y-2 mt-2">
                    {t.channel === 'EMAIL' && (
                      <div>
                        <label className="input-label">Subject</label>
                        <input value={subject} onChange={(e) => setSubject(e.target.value)} className="input-field text-sm" />
                      </div>
                    )}
                    <div>
                      <label className="input-label">{t.channel === 'SMS' ? 'SMS message' : 'Email body'}</label>
                      <textarea
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        rows={t.channel === 'SMS' ? 3 : 8}
                        className="input-field text-sm"
                      />
                    </div>
                    {saveMutation.isError && (
                      <p className="text-xs text-red-600">{saveMutation.error instanceof Error ? saveMutation.error.message : 'Save failed'}</p>
                    )}
                    <button
                      onClick={() => saveMutation.mutate({ key: t.key, body, ...(t.channel === 'EMAIL' ? { subject } : {}) })}
                      disabled={saveMutation.isPending}
                      className="btn-primary text-xs"
                    >
                      {saveMutation.isPending ? 'Saving…' : 'Save Template'}
                    </button>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500">
                    {t.subject && <p className="font-medium text-slate-600">{t.subject}</p>}
                    <p className="whitespace-pre-wrap line-clamp-3">{t.body || <span className="italic">Staff write this message from scratch.</span>}</p>
                    {t.updatedBy && (
                      <p className="text-[11px] text-slate-400 mt-1">
                        Last edited by {t.updatedBy.fullName} · {new Date(t.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
