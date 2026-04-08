# 14_Testing_Acceptance_Criteria.md

## Purpose

Define how the platform should be verified before each phase is accepted.

This is an operational system.
Edge cases matter as much as happy paths.

---

## 1. Testing Pyramid

### Unit / domain tests
For:
- arrival policy logic
- queue classification
- score calculation
- parts blocking
- eligibility checks
- ETA calculations
- state transition guards

### Integration tests
For:
- API + DB flows
- check-in workflow
- queue recomputation
- service order transitions
- parts request / transfer updates
- notification job dispatch
- POS and inventory adapter behavior

### End-to-end tests
For:
- customer booking
- front desk check-in
- live queue board
- technician work updates
- parts readiness workflow
- manager override
- transport flow

---

## 2. Critical Scenario Tests

| id | scenario | expected_result |
| --- | --- | --- |
| TS-01 | On-time appointment check-in | Visit becomes APPT_PROTECTED, queue ticket issued, ETA displayed. |
| TS-02 | Appointment arrives 45 min early | Temporary walk-in treatment until protected window opens. |
| TS-03 | Appointment arrives 10 min late | Protected priority retained. |
| TS-04 | Appointment arrives 22 min late | Protected slot lost; APPT_LATE_SOFT class applied. |
| TS-05 | Appointment arrives 40 min late | Marked missed unless manager override; reschedule or walk-in conversion. |
| TS-06 | Walk-in arrives during peak load | Ticket issued, ranked after protected appointments based on current rules. |
| TS-07 | Quick-service walk-in with idle quick lane | Fast-track permitted if no protected appointment delay breach. |
| TS-08 | Two services for same customer same day | Single active queue position / merged visit. |
| TS-09 | Protected appointment with missing critical parts | Blocked by parts; not scheduled to start until ready or override. |
| TS-10 | No qualified technician available | Blocked by skill; alert surfaced. |
| TS-11 | Technician becomes free | Queue recomputed and candidate assignments updated. |
| TS-12 | Job enters waiting-parts during service | Status changes to WAITING_PARTS, delay minutes captured. |
| TS-13 | Parts transfer received | Blocked job becomes eligible; scheduler recomputes rank. |
| TS-14 | Manager queue override | Before/after rank, actor, reason recorded in audit log. |
| TS-15 | Customer transport request for ineligible short job | Request blocked or requires override based on policy. |
| TS-16 | Ready-for-pickup notification failure | Core workflow continues; communication failure logged and retry path exists. |
| TS-17 | Payment not confirmed at closure | Vehicle release or close blocked unless approved exception. |
| TS-18 | Technician absent mid-day | Assignments re-evaluated and affected ETAs updated. |
| TS-19 | System retry on failed POS sync | Idempotent retry, no duplicate invoice or payment reference. |
| TS-20 | Customer abandons queue before service | Visit marked abandoned, metrics updated, queue recomputed. |

---

## 3. Non-Functional Requirements

| area | criterion |
| --- | --- |
| Performance | Common read actions p95 < 500 ms at pilot load; common writes p95 < 800 ms where practical. |
| Realtime | Queue board updates propagate within ~2 seconds under normal conditions. |
| Reliability | Core operational data writes are transactional and durable. |
| Security | RBAC enforced on all protected routes and privileged actions audited. |
| Data Integrity | No duplicate active queue ticket for the same active visit. |
| Observability | Errors, overrides, failed notifications, and failed integrations are visible in logs/alerts. |
| Backup & Recovery | Database backups and tested restore process available before production pilot. |
| Usability | Routine front desk check-in can be completed in under 60 seconds. |

---

## 4. Acceptance Criteria by Phase

### Phase 1 acceptance
- appointments can be created and rescheduled
- walk-ins can be created
- check-in applies early / late rules automatically
- immutable ticket numbers are generated
- queue rank is dynamic and explainable
- live queue board updates correctly
- audit logs exist for overrides
- timestamp capture supports baseline KPIs

### Phase 2 acceptance
- service orders support line items
- technician and bay assignment enforces compatibility
- statuses move cleanly through execution lifecycle
- manager can see workshop bottlenecks
- payment / close rule is enforced

### Phase 3 acceptance
- parts requests are generated
- critical parts can block service eligibility
- transfer workflow works
- parts-ready state updates scheduling logic

### Phase 4 acceptance
- reminders and delay alerts are sent
- ready-for-pickup notices fire
- transport requests can be managed without breaking workshop flow

### Phase 5 acceptance
- KPI dashboards are trusted
- historical trends are available
- optional predictive features are explainable and measurable

---

## 5. Definition of Done

A feature is only done when:
1. rules are implemented
2. API behavior is tested
3. UI states are handled
4. permissions are enforced
5. audit requirements are met
6. edge cases are covered
7. docs are updated
8. errors are observable
9. rollback risk is acceptable
10. operational users can actually use it

---

## 6. Recommended Tooling

- unit tests: Vitest or Jest
- integration tests: Supertest
- E2E: Playwright
- API exploration: Postman or Insomnia
- seed / fixture support for realistic scenario data

---

## 7. Test Data Guidance

Create fixtures for:
- repeat customer with multiple vehicles
- early appointment arrival
- late appointment
- walk-in quick service
- parts-blocked complex repair
- specialist-only repair
- manager override scenario
- corporate / account payment exception
- transport-eligible customer

Testing without realistic fixtures will miss operational bugs.
