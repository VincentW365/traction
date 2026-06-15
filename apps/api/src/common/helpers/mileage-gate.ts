import { BadRequestException } from '@nestjs/common';

/**
 * DMAIC Rule 5 — Mileage gate (relaxed per CR-2026-037).
 *
 * Mileage may be recorded for ANY job — entering it no longer depends on the
 * service selected:
 *  - service job + no mileage      -> reject (mileage still required for service-category jobs)
 *  - service job + mileage         -> allow
 *  - non-service job + mileage     -> allow   (CR-2026-037 — previously rejected)
 *  - non-service job + no mileage  -> allow
 *
 * A manager override bypasses the remaining requirement (callers MUST audit it).
 * Pure function — no I/O — so it is trivially unit-testable and reusable across
 * every mileage write boundary (check-in mileageIn, walk-in mileageIn, completion mileageOut).
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
  // CR-2026-037 — mileage may be entered for any job regardless of the service
  // selected; the prior "non-service job + mileage -> reject" rule was removed.
}
