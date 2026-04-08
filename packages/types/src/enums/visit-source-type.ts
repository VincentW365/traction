export const VisitSourceType = {
  APPOINTMENT: 'APPOINTMENT',
  WALKIN: 'WALKIN',
} as const;

export type VisitSourceType =
  (typeof VisitSourceType)[keyof typeof VisitSourceType];
