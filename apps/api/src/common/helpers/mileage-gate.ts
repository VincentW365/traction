import { BadRequestException } from '@nestjs/common';

/**
 * DMAIC Rule 5 — Mileage gate.
 *
 * Mileage may be recorded ONLY for service-category jobs:
 *  - service job + no mileage      -> reject (mileage required)
 *  - non-service job + mileage     -> reject (mileage not allowed)
 *  - service job + mileage         -> allow
 *  - non-service job + no mileage  -> allow
 *
 * A manager override bypasses the gate entirely (callers MUST audit the override).
 * Pure function — no I/O — so it is trivially unit-testable and reusable across
 * every mileage write boundary (check-in mileageIn, completion mileageOut).
 */
export function assertMileageGate(opts: {
  requiresMileage: boolean;
  mileageProvided: boolean;
  override?: boolean;
}): void {
  const { requiresMileage, mileageProvided, override } = opts;
  if (override) return;

  if (requiresMileage && !mileageProvided) {
    throw new BadRequestException(
      'Mileage reading is required for service-category jobs. Provide a mileage value or apply a manager override.',
    );
  }
  if (!requiresMileage && mileageProvided) {
    throw new BadRequestException(
      'Mileage cannot be recorded for non-service jobs (DMAIC Rule 5). Apply a manager override if this is intentional.',
    );
  }
}
