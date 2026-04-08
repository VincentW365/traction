# ADR-004: Phase 1 Scheduling Engine Scope

## Status
Proposed

## Context
The scheduling engine specification (`docs/08_Scheduling_Engine_Spec.md`) defines a 6-stage pipeline with 8 priority classes, weighted scoring, resource matching, and features like quick-service fast-track and batching. Phase 1 must deliver a functional queue with explainable ordering, but not all features are needed before Phase 2.

## Decision
Implement all 6 stages with **Phase 1 simplifications**:
- Stages 1-3 (candidate set, eligibility, classification): fully implemented
- Stage 4 (scoring): simplified — base weight + wait bonus - lateness penalty only
- Stage 5 (resource matching): simplified — existence check for tech/bay, no real-time availability
- Stage 6 (decision persistence): fully implemented

### Specific deferrals
- **WALKIN_FASTTRACK bonus:** enum present, scoring bonus disabled (returns 0). Phase 2.
- **Batching bonus:** disabled (returns 0). Phase 2.
- **Fairness escalation bonus:** disabled (returns 0). Phase 2 (active alerting).
- **Promised-time risk bonus:** deferred until ServiceOrders exist in Phase 2.
- **Real-time technician availability:** Phase 1 checks skill existence. Phase 2 tracks live availability.
- **Resource-path-specific ETA:** Phase 1 uses sequential sum. Phase 2 uses earliest-available-on-compatible-path.

### Phase 1 scoring formula
```
score = baseWeight(priorityClass)           // 1000/800/600/0
      + min(waitMinutes, 120) * 2           // wait bonus, capped at 240
      - lateMinutes * 3                     // lateness penalty
```

### Tie-break (all phases)
1. Earlier protected appointment time
2. Earlier check-in time
3. Lower checkin_sequence

## Options Considered
1. **Full engine in Phase 1** — all features including fast-track, batching, fairness
2. **Simplified engine in Phase 1** (chosen) — core ranking with deferred bonus components
3. **No engine in Phase 1** — pure FIFO queue with manual reordering

## Rationale
- Phase 1 acceptance criteria require: "queue order is explainable" and "appointments and walk-ins coexist cleanly." The simplified engine satisfies both.
- Fast-track requires delay-impact analysis on protected appointments, which requires resource-path-specific ETA — a Phase 2 capability.
- Batching requires service family grouping and promised-time breach checking — Phase 2 capabilities.
- The scoring formula is simple enough for staff to understand: "appointments rank higher, longer waits get a boost, late arrivals get a penalty."

## Tradeoffs
- **Gain:** Simpler Phase 1, faster delivery, easier to test, easier for staff to understand
- **Lose:** Quick oil changes wait in standard queue (no fast-track). No grouping optimization. ETAs are conservative (sequential assumption).
- **Risk:** Staff may request fast-track during pilot. Mitigation: manager override is available, and fast-track is planned for Phase 2.

## Impact
- **Scheduling module:** `engine/` pure functions with disabled bonus components that return 0
- **Enums:** All 8 priority classes exist in schema (WALKIN_FASTTRACK present but unused)
- **Scoring constants:** Stored in BusinessRuleConfig but some have no effect until Phase 2
- **ETA:** Sequential sum — will underestimate throughput when multiple bays are active. Acceptable for pilot.

## Rollback / Migration
No rollback needed — Phase 2 enables bonus components by changing return values from 0 to computed values. No structural changes required.

## Approval Gate
AG-03 (scheduling algorithm scope decision).
