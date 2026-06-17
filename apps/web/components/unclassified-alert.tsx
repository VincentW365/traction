'use client';

/**
 * Global "unclassified vehicles" alert (CR-2026-039). Vehicles are classified
 * automatically from make/model; the few the auto-classifier can't match surface
 * here as a small floating alert that opens a popup to set the class — instead of a
 * standing page that's empty almost all the time. Renders nothing when there are
 * none (the common case).
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api-client';
import { useAuth } from '../hooks/use-auth';
import {
  SERVICE_CLASSES,
  confidenceBadgeClass,
  type VehicleServiceClass,
  type ClassificationConfidence,
} from '../lib/vehicle-classes';

const ALLOWED_ROLES = ['ADMIN', 'MANAGER', 'FRONT_DESK', 'SERVICE_ADVISOR'];

interface QueueItem {
  vehicleId: string;
  plateNumber: string;
  make: string | null;
  model: string | null;
  modelYear: number | null;
  customerName: string;
  suggestion: {
    suggestedServiceClass: VehicleServiceClass | null;
    suggestedWeightClass: string | null;
    confidence: ClassificationConfidence;
  };
}
interface QueueResponse { items: QueueItem[]; total: number }

export function UnclassifiedAlert() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Record<string, string>>({});

  const q = useQuery({
    queryKey: ['unclassified-alert'],
    queryFn: () => api.get<QueueResponse>('/vehicles/classification/queue?limit=200'),
    enabled: allowed,
    refetchInterval: 30000, // surface newly-arrived unclassified vehicles
    retry: false,
  });

  const confirmMut = useMutation({
    mutationFn: (v: { vehicleId: string; serviceClass: string; weightClass?: string }) =>
      api.post(`/vehicles/classification/${v.vehicleId}/confirm`, { serviceClass: v.serviceClass, weightClass: v.weightClass }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['unclassified-alert'] }),
  });
  const bulkMut = useMutation({
    mutationFn: (items: { vehicleId: string; serviceClass: string; weightClass?: string }[]) =>
      api.post('/vehicles/classification/bulk-confirm', { items }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['unclassified-alert'] }),
  });

  if (!allowed) return null;
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  if (total === 0) return null; // nothing to show — no standing page when all is well

  const chosenFor = (it: QueueItem): string => choice[it.vehicleId] ?? it.suggestion.suggestedServiceClass ?? '';
  const confirmAllSuggested = () => {
    const batch = items
      .map((it) => ({ vehicleId: it.vehicleId, serviceClass: chosenFor(it), weightClass: it.suggestion.suggestedWeightClass ?? undefined }))
      .filter((b) => b.serviceClass);
    if (batch.length) bulkMut.mutate(batch);
  };
  const anyChoosable = items.some((it) => chosenFor(it));

  return (
    <>
      {/* Floating alert — only rendered when there are unclassified vehicles */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-amber-600 transition-colors"
          title="Some vehicles need a service class"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          {total} vehicle{total !== 1 ? 's' : ''} need a class
        </button>
      )}

      {/* Popup to resolve them */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setOpen(false)}>
          <div className="card w-[660px] max-w-full max-h-[82vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="card-header flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Vehicles needing a service class</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Most vehicles classify automatically. Set a class for these so they can be bay‑assigned (they stay mobile‑jack blocked until set).
                </p>
              </div>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-2">
              {items.map((it) => {
                const rowPending = confirmMut.isPending && confirmMut.variables?.vehicleId === it.vehicleId;
                const sc = chosenFor(it);
                return (
                  <div key={it.vehicleId} className="flex items-center gap-3 rounded-md border border-slate-200 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {[it.make, it.model].filter(Boolean).join(' ') || '—'}
                        {it.modelYear ? <span className="text-slate-400"> · {it.modelYear}</span> : null}
                      </p>
                      <p className="text-xs text-slate-500 truncate">
                        <span className="font-mono">{it.plateNumber}</span> · {it.customerName}
                        <span className={`ml-2 badge ${confidenceBadgeClass(it.suggestion.confidence)}`}>{it.suggestion.confidence}</span>
                      </p>
                    </div>
                    <select
                      value={sc}
                      onChange={(e) => setChoice((p) => ({ ...p, [it.vehicleId]: e.target.value }))}
                      className="input-field py-1 w-44 text-xs"
                    >
                      <option value="">— choose —</option>
                      {SERVICE_CLASSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    <button
                      onClick={() => confirmMut.mutate({ vehicleId: it.vehicleId, serviceClass: sc, weightClass: it.suggestion.suggestedWeightClass ?? undefined })}
                      disabled={!sc || rowPending}
                      className="btn-primary py-1 px-3 text-xs"
                    >
                      {rowPending ? 'Saving…' : 'Set'}
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="card-header border-t border-b-0 flex items-center justify-between">
              <span className="text-xs text-slate-500">{total} remaining</span>
              <div className="flex gap-2">
                <button onClick={confirmAllSuggested} disabled={!anyChoosable || bulkMut.isPending} className="btn-secondary text-xs">
                  {bulkMut.isPending ? 'Saving…' : 'Set all to suggested'}
                </button>
                <button onClick={() => setOpen(false)} className="btn-secondary text-xs">Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
