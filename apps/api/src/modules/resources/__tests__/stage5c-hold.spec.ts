import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CR-2026-108 — the Stage 5C hold.
 *
 * Management accepted Stage 5B and stopped the work: the next activity is a
 * physical walk of the Service Centre, not more code. Seven things must not
 * happen while that hold is in force, and the risk is not that someone defies
 * them — it is that a later change makes one true by accident, months from now,
 * with nobody reading this CR.
 *
 * So the hold is expressed as tests. Each one names the rule it protects, and a
 * failure here is a prompt to go and ask, not to edit the assertion.
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
describe('hold 1 — no new production capacity number is inferred', () => {
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
describe('hold 2 — RESOURCE_AWARE is not activated', () => {
  it('no code switches the capacity mode', () => {
    const writers = ALL_SOURCES.filter(
      ({ src }) =>
        src.includes('booking_capacity_mode') && /businessRuleConfig\.(update|updateMany|upsert|create)/.test(src),
    );
    expect(writers.map((w) => w.file)).toEqual([]);
  });

  it('nothing defaults the capacity mode to anything but FIXED', () => {
    const config = readFileSync(join(API_SRC, 'modules', 'public-booking', 'booking.config.ts'), 'utf8');
    expect(config).not.toMatch(/capacityMode:\s*'RESOURCE_AWARE'/);
    expect(config).not.toMatch(/capacityMode:\s*'SHADOW'/);
  });
});

// ---------------------------------------------------------------------------
describe('hold 3 — durations stay on DEFAULT', () => {
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
describe('hold 4 — the pilot services are not withdrawn from the stale inventory', () => {
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
describe('hold 8 — the CLEANING capability is proposed, never applied', () => {
  const summary = readFileSync(join(__dirname, '..', 'reconciliation-summary.service.ts'), 'utf8');

  it('nothing remaps CLEAN-01 or writes a required capability', () => {
    for (const { src } of ALL_SOURCES) {
      expect(src).not.toMatch(/requiredBayType:\s*'CLEANING'/);
      expect(src).not.toMatch(/serviceType\.update\w*\([\s\S]{0,300}?requiredBayType/);
    }
  });

  it('CLEANING is not seeded into the capability vocabulary ahead of approval', () => {
    // The vocabulary is derived from what the catalogue asks for, so an unapproved
    // capability cannot appear in the UI as an assignable option.
    const admin = readFileSync(join(API_SRC, 'modules', 'resources', 'resource-admin.service.ts'), 'utf8');
    const body = admin.slice(admin.indexOf('async capabilityVocabulary'));
    const method = body.slice(0, body.search(/\n {2}(async |private |public |\/\*\*)/));
    expect(method).not.toContain('CLEANING');
    expect(method).toContain('requiredBayType');
  });

  it('the finding stays open for management rather than being auto-resolved', () => {
    expect(summary).toContain('AWAITING_PHYSICAL_CONFIRMATION');
    expect(summary).toContain('NOT implemented');
    expect(summary).toContain('after physical confirmation');
  });
});

// ---------------------------------------------------------------------------
describe('hold 5 — UNVERIFIED resources are never auto-classified', () => {
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
describe('hold 6 — WorkResource and WorkBay are never linked automatically', () => {
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
describe('hold 7 — no ResourceReservation rows are created yet', () => {
  it('nothing in the resource module writes a reservation', () => {
    for (const { file, src } of ALL_SOURCES) {
      if (!file.includes(join('modules', 'resources'))) continue;
      expect(src, file).not.toMatch(/resourceReservation\.(create|createMany|upsert)/);
    }
  });

  it('the capability question is recorded as open rather than answered in schema', () => {
    const schema = readFileSync(join(REPO, 'prisma', 'schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model ResourceReservation'));
    const body = model.slice(0, model.indexOf('\n}'));
    // Adding this column IS the Stage 5C decision. It must not appear early.
    expect(body).not.toContain('requiredCapability');
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
