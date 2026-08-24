import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * CR-2026-094 — can the deployed site be verified against the pushed commit?
 *
 * The parity problem this answers: the owner pushes a commit, the boss deploys it,
 * and until now nothing on the running site said WHICH commit it was running or
 * whether the database behind it was migrated and populated. "Did the deploy take?"
 * was answered by clicking around.
 *
 * Two tiers, split by audience:
 *
 *   /health              public-safe: up/down, build identity, environment name,
 *                        database reachability. Nothing here helps an attacker and
 *                        everything here helps a deploy check.
 *   /health/deployment   admin-only: row counts, seed presence, configuration
 *                        PRESENCE (never values). This is the page that answers
 *                        "did the deployed version receive the customer database?"
 *                        without terminal access.
 *
 * Build identity comes from the platform, never hand-maintained: Render injects
 * RENDER_GIT_COMMIT; BUILD_COMMIT is the generic override for other hosts. A
 * hard-coded version string is a lie waiting to happen.
 */

const SHORT_SHA = 7;

export interface PublicHealth {
  status: 'ok' | 'degraded';
  build: {
    commit: string | null;
    commitShort: string | null;
    deployedAt: string | null;
  };
  environment: string;
  database: 'connected' | 'unreachable';
  /** Last applied migration NAME — schema position, not schema contents. */
  lastMigration: string | null;
  uptimeSeconds: number;
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  private buildCommit(): string | null {
    return process.env.RENDER_GIT_COMMIT ?? process.env.BUILD_COMMIT ?? null;
  }

  async publicHealth(): Promise<PublicHealth> {
    const commit = this.buildCommit();

    let database: PublicHealth['database'] = 'connected';
    let lastMigration: string | null = null;
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ migration_name: string }[]>(
        `SELECT migration_name FROM _prisma_migrations
         WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
      );
      lastMigration = rows[0]?.migration_name ?? null;
    } catch {
      database = 'unreachable';
    }

    return {
      status: database === 'connected' ? 'ok' : 'degraded',
      build: {
        commit,
        commitShort: commit ? commit.slice(0, SHORT_SHA) : null,
        deployedAt: process.env.RENDER_DEPLOY_TIMESTAMP ?? process.env.BUILD_TIMESTAMP ?? null,
      },
      environment: process.env.NODE_ENV ?? 'development',
      database,
      lastMigration,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  /**
   * The administrator's deployment picture.
   *
   * Everything is a count or a presence flag. No connection strings, no secrets, no
   * sample rows — an empty customers table is reported as the NUMBER zero, which is
   * exactly the fact an administrator needs and nothing more.
   */
  async deploymentStatus() {
    const health = await this.publicHealth();

    const count = async (fn: () => Promise<number>) => {
      try {
        return await fn();
      } catch {
        return null;
      }
    };

    const [
      customers, vehicles, serviceVisits, serviceTypes, sites, users,
      activeKpiPolicies, kpiMappings, activeInspectionTemplates, importedRefs,
    ] = await Promise.all([
      count(() => this.prisma.customer.count()),
      count(() => this.prisma.vehicle.count()),
      count(() => this.prisma.serviceVisit.count()),
      count(() => this.prisma.serviceType.count({ where: { isActive: true } })),
      count(() => this.prisma.site.count()),
      count(() => this.prisma.userAccount.count({ where: { status: 'ACTIVE' } })),
      count(() => this.prisma.kpiPolicy.count({ where: { isActive: true } })),
      count(() => this.prisma.kpiServiceComponent.count({ where: { isActive: true } })),
      count(() => this.prisma.inspectionTemplate.count({ where: { isActive: true } })),
      count(() => this.prisma.externalSystemRef.count()),
    ]);

    // Reference data is what the seed must have produced; operational data is what
    // only the controlled import (or real use) produces. The distinction is the whole
    // point: a deploy with reference data and zero customers is CORRECTLY deployed
    // and awaiting its import — not broken.
    const referenceDataSeeded =
      (serviceTypes ?? 0) > 0 && (activeKpiPolicies ?? 0) > 0 && (activeInspectionTemplates ?? 0) > 0;
    const operationalDataPresent = (customers ?? 0) > 0;

    return {
      ...health,
      reference: {
        seeded: referenceDataSeeded,
        sites,
        serviceTypes,
        activeKpiPolicies,
        kpiServiceMappings: kpiMappings,
        activeInspectionTemplates,
        activeUsers: users,
      },
      operational: {
        present: operationalDataPresent,
        customers,
        vehicles,
        serviceVisits,
        externalImportRefs: importedRefs,
        note: operationalDataPresent
          ? null
          : 'Customer database is empty. If this is a fresh deployment, run the approved customer import (see docs/DEPLOYMENT_HANDOFF.md).',
      },
      configuration: {
        // Presence only. The values never leave the server.
        environment: process.env.NODE_ENV ?? 'development',
        devLoginEnabled:
          process.env.ALLOW_DEV_LOGIN === 'true' && process.env.NODE_ENV !== 'production',
        notificationProvider: process.env.NOTIFICATION_PROVIDER ?? 'stub',
        vinDecodeProvider: process.env.VIN_DECODE_PROVIDER === 'LIVE' ? 'LIVE' : 'STUB',
        inspectionPhotoDriver: process.env.INSPECTION_PHOTO_DRIVER ?? 'local',
        corsConfigured: !!process.env.API_CORS_ORIGIN,
        jwtSecretConfigured: !!process.env.JWT_SECRET,
      },
    };
  }
}
