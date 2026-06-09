# 22 — SharePoint Data Extraction (self-serve)

**Status:** Job data extracted ✅ · customer identity blocked ⛔ (see Outcome)
**Owner:** Vincent Wilson (Web Developer) — has SharePoint site access; **cannot delegate the export to anyone**, so the data must be extracted using his own access.
**Date:** 2026-06-09

---

## Outcome (2026-06-09)

`owssvr`/Export-to-Excel is **disabled** on this tenant; **Export to CSV** blanks lookups. The working path was the **modern REST API in the signed-in browser** (returns Atom XML), pulled in Id-range slices to beat the 5,000-row cap, then flattened by `scripts/sharepoint/json-to-csv.mjs`.

- **Site:** `bertsautopartslimited.sharepoint.com/sites/BertsAutoCentralLogs`
- **Job Sheet list:** `97cd716b-59f4-47cc-87d0-8e035fa683e8` — **readable**. Pulled **9,055 / 9,068 rows** → `jobs.csv` (raw `jobs*.xml` git-ignored).
- **Customer/vehicle master:** lookup `CustomerNo.` → list **`3340b46c-ada3-4a31-92df-067773625206`** (~3,728 distinct customers). **ACCESS DENIED** to this account via direct read *and* lookup `$expand`. So customer **names** and vehicle **models** are unavailable; jobs are keyed by anonymous `CustomerNo` id. (The 55-row "Wholesale Customer Database" `bbf3316b` is unrelated — a red herring.)
- **Field map** (job sheet internal → meaning): `field_3`=Oil Type, `field_6`=Assigned To (multi), `field_13`=Comment, `field_20/21/22/23`=Bulbs&Plugs/Services/R-R Front/R-R Back, `BRAKES0`=BRAKES, `Radiator`, `CurrentMileage`, `Next Service Mileage`, `ServiceDetail(s)`, `JobStart/Pause/Resume/End/Cancel`, `Status`, `RectifyStartTime/EndTime`, `End Time`/`EndTime2`, `CustomerNo.Id`=customer link.

**To unblock names later:** grant this account Read on list `3340b46c` (then re-pull with `$expand=CustomerNo_x002e_&$select=...CustomerNo_x002e_/field_1,CustomerNo_x002e_/field_5`), or have an account that already has access pull it.
**Related:** DMAIC §"Things to Get Done Before Development Begins" (item 5 — *Obtain sample data from SharePoint*); `docs/00_Assumptions_Open_Questions.md`

---

## Why this request exists

The first SharePoint export we received — `Service Center_ Job Sheet.csv` (9,053 rows, Oct 2023 → Jun 2026) — is useful but **does not contain customer or vehicle identity.** The three lookup columns that should carry it exported completely empty:

| Column | Rows filled |
| --- | --- |
| `Customer ID` | 0 / 9,053 |
| `Customer ID: Model` | 0 / 9,053 |
| `Customer ID: Customer Name` | 0 / 9,053 |

This is a known SharePoint behaviour: **lookup columns serialise as blank** when a list is exported to CSV. The data exists in SharePoint; it just didn't come across in this export. As a result we cannot import real customers/vehicles yet, and the mileage/service history in the file is "orphaned" (no vehicle to attach it to).

## What we *were* able to use from the current export

So this isn't a total blocker — the following has already been incorporated:

- **Real technician roster (12 techs)** — now seeded.
- **Oil-type values actually in use** — `Regular Oil`, `Liqui Moly`, `Amsoil` (plus "Not Servicing" = non-service job). Intake dropdown aligned.
- **Confirmation of the real job lifecycle** — `Not Started → In-Progress → (Pause) → Completed / Cancelled`, with `Rectify` (rework). This is being reconciled against our service-order state machine.

---

## How to extract it ourselves (no one else required)

We have site access; the only problem is the export *format*. The identity data is in SharePoint — these methods retrieve it using nothing but our own login. Listed fastest-first; stop at the first one that works.

