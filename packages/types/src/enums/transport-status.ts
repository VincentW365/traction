export const TransportDirection = {
  DROPOFF: 'DROPOFF',
  PICKUP: 'PICKUP',
} as const;

export type TransportDirection =
  (typeof TransportDirection)[keyof typeof TransportDirection];

export const TransportStatus = {
  REQUESTED: 'REQUESTED',
  CONFIRMATION_PENDING: 'CONFIRMATION_PENDING',
  SCHEDULED: 'SCHEDULED',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type TransportStatus =
  (typeof TransportStatus)[keyof typeof TransportStatus];
