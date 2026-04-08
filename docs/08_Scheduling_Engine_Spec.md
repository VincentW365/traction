# 08_Scheduling_Engine_Spec.md

## Purpose

This document defines the **core brain** of the platform.

The Scheduling Engine is responsible for:
- validating appointment slot availability
- activating visits into the queue
- ranking visits fairly
- protecting appointments according to policy
- preserving walk-in fairness
- matching work to qualified technicians and compatible bays
- calculating ETA and predicted completion
- persisting explainable ranking decisions

This is the highest-leverage part of the system.
It must be deterministic, auditable, and testable.

---

## 1. Design Philosophy

### Use deterministic heuristics first
Phase 1–4 should use explicit rules and scoring logic.
Do **not** use black-box machine learning in the first release.

Reasons:
- the business must trust the queue
- managers must understand why rank changed
- historical data will be limited and noisy at first
- policy changes are easier with rule-driven logic

### Add predictive models later
Once clean data exists, later phases can add:
- no-show risk scoring
- duration prediction
- demand forecasting
- capacity planning suggestions

These should be **advisory**, not silently authoritative.

---

## 2. Inputs the Engine Must Read

### Static / configurable inputs
- business rules
- service catalogue
- site operating hours
- technician schedules
- bay definitions
- queue policy thresholds
- quick-service policy
- batching policy
- transport eligibility policy

### Dynamic inputs
- check-in state
- appointment times
- arrival time delta
- service visit status
- required parts readiness
- technician availability
- bay availability
- service duration estimate
- current active queue
- manual override flags
- promised completion commitment if already set

---

## 3. Core Concepts

### 3.1 Ticket number vs rank
- `ticket_number` = immutable operational reference
- `queue_rank` = computed live ordering
- `display_status` = waiting / called / in service / blocked / complete

Never conflate them.

### 3.2 Eligibility vs priority
A visit can have high priority but still be ineligible.

Example:
- on-time appointment
- protected by policy
- but missing critical parts

Result:
- priority class exists
- eligibility fails
- status is blocked
- staff sees why

### 3.3 Resource-aware ranking
The engine is not just deciding “who is next.”
It is deciding:
- who is next **for which compatible resource path**
- which job fits a now-free technician and bay
- whether batching or quick-lane treatment is acceptable

---

## 4. Stage Model

### Stage 1 — Build candidate set
Find active `ServiceVisit` records for the site/day that are not:
- completed
- cancelled
- abandoned
- hard-blocked by business closure

### Stage 2 — Determine eligibility
Check:
- checked in?
- within appointment policy window?
- mandatory parts ready?
- qualified technician exists?
- compatible bay exists?
- other local blocking conditions?

### Stage 3 — Assign priority class
At minimum:
- `APPT_PROTECTED`
- `APPT_LATE_SOFT`
- `WALKIN_STANDARD`
- `WALKIN_FASTTRACK`
- `BLOCKED_PARTS`
- `BLOCKED_SKILL`
- `MISSED_APPOINTMENT`
- `MANUAL_OVERRIDE`

### Stage 4 — Calculate weighted score
Use a transparent score made from policy components.

### Stage 5 — Match to resource candidates
Find compatible technician / bay candidates and estimate earliest start.

### Stage 6 — Persist decision snapshot
Store:
- score
- class
- blocked reason
- resource candidates
- ETA
- reasons

This makes the queue explainable.

---

## 5. Recommended Priority Classes

| Class | Meaning | Typical rank behavior |
| --- | --- | --- |
| APPT_PROTECTED | Appointment checked in within protected window | outranks walk-ins when eligible |
| APPT_LATE_SOFT | Late appointment beyond grace-protection but still salvageable | ranks below protected appointments, above or around walk-ins by score |
| WALKIN_STANDARD | Standard walk-in | ranked by wait, service fit, fairness |
| WALKIN_FASTTRACK | Qualifying quick job | can enter quick lane if policy allows |
| BLOCKED_PARTS | Parts missing | not start-eligible |
| BLOCKED_SKILL | No qualified tech or bay | not start-eligible |
| MISSED_APPOINTMENT | Too late to retain same-day protection | reschedule or convert |
| MANUAL_OVERRIDE | Explicit manager intervention | special handling with audit |

---

## 6. Recommended Scoring Model

Use a weighted score or lexicographic policy stack.
Recommended default:

### Base weights
- APPT_PROTECTED = 1000
- APPT_LATE_SOFT = 800
- WALKIN_STANDARD = 600
- WALKIN_FASTTRACK = 650
- BLOCKED_* = 0 (not rankable for service start)
- MANUAL_OVERRIDE = explicit override path

