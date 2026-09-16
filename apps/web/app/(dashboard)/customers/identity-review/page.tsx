'use client';

/**
 * CR-2026-106 — Identity review (docs/121 §D "Identity").
 *
 * A customer created by self-service booking whose mobile number or email already
 * belongs to another record is listed here. A PERSON decides: keep both (distinct
 * people sharing a number) or merge the new record into the existing customer.
 * Nothing is merged automatically; every decision is audited.
 */

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';

interface Party {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  createdAt?: string;
  vehicles: Array<{ id: string; plateNumber: string; make: string | null; model: string | null }>;
}

interface ReviewItem {
  customer: Party;
  possibleDuplicate: Party | null;
  matchedOn: 'PHONE' | 'EMAIL' | 'UNKNOWN';
}

function PartyCard({ p, title }: { p: Party; title: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{title}</p>
      <p className="text-sm font-semibold text-slate-900">
        <Link href={`/customers/${p.id}`} className="hover:underline">{p.firstName} {p.lastName}</Link>{' '}
        <span className="font-mono text-xs text-slate-500">{p.customerNumber}</span>
      </p>
      <p className="text-xs text-slate-600">{p.phone}{p.email ? ` · ${p.email}` : ''}</p>
      <p className="text-xs text-slate-500">{p.vehicles.length ? p.vehicles.map((v) => `${v.plateNumber}${v.make ? ` (${[v.make, v.model].filter(Boolean).join(' ')})` : ''}`).join(', ') : 'No vehicles'}</p>
    </div>
  );
}

export default function IdentityReviewPage() {
  const qc = useQueryClient();
  const q = useQuery<ReviewItem[]>({ queryKey: ['identity-review'], queryFn: () => api.get('/customers/identity-review') });
  const resolve = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'DISTINCT' | 'MERGE_INTO_EXISTING' }) => api.post(`/customers/${id}/identity-review`, { decision }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['identity-review'] }),
  });

  return (
    <div className="page-container max-w-4xl">
      <PageHeader
        title="Identity review"
        subtitle="Online bookings that may belong to an existing customer. Nothing is merged until you decide."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Customers', href: '/customers' }, { label: 'Identity review' }]}
      />
      {q.isLoading && <LoadingState />}
      {q.isError && <p className="text-sm text-red-700">Could not load the review list.</p>}
      {q.data && q.data.length === 0 && <EmptyState title="Nothing to review" description="No self-service customer currently matches another record by mobile or email." />}
      <div className="space-y-4">
        {q.data?.map((item) => (
          <div key={item.customer.id} className="card p-4" data-testid="identity-review-item">
            <p className="mb-2 text-xs font-semibold text-amber-800">
              Matched on {item.matchedOn === 'PHONE' ? 'mobile number' : item.matchedOn === 'EMAIL' ? 'email' : 'contact details'} · booked online {item.customer.createdAt ? new Date(item.customer.createdAt).toLocaleString() : ''}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <PartyCard p={item.customer} title="New record (from the booking)" />
              {item.possibleDuplicate ? <PartyCard p={item.possibleDuplicate} title="Existing customer" /> : <div className="rounded-lg border border-dashed border-slate-200 p-3 text-xs text-slate-500">Existing record no longer available.</div>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: item.customer.id, decision: 'DISTINCT' })} className="btn-secondary min-h-9 text-xs">
                Different people — keep both
              </button>
              <button
                type="button"
                disabled={resolve.isPending || !item.possibleDuplicate}
                onClick={() => {
                  if (window.confirm('Move this booking\'s vehicle and appointment onto the existing customer and retire the new record? This is recorded.')) {
                    resolve.mutate({ id: item.customer.id, decision: 'MERGE_INTO_EXISTING' });
                  }
                }}
                className="btn-primary min-h-9 text-xs"
              >
                Same person — merge into existing
              </button>
            </div>
            {resolve.isError && <p className="mt-2 text-xs text-red-700">{resolve.error instanceof Error ? resolve.error.message : 'Could not save the decision.'}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
