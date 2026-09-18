/**
 * CR-2026-108 Stage 5C — the resource-aware capacity engine. PURE, no I/O.
 *
 * THE ARITHMETIC THIS EXISTS TO REPLACE
 *
 * The obvious implementation counts pools and compares:
 *
 *     GENERAL = 8, INSPECTION = 3, LUBE = 2  →  13 jobs at once?
 *
 * That is wrong, and wrong in the direction that oversells the shop. The same
 * physical bay appears in several pools: a heavy lift that can do general work,
 * inspections and oil changes is counted three times and is still ONE vehicle at
 * a time. Sum the pools and eight bays become thirteen promises.
 *
 * So capacity is not a number here. It is a question about IDENTITY: can the
 * jobs that overlap at some instant each be given a DIFFERENT physical resource
 * that is eligible for that job? That is a maximum bipartite matching — jobs on
 * one side, resource positions on the other, an edge where the resource can do
 * the work — and a slot is offerable only when every overlapping job, including
 * the one being placed, can be matched simultaneously.
 *
 * Kuhn's augmenting-path algorithm is used rather than anything cleverer. The
 * graph is tiny (a handful of concurrent jobs against tens of positions) and a
 * matching that a reader can check by hand is worth more here than an asymptotic
 * improvement nobody will ever measure.
 *
 * WHAT "INCOMPLETE" MEANS, AND WHY IT IS NOT A KIND OF "NO"
 *
 * A pool of zero has two completely different causes. Either the shop genuinely
 * cannot do the work, or nobody has finished classifying the bays. Reporting the
 * second as "blocked" would make an unfinished spreadsheet look like an
 * operational limit — and in SHADOW mode, where the whole point is to decide
 * whether to trust this engine, that would poison the evidence. So configuration
 * gaps come back as INCOMPLETE, separately from BLOCKED, and never as AVAILABLE.
 */

/** A physical resource, as the solver needs to see it. */
export interface ResourcePosition {
  id: string;
  code: string;
  /** UNVERIFIED / PRIMARY_SERVICE_POSITION / OVERFLOW_SERVICE_POSITION / ... */
  capacityRole: string;
  /** Kinds of work it can take, in the `requiredBayType` vocabulary. */
  capabilities: string[];
  /** How many vehicles it holds at once. Almost always 1; respected, not assumed. */
  capacity: number;
  isActive: boolean;
  retired: boolean;
  schedulingEnabled: boolean;
  /** AVAILABLE / MAINTENANCE / TEMPORARILY_UNAVAILABLE / OUT_OF_SERVICE. */
  operationalStatus: string;
  supportsSedan: boolean;
  supportsSuv: boolean;
  /** 'mobile' triggers the sedan-only DMAIC Rule 3 gate. */
  liftType: string | null;
}

/** A job competing for a position — an existing appointment, or the new one. */
export interface CapacityJob {
  /** Stable within one evaluation; only used to keep jobs distinct. */
  id: string;
  startAt: Date;
  endAt: Date;
  /** The capability this job needs, or null when the catalogue does not say. */
  requiredCapability: string | null;
  /** SEDAN_CLASS / SUV_CLASS, or null when unknown. */
  vehicleClass: string | null;
}

export type ResourceDecisionStatus = 'AVAILABLE' | 'BLOCKED' | 'INCOMPLETE';

