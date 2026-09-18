import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CR-2026-108 — permanent invariants of the resource model.
 *
 * These began as the Stage 5C hold. Management has since lifted the hold and asked
 * for the engine to be finished, so two of the original rules are gone: the
 * resource model may now be activated (behind a preflight rather than never), and
 * CLEANING is now deliberately assignable so a wash bay can be configured before
 * CLEAN-01 is remapped.
 *
 * What remains are the properties that must hold for as long as the platform does,
 * and they are asserted here rather than documented because the risk was never
 * that somebody would defy them — it is that a change months from now breaks one
 * by accident with nobody reading this CR.
 *
 * A failure here is a prompt to go and ask, not to edit the assertion.
 */

const API_SRC = join(__dirname, '..', '..', '..');
const REPO = join(API_SRC, '..', '..', '..');

/** Every .ts file under a directory, excluding tests. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sources(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}
const ALL_SOURCES = sources(join(API_SRC, 'modules')).map((f) => ({ file: f, src: readFileSync(f, 'utf8') }));

// ---------------------------------------------------------------------------
describe('invariant 1 — no capacity number is ever hard-coded', () => {
  it('nothing in the application writes the concurrency rule', () => {
    const writers = ALL_SOURCES.filter(
      ({ src }) =>
        src.includes('booking_max_concurrent_appointments') &&
        /businessRuleConfig\.(update|updateMany|upsert|create)/.test(src),
    );
    expect(writers.map((w) => w.file)).toEqual([]);
  });

  it('the derived position count is not piped into booking capacity', () => {
    for (const name of [
      'public-booking/availability.engine.ts',
      'public-booking/public-booking.service.ts',
      'scheduling/availability/booking-availability.service.ts',
    ]) {
      const src = readFileSync(join(API_SRC, 'modules', name), 'utf8');
      expect(src).not.toContain('verifiedActivePositions');
      expect(src).not.toContain('derivedCapacity');
      expect(src).not.toContain('reconciliationSummary');
    }
  });

  it('no arrival-control key was invented while the number is unknown', () => {
    for (const { src } of ALL_SOURCES) {
      expect(src).not.toContain('booking_max_arrivals_per_slot');
    }
  });
});

// ---------------------------------------------------------------------------
/**
 * §14 — the hold on activation became a GUARD on activation. The resource model
 * may take over customer-facing decisions, but only after a preflight passes:
 * being wrong here turns into a vehicle nobody can service.
 */
describe('invariant 2 — RESOURCE_AWARE cannot be activated without a preflight', () => {
  const config = readFileSync(join(API_SRC, 'modules', 'config', 'config.service.ts'), 'utf8');

  it('the one path that writes the capacity mode checks readiness first', () => {
    const writers = ALL_SOURCES.filter(
      ({ src }) =>
        src.includes('booking_capacity_mode') && /businessRuleConfig\.(update|updateMany|upsert|create)/.test(src),
    );
    expect(writers.map((w) => w.file.slice(w.file.indexOf('modules')))).toEqual([join('modules', 'config', 'config.service.ts')]);
    expect(config).toContain('productionActivationBlockers');
    expect(config).toContain('RESOURCE_AWARE_PREFLIGHT_FAILED');
  });

  it('the guard refuses rather than warns, and names what is blocking', () => {
    const guard = config.slice(config.indexOf("ruleKey === 'booking_capacity_mode'"));
    const upToFind = guard.slice(0, guard.indexOf('// Find current active rule'));
    expect(upToFind).toContain('throw new BadRequestException');
    expect(upToFind).toContain('blockers');
  });

  it('nothing defaults the capacity mode to anything but FIXED', () => {
    const eta = readFileSync(join(API_SRC, 'modules', 'scheduling', 'eta', 'eta.config.ts'), 'utf8');
    expect(eta).toContain("capacityMode: 'FIXED'");
    expect(eta).not.toMatch(/capacityMode:\s*'RESOURCES',?\s*\n\s*capacityResourceCategories/);
  });

  it('the shadow engine is never consulted to answer a customer', () => {
    // SHADOW runs beside the production path, not in front of it. If the booking
    // service ever imported the resource engine, a configuration gap in a bay
    // could start deciding what a real customer is offered.
    for (const name of ['public-booking/public-booking.service.ts', 'public-booking/availability.engine.ts']) {
      const src = readFileSync(join(API_SRC, 'modules', name), 'utf8');
      expect(src).not.toContain('resource-capacity.engine');
      expect(src).not.toContain('ResourceAvailabilityService');
      expect(src).not.toContain('ShadowComparisonService');
    }
  });
});

