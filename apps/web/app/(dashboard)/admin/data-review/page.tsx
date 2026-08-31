'use client';

/**
 * CR-2026-099 — Data Review: reconciliation of historical unknown-customer
 * visits. Each row shows the ORIGINAL imported job text and any high-confidence
 * vehicle matches; an administrator relinks deliberately or marks the record
 * ambiguous. Nothing is guessed, nothing is deleted.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';

interface Candidate {
  vehicleId: string;
  vehicleCode: string;
  plateNumber: string;
  label: string;
  customer: { id: string; name: string; phone: string | null };
}
interface ReviewItem {
  visitId: string;
  visitNumber: string | null;
  visitedAt: string;
  sourceText: string;
  placeholderVehicleCode: string;
  candidates: Candidate[];
}
interface Summary { UNRESOLVED: number; RESOLVED: number; AMBIGUOUS: number; total: number }

const PAGE = 25;

export default function DataReviewPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const allowed = user?.roleCode === 'ADMIN';
  const [skip, setSkip] = useState(0);
  const [status, setStatus] = useState<'UNRESOLVED' | 'RESOLVED' | 'AMBIGUOUS'>('UNRESOLVED');

  const summaryQ = useQuery<Summary>({
    queryKey: ['reconciliation-summary'],
    queryFn: () => api.get('/reconciliation/summary'),
    enabled: allowed,
  });
  const listQ = useQuery<{ items: ReviewItem[]; total: number }>({
    queryKey: ['reconciliation-list', status, skip],
    queryFn: () => api.get(`/reconciliation/unresolved?status=${status}&take=${PAGE}&skip=${skip}`),
    enabled: allowed,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['reconciliation-summary'] });
    queryClient.invalidateQueries({ queryKey: ['reconciliation-list'] });
  };

  const relink = useMutation<unknown, unknown, { visitId: string; vehicleId: string }>({
    mutationFn: ({ visitId, vehicleId }) => api.post(`/reconciliation/${visitId}/relink`, { vehicleId }),
    onSuccess: refresh,
  });
  const ambiguous = useMutation<unknown, unknown, { visitId: string }>({
    mutationFn: ({ visitId }) => api.post(`/reconciliation/${visitId}/ambiguous`, {}),
    onSuccess: refresh,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Data Review" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">Only Managers can review historical records.</p>
        </div>
      </div>
    );
  }

  const s = summaryQ.data;

  return (
    <div className="page-container">
      <PageHeader
        title="Data Review"
        subtitle="Historical visits imported without a known customer — relink or mark ambiguous"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Data Review' }]}
      />

      {s && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          {(['UNRESOLVED', 'RESOLVED', 'AMBIGUOUS'] as const).map((k) => (
            <button
              key={k}
              onClick={() => { setStatus(k); setSkip(0); }}
              className={`card px-4 py-3 text-left transition-colors ${status === k ? 'ring-2 ring-blue-400' : 'hover:border-blue-200'}`}
            >
              <p className="text-xl font-bold text-slate-900">{s[k]}</p>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">
                {k === 'UNRESOLVED' ? 'Awaiting review' : k === 'RESOLVED' ? 'Relinked' : 'Ambiguous'}
              </p>
            </button>
          ))}
        </div>
      )}

      {listQ.isLoading && <LoadingState message="Loading records..." />}

      {listQ.data && listQ.data.items.length === 0 && (
        <div className="card p-6 text-center"><p className="text-sm text-slate-500">Nothing in this list.</p></div>
      )}

      <div className="space-y-3">
        {listQ.data?.items.map((item) => (
          <div key={item.visitId} className="card">
            <div className="card-body">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-slate-400">
                    <Link href={`/visits/${item.visitId}`} className="font-mono text-blue-600 hover:underline">{item.visitNumber ?? item.visitId.slice(0, 8)}</Link>
                    {' · '}{new Date(item.visitedAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
                    {' · '}<span className="font-mono">{item.placeholderVehicleCode}</span>
                  </p>
                  <p className="text-sm text-slate-800 mt-1 break-words">{item.sourceText || <span className="italic text-slate-400">No source text</span>}</p>
                </div>
                {status === 'UNRESOLVED' && (
                  <button
                    onClick={() => ambiguous.mutate({ visitId: item.visitId })}
                    disabled={ambiguous.isPending}
                    className="btn-secondary text-xs shrink-0"
                  >
                    Mark Ambiguous
                  </button>
                )}
              </div>

              {status === 'UNRESOLVED' && (
                item.candidates.length > 0 ? (
                  <div className="mt-3 space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-slate-400">Matches on file</p>
                    {item.candidates.map((c) => (
                      <div key={c.vehicleId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2">
                        <span className="text-sm text-slate-800">
                          <span className="font-mono text-xs text-emerald-700 mr-2">{c.plateNumber || c.vehicleCode}</span>
                          {c.label} — {c.customer.name}
                          {c.customer.phone && <span className="text-xs text-slate-500 ml-1">{c.customer.phone}</span>}
                        </span>
                        <button
                          onClick={() => relink.mutate({ visitId: item.visitId, vehicleId: c.vehicleId })}
                          disabled={relink.isPending}
                          className="btn-primary text-xs"
                        >
                          {relink.isPending ? 'Linking…' : 'Relink to this vehicle'}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 mt-2">No confident match on file — leave unresolved or mark ambiguous.</p>
                )
              )}
            </div>
          </div>
        ))}
      </div>

      {(relink.isError || ambiguous.isError) && (
        <p className="text-xs text-red-600 mt-3">
          {(() => {
            const err = relink.error ?? ambiguous.error;
            return err instanceof Error ? err.message : 'Action failed';
          })()}
        </p>
      )}

      {listQ.data && listQ.data.total > PAGE && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-slate-400">{skip + 1}–{Math.min(skip + PAGE, listQ.data.total)} of {listQ.data.total}</p>
          <div className="flex gap-2">
            <button disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))} className="btn-secondary text-xs disabled:opacity-40">Previous</button>
            <button disabled={skip + PAGE >= listQ.data.total} onClick={() => setSkip(skip + PAGE)} className="btn-secondary text-xs disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