export interface ResourceCapacityDecision {
  status: ResourceDecisionStatus;
  available: boolean;
  /**
   * Structured so a caller can compose the label management asked for
   * (`ALIGNMENT_CAPACITY_REACHED`, `LUBE_CAPACITY_NOT_VERIFIED`) without this
   * module having to know every capability name that will ever exist.
   */
  reasonCode:
    | 'AVAILABLE'
    | 'RESOURCE_CAPACITY_REACHED'
    | 'REQUIRED_RESOURCE_UNAVAILABLE'
    | 'VEHICLE_CLASS_NOT_SUPPORTED'
    | 'RESOURCE_CONFIGURATION_INCOMPLETE';
  requiredCapability: string | null;
  /** Positions that could EVER take this job, ignoring who is using them. */
  eligiblePositions: number;
  /** Eligible positions still free across the whole interval. */
  remainingPositions: number;
  /** Peak number of overlapping jobs (including this one) at the worst instant. */
  peakConcurrentJobs: number;
  /** False when unclassified resources mean the counts are a lower bound. */
  configurationComplete: boolean;
  /** The composed label: e.g. `ALIGNMENT_CAPACITY_REACHED`. */
  label: string;
  /** One sentence a human can act on. */
  detail: string;
  /** Codes of the positions that could take this job, for diagnostics. */
  eligibleCodes: string[];
}

const CAPACITY_ROLES = new Set(['PRIMARY_SERVICE_POSITION', 'OVERFLOW_SERVICE_POSITION']);

/**
 * Is this resource a vehicle position that could be used right now?
 *
 * Role and status are separate dimensions on purpose: a primary bay under
 * maintenance is still a primary bay, it just contributes nothing today.
 */
export function isCountablePosition(r: ResourcePosition): boolean {
  return (
    CAPACITY_ROLES.has(r.capacityRole) &&
    r.isActive &&
    !r.retired &&
    r.schedulingEnabled &&
    r.operationalStatus === 'AVAILABLE'
  );
}

/**
 * Can this position take this job?
 *
 * A null `requiredCapability` means the catalogue does not say what kind of bay
 * the service needs. That is treated as "any position will do" rather than as a
 * blocker: refusing would make an unmapped service look impossible, when what is
 * actually true is that nobody has mapped it.
 */
export function canServe(r: ResourcePosition, job: CapacityJob): boolean {
  if (!isCountablePosition(r)) return false;
  if (job.requiredCapability && !r.capabilities.includes(job.requiredCapability)) return false;
  if (job.vehicleClass === 'SUV_CLASS' && !r.supportsSuv) return false;
  if (job.vehicleClass === 'SEDAN_CLASS' && !r.supportsSedan) return false;
  // DMAIC Rule 3 — a mobile jack takes sedans only. A manager can override it at
  // dispatch, audited; the engine must not offer a slot that depends on one.
  if (r.liftType === 'mobile' && job.vehicleClass !== 'SEDAN_CLASS') return false;
  return true;
}

/**
 * Expand each resource into its individual vehicle positions.
 *
 * A resource with `capacity: 2` genuinely holds two vehicles, so it becomes two
 * nodes. A resource with three capabilities stays ONE node — that is the whole
 * distinction this engine exists to keep.
 */
function positionNodes(resources: ResourcePosition[]): Array<{ resource: ResourcePosition; slot: number }> {
  const nodes: Array<{ resource: ResourcePosition; slot: number }> = [];
  for (const r of resources) {
    for (let i = 0; i < Math.max(1, r.capacity); i++) nodes.push({ resource: r, slot: i });
  }
  return nodes;
}

/**
 * Maximum bipartite matching (Kuhn's algorithm).
 *
 * `edges[j]` lists the position-node indices job `j` can use. Returns how many
 * jobs can be served at once. A full matching (size === jobs.length) means every
 * overlapping job has its own physical position.
 */
export function maxMatching(jobCount: number, edges: number[][]): number {
  const matchedBy = new Map<number, number>(); // position node -> job
  let size = 0;

  const tryAssign = (job: number, seen: Set<number>): boolean => {
    for (const node of edges[job]) {
      if (seen.has(node)) continue;
      seen.add(node);
      const holder = matchedBy.get(node);
      // Free position, or its current holder can move somewhere else.
      if (holder === undefined || tryAssign(holder, seen)) {
        matchedBy.set(node, job);
        return true;
      }
    }
    return false;
  };

  for (let j = 0; j < jobCount; j++) {
    if (tryAssign(j, new Set())) size++;
  }
  return size;
}