// ---------------------------------------------------------------------------
describe('invariant 3 — the duration source is configuration, never code', () => {
  it('no code switches the duration source', () => {
    const writers = ALL_SOURCES.filter(
      ({ src }) =>
        src.includes('appointment_duration_source') &&
        /businessRuleConfig\.(update|updateMany|upsert|create)/.test(src),
    );
    expect(writers.map((w) => w.file)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('invariant 4 — the public catalogue is never changed by a capacity reading', () => {
  it('nothing in the application sets bookableOnline', () => {
    // The pilot is configured by an explicit, reviewed script run by a person —
    // never as a side effect of a request, and never from a capacity reading.
    const writers = ALL_SOURCES.filter(({ src }) => /serviceType\.update\w*\([\s\S]{0,400}?bookableOnline/.test(src));
    expect(writers.map((w) => w.file)).toEqual([]);
  });

  it('the specialty risk is reported, not acted on', () => {
    const summary = readFileSync(join(__dirname, '..', 'reconciliation-summary.service.ts'), 'utf8');
    expect(summary).toContain('singlePositionBookableServices');
    expect(summary).not.toContain('bookableOnline: false');
  });
});

// ---------------------------------------------------------------------------
/**
 * §15 — CLEANING is now assignable, because a wash bay has to be configurable
 * BEFORE CLEAN-01 can be remapped to require it. What must NOT happen is the
 * remap: changing what a public service requires is a catalogue decision.
 */
describe('invariant 8 — CLEANING is assignable, the CLEAN-01 remap is not automatic', () => {
  const summary = readFileSync(join(__dirname, '..', 'reconciliation-summary.service.ts'), 'utf8');

  it('nothing in the application remaps a service to a different required capability', () => {
    for (const { file, src } of ALL_SOURCES) {
      expect(src, file).not.toMatch(/requiredBayType:\s*'CLEANING'/);
      expect(src, file).not.toMatch(/serviceType\.update\w*\([\s\S]{0,300}?requiredBayType/);
    }
  });

  it('extending the vocabulary is configuration, not a code edit', () => {
    const admin = readFileSync(join(API_SRC, 'modules', 'resources', 'resource-admin.service.ts'), 'utf8');
    expect(admin).toContain("RESOURCE_EXTRA_CAPABILITIES_KEY = 'resource_additional_capabilities'");
    const body = admin.slice(admin.indexOf('async capabilityVocabulary'));
    const method = body.slice(0, body.search(/\n {2}(async |private |public |\/\*\*)/));
    // Read from a rule row, not hard-coded into the method.
    expect(method).toContain('RESOURCE_EXTRA_CAPABILITIES_KEY');
    expect(method).toContain('requiredBayType');
  });

  it('assigning CLEANING changes no availability while no service requires it', () => {
    // The solver matches a job's required capability against a resource's list.
    // A capability nothing asks for can never appear on the left-hand side.
    const engine = readFileSync(join(API_SRC, 'modules', 'scheduling', 'availability', 'resource-capacity.engine.ts'), 'utf8');
    expect(engine).toContain('job.requiredCapability && !r.capabilities.includes(job.requiredCapability)');
    expect(engine).not.toContain('CLEANING');
  });

  it('the physical-confirmation question stays open for management', () => {
    expect(summary).toContain('AWAITING_PHYSICAL_CONFIRMATION');
    expect(summary).toContain('NOT implemented');
    expect(summary).toContain('after physical confirmation');
  });
});

// ---------------------------------------------------------------------------
describe('invariant 5 — a resource is never auto-classified', () => {
  /**
   * The guarantee is structural rather than textual: exactly ONE file in the
   * application writes a WorkResource at all, and it is the audited, permission-
   * guarded admin service. A heuristic elsewhere would have to appear here first.
   */
  const writers = ALL_SOURCES.filter(({ src }) =>
    /workResource\.(update|updateMany|upsert|create|createMany)/.test(src),
  );

  it('only the audited admin write path writes a resource at all', () => {
    expect(writers.map((w) => w.file.slice(w.file.indexOf('modules')))).toEqual([
      join('modules', 'resources', 'resource-admin.service.ts'),
    ]);
  });

  it('the create default is UNVERIFIED and the update is caller-supplied', () => {
    const src = readFileSync(join(API_SRC, 'modules', 'resources', 'resource-admin.service.ts'), 'utf8');
    expect(src).toContain("capacityRole: (data.capacityRole as never) ?? 'UNVERIFIED'");
    expect(src).toContain('...(data.capacityRole !== undefined ? { capacityRole: data.capacityRole as never } : {})');
    // A heuristic assigning a role would look like this. It must not exist.
    expect(src).not.toMatch(/capacityRole:\s*'PRIMARY_SERVICE_POSITION'/);
    expect(src).not.toMatch(/capacityRole:\s*proposedRole/);
  });

  it('the truth audit proposes a role but never writes one', () => {
    const src = readFileSync(join(API_SRC, 'modules', 'resources', 'resource-truth-audit.service.ts'), 'utf8');
    expect(src).toContain('proposedRole');
    expect(src).not.toMatch(/workResource\.(update|updateMany|upsert|create)/);
  });
});

// ---------------------------------------------------------------------------
describe('invariant 6 — the legacy bridge is never inferred', () => {
  it('the bridge is written in exactly one place, from an id the caller chose', () => {
    const writes = ALL_SOURCES.flatMap(({ file, src }) =>
      [...src.matchAll(/data:\s*\{[^}]*legacyBayId[^}]*\}/g)].map((m) => ({ file, text: m[0] })),
    );
    expect(writes.map((w) => w.file.slice(w.file.indexOf('modules')))).toEqual([
      join('modules', 'resources', 'resource-admin.service.ts'),
    ]);
    // The value is the parameter, never a lookup result. `legacyBayId: bay.id`
    // would be the beginning of inference.
    expect(writes[0].text).toBe('data: { legacyBayId }');
  });

  /**
   * The escape hatch that stops the gate pushing towards a false link. It writes
   * a disposition and a note — never a link, never an assignment.
   */
  it('the disposition path records a finding and cannot create a link', () => {
    const src = readFileSync(join(API_SRC, 'modules', 'resources', 'resource-admin.service.ts'), 'utf8');
    const body = src.slice(src.indexOf('async setLegacyBayDisposition'));
    const method = body.slice(0, body.search(/\n {2}(async |private |public |\/\*\*)/));
    expect(method).not.toContain('legacyBayId');
    expect(method).not.toMatch(/technicianAssignment\.(update|delete|create)/);
    // A linked bay is already resolved; carrying both would be two answers.
    expect(method).toContain('already matched to resource');
  });

  it('no seed or migration pairs them up by code or name', () => {
    const migrations = join(REPO, 'prisma', 'migrations');
    for (const dir of readdirSync(migrations)) {
      const sql = join(migrations, dir, 'migration.sql');
      try {
        const src = readFileSync(sql, 'utf8');
        // A back-fill would have to UPDATE the column. Nothing may.
        expect(src, `${dir} back-fills the bridge`).not.toMatch(/UPDATE[\s\S]{0,200}legacy_bay_id/i);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  });
});

// ---------------------------------------------------------------------------
/**
 * §17 — a reservation holds "one compatible ALIGNMENT position", not ALIGN-01.
 * Forcing a concrete bay at booking time would hand a dispatch decision to a
 * customer picking a time three weeks out, and then break the moment that bay
 * went into maintenance.
 */
describe('invariant 7 — reservations are abstract, not a bay assignment', () => {
  const schema = readFileSync(join(REPO, 'prisma', 'schema.prisma'), 'utf8');
  const model = (() => {
    const m = schema.slice(schema.indexOf('model ResourceReservation'));
    return m.slice(0, m.indexOf('\n}'));
  })();

  it('the resource is still optional, and the capability says what it must be compatible with', () => {
    expect(model).toMatch(/resourceId\s+String\?/);
    expect(model).toContain('requiredCapability String?');
  });

  it('nothing in the resource module writes a reservation', () => {
    for (const { file, src } of ALL_SOURCES) {
      if (!file.includes(join('modules', 'resources'))) continue;
      expect(src, file).not.toMatch(/resourceReservation\.(create|createMany|upsert)/);
    }
  });

  it('no reservation is created with a concrete resource id by the booking path', () => {
    for (const { file, src } of ALL_SOURCES) {
      const matches = [...src.matchAll(/resourceReservation\.create\w*\(([\s\S]{0,400}?)\}\s*\)/g)];
      for (const m of matches) {
        expect(m[1], `${file} pins a specific bay at booking time`).not.toMatch(/resourceId:\s*(?!null)/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('the corrected impact logic is retained', () => {
  const src = readFileSync(join(API_SRC, 'modules', 'resources', 'resource-admin.service.ts'), 'utf8');

  it('impact still assesses loss of pool capacity, not only direct references', () => {
    expect(src).toContain('capabilityImpact');
    expect(src).toContain('positionsBefore');
    expect(src).toContain('positionsAfter');
    expect(src).toContain('LAST_POSITION');
  });

  it('it still counts booked work through the catalogue, not through assignments', () => {
    expect(src).toContain('required_bay_type');
    expect(src).toContain('appointment_services');
  });

  it('it still refuses to predict a delay it cannot model', () => {
    expect(src).toContain('does not model');
    expect(src).toContain('PHYSICAL CAPACITY REQUIRES CONFIRMATION');
  });
});
