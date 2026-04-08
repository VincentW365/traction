export const ServiceVisitStatus = {
  CREATED: 'CREATED',
  ARRIVED: 'ARRIVED',
  CHECKED_IN: 'CHECKED_IN',
  QUEUED: 'QUEUED',
  CALLED: 'CALLED',
  IN_SERVICE: 'IN_SERVICE',
  WAITING_PARTS: 'WAITING_PARTS',
  QC: 'QC',
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  CLOSED: 'CLOSED',
  ABANDONED: 'ABANDONED',
  CANCELLED: 'CANCELLED',
} as const;

export type ServiceVisitStatus =
  (typeof ServiceVisitStatus)[keyof typeof ServiceVisitStatus];
