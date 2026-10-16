'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';
import { useSiteId } from '../../../../../hooks/use-site';
import { PageHeader } from '../../../../../components/ui/page-header';
import { LoadingState } from '../../../../../components/ui/loading-state';

/**
 * CR-2026-108 Stage 5B — Confirm Work Positions.
 *
 * The Service Centre has physically expanded, and the platform holds two
 * inventories that disagree: 17 `WorkResource` rows nothing has ever been
 * assigned to, and 6 `WorkBay` rows that carry every assignment ever made. Neither
 * is a statement of what is standing in the building today.
 *
 * This screen is how a person resolves that, by walking the shop rather than by
 * reading the database. It shows both inventories, which rows are already paired,
 * and — the column that matters — which are not. It merges nothing, infers
 * nothing from codes, and deletes nothing.
 *
 * Every resource starts UNVERIFIED and contributes ZERO. That is not a guess
 * about the bay; it is the absence of one. Capacity only appears here after
 * someone says what a thing is.
 */

type LinkState = 'LINKED' | 'UNLINKED';

interface ResourceRow {
  id: string;
  code: string;
  name: string;
  category: string;
  capacity: number;
  capacityRole: string;
  /** §1 — confirmed in the building, or mapped from a name and a code series? */
  identityConfirmed: boolean;
  capabilities: string[];
  operationalStatus: string;
  isActive: boolean;
  retired: boolean;
  schedulingEnabled: boolean;
  link: { state: LinkState; bayId: string | null; bayCode: string | null; bayType: string | null };
  needsAttention: boolean;
  /** CR-2026-119 §10 — where it is in the building, in the floor's words. Null until someone says. */
  physicalPosition?: string | null;
}

interface LegacyBayRow {
  id: string;
  code: string;
  bayType: string;
  status: string;
  historicalAssignments: number;
  link: { state: LinkState; resourceId: string | null; resourceCode: string | null };
  disposition: string;
  dispositionNote: string | null;
  dispositionedAt: string | null;
  /** Linked, or explicitly accounted for. Either one finishes the job. */
  resolved: boolean;
  needsAttention: boolean;
}

interface Reconciliation {
  capabilityVocabulary: string[];
  capacityRoles: string[];
  dispositions: string[];
  resources: ResourceRow[];
  legacyBays: LegacyBayRow[];
  summary: {
    resourceRows: number;
    legacyBayRows: number;
    linkedPairs: number;
    unlinkedResources: number;
    dispositionedBays: number;
    unresolvedBays: number;
    unresolvedBaysWithHistory: number;
    unverifiedResources: number;
  };
}

interface TruthAudit {
  derived: {
    verifiedActivePositions: number;
    unverifiedResources: number;
    configurationIncomplete: boolean;
    incompleteWarning: string | null;
    capabilityPools: Array<{
      capability: string;
      eligiblePositions: number;
      servicesRequiring: number;
      pilotServicesRequiring: number;
      confidence: 'MEASURED' | 'LOWER_BOUND';
      doubleBookingRisk: boolean;
    }>;
  };
}

/**
 * The role vocabulary in operational words. UNVERIFIED and "support equipment"
 * both contribute nothing, and the difference between them is the whole point of
 * this screen: one is a decision, the other is the absence of one.
 */
const ROLE_LABEL: Record<string, string> = {
  UNVERIFIED: 'Not yet confirmed',
  PRIMARY_SERVICE_POSITION: 'Work position',
  OVERFLOW_SERVICE_POSITION: 'Overflow position',
  SUPPORT_EQUIPMENT: 'Equipment (not a position)',
  PLACEHOLDER: 'Planned / not built yet',
};

const ROLE_HELP: Record<string, string> = {
  UNVERIFIED: 'Nobody has said what this is. It counts for nothing until someone does.',
  PRIMARY_SERVICE_POSITION: 'A vehicle can be worked on here, on its own. Counts as one position.',
  OVERFLOW_SERVICE_POSITION: 'A genuine extra vehicle position, used in defined circumstances. Counts.',
  SUPPORT_EQUIPMENT: 'A jack, a stand, a tool used AT a position. Counts for nothing — on purpose.',
  PLACEHOLDER: 'Written down but not standing in the building yet. Counts for nothing.',
};

