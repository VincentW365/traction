'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../hooks/use-auth';
import { PageHeader } from '../../../components/ui/page-header';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';
import {
  SERVICE_CLASSES,
  WEIGHT_CLASSES,
  CONFIDENCE_FILTERS,
  confidenceBadgeClass,
  type VehicleServiceClass,
  type VehicleWeightClass,
  type ClassificationConfidence,
} from '../../../lib/vehicle-classes';

const ALLOWED_ROLES = ['FRONT_DESK', 'SERVICE_ADVISOR', 'MANAGER', 'ADMIN'];
const PAGE_SIZE = 50;

interface QueueItem {
  vehicleId: string;
  vehicleCode: string;
  plateNumber: string;
  make: string | null;
  model: string | null;
  modelYear: number | null;
  currentServiceClass: VehicleServiceClass | null;
  currentWeightClass: VehicleWeightClass | null;
  customerName: string;
  classificationStatus: string;
  suggestion: {
    suggestedServiceClass: VehicleServiceClass | null;
    suggestedWeightClass: VehicleWeightClass | null;
    confidence: ClassificationConfidence;
    source: string;
  };
}

interface QueueResponse {
  items: QueueItem[];
  total: number;
  limit: number;
  offset: number;
}

interface BulkResult {
  confirmed: number;
  failed: number;
  results: { vehicleId: string; ok: boolean; error?: string }[];
}

type Choice = { serviceClass: string; weightClass: string };

