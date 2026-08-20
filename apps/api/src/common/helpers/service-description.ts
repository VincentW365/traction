/**
 * CR-2026-084 — one way to answer "what is this visit here for?".
 *
 * Five read paths (queue board, ticket detail, the three schedule views and the
 * dispatch overview) each carried their own copy of
 *
 *     visit.appointment?.services.map(s => s.serviceType.name).join(' + ') || 'Walk-in service'
 *
 * which reads ONLY from the appointment. A walk-in has no appointment row, so every
 * one of them fell through to the literal "Walk-in service" and the staff member
 * could never see what the customer had actually asked for. Walk-in intake now
 * records its services as a service order, so the fallback order below resolves for
 * both kinds of visit.
 *
 * Pure and defensive: every level is optional so partially-included Prisma results
 * cannot throw.
 */

interface NamedServiceType {
  serviceType?: { name?: string | null } | null;
}

export interface VisitServiceSource {
  appointment?: { services?: NamedServiceType[] | null } | null;
  serviceOrders?: Array<{ items?: NamedServiceType[] | null }> | null;
}

/** The Prisma `include` a caller needs for {@link describeVisitServices} to resolve. */
export const VISIT_SERVICES_INCLUDE = {
  appointment: {
    include: { services: { include: { serviceType: true } } },
  },
  serviceOrders: {
    include: { items: { include: { serviceType: true } } },
  },
} as const;

/**
 * Distinct service names for a visit, in a stable order: what was booked first,
 * then anything added on the work order.
 */
export function listVisitServices(visit: VisitServiceSource | null | undefined): string[] {
  if (!visit) return [];

  const names: string[] = [];

  for (const s of visit.appointment?.services ?? []) {
    const name = s?.serviceType?.name?.trim();
    if (name) names.push(name);
  }

  for (const order of visit.serviceOrders ?? []) {
    for (const item of order?.items ?? []) {
      const name = item?.serviceType?.name?.trim();
      if (name) names.push(name);
    }
  }

  return [...new Set(names)];
}

/**
 * Human-readable service list for a visit.
 *
 * @param separator joiner between names — the queue board uses " + ", the detail
 *                  views use ", ".
 * @param fallback  shown only when the visit genuinely has no services recorded.
 */
export function describeVisitServices(
  visit: VisitServiceSource | null | undefined,
  separator = ' + ',
  fallback = 'No services recorded',
): string {
  const names = listVisitServices(visit);
  return names.length > 0 ? names.join(separator) : fallback;
}
