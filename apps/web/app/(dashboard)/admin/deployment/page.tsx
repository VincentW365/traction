'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmailVerificationCard } from '../../../../components/email-verification-card';

/**
 * CR-2026-094 — Admin → Deployment.
 *
 * Exists so "did the deployed site receive the customer database?" and "is this the
 * commit I pushed?" are answered by a page, not by someone with terminal access.
 * Everything shown is a count, a name or a presence flag — the API endpoint behind it
 * never returns values or secrets, so this page cannot leak what it never receives.
 */

interface DeploymentStatus {
  status: 'ok' | 'degraded';
  build: { commit: string | null; commitShort: string | null; deployedAt: string | null };
  environment: string;
  database: 'connected' | 'unreachable';
  lastMigration: string | null;
  uptimeSeconds: number;
  reference: {
    seeded: boolean;
    sites: number | null;
    serviceTypes: number | null;
    activeKpiPolicies: number | null;
    kpiServiceMappings: number | null;
    activeInspectionTemplates: number | null;
    activeUsers: number | null;
    // CR-2026-106 — Required Form Configuration, per form.
    forms?: { jobSheet: boolean; preJobInspection: boolean; serviceInspection: boolean };
  };
  operational: {
    present: boolean;
    customers: number | null;
    vehicles: number | null;
    serviceVisits: number | null;
    externalImportRefs: number | null;
    note: string | null;
  };
  configuration: {
    environment: string;
    devLoginEnabled: boolean;
    notificationProvider: string;
    emailProvider?: string;
    notificationMode?: string;
    vinDecodeProvider: string;
    inspectionPhotoDriver: string;
    corsConfigured: boolean;
    jwtSecretConfigured: boolean;
    /** CR-2026-106 — is the base every customer link is built from publicly reachable? */
    publicAppUrl?: { ok: boolean; reason: string; value: string | null };
  };
}

