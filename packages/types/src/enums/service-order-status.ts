export const ServiceOrderStatus = {
  DRAFT: 'DRAFT',
  APPROVED: 'APPROVED',
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING_PARTS: 'WAITING_PARTS',
  QC: 'QC',
  READY_TO_INVOICE: 'READY_TO_INVOICE',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
} as const;

export type ServiceOrderStatus =
  (typeof ServiceOrderStatus)[keyof typeof ServiceOrderStatus];
