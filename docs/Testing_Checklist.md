# BSOP — Owner Acceptance Testing Checklist

A structured way to walk the whole site and confirm it works the way you want.
Tick each box; jot anything off in the **Issue Log** at the bottom and hand it back.

- **App:** http://localhost:3000  (API: http://localhost:3001/api/v1, Swagger at `/api/docs`)
- **Role switcher:** open **http://localhost:3000/dev-login** and click a role to instantly sign in as it (no password). Use this to test each role.
- **Demo data:** the queue/schedule/dispatch are pre‑loaded with sandbox data (label `test-walkthrough-2026-06-15`). It's tagged so it can be wiped cleanly afterward — ask me to "clean up the demo data" when you're done.


## 1. Golden path (end‑to‑end) — do this once
Run a single job from arrival to pickup. This exercises the core wiring.

- [ ] **Customer:** Customers → create a new customer (name + phone). Saves, opens detail.
- [ ] **Vehicle:** add a vehicle (plate, make/model/year). Appears on the customer.
- [ ] **Appointment:** Schedule → Appointments view → click an empty time → "Schedule Appointment"; fill details; it appears on the **Appointments calendar** (no overlap with others).
- [ ] **Check‑in:** Check‑in → find the customer/vehicle → enter Mileage + intake details → check the appointment in.
- [ ] **Queue:** the visit now shows on the **Queue** board with a ticket number and rank.
- [ ] **Assign:** open the queue ticket → see **Recommended technicians** (ranked) → assign a Technician + Bay.
- [ ] **Bays view:** Schedule → **Bays** → the assignment shows on the bay/resource timeline.
- [ ] **Work status:** move the job through its statuses (in progress → … → complete).
- [ ] **Inspection:** start/complete a Visual Inspection for the visit; sign‑off (advisor + customer).
- [ ] **Pickup:** mark ready‑for‑pickup; confirm the ready‑for‑pickup notice/notification is logged.

## 3. Exception flows (the important edge cases)
- [ ] **Walk‑in** (no appointment): Check‑in → Register Walk‑In → pick services → it enters the queue.
- [ ] **No‑show / abandon:** mark a checked‑in visit abandoned → it leaves the active queue, status recorded.
- [ ] **Late / early arrival:** check in an appointment well after its time → confirm it's handled per your rules.
- [ ] **Blocked parts:** a visit needing parts shows as blocked and can't be dispatched until marked ready.
- [ ] **No available technician/bay:** the recommender shows none / the assign flow prevents a bad assignment.
- [ ] **Manager override:** where the system blocks something, a manager override works **and** is recorded in Audit Logs.

## 4. Module‑by‑module
- [ ] **Schedule → Appointments:** calendar shows the day's appointments side‑by‑side (no overlap); click an appt opens detail; click empty time creates one; date nav + zoom work.
- [ ] **Schedule → Bays:** resource/bay timeline shows assignments + queue rail; zoom works.
- [ ] **Schedule → Week:** week overview; clicking a day jumps to it.
- [ ] **Appointments:** list/create/edit/reschedule/cancel.
- [ ] **Queue:** ranking order looks right; blocked/late flags visible; open a ticket for detail/assignment.
- [ ] **Dispatch:** transport requests + dispatch board.
- [ ] **Customers:** search + directory (A–Z, filters), detail page, history, "due for contact".
- [ ] **Vehicles:** detail, fields (incl. engine #, drive side), service history.
- [ ] **Inspections:** list, fill, sign‑off, print view, approved recommendation → work order.
- [ ] **Complaints:** log a complaint, triage (acknowledge/resolve), SLA/overdue flag.
- [ ] **Reports:** Rework/First‑Time‑Fix, Due‑for‑Contact, Service Mix, Historical, Classification — each loads and the numbers look sane.
- [ ] **Admin:** staff (add/deactivate), availability, performance, assignments, service catalogue, resources/bays, integrations, settings, **Audit Logs**.


## 6. Cross‑cutting
- [ ] **Exports:** on Reports + Customers/Complaints/Inspections lists, the **Export** menu → CSV opens cleanly in Excel; PDF prints a branded, properly‑laid‑out page.
- [ ] **Inspection form (print):** the standalone Visual Inspection Form (`docs/Visual_Inspection_Form.pdf`) prints correctly in **black & white** (O/F/I letters readable) and the Prior Body Damage diagram looks right.
- [ ] **Public pages:** customer **status** page (`/status/<token>`) and lobby **display** (`/display/<token>`) show the right info and no internal PII.
- [ ] **Notifications:** status changes / ready‑for‑pickup produce a notification log entry (SMS is stub/opt‑in unless Twilio is enabled).
- [ ] **Audit:** overrides and key status changes appear in Admin → Audit Logs with who/when.

## 7. Recently changed — verify specifically
- [ ] Schedule is split into **Appointments / Bays / Week**, and appointments **don't overlap**.
- [ ] **Mileage** can be entered for any service.
- [ ] **CSV + PDF export** on reports/lists.
- [ ] **Visual Inspection Form** — black‑and‑white friendly, single page, the new Prior Body Damage diagram.

---

## Issue Log
| # | Screen / role | What I expected | What happened | Severity |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

> Tip: test as one role at a time, top‑to‑bottom. When you hit something wrong, note it here and keep going — I'll fix them one at a time (verify → commit).