const num = (n: number | null) => (n == null ? '—' : n.toLocaleString());

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const colour =
    tone === 'ok' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-slate-900';
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-xs font-medium tabular-nums ${colour}`}>{value}</span>
    </div>
  );
}

export default function DeploymentStatusPage() {
  const { user } = useAuth();

  const q = useQuery<DeploymentStatus>({
    queryKey: ['deployment-status'],
    queryFn: () => api.get('/health/deployment'),
    enabled: user?.roleCode === 'ADMIN',
    refetchInterval: 30_000,
  });

  if (user && user.roleCode !== 'ADMIN') {
    return (
      <div className="p-6">
        <p className="text-sm text-slate-600">Deployment status is available to managers.</p>
      </div>
    );
  }

  const d = q.data;

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Deployment"
        subtitle="What this environment is running and what its database contains"
      />

      {q.isLoading && <LoadingState message="Reading deployment status..." />}
      {q.isError && (
        <div className="card p-6 border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Could not read deployment status from the API.</p>
        </div>
      )}

      {d && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card p-4">
            <h2 className="text-sm font-semibold text-slate-900 mb-2">Build</h2>
            <Row
              label="Commit"
              value={d.build.commitShort ?? 'not stamped (local dev)'}
              tone={d.build.commitShort ? 'ok' : undefined}
            />
            <Row label="Environment" value={d.environment} />
            <Row label="Deployed at" value={d.build.deployedAt ?? '—'} />
            <Row label="Uptime" value={`${Math.floor(d.uptimeSeconds / 60)} min`} />
            <Row
              label="Database"
              value={d.database}
              tone={d.database === 'connected' ? 'ok' : 'bad'}
            />
            <Row label="Latest migration" value={d.lastMigration ?? 'none recorded'} />
          </div>

          <div className="card p-4">
            <h2 className="text-sm font-semibold text-slate-900 mb-2">Reference data (from seed)</h2>
            <Row label="Seeded" value={d.reference.seeded ? 'yes' : 'NO — run the bootstrap'} tone={d.reference.seeded ? 'ok' : 'bad'} />
            <Row label="Sites" value={num(d.reference.sites)} />
            <Row label="Service types" value={num(d.reference.serviceTypes)} />
            <Row label="Active KPI policies" value={num(d.reference.activeKpiPolicies)} />
            <Row label="KPI service mappings" value={num(d.reference.kpiServiceMappings)} />
            <Row label="Inspection templates" value={num(d.reference.activeInspectionTemplates)} />
            <Row label="Active user accounts" value={num(d.reference.activeUsers)} />
            {d.reference.forms && (
              <>
                <p className="mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Required form configuration</p>
                <Row label="Job Sheet" value={d.reference.forms.jobSheet ? 'PASS' : 'FAIL'} tone={d.reference.forms.jobSheet ? 'ok' : 'bad'} />
                <Row label="Pre-Job Inspection" value={d.reference.forms.preJobInspection ? 'PASS' : 'FAIL — run pnpm db:seed'} tone={d.reference.forms.preJobInspection ? 'ok' : 'bad'} />
                <Row label="Service Inspection" value={d.reference.forms.serviceInspection ? 'PASS' : 'FAIL — run pnpm db:seed'} tone={d.reference.forms.serviceInspection ? 'ok' : 'bad'} />
              </>
            )}
          </div>

          <div className="card p-4">
            <h2 className="text-sm font-semibold text-slate-900 mb-2">Operational data (from import / live use)</h2>
            <Row
              label="Customer database"
              value={d.operational.present ? 'present' : 'EMPTY'}
              tone={d.operational.present ? 'ok' : 'warn'}
            />
            <Row label="Customers" value={num(d.operational.customers)} />
            <Row label="Vehicles" value={num(d.operational.vehicles)} />
            <Row label="Service visits" value={num(d.operational.serviceVisits)} />
            <Row label="Import references" value={num(d.operational.externalImportRefs)} />
            {d.operational.note && (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 leading-relaxed">
                {d.operational.note}
              </p>
            )}
          </div>

          <div className="card p-4">
            <h2 className="text-sm font-semibold text-slate-900 mb-2">Configuration presence</h2>
            <Row label="JWT secret" value={d.configuration.jwtSecretConfigured ? 'configured' : 'MISSING'} tone={d.configuration.jwtSecretConfigured ? 'ok' : 'bad'} />
            <Row label="CORS origin" value={d.configuration.corsConfigured ? 'configured' : 'not set'} tone={d.configuration.corsConfigured ? 'ok' : 'warn'} />
            <Row
              label="Public app URL (customer links)"
              value={d.configuration.publicAppUrl ? (d.configuration.publicAppUrl.ok ? d.configuration.publicAppUrl.value ?? 'configured' : `FAIL — ${d.configuration.publicAppUrl.reason}`) : 'unknown (older API)'}
              tone={d.configuration.publicAppUrl ? (d.configuration.publicAppUrl.ok ? 'ok' : 'bad') : 'warn'}
            />
            <Row
              label="Dev login"
              value={d.configuration.devLoginEnabled ? 'ENABLED (non-production only)' : 'off'}
              tone={d.configuration.devLoginEnabled ? 'warn' : 'ok'}
            />
            <Row label="SMS provider" value={d.configuration.notificationProvider} />
            <Row label="Email provider" value={d.configuration.emailProvider ?? 'stub'} tone={(d.configuration.emailProvider ?? 'stub') === 'stub' ? 'warn' : 'ok'} />
            <Row
              label="Notification mode"
              value={(d.configuration.notificationMode ?? 'TEST') === 'LIVE' ? 'LIVE — real customers' : 'TEST — redirected to the test recipient'}
              tone={(d.configuration.notificationMode ?? 'TEST') === 'LIVE' ? 'ok' : 'warn'}
            />
            <Row label="VIN decode" value={d.configuration.vinDecodeProvider} />
            <Row label="Inspection photo storage" value={d.configuration.inspectionPhotoDriver} />
          </div>

          <EmailVerificationCard />
        </div>
      )}
    </div>
  );
}
