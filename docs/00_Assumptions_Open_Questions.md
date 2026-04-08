# 00_Assumptions_Open_Questions.md

## Purpose

This document prevents hidden assumptions from leaking into design or code.
Anything not yet confirmed should live here until explicitly resolved.

---

## Assumptions Used for the Baseline Blueprint

### A1. Pilot first, multi-site ready
The initial rollout will likely begin with a single service centre, but the data model and architecture must support multiple sites later without redesign.

### A2. Existing POS remains payment system of record in early phases
The platform should track payment references and closure state, but it should not replace the existing POS in phase 1.

### A3. Inventory may be external or partially manual at first
Phase 3 must support manual parts readiness as a fallback while still designing for inventory integration.

### A4. Customer portal can be phased in
Internal staff workflows are the first operational priority. Customer self-service should not block phase 1.

### A5. Business rule values must be configurable
Grace period, early arrival threshold, operating hours, service durations, notification templates, and technician availability should not be hard-coded.

### A6. Queue fairness must be visible
The business wants a fair system, so the rank result must be explainable to staff and, where appropriate, to customers.

### A7. Appointment protection is not absolute
Protected appointments outrank walk-ins when eligible, but they can still be blocked by missing parts, no qualified technician, or explicit policy exceptions.

### A8. Same customer + same vehicle + same day usually means one operational visit
Multiple booked services should merge into one active operational visit to avoid duplicate queue entries.

### A9. Transport is a premium convenience module, not the default flow
The service platform should support transport, but transport capacity and geography are constrained.

### A10. Historical data may be insufficient for advanced predictive models
Phase 1–4 should rely on deterministic rules and operational heuristics. Predictive analytics can follow once clean data exists.

### A11. Queue boards should protect privacy
Public display boards should use ticket numbers or masked identifiers, not full customer names.

### A12. Staff need fast touch-friendly workflows
Front desk and technician interfaces will likely be used on shared desktops, tablets, or kiosk-like screens under time pressure.

---

## Known Dependencies

- Existing POS or billing system
- Existing inventory / stock tracking source
- SMS provider account
- Email provider account
- Identity provider choice
- Internal network reliability and device availability
- Service centre operating hours and staffing rosters
- Transport fleet / driver capacity and geography rules

---

## Open Business Questions Requiring Confirmation

### Operating model
1. How many service centre locations are in scope for the first 12 months?
2. Are all technicians generalists, or are some services limited to named individuals?
3. Are work bays typed and capacity-constrained today, or is bay allocation informal?
4. Should advisors create service orders at booking time, check-in time, or after inspection?

### Queue policy
5. After the 15-minute grace period, should late appointments rank ahead of all walk-ins, only some walk-ins, or purely by weighted score?
6. What is the fairness threshold for long-wait walk-ins before escalation? Baseline blueprint assumes **90 minutes**.
7. Should VIP / fleet / warranty customers have special queue rules? If yes, how strong are they?

### Booking policy
8. Which services are appointment-only versus walk-in-friendly?
9. Do certain services require deposit, confirmation, or advisor review before confirmation?
10. Is remote queue joining allowed? If yes, under what controls (time window, geofence, confirmation rules)?

### Parts policy
11. What is the previous-business-day cutoff for next-day parts transfer? Baseline blueprint uses **3:00 PM** as a planning assumption.
12. Can substitute parts be auto-approved for certain categories?
13. Does Bert's already use a parts reservation discipline by appointment, or is that new?

### Transport policy
14. What distance / zone makes a customer transport request eligible?
15. What minimum service duration qualifies for transport? Baseline recommendation: **90 minutes or more**.
16. Can drivers move customers only, vehicles only, or both?
17. Is transport offered for walk-ins, appointments only, or manager discretion?

### Communication policy
18. What reminder cadence is preferred: 24h + 2h, 24h only, same-day only?
19. Is SMS the primary channel or a fallback to email?
20. Should customers be able to confirm, reschedule, or cancel from message links?

### Finance / POS policy
21. Is payment always required before vehicle release?
22. Are there fleet / corporate customers with account billing exceptions?
23. What POS events must synchronize back into the platform?

### Reporting policy
24. What baseline current-state numbers exist for wait time, no-shows, and utilization?
25. How will customer satisfaction be captured: SMS survey, kiosk, call, or email?

---

## Recommended Resolution Order

1. Queue policy
2. Appointment / lateness policy
3. Service catalogue and durations
4. Technician skill map
5. Parts cutoff and reservation policy
6. Payment / POS release rule
7. Transport eligibility
8. Customer communication preferences

---

## Change-Control Rule

No unresolved open question should be silently encoded in production logic.
If implementation must proceed before the question is answered:
- record the assumption
- flag the risk
- make the value configurable when possible
- surface the assumption in the change output

See:
- `templates/ADR_Template.md`
- `templates/Change_Request_Template.md`
- `docs/21_Approval_Gates.md`