### Additive components
- wait_time_bonus = min(wait_minutes, 120) * 2
- quick_service_bonus = +50 when quick lane eligible
- batching_bonus = +30 when same-family batch improves flow without violating fairness
- promised_time_risk_bonus = 0 to +100 based on committed completion risk
- fairness_escalation_bonus = +40 after long-wait threshold breach

### Penalties
- lateness_penalty = late_minutes * 3 after protected grace
- context_switch_penalty = optional penalty if assignment creates inefficient switching
- parts_unready_penalty = ineligible, not merely lower score
- skill_mismatch_penalty = ineligible, not merely lower score

### Important policy note
Do not rely on score alone when hard rules exist.
Hard rules win first.

---

## 7. Appointment Timing Rules

### Protected window
Default policy:
- appointment is protected when checked in from **30 minutes before** to **15 minutes after** scheduled start

### Too early
If earlier than 30 minutes before:
- treat as temporary walk-in
- do not grant protected rank yet

### Soft late
If 16–30 minutes late:
- remove protected status
- keep same-day salvage path

### Missed
If more than 30 minutes late:
- mark missed unless staff-approved exception
- allow reschedule or conversion to walk-in based on policy

These values should remain configurable.

---

## 8. Quick-Service Fast-Track Rules

Quick-service fast-track should exist only when one of the following is true:
1. a dedicated quick lane / lube bay exists, or
2. a compatible idle resource exists and protected appointments are not delayed beyond the configured tolerance

Recommended default tolerance:
- max additional delay to a protected appointment = **10 minutes**

Quick-service should never become a hidden way to make walk-ins unfairly jump the queue.

---

## 9. Batching Rules

Batching similar services can improve throughput.
Examples:
- tire rotations
- oil changes
- brake family work
- diagnostic families if same specialist can stay in mode

### Batching is allowed only if:
- same service family or compatible family
- same skill / bay path
- no protected appointment breaches tolerance
- no customer promise breach beyond policy
- batching bonus remains explainable

---

## 10. Candidate Technician / Bay Matching

The engine should output one or more candidate resource pairings.

### Filter
Only resources that satisfy:
- required skill
- required proficiency
- required bay type
- not already double-booked in active work

### Rank candidate pairings
Use:
- earliest feasible start
- projected completion
- current load balance
- proficiency / historical speed bonus (later phase)
- minimal context switching (optional later)

---

## 11. ETA Calculation

### Phase 1 ETA method
Use deterministic ETA:
- sum remaining projected work ahead on compatible path
- add current service durations in progress
- add setup / transition overhead if defined
- add parts or block condition if not eligible

### Recommended duration estimate formula
`estimated_minutes = base_service_minutes * vehicle_factor * complexity_factor`

Where:
- `base_service_minutes` comes from service catalogue
- `vehicle_factor` can remain 1.0 in early versions unless business wants segmentation
- `complexity_factor` reflects line-item stack and inspection findings

### Later improvement
After enough data, use historical service-family completion distributions per technician skill and vehicle class.

---

## 12. Queue Recompute Triggers

Recompute rank when:
- appointment created, changed, or cancelled
- walk-in created
- customer checked in
- technician becomes free
- service starts or completes
- parts become ready or blocked
- bay becomes available or unavailable
- manager override occurs
- appointment crosses protection window threshold
- fairness threshold is breached

---

## 13. Required Reason Codes

Persist reason codes or structured explanation fields such as:
- appointment_protected
- arrived_early
- arrived_late_soft
- missed_appointment
- quick_lane_available
- batching_applied
- blocked_parts
- blocked_skill
- blocked_bay
- fairness_escalated
- manager_override

These reason codes are essential for audit and support.

---

## 14. Queue Decision Table