export default function VehicleClassificationPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [confidence, setConfidence] = useState<'' | ClassificationConfidence>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');
  const [offset, setOffset] = useState(0);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  // Debounce search; reset paging when filters change.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTerm(searchTerm.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);
  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [confidence, debouncedTerm]);

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (confidence) params.set('confidence', confidence);
  if (debouncedTerm) params.set('search', debouncedTerm);

  const queueQuery = useQuery({
    queryKey: ['vehicle-classification', confidence, debouncedTerm, offset],
    queryFn: () => api.get<QueueResponse>(`/vehicles/classification/queue?${params.toString()}`),
    enabled: ALLOWED_ROLES.includes(user?.roleCode ?? ''),
  });

  const confirmMutation = useMutation({
    mutationFn: (v: { vehicleId: string; serviceClass: string; weightClass: string }) =>
      api.post(`/vehicles/classification/${v.vehicleId}/confirm`, {
        serviceClass: v.serviceClass,
        weightClass: v.weightClass || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle-classification'] });
    },
  });

  const bulkMutation = useMutation({
    mutationFn: (items: { vehicleId: string; serviceClass: string; weightClass?: string }[]) =>
      api.post<BulkResult>('/vehicles/classification/bulk-confirm', { items }),
    onSuccess: (res) => {
      setBulkResult(res);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['vehicle-classification'] });
    },
  });

  if (!ALLOWED_ROLES.includes(user?.roleCode ?? '')) {
    return (
      <div className="page-container">
        <PageHeader title="Vehicle Classification" subtitle="Staff review queue" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">
            You don&apos;t have permission to classify vehicles. Ask a manager for the
            vehicle:update role.
          </p>
        </div>
      </div>
    );
  }

  const items = queueQuery.data?.items ?? [];
  const total = queueQuery.data?.total ?? 0;

  // Effective chosen value for a row: explicit choice, else the suggestion default.
  const chosenFor = (it: QueueItem): Choice =>
    choices[it.vehicleId] ?? {
      serviceClass: it.suggestion.suggestedServiceClass ?? '',
      weightClass: it.suggestion.suggestedWeightClass ?? '',
    };

  const setChoice = (id: string, patch: Partial<Choice>, base: Choice) =>
    setChoices((prev) => ({ ...prev, [id]: { ...base, ...prev[id], ...patch } }));

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const selectableIds = items.filter((it) => chosenFor(it).serviceClass).map((it) => it.vehicleId);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(selectableIds));

  const runBulk = () => {
    const itemsToConfirm = items
      .filter((it) => selected.has(it.vehicleId))
      .map((it) => {
        const c = chosenFor(it);
        return { vehicleId: it.vehicleId, serviceClass: c.serviceClass, weightClass: c.weightClass || undefined };
      })
      .filter((i) => i.serviceClass);
    if (itemsToConfirm.length) bulkMutation.mutate(itemsToConfirm);
  };

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="page-container">
      <PageHeader
        title="Vehicle Classification"
        subtitle="Confirm or correct imported vehicles' service class. Suggestions are advisory — a vehicle stays mobile-jack blocked until confirmed."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Vehicle Classification' }]}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="input-label">Confidence</label>
          <select
            value={confidence}
            onChange={(e) => setConfidence(e.target.value as '' | ClassificationConfidence)}
            className="input-field"
          >
            {CONFIDENCE_FILTERS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[220px] max-w-md">
          <label className="input-label">Search</label>
          <input
            type="text"
            placeholder="make / model / plate"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input-field"
          />
        </div>
        <div className="ml-auto">
          <button
            onClick={runBulk}
            disabled={selected.size === 0 || bulkMutation.isPending}
            className="btn-primary"
          >
            {bulkMutation.isPending ? 'Confirming...' : `Confirm selected (${selected.size})`}
          </button>
        </div>
      </div>

      {bulkResult && (
        <div className="rounded-md bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-700 mb-4">
          Bulk confirm: <strong>{bulkResult.confirmed}</strong> confirmed
          {bulkResult.failed > 0 && (
            <span className="text-red-600"> · {bulkResult.failed} failed</span>
          )}
          {bulkResult.failed > 0 && (
            <ul className="mt-1 list-disc list-inside text-xs text-red-600">
              {bulkResult.results.filter((r) => !r.ok).slice(0, 10).map((r) => (
                <li key={r.vehicleId}>{r.vehicleId}: {r.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {confirmMutation.isError && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-4">
          {confirmMutation.error instanceof Error ? confirmMutation.error.message : 'Failed to confirm classification'}
        </div>
      )}

      {queueQuery.isLoading && <LoadingState message="Loading classification queue..." />}

      {queueQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load the classification queue.</p>
        </div>
      )}

      {queueQuery.data && items.length === 0 && (
        <EmptyState
          title="Nothing to classify"
          description="No vehicles match the current filters. Try clearing the search or confidence filter."
        />
      )}

      {queueQuery.data && items.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-2 text-xs text-slate-500">
            <span>Showing {pageStart}–{pageEnd} of {total}</span>
          </div>
          <div className="table-container">
            <table className="w-full text-sm">
              <thead className="table-header">
                <tr>
                  <th className="w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th>Vehicle</th>
                  <th>Plate</th>
                  <th>Customer</th>
                  <th>Suggestion</th>
                  <th>Service class</th>
                  <th>Weight</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const c = chosenFor(it);
                  const rowPending = confirmMutation.isPending && confirmMutation.variables?.vehicleId === it.vehicleId;
                  const canConfirm = !!c.serviceClass && !rowPending;
                  return (
                    <tr key={it.vehicleId} className="table-row">
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(it.vehicleId)}
                          disabled={!c.serviceClass}
                          onChange={() => toggleSelect(it.vehicleId)}
                          aria-label={`Select ${it.plateNumber}`}
                        />
                      </td>
                      <td>
                        <span className="font-medium text-slate-900">
                          {[it.make, it.model].filter(Boolean).join(' ') || '—'}
                        </span>
                        {it.modelYear ? <span className="text-slate-400"> · {it.modelYear}</span> : null}
                      </td>
                      <td className="font-mono text-xs text-slate-600">{it.plateNumber}</td>
                      <td className="text-slate-700">{it.customerName}</td>
                      <td>
                        <span className={`badge ${confidenceBadgeClass(it.suggestion.confidence)}`}>
                          {it.suggestion.confidence}
                        </span>
                        {it.suggestion.suggestedServiceClass && (
                          <span className="ml-2 text-xs text-slate-500">
                            {it.suggestion.suggestedServiceClass}
                            {it.suggestion.suggestedWeightClass ? ` / ${it.suggestion.suggestedWeightClass}` : ''}
                          </span>
                        )}
                      </td>
                      <td>
                        <select
                          value={c.serviceClass}
                          onChange={(e) => setChoice(it.vehicleId, { serviceClass: e.target.value }, c)}
                          className="input-field py-1"
                        >
                          <option value="">— choose —</option>
                          {SERVICE_CLASSES.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={c.weightClass}
                          onChange={(e) => setChoice(it.vehicleId, { weightClass: e.target.value }, c)}
                          className="input-field py-1"
                        >
                          <option value="">—</option>
                          {WEIGHT_CLASSES.map((w) => (
                            <option key={w.value} value={w.value}>{w.label}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <button
                          onClick={() =>
                            confirmMutation.mutate({
                              vehicleId: it.vehicleId,
                              serviceClass: c.serviceClass,
                              weightClass: c.weightClass,
                            })
                          }
                          disabled={!canConfirm}
                          className="btn-primary py-1 px-3 text-xs"
                        >
                          {rowPending ? 'Saving...' : 'Confirm'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Paging */}
          <div className="flex items-center justify-between mt-4">
            <button
              onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
              disabled={offset === 0}
              className="btn-secondary"
            >
              ← Previous
            </button>
            <span className="text-xs text-slate-500">{pageStart}–{pageEnd} of {total}</span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={pageEnd >= total}
              className="btn-secondary"
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