const ROLE_BADGE: Record<string, string> = {
  UNVERIFIED: 'bg-amber-50 text-amber-700 border-amber-200',
  PRIMARY_SERVICE_POSITION: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  OVERFLOW_SERVICE_POSITION: 'bg-teal-50 text-teal-700 border-teal-200',
  SUPPORT_EQUIPMENT: 'bg-slate-100 text-slate-600 border-slate-200',
  PLACEHOLDER: 'bg-slate-100 text-slate-500 border-slate-200',
};

/**
 * How an old bay record was accounted for when no current resource corresponds
 * to it. Written in shop words: a manager walking the floor says "that one's
 * gone", not "HISTORICAL_ONLY".
 */
const DISPOSITION_LABEL: Record<string, string> = {
  UNRESOLVED: 'Not decided yet',
  HISTORICAL_ONLY: 'Gone — keep its history',
  REPLACED: 'Replaced by the new layout',
  RETIRED: 'Taken out of service',
};

const DISPOSITION_HELP: Record<string, string> = {
  UNRESOLVED: 'Nobody has said what happened to this bay.',
  HISTORICAL_ONLY: 'The bay no longer exists. Its past jobs are real and stay exactly where they are.',
  REPLACED: 'The floor was reorganised, so no single bay today is the same place this one was.',
  RETIRED: 'Formally out of service, kept for its record.',
};

const CAPABILITY_LABEL: Record<string, string> = {
  ALIGNMENT: 'Wheel alignment',
  DIAGNOSTIC: 'Diagnostics',
  GENERAL: 'General repair',
  INSPECTION: 'Inspection',
  LUBE: 'Oil & lube',
  TIRE: 'Tires',
};

const capLabel = (c: string) => CAPABILITY_LABEL[c] ?? c;

