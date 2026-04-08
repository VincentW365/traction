export const RecommendationConfidence = {
  OEM: 'OEM',
  VERIFIED: 'VERIFIED',
  NEEDS_CONFIRMATION: 'NEEDS_CONFIRMATION',
  ESTIMATE: 'ESTIMATE',
} as const;

export type RecommendationConfidence =
  (typeof RecommendationConfidence)[keyof typeof RecommendationConfidence];

export const DrivingProfile = {
  NORMAL: 'NORMAL',
  SEVERE: 'SEVERE',
} as const;

export type DrivingProfile =
  (typeof DrivingProfile)[keyof typeof DrivingProfile];
