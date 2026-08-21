'use client';

/**
 * CR-2026-090 — recording which axle a brake line covers.
 *
 * Traction's brake service codes carry no axle, but the shop's price list
 * distinguishes them explicitly — separate lines for disc pads and rear electronic
 * disc pads, plus brake shoes for drums. A brake line is therefore ambiguous on its
 * own, and rear-only work must not silently satisfy a standard built for front
 * brakes.
 *
 * The component only appears where it is needed. Which services need an axle is
 * configuration, so it is read from the package detection rather than guessed from a
 * service code here — a hard-coded list of "brake-ish" codes in the UI would drift
 * away from the admin screen the first time someone added a service.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api-client';

export type AxlePosition = 'FRONT' | 'REAR' | 'FRONT_AND_REAR' | 'NOT_APPLICABLE';

export const AXLE_LABEL: Record<AxlePosition, string> = {
  FRONT: 'Front',
  REAR: 'Rear',
  FRONT_AND_REAR: 'Front & rear',
  NOT_APPLICABLE: 'Not applicable',
};

const AXLE_OPTIONS: AxlePosition[] = ['FRONT', 'REAR', 'FRONT_AND_REAR', 'NOT_APPLICABLE'];

interface PackageDetection {
  packageType: string;
  reason: string | null;
  awaitingAxleQualifierServiceTypeIds: string[];
  disqualifiedByAxleServiceTypeIds: string[];
  resolvableByAxleQualifier: boolean;
}

export interface AxleQualifierItem {
  id: string;
  axlePosition: AxlePosition | null;
  serviceType: { id: string; name: string; code: string };
}

interface Props {
  orderId: string;
  items: AxleQualifierItem[];
  /** Query keys to refresh once an axle is recorded. */
  invalidateKeys?: unknown[][];
  disabled?: boolean;
}

export function AxleQualifier({ orderId, items, invalidateKeys = [], disabled }: Props) {
  const queryClient = useQueryClient();

  const detection = useQuery<PackageDetection>({
    queryKey: ['kpi-package', orderId],
    queryFn: () => api.get(`/kpi/orders/${orderId}/package`),
    retry: false,
  });

  const setAxle = useMutation({
    mutationFn: ({ itemId, axlePosition }: { itemId: string; axlePosition: AxlePosition }) =>
      api.patch(`/service-orders/${orderId}/items/${itemId}/axle`, { axlePosition }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kpi-package', orderId] });
      for (const key of invalidateKeys) queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const d = detection.data;
  if (!d) return null;

  const needsAxle = new Set([
    ...d.awaitingAxleQualifierServiceTypeIds,
    ...d.disqualifiedByAxleServiceTypeIds,
  ]);

  // A line that already carries an axle stays visible so it can be corrected — the
  // control disappearing the moment it is answered makes a mistyped axle unfixable
  // from the screen where it was entered.
  const relevant = items.filter(
    (i) => needsAxle.has(i.serviceType.id) || i.axlePosition !== null,
  );
  if (relevant.length === 0) return null;

  return (
    <div className="mt-2 pt-2 border-t border-slate-100 space-y-2">
      {d.resolvableByAxleQualifier && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          Record the axle to measure this job against the Front Brakes standard. Rear-only
          work is not covered by that standard.
        </p>
      )}

      {relevant.map((item) => (
        <div key={item.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-slate-600">{item.serviceType.name} — axle</span>
          <div className="flex items-center gap-1">
            {AXLE_OPTIONS.map((opt) => {
              const selected = item.axlePosition === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  disabled={disabled || setAxle.isPending}
                  onClick={() => setAxle.mutate({ itemId: item.id, axlePosition: opt })}
                  className={`px-2 py-0.5 rounded border text-[11px] ${
                    selected
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
                  } disabled:opacity-50`}
                >
                  {AXLE_LABEL[opt]}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {setAxle.isError && (
        <p className="text-[11px] text-red-600">
          {setAxle.error instanceof Error ? setAxle.error.message : 'Could not record the axle'}
        </p>
      )}
    </div>
  );
}
