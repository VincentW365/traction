import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ensureRequiredForms, requiredFormsState } from './templates/required-forms';

/**
 * CR-2026-107 — the deployment-parity fix.
 *
 * The recurring defect this closes: the repository could always reproduce both
 * inspection templates from `pnpm db:seed`, but NOTHING in the deployed
 * application guaranteed the seed had ever run. The guarantee lived in
 * `render.yaml`'s build command, in `scripts/deploy-bootstrap.mjs` and in a
 * runbook — all of which a deployment can skip without any error:
 *
 *   - a Render service whose Build Command was edited in the dashboard stops
 *     reading render.yaml, so pushing a corrected render.yaml changes nothing;
 *   - a database restored, replaced or newly attached after the last build has
 *     never been seeded by that build.
 *
 * In both cases migrations still ran (they are part of every start command), so
 * the Job Sheet — which needs only its table — kept working, while the two
 * inspection forms, which need seeded ROWS, did not. That asymmetry is exactly
 * what the manager reported.
 *
 * Running the guarantee here, at API start, removes the operator from the loop:
 * there is no configuration to detach and no step to forget.
 *
 * Failure policy: log loudly, never crash. A shop that cannot open an inspection
 * must not also lose its queue board, job sheets and check-in — and a boot loop
 * would take the whole site down. The deployment pipeline (`deploy:check`) is
 * the gate that fails; this is the safety net behind it, and Admin → Deployment
 * plus /health keep showing the true state either way.
 *
 * Opt out with FORMS_BOOTSTRAP=off (documented in .env.example) for a read-only
 * replica or a forensic restore where writes are not wanted.
 */
@Injectable()
export class RequiredFormsBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('RequiredForms');

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.FORMS_BOOTSTRAP === 'off') {
      this.logger.warn('FORMS_BOOTSTRAP=off — skipping the required-forms check. Inspection forms are not guaranteed.');
      return;
    }
    await this.run();
  }

  /** Extracted so tests can drive it without a Nest lifecycle. */
  async run(): Promise<void> {
    try {
      const { actions, changed, state } = await ensureRequiredForms(this.prisma);

      if (changed) {
        // Someone deployed into a database that could not open an inspection.
        // Say so plainly and say what was repaired — this is the line that
        // explains a previously silent failure.
        this.logger.warn(`Required forms were incomplete on this database — repaired ${actions.length} item(s):`);
        for (const a of actions) this.logger.warn(`  ${a.form}: ${a.action} — ${a.detail}`);
      }

      this.logger.log(
        `Required forms — Job Sheet: ${pass(state.jobSheet)} · ` +
          `Pre-Job Inspection: ${pass(state.preJobInspection)} · ` +
          `Service Inspection: ${pass(state.serviceInspection)}`,
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `Could not guarantee the required inspection forms: ${message}. ` +
          'The API will keep serving, but inspections may not open. ' +
          'Run "pnpm forms:ensure" against this database, then check Admin -> Deployment -> Required forms.',
      );
      // Report whatever the true state is, even on failure — never leave the log
      // implying the forms are fine.
      try {
        const state = await requiredFormsState(this.prisma);
        this.logger.error(
          `Required forms — Job Sheet: ${pass(state.jobSheet)} · ` +
            `Pre-Job Inspection: ${pass(state.preJobInspection)} · ` +
            `Service Inspection: ${pass(state.serviceInspection)}`,
        );
      } catch {
        this.logger.error('Required forms — state unknown (database unreachable).');
      }
    }
  }
}

const pass = (ok: boolean): string => (ok ? 'PASS' : 'FAIL');
