/**
 * Confidence Resolver — Pure Function
 *
 * Determines the overall recommendation confidence based on:
 * 1. Whether a VIN was available for decode
 * 2. The vehicle decode confidence level
 * 3. The fluid specification confidence level
 *
 * The result is the LOWEST confidence among inputs — the chain is only
 * as strong as its weakest link.
 */

export type RecommendationConfidence =
  | 'OEM'
  | 'VERIFIED'
  | 'NEEDS_CONFIRMATION'
  | 'ESTIMATE';

const CONFIDENCE_RANK: Record<RecommendationConfidence, number> = {
  OEM: 4,
  VERIFIED: 3,
  NEEDS_CONFIRMATION: 2,
  ESTIMATE: 1,
};

/**
 * Resolve the effective confidence for a maintenance recommendation.
 *
 * @param hasVin - Whether the vehicle has a VIN on file
 * @param decodeConfidence - Confidence from the VehicleSpecSnapshot decode
 * @param fluidSpecConfidence - Confidence from the FluidSpecSnapshot lookup
 * @returns The lowest confidence level among all inputs
 */
export function resolveConfidence(
  hasVin: boolean,
  decodeConfidence: RecommendationConfidence | null,
  fluidSpecConfidence: RecommendationConfidence | null,
): RecommendationConfidence {
  // No VIN means we cannot have decoded the vehicle reliably
  if (!hasVin) {
    return 'ESTIMATE';
  }

  // If either source is missing, we cannot confirm
  if (decodeConfidence == null || fluidSpecConfidence == null) {
    return 'NEEDS_CONFIRMATION';
  }

  const decodeRank = CONFIDENCE_RANK[decodeConfidence];
  const fluidRank = CONFIDENCE_RANK[fluidSpecConfidence];

  const minRank = Math.min(decodeRank, fluidRank);

  const entry = Object.entries(CONFIDENCE_RANK).find(
    ([, rank]) => rank === minRank,
  );

  return (entry?.[0] as RecommendationConfidence) ?? 'ESTIMATE';
}
