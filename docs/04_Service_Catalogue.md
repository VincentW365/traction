# 04_Service_Catalogue.md

## Purpose

This catalogue defines the baseline service taxonomy for booking, scheduling, queueing, technician assignment, and parts readiness.

It is not just a list for the UI.
It is a core operational model.

The CSV source lives in `data/service_catalogue.csv`.

---

## 1. Catalogue Design Rules

1. Every service type needs a stable code.
2. Every service type needs a default duration.
3. Every service type needs a skill mapping.
4. Every service type should identify whether parts staging is normally required.
5. Every service type should identify whether quick-service treatment is even possible.
6. Every service type should point to a compatible bay type.
7. Every service type should identify whether customer transport is generally reasonable.

---

## 2. Service Catalogue Summary

| service_code | service_name | family | base_duration_min | quick_service | skill_code | bay_type | parts_preposition_required | transport_eligible |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OIL-01 | Oil Change | Quick Service | 30 | Yes | LUBE | Lube Bay | Yes | No |
| TIR-01 | Tire Rotation | Quick Service | 25 | Yes | TIRE | General Bay | No | No |
| BAT-01 | Battery Test / Replace | Electrical / Quick | 30 | Yes | ELECTRICAL | General Bay | Yes | No |
| BRK-01 | Brake Inspection | Brakes | 30 | No | BRAKE | General Bay | No | No |
| BRK-02 | Brake Pad Replacement | Brakes | 90 | No | BRAKE | General Bay | Yes | Yes |
| TIR-02 | Wheel Alignment | Tires | 60 | No | ALIGNMENT | Alignment Bay | No | No |
| TIR-03 | Tire Install & Balance | Tires | 60 | No | TIRE | Tire Bay | Yes | No |
| ENG-01 | Engine Diagnostic | Diagnostics | 90 | No | DIAG | Diagnostic Bay | No | No |
| ENG-02 | Major Tune-Up | Engine | 180 | No | ENGINE | General Bay | Yes | Yes |
| ELE-01 | Electrical Diagnostic | Electrical | 90 | No | ELECTRICAL | Diagnostic Bay | No | No |
| COL-01 | Cooling System Service | Cooling | 90 | No | GENERAL | General Bay | Yes | Yes |
| SUSP-01 | Suspension Inspection | Suspension | 45 | No | SUSPENSION | General Bay | No | No |
| SUSP-02 | Shock / Strut Replacement | Suspension | 180 | No | SUSPENSION | General Bay | Yes | Yes |
| TRANS-01 | Transmission Diagnostic | Transmission | 120 | No | TRANSMISSION | Diagnostic Bay | No | Yes |
| INSP-01 | Pre-Purchase Inspection | Inspection | 75 | No | GENERAL | Inspection Bay | No | No |
| GEN-01 | General Diagnostic | Diagnostics | 60 | No | GENERAL | Diagnostic Bay | No | No |
| BEL-01 | Belt / Hose Replacement | Engine / Cooling | 60 | No | GENERAL | General Bay | Yes | No |
| SPK-01 | Spark Plug Replacement | Engine | 120 | No | ENGINE | General Bay | Yes | No |

---

## 3. Operational Notes by Family

### Quick Service
Examples:
- oil change
- tire rotation
- battery replace

Rules:
- short durations
- possible fast-track candidate
- must not delay protected appointments beyond policy threshold
- best served through dedicated capacity when possible

### Diagnostics
Examples:
- engine diagnostic
- electrical diagnostic
- general diagnostic

Rules:
- often create secondary work after inspection
- duration variance may be high
- should preserve advisor review before promising completion

### Complex Repair
Examples:
- suspension replacement
- transmission diagnostic
- major engine repair

Rules:
- specialist skill required
- often parts-dependent
- stronger pre-booking validation required
- more likely transport-eligible

### Inspection / Advisory Work
Examples:
- pre-purchase inspection
- brake inspection
- suspension inspection

Rules:
- may convert into approved repair scope
- should preserve original inspection result history
- may require customer approval before expanded work begins

---

## 4. How the Catalogue Drives System Logic

The service catalogue should directly influence:

- slot generation
- duration estimation
- technician filtering
- bay filtering
- quick-service eligibility
- parts prepositioning workflow
- transport eligibility defaults
- reporting by service family
- batching family for sequencing

If the service catalogue is weak, the scheduler will be weak.

---

## 5. Recommended Future Enhancements

Later versions may add:
- vehicle-class multipliers
- OEM / make-model duration variants
- customer-promised SLA defaults by service family
- inspection template attachments
- recurring maintenance intervals
- dependency bundles between service lines

---

## 6. Governance

Only managers and admins should be able to change:
- duration templates
- quick-service flags
- skill mappings
- bay mappings
- transport defaults

Every change must be versioned and auditable because these values directly affect fairness, ETA, and capacity.
