export const PartsRequestStatus = {
  OPEN: 'OPEN',
  RESERVING: 'RESERVING',
  PARTIAL: 'PARTIAL',
  READY: 'READY',
  TRANSFER_IN_PROGRESS: 'TRANSFER_IN_PROGRESS',
  RECEIVED: 'RECEIVED',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
} as const;

export type PartsRequestStatus =
  (typeof PartsRequestStatus)[keyof typeof PartsRequestStatus];
