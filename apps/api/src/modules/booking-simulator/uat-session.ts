/**
 * CR-2026-108 Stage 3 — the UAT booking session.
 *
 * THE PROBLEM IT SOLVES
 * Stage 1 suppresses notifications per record, by resolving `testDataRunId` from
 * the customer / vehicle / visit a message is about. That covers a RETURNING test
 * customer perfectly — and not at all the case we most need to test: a genuinely
 * brand-new customer coming through /book for the first time. Such a customer has
 * no anchor to resolve, so their records look real and their confirmation is sent.
 *
 * Booking as a pre-tagged customer does not close the gap either: it converts the
 * scenario into the existing-customer workflow, which is a different code path.
 *
 * So an administrator mints a short-lived, signed session and launches the REAL
 * /book flow carrying it. Records created during that session are tagged to the
 * test run, their notifications are captured, and standard test-run cleanup
 * removes them.
 *
 * WHY A SIGNED TOKEN AND NOT A FLAG
 * A `?test=true` parameter would let anyone mark their own booking as a test:
 * free bookings that never notify anyone, invisible to operational reporting, and
 * removable by a cleanup that thinks they are disposable. The capability has to be
 * unforgeable and expiring, so it is a JWT signed with the server secret — the
 * same mechanism as the existing booking session, with its own `kind` so the two
 * can never be interchanged.
 */
import * as jwt from 'jsonwebtoken';

export const UAT_SESSION_KIND = 'uat-booking-session';
/** Matches the customer booking session; long enough to walk the flow, short
 *  enough that a leaked link is not a standing capability. */
export const UAT_SESSION_TTL_MINUTES = 30;

export interface UatSessionClaims {
  kind: typeof UAT_SESSION_KIND;
  /** The TestDataRun everything created in this session belongs to. */
  testDataRunId: string;
  /** Human label, carried so captures can be filtered without a second lookup. */
  runLabel: string;
  /** Who minted it — every test booking is attributable to a person. */
  issuedByUserId: string;
}

export interface UatSessionContext {
  testDataRunId: string;
  runLabel: string;
  issuedByUserId: string;
  expiresAt: Date;
}

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not configured');
  return s;
}

export function signUatSession(claims: Omit<UatSessionClaims, 'kind'>): { token: string; expiresAt: Date } {
  const token = jwt.sign({ ...claims, kind: UAT_SESSION_KIND }, secret(), {
    expiresIn: `${UAT_SESSION_TTL_MINUTES}m`,
  });
  return { token, expiresAt: new Date(Date.now() + UAT_SESSION_TTL_MINUTES * 60_000) };
}

/**
 * Verify a UAT session token.
 *
 * Returns null for ANY problem — bad signature, expired, wrong `kind`, missing
 * claims. Null means "no UAT context", and the booking then proceeds exactly as a
 * normal public booking: a real customer record, a real notification. That is the
 * safe direction. Treating an unverifiable token as valid would let a stranger
 * book invisibly; treating it as absent merely means a tester's booking behaves
 * like a real one, which is loud and recoverable.
 */
export function verifyUatSession(token: string | null | undefined): UatSessionContext | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, secret()) as Partial<UatSessionClaims> & { exp?: number };
    if (decoded.kind !== UAT_SESSION_KIND) return null;
    if (!decoded.testDataRunId || !decoded.runLabel || !decoded.issuedByUserId) return null;
    return {
      testDataRunId: decoded.testDataRunId,
      runLabel: decoded.runLabel,
      issuedByUserId: decoded.issuedByUserId,
      expiresAt: decoded.exp ? new Date(decoded.exp * 1000) : new Date(),
    };
  } catch {
    return null;
  }
}