| scenario | source_type | arrival_delta_min | parts_ready | quick_service | result_priority_class | ranking_action | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| On-time appointment checked in, parts ready, skill available | APPOINTMENT | -30 to +15 | Yes | Any | APPT_PROTECTED | Rank above walk-ins; assign earliest compatible resource. | Protected appointment policy applies. |
| Appointment arrives >30 min early | APPOINTMENT | < -30 | Yes | Any | WALKIN_TEMP | Treat as walk-in until protection window opens. | Can be served early if capacity allows. |
| Appointment arrives 16-30 min late | APPOINTMENT | +16 to +30 | Yes | Any | APPT_LATE_SOFT | Lose protected slot; rank dynamically with lateness penalty. | Manager may restore priority. |
| Appointment arrives >30 min late, no contact | APPOINTMENT | > +30 | Any | Any | MISSED | Remove from protected flow; reschedule or convert to walk-in. | Capacity-based salvage only. |
| Walk-in quick service, quick lane idle | WALKIN | N/A | Yes | Yes | WALKIN_FASTTRACK | Insert into quick lane if protected appointments not delayed >10 min. | Lane capacity required. |
| Walk-in standard service | WALKIN | N/A | Yes | No | WALKIN_STANDARD | Rank after protected appointments using wait-time fairness. | Default walk-in path. |
| Any visit with mandatory parts not ready | ANY | Any | No | Any | BLOCKED_PARTS | Do not schedule to service start; alert parts team. | Can remain visible with blocked reason. |
| Any visit with no qualified tech scheduled | ANY | Any | Yes | Any | BLOCKED_SKILL | Hold from scheduling; escalate or reschedule. | Eligibility fails. |
| Multiple services same customer and vehicle same day | ANY | Any | Mixed | Mixed | MERGED_VISIT | Single queue position with multi-line service order. | No duplicate ticket. |
| Long-wait walk-in breaches fairness threshold | WALKIN | N/A | Yes | No | WALKIN_ESCALATED | Manager alert; optional manual intervention. | Threshold default 90 min. |
| Batched similar service family with no protected-delay breach | ANY | Any | Yes | Any | BATCH_ELIGIBLE | Apply batching bonus in ranking and assignment. | Efficiency without unfairness. |
| Manager override | ANY | Any | Any | Any | MANUAL_OVERRIDE | Apply explicit ranked order change with audit. | Reason code mandatory. |

---

## 15. Pseudocode (Reference Only)

```text
function recomputeQueue(siteId, now):
  visits = loadActiveServiceVisits(siteId)

  for each visit in visits:
    eligibility = evaluateHardConstraints(visit, now)
    priorityClass = classifyVisit(visit, now, eligibility)

    if eligibility.blocked:
      saveQueueDecision(visit, priorityClass, blockedReason=eligibility.reason)
      continue

    score = baseWeight(priorityClass)
    score += waitTimeBonus(visit, now)
    score += quickServiceBonus(visit, eligibility)
    score += batchingBonus(visit, siteId)
    score += promisedTimeRiskBonus(visit, now)
    score += fairnessEscalationBonus(visit, now)
    score -= latenessPenalty(visit, now)

    candidates = findCompatibleResources(visit, now)
    bestCandidate = rankCandidates(candidates, visit, now)

    eta = calculateEta(visit, bestCandidate, now)

    saveQueueDecision(
      visit,
      priorityClass,
      score,
      bestCandidate,
      eta,
      reasonCodes
    )

  ranked = sortEligibleVisitsBy(priorityClass, score, eta, checkInSequenceTieBreak)
  persistQueueRanks(ranked)
```

### Tie-break recommendation
If two items are otherwise equal:
1. earlier protected appointment time
2. earlier check-in time
3. lower check-in sequence

---

## 16. Failure Handling

### If no qualified technician exists
- classify as `BLOCKED_SKILL`
- surface to advisor / manager
- do not silently drop from board

### If parts are missing
- classify as `BLOCKED_PARTS`
- show blocked reason
- allow parts team workflow to unblock

### If notification fails
- do not affect queue
- log communication failure separately

### If system is under maintenance
- preserve existing ticket numbers and current ranks
- fail safely with clear staff messaging

---

## 17. Future Optimization Models (Not Phase 1)

Use only after clean data exists.

### Candidate model 1 — No-show risk
- gradient boosting or logistic classification
- output advisory risk score for overbooking / reminder strategy

### Candidate model 2 — Duration prediction
- regression model by service family, vehicle class, technician, and historical variance
- output estimated labor minutes and confidence interval

### Candidate model 3 — Demand forecasting
- time-series forecasting for future load by day / hour / service family

### Candidate model 4 — Optimization solver
- optional mixed-integer or heuristic optimizer for advanced assignment scenarios
- should remain advisory until trust is proven

These models should never replace explainable policy without explicit approval.

---

## 18. Acceptance Criteria for the Engine

The engine is acceptable when:
- all core priority rules are implemented
- blocked states are explicit
- queue order is explainable
- ETA is consistently recalculated
- technician / bay compatibility is enforced
- manager overrides are audited
- scenario tests pass for early, late, walk-in, quick-service, parts-blocked, and technician-unavailable cases