/** Instants where the set of active jobs changes, clipped to [start, end). */
function eventPoints(jobs: CapacityJob[], start: Date, end: Date): number[] {
  const points = new Set<number>([start.getTime()]);
  for (const j of jobs) {
    const s = j.startAt.getTime();
    if (s > start.getTime() && s < end.getTime()) points.add(s);
  }
  return [...points].sort((a, b) => a - b);
}

export interface ResourceCapacityInput {
  resources: ResourcePosition[];
  /** Jobs already on the book that could overlap. */
  existing: CapacityJob[];
  /** The job being placed. */
  candidate: CapacityJob;
  /** Resources nobody has classified yet — makes every count a lower bound. */
  unverifiedResourceCount: number;
}

/**
 * Can the candidate job be placed without two jobs needing the same position?
 *
 * The check is made at every instant where the set of overlapping jobs changes,
 * because a matching that works at the start of an interval can fail in the
 * middle when a third job begins.
 */
export function evaluateResourceCapacity(input: ResourceCapacityInput): ResourceCapacityDecision {
  const { resources, existing, candidate, unverifiedResourceCount } = input;
  const capability = candidate.requiredCapability;
  const configurationComplete = unverifiedResourceCount === 0;

  const nodes = positionNodes(resources);
  const eligibleNodes = nodes.filter((n) => canServe(n.resource, candidate));
  const eligibleCodes = [...new Set(eligibleNodes.map((n) => n.resource.code))].sort();
  const eligiblePositions = eligibleNodes.length;

  // --- nothing can do this work at all ------------------------------------
  if (eligiblePositions === 0) {
    // Which of the two zeroes is this? The distinction decides whether anyone
    // should act on it, so it is worth being careful about.
    const anyCountable = resources.some(isCountablePosition);
    const capableIgnoringVehicle = resources.some(
      (r) => isCountablePosition(r) && (!capability || r.capabilities.includes(capability)),
    );

    if (capableIgnoringVehicle) {
      // Positions exist for the work; the vehicle is the problem.
      return decision({
        status: 'BLOCKED',
        reasonCode: 'VEHICLE_CLASS_NOT_SUPPORTED',
        requiredCapability: capability,
        eligiblePositions: 0,
        remainingPositions: 0,
        peakConcurrentJobs: 0,
        configurationComplete,
        eligibleCodes,
        detail:
          `No available position accepts a ${String(candidate.vehicleClass ?? 'vehicle of this class')}` +
          (capability ? ` for ${capability} work.` : '.'),
      });
    }
    if (!configurationComplete || !anyCountable) {
      // Nobody has finished saying what the bays are. That is a fact about the
      // configuration, not about the workshop, and must not read as "blocked".
      return decision({
        status: 'INCOMPLETE',
        reasonCode: 'RESOURCE_CONFIGURATION_INCOMPLETE',
        requiredCapability: capability,
        eligiblePositions: 0,
        remainingPositions: 0,
        peakConcurrentJobs: 0,
        configurationComplete,
        eligibleCodes,
        detail: anyCountable
          ? `No confirmed position carries ${capability ?? 'this work'}, and ${unverifiedResourceCount} resource(s) are still unclassified — this is a configuration gap, not a capacity limit.`
          : `No resource has been confirmed as a vehicle position yet (${unverifiedResourceCount} unclassified).`,
      });
    }
    // Everything is classified and nothing can do it. That IS an operational fact.
    return decision({
      status: 'BLOCKED',
      reasonCode: 'REQUIRED_RESOURCE_UNAVAILABLE',
      requiredCapability: capability,
      eligiblePositions: 0,
      remainingPositions: 0,
      peakConcurrentJobs: 0,
      configurationComplete,
      eligibleCodes,
      detail: `No position is configured for ${capability ?? 'this work'}.`,
    });
  }

  // --- the matching, instant by instant ------------------------------------
  const overlapping = existing.filter(
    (j) => j.startAt.getTime() < candidate.endAt.getTime() && j.endAt.getTime() > candidate.startAt.getTime(),
  );
  const points = eventPoints(overlapping, candidate.startAt, candidate.endAt);

  let worstPeak = 0;
  let feasible = true;
  let remainingAtWorst = eligiblePositions;

  for (const t of points) {
    const activeJobs = [candidate, ...overlapping.filter((j) => j.startAt.getTime() <= t && j.endAt.getTime() > t)];
    if (activeJobs.length > worstPeak) worstPeak = activeJobs.length;

    const edges = activeJobs.map((job) =>
      nodes.map((n, i) => (canServe(n.resource, job) ? i : -1)).filter((i) => i >= 0),
    );
    const matched = maxMatching(activeJobs.length, edges);
    if (matched < activeJobs.length) {
      feasible = false;
      // How many eligible positions were free for the candidate at this instant?
      // Everything else active is, at best, occupying one each.
      remainingAtWorst = Math.max(0, eligiblePositions - (activeJobs.length - 1));
      break;
    }
  }

  if (!feasible) {
    return decision({
      status: 'BLOCKED',
      reasonCode: 'RESOURCE_CAPACITY_REACHED',
      requiredCapability: capability,
      eligiblePositions,
      remainingPositions: remainingAtWorst,
      peakConcurrentJobs: worstPeak,
      configurationComplete,
      eligibleCodes,
      detail:
        `${eligiblePositions} position(s) can do this work and they cannot cover ${worstPeak} overlapping job(s) — ` +
        'one physical position cannot take two vehicles at once.',
    });
  }

  // Free eligible positions once every overlapping job has taken one it could use.
  const contested = overlapping.filter((j) => eligibleNodes.some((n) => canServe(n.resource, j))).length;
  return decision({
    status: 'AVAILABLE',
    reasonCode: 'AVAILABLE',
    requiredCapability: capability,
    eligiblePositions,
    remainingPositions: Math.max(0, eligiblePositions - contested - 1),
    peakConcurrentJobs: worstPeak,
    configurationComplete,
    eligibleCodes,
    detail: configurationComplete
      ? `${eligiblePositions} position(s) can do this work; a distinct one is free for every overlapping job.`
      : `${eligiblePositions} confirmed position(s) can do this work (a lower bound — ${unverifiedResourceCount} resource(s) are still unclassified).`,
  });
}

