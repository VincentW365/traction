'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';

interface CustomerHit { id: string; firstName: string; lastName: string; customerNumber: string }

const TYPES = ['SERVICE_QUALITY', 'WAIT_TIME', 'STAFF_CONDUCT', 'PRICING', 'VEHICLE_DAMAGE', 'COMMUNICATION', 'OTHER'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export default function NewComplaintPage() {
  const siteId = useSiteId();
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [type, setType] = useState('SERVICE_QUALITY');
  const [severity, setSeverity] = useState('MEDIUM');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');

  const searchQuery = useQuery<CustomerHit[]>({
    queryKey: ['customer-search', search],
    queryFn: () => api.get<CustomerHit[]>(`/customers?q=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 2 && !customer,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/complaints', {
        siteId,
        customerId: customer!.id,
        type,
        severity,
        subject: subject.trim(),
        description: description.trim(),
      }),
    onSuccess: (created) => router.push(`/complaints/${created.id}`),
  });

  const canSubmit = !!customer && subject.trim().length > 0 && description.trim().length > 0 && !createMutation.isPending;

  return (
    <div className="page-container">
      <PageHeader
        title="Log Complaint"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Complaints', href: '/complaints' }, { label: 'New' }]}
      />

      <div className="card max-w-2xl">
        <div className="card-body space-y-5">
          {/* Customer */}
          <div>
            <label className="input-label">Customer *</label>
            {customer ? (
              <div className="flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2">
                <span className="text-sm text-slate-800">{customer.firstName} {customer.lastName}
                  <span className="text-slate-400 ml-2 text-xs font-mono">{customer.customerNumber}</span>
                </span>
                <button onClick={() => setCustomer(null)} className="text-xs text-blue-600 hover:underline">Change</button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, phone, customer #, or plate"
                  className="input-field"
                />
                {searchQuery.data && searchQuery.data.length > 0 && (
                  <div className="mt-1 border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-56 overflow-y-auto">
                    {searchQuery.data.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => { setCustomer(c); setSearch(''); }}
                        className="w-full text-left px-3 py-2 hover:bg-blue-50/40 text-sm"
                      >
                        {c.firstName} {c.lastName}
                        <span className="text-slate-400 ml-2 text-xs font-mono">{c.customerNumber}</span>
                      </button>
                    ))}
                  </div>
                )}
                {searchQuery.data && search.trim().length >= 2 && searchQuery.data.length === 0 && (
                  <p className="text-xs text-slate-400 mt-1">No customers found.</p>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="input-label">Type *</label>
              <select value={type} onChange={(e) => setType(e.target.value)} className="input-field">
                {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="input-label">Severity</label>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="input-field">
                {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="input-label">Subject *</label>
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className="input-field" placeholder="Short title" />
          </div>

          <div>
            <label className="input-label">Description *</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={5} className="input-field" placeholder="What happened?" />
          </div>

          {createMutation.isError && (
            <p className="text-xs text-red-600">{createMutation.error instanceof Error ? createMutation.error.message : 'Failed to log complaint'}</p>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
            <button onClick={() => createMutation.mutate()} disabled={!canSubmit} className="btn-primary text-sm disabled:opacity-50">
              {createMutation.isPending ? 'Logging...' : 'Log Complaint'}
            </button>
            <button onClick={() => router.push('/complaints')} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
