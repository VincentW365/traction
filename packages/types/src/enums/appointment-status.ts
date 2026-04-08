export const AppointmentStatus = {
  DRAFT: 'DRAFT',
  CONFIRMED: 'CONFIRMED',
  CHECKED_IN: 'CHECKED_IN',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  MISSED: 'MISSED',
  CANCELLED: 'CANCELLED',
  RESCHEDULED: 'RESCHEDULED',
} as const;

export type AppointmentStatus =
  (typeof AppointmentStatus)[keyof typeof AppointmentStatus];
