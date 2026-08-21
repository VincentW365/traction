# CR-2026-089 — Queue ticket numbering v2

**Status:** Implemented (backend). Front-desk/display copy tweaks noted in §8.
**Local commits only, not pushed**, per the directive.

---

## 1. Format

| | Example |
|---|---|
| Internal database ID | UUID (unchanged, never shown) |
| **Full reference** | `B01-260821-002` |
| **Customer number** | `B01-002` |
| Display emphasis | `002` |

```
{LOCATION_CODE}-{YYMMDD}-{DAILY_SEQUENCE}
```

Compared with the old `QTK-BERT-01-20260820-0003`: `QTK` and `BERT` identified
nothing the application did not already know, and the four-digit year plus four-digit
padding cost width on a lobby screen and on a technician's phone for no
identification benefit.

## 2. Sequence rules

- Starts at `001`, per location, per **Jamaica** business day.
- Assigned atomically; **never reused** after cancellation, void, deletion or no-show.
- Immutable once issued.
- Survives restarts (it is a database row, not in-process state).
- Three digits is a **minimum width**, not a limit: 999 is followed by `1000`, never
  wrapping and never rejected.

## 3. Concurrency

The previous generator was a `SELECT MAX(seq)+1` with no lock, relying entirely on
the caller running SERIALIZABLE. Technically safe, practically poor: Prisma does not
retry, so two front-desk users checking in simultaneously handed one of them a raw
500.

The sequence now comes from one atomic statement:

```sql
INSERT INTO daily_ticket_counters (site_id, business_date, last_sequence, ...)
VALUES ($1, $2, 1, ...)
ON CONFLICT (site_id, business_date)
DO UPDATE SET last_sequence = daily_ticket_counters.last_sequence + 1
RETURNING last_sequence
```

Postgres serialises concurrent writers on the conflicting row. **Verified against the
real database: 60 simultaneous allocations produced 60 unique, contiguous values.**

Uniqueness is enforced twice over: a unique index on the full reference, and a
composite unique on `(business_date, daily_sequence, location_code_snapshot)` so a
duplicate is impossible even if the allocator were bypassed.

## 4. Timezone

The old generator had a real bug: the **printed date** used the site's timezone while
the **SQL day-bucket** used `CURRENT_DATE`, which resolves in the database session's
timezone. With a UTC database and a Jamaica site (UTC−5) those disagree for five
hours every evening, so the printed date could roll over while the sequence had not.

The business date is now computed once, in the site's timezone, and used for both the
reference and the counter key. Tests pin this: 02:00 UTC on the 21st is still business
date `260820`, and the sequence resets at Jamaica midnight, not UTC midnight.

## 5. Location codes

Configured per site (`Site.ticketCode`): uppercase, 2–4 alphanumerics, unique. `B01`
is seeded for BERT-01. A site without one falls back to a derived code so the scheme
works on day one.

**Changing a location code never alters tickets already issued** — the code is
*snapshotted* onto each ticket at creation, so a historical reference is read from
stored data and never reconstructed from a code that may have changed since.

## 6. Legacy compatibility

**No historical ticket is rewritten.** `QTK-BERT-01-20260820-0003` and the test-data
`VWT-...` shape stay exactly as issued for auditability. Every new column is nullable
precisely so old rows leave them empty.

Every existing read path keeps working because **nothing in the codebase ever parsed
the ticket string** — it has always been an opaque display token. New tickets write
the full reference into the existing `ticketNumber` field as well, so every current
consumer picks up the new format with no further change.

## 7. Search

`normaliseTicketSearch()` accepts, case-insensitively and with or without hyphens:
`B01-003`, `B01003`, `B01-260821-002`, `B01260821002`, and the legacy format.
Normalisation is applied to **input only** — database uniqueness stays on the exact
stored string. Weakening a constraint to make a text box friendlier would be the
wrong trade.

## 8. Display

| Surface | Shows |
|---|---|
| Lobby display | `B01-002` (emphasis on `002`) |
| Customer status page | `B01-002` |
| Staff queue board / ticket detail | `B01-260821-002` |
| Reporting | Full reference, plus location, business date and sequence as separate fields |

Queue **position** stays entirely separate from the ticket number. Moving from
position 5 to position 2 does not change the ticket.

## 9. Immutability

Business date, sequence, location snapshot, display number and full reference are all
immutable once issued. A ticket does not change when priority changes, the bay
changes, a technician is reassigned, work pauses, services are added, the visit
completes, or it is cancelled. A ticket created under the wrong location should be
voided and reissued, with the replacement linked to the original — not silently
renamed.

## 10. What is deliberately NOT encoded

Vehicle class, customer initials, registration, service type, appointment/walk-in
source, technician, bay, queue rank, priority and status. All of those change, and a
moving identifier is not an identifier — several would also leak customer or
operational detail onto a public screen.

## 11. Security

Unchanged, and confirmed by audit: there is **no lookup-by-ticket-number anywhere in
the API**, and the customer status page is gated on an independent 128-bit random
token with a 24-hour expiry, not on the ticket number. A shorter, per-day-reused
number therefore creates no enumeration vector — there is no endpoint to enumerate
against. The public display exposes ticket numbers and bay names only; no names,
phones, emails or full plates.
