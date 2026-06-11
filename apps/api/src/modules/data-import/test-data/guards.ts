/**
 * Test Data Sandbox — guards (CR-2026-020, T-b). Pure, unit-testable.
 *
 * Safety rails for the create path:
 *  - env gate: ALLOW_TEST_DATA_TOOLS must be true,
 *  - label must be a safe slug and not already in use,
 *  - test customers keep normal `CUST-` numbers (NEVER a `VWTEST-` number — that
 *    would break the customer-number generator's SUBSTRING/CAST). The visible
 *    marker is the customer NAME prefix.
 *
 * This module touches NO database and creates/deletes nothing.
 */

/** Visible name marker for sandbox customers (also exported from operational-scope). */
export const TEST_CUSTOMER_FIRST_NAME = 'VWTEST';
/** Vehicle business-code prefix for sandbox vehicles (live placeholder prefix is HIST-UNRESOLVED-). */
export const TEST_VEHICLE_CODE_PREFIX = 'SC-VWT';

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,59}$/;
const CUST_NUMBER_RE = /^CUST-[0-9]+$/;

/** Refuse to create test data unless the env gate is explicitly enabled. */
export function assertTestDataToolsEnabled(enabled: boolean): void {
  if (enabled !== true) {
    throw new Error(
      'Refusing: test-data tools are disabled. Set ALLOW_TEST_DATA_TOOLS=true ' +
        '(local/staging only) to create test data.',
    );
  }
}

/** A label is a 3–60 char slug: letters/digits then letters/digits/._- */
export function assertValidLabel(label: string | undefined): asserts label is string {
  if (!label || !LABEL_RE.test(label)) {
    throw new Error(
      `Invalid --label "${label ?? ''}". Use 3–60 chars [A-Za-z0-9._-], ` +
        'e.g. vw-test-run-2026-06-11.',
    );
  }
}

/** Refuse to reuse an existing run label (labels are unique per run). */
export function assertLabelAvailable(existingRun: { id: string } | null, label: string): void {
  if (existingRun) {
    throw new Error(
      `Refusing: a TestDataRun with label "${label}" already exists (id ${existingRun.id}). ` +
        'Use a new --label.',
    );
  }
}

/** Format a sandbox customer number in the normal CUST- space (never VWTEST-). */
export function formatTestCustomerNumber(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`formatTestCustomerNumber: seq must be a non-negative integer, got ${seq}`);
  }
  return `CUST-${String(seq).padStart(6, '0')}`;
}

/** Defensive: a sandbox customer number MUST be in CUST-<digits> form. */
export function assertCustomerNumberSafe(customerNumber: string): void {
  if (!CUST_NUMBER_RE.test(customerNumber)) {
    throw new Error(
      `Refusing: test customer number "${customerNumber}" is not in CUST-<digits> form. ` +
        'Test customers must use normal CUST- numbers (a VWTEST- number would break the ' +
        'customer-number generator).',
    );
  }
}
