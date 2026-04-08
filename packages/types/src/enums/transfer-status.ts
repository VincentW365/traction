export const TransferStatus = {
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  IN_TRANSIT: 'IN_TRANSIT',
  RECEIVED: 'RECEIVED',
  DELAYED: 'DELAYED',
  CANCELLED: 'CANCELLED',
} as const;

export type TransferStatus =
  (typeof TransferStatus)[keyof typeof TransferStatus];
