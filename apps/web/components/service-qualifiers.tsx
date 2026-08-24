'use client';

/**
 * CR-2026-092 — capture the qualifiers a conditional service needs, and show what
 * they do to the job's standard before anybody commits to them.
 *
 * Replaces the axle-only control of CR-2026-090, which could not describe a brake
 * line: an axle narrows the work but never says whether it is pads, shoes, a rotor
 * or a bleed, and those carry different allowances.
 *
 * The prompt appears as soon as the service is on the order rather than at Start
 * Work. The API refuses to start an assignment whose qualifiers are outstanding, so
 * a technician who first meets the question there meets it as a refusal, standing at
 * the car, with no idea what is being asked of them.
 *
 * Controlled choices only. The qualifier decides which benchmark somebody is
 * measured against, and "front pads (I think)" is not something a calculation can
 * act on.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api-client';
import {
  type KpiCalculationBreakdown,
  type KpiCalculationLine,
} from './kpi-calculation-panel';
import {
  AXLE_LABEL,
  BRAKE_AXLE_OPTIONS,
  BRAKE_WORK_LABEL,
  BRAKE_WORK_OPTIONS,
  TIRE_OP_LABEL,
  TIRE_OP_OPTIONS,
  qualifierPrompts,
  showBrakeAxle,
  type AxlePosition,
  type BrakeWorkType,
  type MissingQualifier,
  type QualifierItem,
  type TireOperation,
} from '../lib/service-qualifiers';

/** Any subset; the API leaves qualifiers the body does not name untouched. */
interface QualifierPatch {
  axlePosition?: AxlePosition;
  brakeWorkType?: BrakeWorkType;
  tireOperation?: TireOperation;
}

/** The fields of GET /service-orders/:id/benchmark-readiness this control reads. */
interface BenchmarkReadiness {
  missingQualifiers: MissingQualifier[];
  unmappedServiceTypeIds: string[];
  calculation: {
    packageType: string;
    basePackageMinutes: number | null;
    additiveMinutes: number;
    finalStandardMinutes: number | null;
    benchmarkSource: KpiCalculationBreakdown['benchmarkSource'];
    provisionalDurationsUsed: boolean;
    contributions: KpiCalculationLine[];
    missingQualifiers: MissingQualifier[];
  };
}

export function useBenchmarkReadiness(orderId: string) {
  return useQuery<BenchmarkReadiness>({
    queryKey: ['benchmark-readiness', orderId],
    queryFn: () => api.get(`/service-orders/${orderId}/benchmark-readiness`),
    retry: false,
  });
}

