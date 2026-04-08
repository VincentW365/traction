# 21_Approval_Gates.md

## Purpose

This document defines which decisions must be surfaced for explicit review before they are implemented.

It exists because the user wants architecture and product decisions reviewed before Claude locks them in.

---

## Approval Gates

| gate | decision_area | examples | required_artifact | why |
| --- | --- | --- | --- | --- |
| AG-01 | Business rule change | grace period, early/late rules, walk-in priority, fast-track behavior | ADR or change request | Changes fairness and customer trust. |
| AG-02 | Core schema change | ServiceVisit shape, QueueTicket ownership, status model changes | ADR | Can create long-term inconsistency or migration risk. |
| AG-03 | Scheduling algorithm change | score weights, tie-breaks, batching logic, ETA model | ADR with test impact | Affects queue order and operational behavior. |
| AG-04 | Architecture deviation | microservices, multiple DBs, direct DB subscriptions as primary logic path | ADR | High structural cost and complexity. |
| AG-05 | New third-party dependency in core flow | auth provider lock-in, scheduling library, workflow engine | Change request | Can create lock-in or hidden complexity. |
| AG-06 | Integration contract change | POS payloads, inventory reservation semantics, webhook design | ADR or contract note | Affects system boundaries and rollout risk. |
| AG-07 | Security / permission model change | role changes, override rights, export rights | ADR | Affects control and exposure. |
| AG-08 | Transport policy change | eligibility thresholds, customer window behavior | Change request | Affects service promise and operational scope. |
| AG-09 | Reporting / metric definition change | what counts as wait time or utilization | Change request | Metrics lose trust if definitions drift. |
| AG-10 | Production readiness waiver | shipping without audit, without tests, or without backup | Explicit risk acceptance | Operational risk must be visible. |

---

## What Claude Must Provide for a Reviewable Decision

For every gated decision, Claude must provide:

1. **Problem statement**
2. **Options considered**
3. **Recommended option**
4. **Why it fits this platform**
5. **Tradeoffs**
6. **Impacted modules**
7. **Impacted entities / contracts**
8. **Migration or rollback note**
9. **Test impact**
10. **Whether docs / rules / schema need updates**

---

## Fast Decision Template

Claude can use:
- `templates/ADR_Template.md`
- `templates/Change_Request_Template.md`

---

## Examples of Decisions That Do NOT Need Formal Gate Review

- typo fixes in docs
- UI layout tweaks that do not change workflow
- non-core styling changes
- refactors with no domain or API impact
- adding a missing unit test

---

## Escalation Rule

If Claude is unsure whether something requires approval, it should assume **yes** and surface the decision.
