import { describe, it, expect, vi } from 'vitest';
import { ManagerDashboardService } from '../manager-dashboard.service';

/**
 * CR-2026-074 — a job a technician handed to QC (ServiceOrder status QC) surfaces to
 * managers as a READY_FOR_QC alert on the Control Center alerts feed.
 */
const qcOrder = {
  id: 'so-1',
  completedAt: new Date('2026-07-06T11:00:00Z'),
  serviceVisit: {
    customer: { firstName: 'Ann', lastName: 'Lee' },
    vehicle: { plateNumber: 'ABC123' },
    queueTicket: { ticketNumber: 'A007' },
  },
};

function build() {
  const prisma: any = {
    // overdue query → []; qc query (status QC) → the QC order
    serviceOrder: { findMany: vi.fn(async ({ where }: any) => (where.status === 'QC' ? [qcOrder] : [])) },
    queueTicket: { findMany: vi.fn(async () => []) },
    mechanicDayAvailability: { findMany: vi.fn(async () => []) },
  };
  return { service: new ManagerDashboardService(prisma as any), prisma };
}

describe('getAlerts — READY_FOR_QC (CR-2026-074)', () => {
  it('emits a READY_FOR_QC alert for an order in QC, with the ticket + customer', async () => {
    const { service } = build();
    const alerts = await service.getAlerts('site-1');

    const qc = alerts.find((a) => a.type === 'READY_FOR_QC');
    expect(qc).toBeDefined();
    expect(qc!.title).toContain('A007');
    expect(qc!.detail).toContain('Ann Lee');
    expect(qc!.entityId).toBe('so-1');
  });

  it('emits no READY_FOR_QC alert when nothing is in QC', async () => {
    const prisma: any = {
      serviceOrder: { findMany: vi.fn(async () => []) },
      queueTicket: { findMany: vi.fn(async () => []) },
      mechanicDayAvailability: { findMany: vi.fn(async () => []) },
    };
    const service = new ManagerDashboardService(prisma as any);
    const alerts = await service.getAlerts('site-1');
    expect(alerts.some((a) => a.type === 'READY_FOR_QC')).toBe(false);
  });
});
