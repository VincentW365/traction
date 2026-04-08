# 02_Process_Flows.md

## Purpose

This document provides the first-pass process diagrams for the unified platform.

Use these flows before any UI or schema build.
If Claude proposes logic that contradicts these flows, it must explain why and submit a review request.

---

## 1. End-to-End Service Journey

```mermaid
flowchart LR
    subgraph Customer
        C1[Book appointment]
        C2[Walk-in arrival]
        C3[Receive notifications]
        C4[Pickup / transport]
    end

    subgraph FrontDesk["Front Desk / Service Advisor"]
        F1[Create or confirm booking]
        F2[Check-in]
        F3[Issue queue ticket]
        F4[Create / refine service order]
        F5[Close order / payment handoff]
    end

    subgraph Scheduler["Scheduling Engine (Core Brain)"]
        S1[Validate slot]
        S2[Build active visit]
        S3[Compute eligibility]
        S4[Rank queue dynamically]
        S5[Estimate start / completion]
        S6[Assign technician / bay candidates]
    end

    subgraph Ops["Service Operations"]
        O1[Technician assignment]
        O2[Service execution]
        O3[Pause / waiting parts]
        O4[Quality check]
        O5[Ready for pickup]
    end

    subgraph Parts["Parts & Logistics"]
        P1[Reserve parts]
        P2[Transfer / procure]
        P3[Mark parts ready]
    end

    subgraph Transport["Transport"]
        T1[Schedule drop-off]
        T2[Schedule pickup]
        T3[Assign driver]
    end

    C1 --> F1 --> S1
    C2 --> F2
    S1 --> C3
    F2 --> F3 --> S2 --> S3 --> S4 --> S5 --> S6
    S6 --> F4 --> O1 --> O2
    O2 --> O3
    O3 --> P1 --> P2 --> P3 --> S4
    O2 --> O4 --> O5 --> F5 --> C4
    S5 --> C3
    O5 --> T2 --> T3 --> C4
    F4 --> T1 --> T3
```

Source file: `diagrams/01_service_journey.mmd`

---

## 2. Queue Priority and Eligibility Flow

```mermaid
flowchart TD
    A[Customer checked in] --> B{Has appointment?}
    B -- No --> W1[Classify as walk-in]
    B -- Yes --> C{Arrival time vs appointment}
    C -- More than 30 min early --> E1[Temporary walk-in class]
    C -- 30 min early to 15 min late --> E2[Protected appointment]
    C -- 16 to 30 min late --> E3[Late-soft appointment]
    C -- More than 30 min late --> E4[Missed appointment / reschedule or convert]

    W1 --> P{Mandatory parts ready?}
    E1 --> P
    E2 --> P
    E3 --> P

    P -- No --> B1[Blocked by parts]
    P -- Yes --> T{Qualified tech and bay available?}
    T -- No --> B2[Blocked by skill or bay]
    T -- Yes --> Q{Quick-service fast-track eligible?}
    Q -- Yes --> F1[Insert into quick lane if no protected delay breach]
    Q -- No --> R1[Compute weighted rank]

    R1 --> G{Batching opportunity?}
    G -- Yes --> R2[Apply batching bonus]
    G -- No --> R3[Keep standard score]

    F1 --> Z[Persist queue decision snapshot]
    R2 --> Z
    R3 --> Z
    B1 --> Z
    B2 --> Z
```

Source file: `diagrams/02_queue_priority_logic.mmd`

### Flow notes
- Check-in is the activation trigger for queue participation.
- Appointment timing determines protection class.
- Parts and resource constraints can block otherwise valid visits.
- Quick-service insertion is conditional, not automatic.
- Every ranking decision should be explainable.

---

## 3. Parts Reservation and Transfer Flow

```mermaid
flowchart LR
    A[Appointment or approved repair scope] --> B[Create parts request]
    B --> C{All critical parts on site?}
    C -- Yes --> D[Reserve / stage parts]
    C -- No --> E[Create transfer or procurement task]
    E --> F[Track ETA and exceptions]
    F --> G{Received before service?}
    G -- Yes --> D
    G -- No --> H[Job remains BLOCKED_PARTS]
    D --> I[Mark parts ready]
    I --> J[Scheduler can rank visit as eligible]
```

Source file: `diagrams/03_parts_logistics_flow.mmd`

### Flow notes
- Parts readiness must be visible before the day is lost.
- Next-day appointments should be reviewed by a cutoff.
- Jobs blocked by parts remain visible to staff, not hidden.

---

## 4. Transport Coordination Flow

```mermaid
flowchart TD
    A[Eligible service identified] --> B[Offer transport options]
    B --> C{Customer accepts?}
    C -- No --> X[No transport workflow]
    C -- Yes --> D[Capture drop-off / pickup preferences]
    D --> E[Create transport request]
    E --> F{Capacity available?}
    F -- No --> G[Waitlist or manager decision]
    F -- Yes --> H[Assign driver and time window]
    H --> I[Execute drop-off leg]
    I --> J[Service in progress]
    J --> K{ETA <= 30 min or ready for pickup?}
    K -- No --> J
    K -- Yes --> L[Trigger pickup coordination]
    L --> M[Confirm customer window]
    M --> N[Assign pickup driver]
    N --> O[Complete pickup leg]
```

Source file: `diagrams/04_transport_flow.mmd`

### Flow notes
- Transport is governed by eligibility and capacity.
- Customer confirmation must exist before final driver assignment.
- Pickup orchestration should start before actual completion, using ETA.

---

## 5. Scheduler State Machine

```mermaid
stateDiagram-v2
    [*] --> PendingCheckIn
    PendingCheckIn --> CheckedIn : check_in
    CheckedIn --> BlockedParts : parts_missing
    CheckedIn --> BlockedSkill : no_tech_or_bay
    CheckedIn --> Ranked : scheduler_ranked
    BlockedParts --> Ranked : parts_ready
    BlockedSkill --> Ranked : qualified_resource_available
    Ranked --> Called : technician_or_bay_ready
    Called --> InService : service_start
    InService --> WaitingParts : parts_shortage_discovered
    WaitingParts --> InService : parts_arrive
    InService --> QC : technician_complete
    QC --> ReadyForPickup : qc_pass
    ReadyForPickup --> Closed : paid_and_released
    CheckedIn --> Abandoned : customer_leaves
    Ranked --> Abandoned : customer_leaves
    PendingCheckIn --> Cancelled : cancel
    CheckedIn --> Cancelled : cancel_before_service
    Closed --> [*]
    Cancelled --> [*]
    Abandoned --> [*]
```

Source file: `diagrams/06_scheduler_state_machine.mmd`

### State design notes
- `BlockedParts` and `BlockedSkill` are explicit states, not vague notes.
- `Ranked` is separate from `Called` so the board can show waiting vs ready.
- `WaitingParts` during service must preserve actual operational delay data.

---

## 6. Process Design Rules

1. Every process must have a clear system trigger.
2. Every handoff should produce a state change or timestamp.
3. Failure states must be modeled explicitly.
4. Customer-facing status must come from real operational state, not manual guesswork.
5. Manager intervention must be visible in process history.

---

## 7. Diagram Governance

When updating a flow:
- update the diagram file
- update the related rules
- update any impacted entity statuses
- check if tests or UX states also change

No flow changes should happen in isolation.
