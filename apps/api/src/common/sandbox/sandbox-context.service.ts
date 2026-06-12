import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped dev-login sandbox context (CR-2026-023). Holds the active
 * TestDataRun id for the duration of a dev-login request so that create flows
 * can tag new rows to the session. Empty (getRunId === undefined) for ALL normal
 * username/password requests → callers behave exactly as before.
 *
 * Built on Node's AsyncLocalStorage (no new dependency).
 */
interface SandboxStore {
  runId: string;
}

@Injectable()
export class SandboxContextService {
  private readonly als = new AsyncLocalStorage<SandboxStore>();

  /** Run `cb` with the given sandbox run id in context (propagates across awaits). */
  run<T>(runId: string, cb: () => T): T {
    return this.als.run({ runId }, cb);
  }

  /** The active sandbox run id, or undefined when not in a dev-login session. */
  getRunId(): string | undefined {
    return this.als.getStore()?.runId;
  }
}
