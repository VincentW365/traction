# 16_Risk_Register.md

## Purpose

Track the major delivery and operational risks for the project.

---

## Risk Register

| risk | probability | impact | mitigation |
| --- | --- | --- | --- |
| Ambiguous queue policy | High | High | Freeze business rules early; use approval gates for priority logic. |
| Duplicate truth across modules | Medium | High | Use ServiceVisit as canonical aggregate and one shared DB model. |
| Weak front-desk usability | Medium | High | Design and test check-in workflow first with realistic time pressure. |
| Parts logic deferred too long | High | High | Model parts entities early even if full integration waits until phase 3. |
| POS / inventory integration surprises | Medium | High | Use adapter layer and define contracts early. |
| Too much phase-1 scope | High | High | Hold MVP boundary hard; defer transport optimization and predictive features. |
| Low staff adoption | Medium | High | Pilot with frontline users, train, and iterate on UX quickly. |
| Poor timestamp discipline | Medium | High | Make timestamps automatic on all critical transitions. |
| Manual overrides hide policy failure | Medium | Medium | Measure override rate and reasons; treat as feedback for rule tuning. |
| Network or provider outages | Medium | Medium | Retries, dead-letter queues, and degrade gracefully for notifications/integrations. |
| Technician availability data inaccurate | Medium | Medium | Manage shifts/availability explicitly; surface conflicts. |
| Privacy leakage on public queue boards | Low | High | Use masked identifiers only and role-based internal views. |

---

## Highest-Priority Risks

### 1. Ambiguous queue policy
If the business does not agree on early, late, protected, walk-in, and fast-track behavior, development will become unstable.

### 2. Duplicated data truth
If appointment status, queue rank, or service state are duplicated across modules without ownership, the platform will become inconsistent.

### 3. Weak operational usability
Even correct business logic can fail if the front desk cannot use it quickly.

### 4. Parts blind spots
A scheduling system without parts readiness visibility will keep promising work that cannot start.

### 5. Scope creep
Trying to launch everything at once will hurt quality and delay value.

---

## Risk Management Rules

- review this register at the end of every phase
- convert major risks into backlog items where needed
- track override rates and blocked states as indicators of policy weakness