function errText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export default function ResourceReconciliationPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const recon = useQuery<Reconciliation>({
    queryKey: ['resource-reconciliation', siteId],
    queryFn: () => api.get(`/resources/reconciliation?siteId=${siteId}`),
    enabled: !!siteId,
  });
  const audit = useQuery<TruthAudit>({
    queryKey: ['resource-truth-audit'],
    queryFn: () => api.get('/resources/truth-audit'),
  });

  const refresh = () => {
    setError(null);
    queryClient.invalidateQueries({ queryKey: ['resource-reconciliation'] });
    queryClient.invalidateQueries({ queryKey: ['resource-truth-audit'] });
    queryClient.invalidateQueries({ queryKey: ['resources-admin'] });
  };
  const onError = (e: unknown, fallback: string) => setError(errText(e, fallback));

  const setRole = useMutation({
    mutationFn: ({ id, capacityRole }: { id: string; capacityRole: string }) =>
      api.patch(`/resources/${id}`, { capacityRole }),
    onSuccess: refresh,
    onError: (e) => onError(e, 'Could not save that role.'),
  });
  const setCapabilities = useMutation({
    mutationFn: ({ id, capabilities }: { id: string; capabilities: string[] }) =>
      api.post(`/resources/${id}/capabilities`, { capabilities }),
    onSuccess: refresh,
    onError: (e) => onError(e, 'Could not save what work this position takes.'),
  });
  const setLink = useMutation({
    mutationFn: ({ id, legacyBayId }: { id: string; legacyBayId: string | null }) =>
      api.post(`/resources/${id}/legacy-bay`, { legacyBayId }),
    onSuccess: refresh,
    onError: (e) => onError(e, 'Could not change that link.'),
  });
  const confirmIdentity = useMutation({
    mutationFn: ({ id, confirmed }: { id: string; confirmed: boolean }) =>
      api.post(`/resources/${id}/confirm-identity`, { confirmed }),
    onSuccess: refresh,
    onError: (e) => onError(e, 'Could not record that confirmation.'),
  });
  const setDisposition = useMutation({
    mutationFn: ({ bayId, disposition, note }: { bayId: string; disposition: string; note?: string }) =>
      api.post(`/resources/legacy-bays/${bayId}/disposition`, { disposition, note }),
    onSuccess: refresh,
    onError: (e) => onError(e, 'Could not record what happened to that bay.'),
  });

  if (recon.isLoading || !recon.data) return <LoadingState />;
  const data = recon.data;
  const derived = audit.data?.derived;

  const live = data.resources.filter((r) => !r.retired);
  const unconfirmed = live.filter((r) => r.capacityRole === 'UNVERIFIED');
  const confirmed = live.filter((r) => r.capacityRole !== 'UNVERIFIED');
  // A bay that carries real assignment history and is still unaccounted for is
  // the urgent case: it is the model scheduling has actually been using.
  const orphanBays = data.legacyBays.filter((b) => !b.resolved);

  return (
    <div className="p-6 max-w-[1400px]">
      <PageHeader
        title="Confirm Work Positions"
        subtitle="What is actually standing in the Service Centre, and what each thing can do"
        breadcrumbs={[
          { label: 'Setup', href: '/admin' },
          { label: 'Resources & Bays', href: '/admin/resources' },
          { label: 'Confirm Work Positions' },
        ]}
        actions={
          <>
            <Link
              href="/admin/resources"
              className="px-3 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800"
            >
              Add a new bay
            </Link>
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* ---- the headline number, and why it cannot be trusted yet ---------- */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <div>
            <div className="text-3xl font-bold text-slate-900">{derived?.verifiedActivePositions ?? '—'}</div>
            <div className="text-xs text-slate-500 mt-0.5">Confirmed work positions available now</div>
          </div>
          <div>
            <div className="text-3xl font-bold text-amber-600">{unconfirmed.length}</div>
            <div className="text-xs text-slate-500 mt-0.5">Still to confirm</div>
          </div>
          <div>
            <div className="text-3xl font-bold text-slate-900">{data.summary.unresolvedBays}</div>
            <div className="text-xs text-slate-500 mt-0.5">
              Old bay records still to deal with
              <span className="block text-slate-400">
                {data.summary.linkedPairs} matched · {data.summary.dispositionedBays} recorded as gone · of{' '}
                {data.summary.legacyBayRows}
              </span>
            </div>
          </div>
        </div>
        {derived?.configurationIncomplete && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span className="font-semibold">Capacity configuration incomplete.</span>{' '}
            {derived.incompleteWarning}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500 leading-relaxed">
          This number is <span className="font-medium text-slate-700">worked out, not typed in</span>. Confirm a bay here
          and it rises immediately; put one into maintenance on the Resources screen and it falls. Nothing needs to be
          deployed, and no setting is edited. Customer booking is unaffected by this screen — it still runs on the fixed
          limit until the resource model has been proven separately.
        </p>
      </div>

      {/* The "walk the shop" checklist that stood here (CR-2026-108 §13) was
          removed in CR-2026-121: the walk is done and its answers are applied by
          the deployment seed. */}

      {/* ---- what each kind of work has available ------------------------- */}
      {derived && derived.capabilityPools.length > 0 && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Positions by kind of work</h2>
          <p className="text-xs text-slate-500 mt-1 mb-3">
            A position that can do three kinds of work appears in three rows here and is still{' '}
            <span className="font-medium text-slate-700">one vehicle at a time</span>. These are not added together.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-4 font-medium">Kind of work</th>
                  <th className="py-2 pr-4 font-medium">Positions that can do it</th>
                  <th className="py-2 pr-4 font-medium">Services</th>
                  <th className="py-2 pr-4 font-medium">Offered online</th>
                  <th className="py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {derived.capabilityPools.map((p) => (
                  <tr key={p.capability} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-4 font-medium text-slate-900">{capLabel(p.capability)}</td>
                    <td className="py-2 pr-4">
                      <span className={p.eligiblePositions === 0 ? 'text-red-600 font-semibold' : 'text-slate-900'}>
                        {p.eligiblePositions}
                      </span>
                      {p.confidence === 'LOWER_BOUND' && <span className="ml-1 text-xs text-slate-400">or more</span>}
                    </td>
                    <td className="py-2 pr-4 text-slate-600">{p.servicesRequiring}</td>
                    <td className="py-2 pr-4 text-slate-600">{p.pilotServicesRequiring}</td>
                    <td className="py-2 text-xs">
                      {p.doubleBookingRisk ? (
                        <span className="text-amber-700">
                          Two customers can book this at once, and fewer than two positions are confirmed for it.
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* CR-2026-119 §10 — the building, as the floor numbers it. A reference to
          existing records, never a source of them: a slot with nothing linked
          says so, and creating a record for it is a deliberate act elsewhere. */}
      <WorkshopLayout rows={[...unconfirmed, ...confirmed]} onSelect={(id) => setExpanded(id)} />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* ---- the resources ------------------------------------------------ */}
        <div className="xl:col-span-2 space-y-6">
          <Section
            title={`Still to confirm (${unconfirmed.length})`}
            help="Each of these counts for nothing until someone says what it is. That is deliberate — an unclassified row is not evidence of a bay."
            tone="amber"
          >
            {unconfirmed.length === 0 ? (
              <p className="text-sm text-slate-500 px-4 py-6">
                Everything has been confirmed. The position count above is now a complete picture.
              </p>
            ) : (
              unconfirmed.map((r) => (
                <ResourceCard
                  key={r.id}
                  r={r}
                  data={data}
                  expanded={expanded === r.id}
                  onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                  onRole={(capacityRole) => setRole.mutate({ id: r.id, capacityRole })}
                  onCapabilities={(capabilities) => setCapabilities.mutate({ id: r.id, capabilities })}
                  onLink={(legacyBayId) => setLink.mutate({ id: r.id, legacyBayId })}
                  onConfirmIdentity={(confirmed) => confirmIdentity.mutate({ id: r.id, confirmed })}
                  busy={setRole.isPending || setCapabilities.isPending || setLink.isPending || confirmIdentity.isPending}
                />
              ))
            )}
          </Section>

          <Section
            title={`Confirmed (${confirmed.length})`}
            help="Already classified. Change any of it here — every change is recorded against the resource's history."
            tone="plain"
          >
            {confirmed.length === 0 ? (
              <p className="text-sm text-slate-500 px-4 py-6">Nothing confirmed yet.</p>
            ) : (
              confirmed.map((r) => (
                <ResourceCard
                  key={r.id}
                  r={r}
                  data={data}
                  expanded={expanded === r.id}
                  onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                  onRole={(capacityRole) => setRole.mutate({ id: r.id, capacityRole })}
                  onCapabilities={(capabilities) => setCapabilities.mutate({ id: r.id, capabilities })}
                  onLink={(legacyBayId) => setLink.mutate({ id: r.id, legacyBayId })}
                  onConfirmIdentity={(confirmed) => confirmIdentity.mutate({ id: r.id, confirmed })}
                  busy={setRole.isPending || setCapabilities.isPending || setLink.isPending || confirmIdentity.isPending}
                />
              ))
            )}
          </Section>
        </div>

        {/* ---- the legacy side ---------------------------------------------- */}
        <div>
          <Section
            title={`Older bay records (${data.summary.unresolvedBays} to go)`}
            help="These are the rows the scheduler has actually been writing against. Each one needs either a match to the resource that IS that same place, or a note saying it is gone. Never invent a match to clear the list."
            tone="plain"
          >
            {data.legacyBays.map((b) => (
              <LegacyBayCard
                key={b.id}
                b={b}
                dispositions={data.dispositions}
                busy={setDisposition.isPending || setLink.isPending}
                onDisposition={(disposition, note) => setDisposition.mutate({ bayId: b.id, disposition, note })}
              />
            ))}
            {orphanBays.some((b) => b.needsAttention) && (
              <div className="px-4 py-3 bg-amber-50 text-xs text-amber-900 leading-relaxed">
                Some of these carry real job history — they are the ones the scheduler has been using. Worth dealing
                with first.
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

/**
 * One old bay record, and the two honest ways to finish with it.
 *
 * The important design choice: "gone" is offered as prominently as "matched".
 * An earlier version only allowed matching, which quietly pushed whoever was
 * doing the walk towards pairing a demolished bay with whichever new one stood
 * nearest — and that invented link would then be a fact the scheduler reasons from.
 */
function LegacyBayCard({
  b,
  dispositions,
  busy,
  onDisposition,
}: {
  b: LegacyBayRow;
  dispositions: string[];
  busy: boolean;
  onDisposition: (disposition: string, note?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(b.dispositionNote ?? '');
  const [choice, setChoice] = useState(b.disposition);

  const linked = b.link.state === 'LINKED';
  const badge = linked
    ? { text: `Matched to ${b.link.resourceCode}`, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
    : b.resolved
      ? { text: DISPOSITION_LABEL[b.disposition] ?? b.disposition, cls: 'bg-slate-100 text-slate-600 border-slate-200' }
      : {
          text: 'Not decided',
          cls: b.needsAttention ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-100 text-slate-500 border-slate-200',
        };

  return (
    <div className="border-b border-slate-100 last:border-0">
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-medium text-slate-900 text-sm">{b.code}</div>
            <div className="text-xs text-slate-500">
              {capLabel(b.bayType)} · {b.historicalAssignments} job{b.historicalAssignments === 1 ? '' : 's'} on record
            </div>
            {b.resolved && !linked && b.dispositionNote && (
              <div className="text-xs text-slate-500 mt-1 italic">&ldquo;{b.dispositionNote}&rdquo;</div>
            )}
          </div>
          <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium border ${badge.cls}`}>{badge.text}</span>
        </div>

        {linked ? (
          <p className="text-xs text-slate-400 mt-2">
            Matched from the resource side. Unmatch it there if that was wrong.
          </p>
        ) : (
          <button
            onClick={() => setOpen((v) => !v)}
            className="mt-2 text-xs font-medium text-slate-600 hover:text-slate-900 underline underline-offset-2"
          >
            {open ? 'Cancel' : b.resolved ? 'Change what happened to it' : 'Say what happened to it'}
          </button>
        )}
      </div>

      {open && !linked && (
        <div className="px-4 pb-4 bg-slate-50/50 space-y-3">
          <p className="text-xs text-slate-500 leading-relaxed pt-2">
            If a bay standing today IS this same place, match it from the resource list instead. Only use this when
            nothing today corresponds to it — and its {b.historicalAssignments} past job
            {b.historicalAssignments === 1 ? '' : 's'} stay exactly where they are either way.
          </p>
          <fieldset disabled={busy} className="space-y-1">
            {dispositions.map((d) => (
              <label
                key={d}
                className="flex items-start gap-2 p-2 rounded-lg hover:bg-white cursor-pointer border border-transparent hover:border-slate-200"
              >
                <input type="radio" name={`disp-${b.id}`} checked={choice === d} onChange={() => setChoice(d)} className="mt-0.5" />
                <span>
                  <span className="text-sm font-medium text-slate-900">{DISPOSITION_LABEL[d] ?? d}</span>
                  <span className="block text-xs text-slate-500 leading-relaxed">{DISPOSITION_HELP[d]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {choice !== 'UNRESOLVED' && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                What happened, briefly? <span className="font-normal text-slate-500">(required)</span>
              </label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Demolished when the new lifts went in"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 bg-white"
              />
              <p className="text-xs text-slate-500 mt-1">
                Whoever reads this in a year will not remember. One line is enough.
              </p>
            </div>
          )}
          <button
            disabled={busy || (choice !== 'UNRESOLVED' && !note.trim())}
            onClick={() => {
              onDisposition(choice, note.trim() || undefined);
              setOpen(false);
            }}
            className="px-3 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  help,
  tone,
  children,
}: {
  title: string;
  help: string;
  tone: 'amber' | 'plain';
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className={`px-4 py-3 border-b border-slate-200 ${tone === 'amber' ? 'bg-amber-50/50' : 'bg-slate-50'}`}>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{help}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}

/**
 * CR-2026-119 §10 — the Physical Workshop Layout reference.
 *
 * The photographic audit numbered eight working positions and named a wash area
 * and a press corner. Those are the only shared vocabulary between the people
 * who walk the floor and the records in this database, so this schematic is
 * drawn in that vocabulary and nothing else. It does not measure the building,
 * and it creates nothing: a slot with no record linked says so, and linking is
 * done by typing the position onto the record, deliberately.
 */
const LAYOUT_SLOTS: Array<{ key: string; label: string; aliases: RegExp; kind: 'lift' | 'ground' | 'wash' | 'press' }> = [
  { key: 'p1', label: 'Position 1', aliases: /^(position|pos|p)?\s*0?1$/i, kind: 'lift' },
  { key: 'p2', label: 'Position 2', aliases: /^(position|pos|p)?\s*0?2$/i, kind: 'lift' },
  { key: 'p3', label: 'Position 3', aliases: /^(position|pos|p)?\s*0?3$/i, kind: 'lift' },
  { key: 'p4', label: 'Position 4', aliases: /^(position|pos|p)?\s*0?4$/i, kind: 'lift' },
  { key: 'p5', label: 'Position 5', aliases: /^(position|pos|p)?\s*0?5$/i, kind: 'ground' },
  { key: 'p6', label: 'Position 6', aliases: /^(position|pos|p)?\s*0?6$/i, kind: 'lift' },
  { key: 'p7', label: 'Position 7', aliases: /^(position|pos|p)?\s*0?7$/i, kind: 'ground' },
  { key: 'p8', label: 'Position 8', aliases: /^(position|pos|p)?\s*0?8$/i, kind: 'lift' },
  { key: 'wash', label: 'Wash area', aliases: /wash/i, kind: 'wash' },
  { key: 'press', label: 'Press corner', aliases: /press/i, kind: 'press' },
];

function WorkshopLayout({ rows, onSelect }: { rows: ResourceRow[]; onSelect: (id: string) => void }) {
  const linked = (slot: (typeof LAYOUT_SLOTS)[number]) =>
    rows.filter((r) => !r.retired && (r.physicalPosition ?? '').trim() && slot.aliases.test((r.physicalPosition ?? '').trim()));
  const linkedCount = LAYOUT_SLOTS.filter((s) => linked(s).length > 0).length;
  const tone: Record<(typeof LAYOUT_SLOTS)[number]['kind'], string> = {
    lift: 'border-slate-300 bg-white',
    ground: 'border-dashed border-slate-300 bg-slate-50',
    wash: 'border-sky-300 bg-sky-50',
    press: 'border-violet-300 bg-violet-50',
  };
  return (
    <div className="card">
      <div className="card-header flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Physical workshop layout</h2>
          <p className="text-xs text-slate-500">
            As numbered on the photographs. A schematic, not a plan — nothing here is to scale.
          </p>
        </div>
        <span className="badge bg-slate-100 text-slate-700 text-xs">{linkedCount} of {LAYOUT_SLOTS.length} slots linked to a record</span>
      </div>
      <div className="card-body">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
          {LAYOUT_SLOTS.map((slot) => {
            const hits = linked(slot);
            return (
              <div key={slot.key} className={`rounded-md border px-3 py-2 min-h-[72px] ${tone[slot.kind]}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-800">{slot.label}</span>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400">
                    {slot.kind === 'lift' ? 'lift' : slot.kind === 'ground' ? 'ground' : slot.kind}
                  </span>
                </div>
                {hits.length === 0 ? (
                  <p className="mt-1 text-xs italic text-amber-700">No record linked</p>
                ) : (
                  <div className="mt-1 space-y-0.5">
                    {hits.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => onSelect(r.id)}
                        className="block text-left text-xs text-blue-700 hover:underline"
                        title="Open this record below"
                      >
                        <span className="font-mono">{r.code}</span> · {r.name}
                      </button>
                    ))}
                    {hits.length > 1 && (
                      <p className="text-[11px] text-red-700">
                        {hits.length} records claim this one place — only one can be it.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          To link a record, open it below and type its position ("Position 3", "Wash area", "Press corner").
          Two records on one slot means the same place is being counted twice — resolve it, never leave it.
        </p>
      </div>
    </div>
  );
}

function ResourceCard({
  r,
  data,
  expanded,
  onToggle,
  onRole,
  onCapabilities,
  onLink,
  onConfirmIdentity,
  busy,
}: {
  r: ResourceRow;
  data: Reconciliation;
  expanded: boolean;
  onToggle: () => void;
  onRole: (role: string) => void;
  onCapabilities: (capabilities: string[]) => void;
  onLink: (legacyBayId: string | null) => void;
  onConfirmIdentity: (confirmed: boolean) => void;
  busy: boolean;
}) {
  const toggleCapability = (c: string) => {
    const next = r.capabilities.includes(c) ? r.capabilities.filter((x) => x !== c) : [...r.capabilities, c];
    onCapabilities(next);
  };

  // A bay is available to link if nothing else holds it, or this resource does.
  const linkable = data.legacyBays.filter((b) => b.link.state === 'UNLINKED' || b.id === r.link.bayId);

  return (
    <div className="border-b border-slate-100 last:border-0">
      <button onClick={onToggle} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-50">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-slate-900 text-sm">{r.code}</span>
            <span className="text-sm text-slate-500 truncate">{r.name}</span>
            {/* CR-2026-119 §10 — where it is in the building, in the floor's words,
                shown beside the code so the two are never confused for each other. */}
            {r.physicalPosition ? (
              <span className="px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-700 border border-blue-200">
                {r.physicalPosition}
              </span>
            ) : (
              <span className="px-1.5 py-0.5 rounded text-xs bg-amber-50 text-amber-700 border border-amber-200" title="Nobody has said where this is yet">
                Position not recorded
              </span>
            )}
            {!r.isActive && (
              <span className="px-1.5 py-0.5 rounded text-xs bg-slate-100 text-slate-500 border border-slate-200">
                Inactive
              </span>
            )}
            {r.operationalStatus !== 'AVAILABLE' && (
              <span className="px-1.5 py-0.5 rounded text-xs bg-orange-50 text-orange-700 border border-orange-200">
                Not available today
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {r.capabilities.length > 0 ? r.capabilities.map(capLabel).join(' · ') : 'No kinds of work set'}
            {r.link.state === 'LINKED' && ` · matched to ${r.link.bayCode}`}
          </div>
        </div>
        <span
          className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium border ${ROLE_BADGE[r.capacityRole] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}
        >
          {ROLE_LABEL[r.capacityRole] ?? r.capacityRole}
        </span>
        <svg
          className={`w-4 h-4 shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-4 bg-slate-50/50">
          <fieldset disabled={busy}>
            <legend className="text-xs font-semibold text-slate-700 mb-1.5">What is it?</legend>
            <div className="space-y-1">
              {data.capacityRoles.map((role) => (
                <label
                  key={role}
                  className="flex items-start gap-2 p-2 rounded-lg hover:bg-white cursor-pointer border border-transparent hover:border-slate-200"
                >
                  <input
                    type="radio"
                    name={`role-${r.id}`}
                    checked={r.capacityRole === role}
                    onChange={() => onRole(role)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="text-sm font-medium text-slate-900">{ROLE_LABEL[role] ?? role}</span>
                    <span className="block text-xs text-slate-500 leading-relaxed">{ROLE_HELP[role]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/*
            §1 — the count of eight heavy-lift bays is management-confirmed. WHICH
            row is WHICH bay was inferred from names and a code series, and an
            inference that looks like a verified fact is how a provisional label
            quietly becomes business truth. Confirming changes no capacity.
          */}
          <fieldset disabled={busy}>
            <legend className="text-xs font-semibold text-slate-700 mb-1.5">Is this record really that bay?</legend>
            <label className="flex items-start gap-2 p-2 rounded-lg hover:bg-white cursor-pointer border border-transparent hover:border-slate-200">
              <input
                type="checkbox"
                checked={r.identityConfirmed}
                onChange={(e) => onConfirmIdentity(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="text-sm font-medium text-slate-900">
                  I have checked this in the building
                </span>
                <span className="block text-xs text-slate-500 leading-relaxed">
                  {r.identityConfirmed
                    ? 'Confirmed — this record is that physical position.'
                    : 'Not yet checked. The record was matched from its name and code, which is a good guess, not a fact. It still counts toward capacity either way.'}
                </span>
              </span>
            </label>
          </fieldset>

          <fieldset disabled={busy}>
            <legend className="text-xs font-semibold text-slate-700 mb-1.5">What work can happen here?</legend>
            <div className="flex flex-wrap gap-2">
              {data.capabilityVocabulary.map((c) => {
                const on = r.capabilities.includes(c);
                return (
                  <button
                    key={c}
                    onClick={() => toggleCapability(c)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                      on
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                    }`}
                  >
                    {capLabel(c)}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-slate-500 mt-1.5">
              Ticking three of these means one position that can do three kinds of work — not three positions.
            </p>
          </fieldset>

          <fieldset disabled={busy}>
            <legend className="text-xs font-semibold text-slate-700 mb-1.5">Is this the same physical place as an older bay record?</legend>
            <select
              value={r.link.bayId ?? ''}
              onChange={(e) => onLink(e.target.value || null)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 bg-white"
            >
              <option value="">No — this is its own position</option>
              {linkable.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {capLabel(b.bayType)} ({b.historicalAssignments} jobs on record)
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1.5">
              Matching keeps both records. Nothing is merged or deleted, and every past job stays exactly where it is.
              Leave this alone for a bay that was added after the old records were made.
            </p>
          </fieldset>
        </div>
      )}
    </div>
  );
}
