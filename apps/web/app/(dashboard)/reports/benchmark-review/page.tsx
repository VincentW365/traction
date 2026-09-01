'use client';

import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { VEHICLE_CLASS_LABEL } from '../../../../components/kpi-strip';

/**
 * CR-2026-091 — jobs waiting for benchmark configuration.
 *
 * Leaving a service unmapped is acceptable temporarily. What makes it temporary is
 * this screen: without somewhere the held jobs are listed, "we will map it later"
 * quietly means those jobs are never rated at all.
 *
 * Every job here carries NO rating — not the adjusted one, and not the absolute band
 * either. The technician did the work; nobody had yet said what to measure it against,
 * and an administrative gap must never read as somebody's poor result. They are also
 * outside every technician denominator, so they neither help nor harm anyone while
 * they sit here.
 */

const ALLOWED_ROLES = ['ADMIN'];

interface BlockingService {
  code: string;
  name: string;
  problem: string;
}

interface PendingJob {
  serviceOrderId: string;
  ticketNumber: string | null;
  plate: string | null;
  vehicleClass: string | null;
  firstSubmittedToQcAt: string | null;
  rawElapsedMinutes: number | null;
  eligibilityReason: string | null;
  blockingServices: BlockingService[];
}

export default function BenchmarkReviewPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const queue = useQuery<PendingJob[]>({
    queryKey: ['benchmark-review'],
    queryFn: () => api.get('/kpi/reports/benchmark-review'),
    enabled: ALLOWED_ROLES.includes(user?.roleCode ?? ''),
  });

  const resolve = useMutation({
    mutationFn: (serviceOrderId: string) =>
      api.post(`/kpi/orders/${serviceOrderId}/resolve-benchmark-review`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['benchmark-review'] });
      queryClient.invalidateQueries({ queryKey: ['kpi-dashboard'] });
    },
  });

  if (!ALLOWED_ROLES.includes(user?.roleCode ?? '')) {
    return (
      <div className="p-6">
        <p className="text-sm text-slate-600">
          Benchmark review is available to managers.
        </p>
      </div>
    );
  }

  const jobs = queue.data ?? [];

  // Which services are holding up the most jobs — the shortest route to clearing the
  // queue is usually one mapping, not one job at a time.
  const byService = new Map<string, { name: string; problem: string; jobs: number }>();
  for (const j of jobs) {
    for (const s of j.blockingServices) {
      const e = byService.get(s.code) ?? { name: s.name, problem: s.problem, jobs: 0 };
      e.jobs++;
      byService.set(s.code, e);
    }
  }
  const topBlockers = [...byService.entries()].sort((a, b) => b[1].jobs - a[1].jobs);

  return (
    <div className="p-6">
      <PageHeader
        title="Benchmark review"
        subtitle="Finished jobs that cannot be rated until their benchmark configuration exists"
      />

      <div className="card mb-4 border-amber-200 bg-amber-50">
        <div className="card-body">
          <p className="text-xs text-amber-900 max-w-3xl">
            These jobs carry <strong>no rating at all</strong> — not the scope-adjusted rating,
            and not the absolute completion band. A service on each is not mapped to a benchmark
            component, or a brake line has no axle recorded. The work was done; nobody has said
            what it should be measured against yet.
          </p>
          <p className="text-xs text-amber-900 mt-2 max-w-3xl">
            They are excluded from every technician&apos;s figures while they sit here, so they
            neither help nor harm anyone. Map the service, then rate the job — it gets its first
            rating, and nothing that already had a result is changed.
          </p>
        </div>
      </div>

      {queue.isLoading ? (
        <LoadingState />
      ) : queue.isError ? (
        // CR-2026-100 — a failed request must never read as a clean queue.
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">
            Failed to load the review queue.
            {queue.error instanceof Error ? ` ${queue.error.message}` : ''}
          </p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="card">
          <div className="card-body text-sm text-slate-600">
            Nothing is waiting. Every completed job either has a rating or has a settled reason
            for not having one.
          </div>
        </div>
      ) : (
        <>
          {topBlockers.length > 0 && (
            <div className="card mb-4">
              <div className="card-header">
                <h2 className="text-sm font-semibold text-slate-900">What is holding them up</h2>
              </div>
              <div className="card-body space-y-2">
                {topBlockers.map(([code, s]) => (
                  <div key={code} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-slate-700">
                      <span className="font-mono text-slate-500">{code}</span> {s.name}
                      <span className="ml-2 badge bg-amber-100 text-amber-800 text-[10px]">
                        {s.problem}
                      </span>
                    </span>
                    <span className="text-slate-500 tabular-nums">
                      {s.jobs} job{s.jobs === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
                <div className="pt-2">
                  <Link href="/admin/kpi-mapping" className="btn-secondary text-xs py-1 px-3">
                    Open KPI mapping
                  </Link>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-header flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                {jobs.length} job{jobs.length === 1 ? '' : 's'} awaiting setup
              </h2>
            </div>
            <div className="table-container">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-left">Ticket</th>
                    <th className="text-left">Vehicle</th>
                    <th className="text-left">Class</th>
                    <th className="text-right">Job time</th>
                    <th className="text-left">Waiting on</th>
                    <th className="text-right">Finished</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.serviceOrderId}>
                      <td className="font-mono">{j.ticketNumber ?? '--'}</td>
                      <td>{j.plate ?? '--'}</td>
                      <td>
                        {j.vehicleClass
                          ? (VEHICLE_CLASS_LABEL[j.vehicleClass] ?? j.vehicleClass)
                          : '--'}
                      </td>
                      {/* Labelled as job time, never as a result — there is no standard
                          to compare it against, which is the whole reason it is here. */}
                      <td className="text-right tabular-nums text-slate-500">
                        {j.rawElapsedMinutes != null ? `${j.rawElapsedMinutes} min` : '--'}
                      </td>
                      <td>
                        {j.blockingServices.length === 0 ? (
                          <span className="text-slate-400">--</span>
                        ) : (
                          <div className="space-y-0.5">
                            {j.blockingServices.map((s) => (
                              <div key={s.code}>
                                <span className="font-mono text-slate-500">{s.code}</span>{' '}
                                <span className="text-slate-400">{s.problem}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="text-right text-slate-500">
                        {j.firstSubmittedToQcAt
                          ? new Date(j.firstSubmittedToQcAt).toLocaleDateString()
                          : '--'}
                      </td>
                      <td className="text-right">
                        <button
                          onClick={() => resolve.mutate(j.serviceOrderId)}
                          disabled={resolve.isPending}
                          className="btn-primary text-[11px] py-1 px-2"
                          title="Rate this job now the configuration exists"
                        >
                          Rate now
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {resolve.isError && (
              <div className="card-body pt-0">
                <p className="text-xs text-red-600">
                  {resolve.error instanceof Error
                    ? resolve.error.message
                    : 'Could not rate this job'}
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
