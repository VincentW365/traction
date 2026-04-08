export const PaymentStatus = {
  UNPAID: 'UNPAID',
  PENDING: 'PENDING',
  PAID: 'PAID',
  ON_ACCOUNT: 'ON_ACCOUNT',
  FAILED: 'FAILED',
  WAIVED: 'WAIVED',
} as const;

export type PaymentStatus =
  (typeof PaymentStatus)[keyof typeof PaymentStatus];