function decision(d: Omit<ResourceCapacityDecision, 'available' | 'label'>): ResourceCapacityDecision {
  return {
    ...d,
    available: d.status === 'AVAILABLE',
    label: composeLabel(d.reasonCode, d.requiredCapability),
  };
}

/**
 * `ALIGNMENT_CAPACITY_REACHED`, `LUBE_CAPACITY_NOT_VERIFIED` — the labels
 * management asked to see, composed from the capability rather than enumerated,
 * so a capability added tomorrow needs no code change here.
 */
export function composeLabel(reasonCode: ResourceCapacityDecision['reasonCode'], capability: string | null): string {
  const prefix = capability ? `${capability}_` : '';
  switch (reasonCode) {
    case 'AVAILABLE':
      return 'AVAILABLE';
    case 'RESOURCE_CAPACITY_REACHED':
      return `${prefix}CAPACITY_REACHED`;
    case 'REQUIRED_RESOURCE_UNAVAILABLE':
      return `${prefix}POSITION_NOT_CONFIGURED`;
    case 'VEHICLE_CLASS_NOT_SUPPORTED':
      return `${prefix}VEHICLE_CLASS_NOT_SUPPORTED`;
    case 'RESOURCE_CONFIGURATION_INCOMPLETE':
      return `${prefix}CAPACITY_NOT_VERIFIED`;
    default:
      return 'UNKNOWN';
  }
}
