export const QueueDisplayStatus = {
  PENDING_RANK: 'PENDING_RANK',
  ISSUED: 'ISSUED',
  WAITING: 'WAITING',
  CALLED: 'CALLED',
  IN_SERVICE: 'IN_SERVICE',
  BLOCKED: 'BLOCKED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type QueueDisplayStatus =
  (typeof QueueDisplayStatus)[keyof typeof QueueDisplayStatus];