/** "90" is a database value; "about 1 h 30 min" is what a person plans around. */
function formatApproxMinutes(minutes: number): string {
  if (minutes < 60) return `about ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
}

interface Props {
  orderId: string;
  /** Omit to let the control load the order's lines itself. */
  items?: QualifierItem[];
  /** Query keys to refresh once an answer is recorded. */
  invalidateKeys?: unknown[][];
  showCalculation?: boolean;
}

export function ServiceQualifiers({
  orderId,
  items,
  invalidateKeys = [],
  showCalculation = true,
}: Props) {
  const queryClient = useQueryClient();
  const readiness = useBenchmarkReadiness(orderId);

  const ownLines = useQuery<{ items: QualifierItem[] }>({
    queryKey: ['service-order-lines', orderId],
    queryFn: () => api.get(`/service-orders/${orderId}`),
    enabled: !items,
  });

  const save = useMutation({
    mutationFn: ({ itemId, patch }: { itemId: string; patch: QualifierPatch }) =>
      api.patch(`/service-orders/${orderId}/items/${itemId}/qualifiers`, patch),
    // The server re-derives the standard on save, so the breakdown is refetched
    // rather than recomputed here — two implementations of the same arithmetic
    // eventually disagree, and the screen would then contradict the filed result.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['benchmark-readiness', orderId] });
      queryClient.invalidateQueries({ queryKey: ['service-order-lines', orderId] });
      for (const key of invalidateKeys) queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const data = readiness.data;
  if (!data) return null;

  const lines = items ?? ownLines.data?.items ?? [];
  const prompts = qualifierPrompts(lines, data.missingQualifiers);
  if (prompts.length === 0 && !showCalculation) return null;

  return (
    <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
      {prompts.map(({ item, kind, message }) => (
        <div key={item.id} className="rounded-lg border border-slate-200 px-3 py-2 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-slate-800">{item.serviceType.name}</span>
            <span className="font-mono text-[10px] text-slate-400">{item.serviceType.code}</span>
          </div>

          {/* Names the service and the choice to make, so the reader is not left
              looking for the control the warning is about. */}
          {message && (
            <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
              {message}
            </p>
          )}

          {kind === 'BRAKE' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="input-label">Brake work</label>
                <select
                  className="input-field text-xs"
                  value={item.brakeWorkType ?? ''}
                  disabled={save.isPending}
                  onChange={(e) =>
                    save.mutate({
                      itemId: item.id,
                      patch: { brakeWorkType: e.target.value as BrakeWorkType },
                    })
                  }
                >
                  {!item.brakeWorkType && <option value="">Choose…</option>}
                  {BRAKE_WORK_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {BRAKE_WORK_LABEL[o]}
                    </option>
                  ))}
                </select>
              </div>

              {showBrakeAxle(item) && (
                <div>
                  <label className="input-label">Axle</label>
                  <select
                    className="input-field text-xs"
                    value={
                      item.axlePosition && item.axlePosition !== 'NOT_APPLICABLE'
                        ? item.axlePosition
                        : ''
                    }
                    disabled={save.isPending}
                    onChange={(e) =>
                      save.mutate({
                        itemId: item.id,
                        patch: { axlePosition: e.target.value as AxlePosition },
                      })
                    }
                  >
                    {(!item.axlePosition || item.axlePosition === 'NOT_APPLICABLE') && (
                      <option value="">Choose…</option>
                    )}
                    {BRAKE_AXLE_OPTIONS.map((o) => (
                      <option key={o} value={o}>
                        {AXLE_LABEL[o]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          ) : (
            <div>
              <label className="input-label">Tyre work</label>
              <select
                className="input-field text-xs"
                value={item.tireOperation ?? ''}
                disabled={save.isPending}
                onChange={(e) =>
                  save.mutate({
                    itemId: item.id,
                    patch: { tireOperation: e.target.value as TireOperation },
                  })
                }
              >
                {!item.tireOperation && <option value="">Choose…</option>}
                {TIRE_OP_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {TIRE_OP_LABEL[o]}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      ))}

      {save.isError && (
        <p className="text-[11px] text-red-600">
          {save.error instanceof Error ? save.error.message : 'Could not record the answer'}
        </p>
      )}

      {showCalculation && (
        <>
          {/* Just how long the job should take. The full benchmark arithmetic and the
              ratings it feeds are management material and live on the dispatch board
              and the KPI reports — front-of-house needs a time, not a scorecard. */}
          {data.calculation.finalStandardMinutes != null && (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              Approximate job time:{' '}
              <span className="font-semibold text-slate-900">
                {formatApproxMinutes(data.calculation.finalStandardMinutes)}
              </span>
            </p>
          )}

          {/* Nobody on this screen can fix an unmapped service, so the note says who
              can rather than leaving the reader to guess at the blank estimate. */}
          {data.unmappedServiceTypeIds.length > 0 && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              {data.unmappedServiceTypeIds.length === 1
                ? 'One service on this job has no time standard configured'
                : `${data.unmappedServiceTypeIds.length} services on this job have no time standard configured`}
              , so an approximate job time cannot be shown yet. An administrator sets
              this under Admin → KPI Mapping.
            </p>
          )}
        </>
      )}
    </div>
  );
}