### Method 1 — Export to Excel (not CSV) — try first

In the list command bar: **Export → Export to Excel**. This downloads a refreshable query that pulls the **rendered** list (lookup display values included), unlike "Export to CSV". Open the `.xlsx` → **Save As → CSV**. Because the three lookup columns already exist in the list, this usually populates them immediately.

### Method 2 — SharePoint REST API in the authenticated browser (no code, no admin)

We're already logged in, so the browser session authorises these calls.

1. **Find internal field names:**
   ```
   https://<tenant>.sharepoint.com/sites/<site>/_api/web/lists/getByTitle('Service Center Job Sheet')/fields?$select=Title,InternalName,TypeAsString&$filter=Hidden eq false
   ```
2. **Pull items with the lookup resolved via `$expand`:**
   ```
   https://<tenant>.sharepoint.com/sites/<site>/_api/web/lists/getByTitle('Service Center Job Sheet')/items?$top=5000&$select=Id,Current_Mileage,Oil_Type,<LookupField>/Title,<LookupField>/Model&$expand=<LookupField>
   ```
   Save the JSON/XML (pages via the `__next` link). `$expand` is what resolves the lookup the CSV exporter dropped.

### Method 3 — Export the underlying master list directly

`Customer ID` is a **lookup into another list** (the customer/vehicle register), where name/model are *normal* columns. Open that source list and export it — its CSV is not blank. Gets the clean customer/vehicle master in one shot.

### Method 4 — PnP PowerShell (repeatable / scriptable)

`Connect-PnPOnline -Url <site> -Interactive` (logs in as us), then `Get-PnPListItem` → `.FieldValues` returns lookups already resolved. Best for an ongoing sync. ⚠️ First interactive login may require admin consent to the PnP app in some tenants — if so, fall back to Methods 1–3 (own session only).

Fields we want per customer/vehicle (whatever exists):

| Entity | Fields needed |
| --- | --- |
| Customer | Name, phone number(s), email, any customer ID/reference |
| Vehicle | Make, model, year, **plate/registration**, colour, VIN (if held), **vehicle class** (sedan / SUV / truck / van) if recorded, owning customer reference |
| Link | The key that ties a Job Sheet row to its customer/vehicle (so history can be re-attached) |

> **Vehicle class** matters specifically: it drives the mobile-jack restriction (sedans only). If SharePoint doesn't record it, tell us — we'll derive it from make/model instead.

## Other data still needed (not in the export — collect from the shop / decide)

These don't live in the job sheet and can't be exported. They're small and can be defined directly with the shop, not requested from a system owner.

- **Technician skill matrix** — per technician, which service families they cover (lube, brakes, electrical, A/C, suspension/alignment, engine, diagnostics) + rough proficiency. Needed before skill-based scheduling is trustworthy; today all 12 are seeded with a baseline GENERAL+LUBE only.
- **Service-interval rules** (DMAIC open item: *"not currently done"*) — months and/or kilometres after a service that triggers a reminder; may differ by oil type (Regular Oil vs. Liqui Moly).
- **Power-wash status protocol** (DMAIC open item) — how staff mark the machine operational/down daily, so the cleaning-bay gate has a real signal.

---

## What happens once the data is extracted

1. Confirm the field mapping (SharePoint columns → BSOP `Customer` / `Vehicle` / `ServiceVisit`).
2. Run the one-time importer into the dev database.
3. Re-attach the historical mileage/service records from the Job Sheet to the now-identified vehicles.
4. Validate against a handful of known real records before any wider load.

---

## Notes

- SharePoint owner of record: Jhevel Mitchell (access already granted) — but extraction does **not** require their involvement; the methods above use our own access.
- Assumes **SharePoint Online** (Microsoft 365). If the site is on-prem SharePoint Server, Methods 1–3 still apply (REST API path is the same); only the PnP auth flow differs.
