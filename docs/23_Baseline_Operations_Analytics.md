# 23 — Service Centre Baseline Operations Analytics

> Generated from `jobs.csv` (9,055 jobs, **2023-10-25 → 2026-06-09**). Source: SharePoint "Service Center: Job Sheet" via REST extract. Customer identity is locked on the source, so customers are counted by anonymous `CustomerNo` id. Re-run: `node scripts/sharepoint/analyze-jobs.mjs`.

## Headline

- **9,055 jobs** over **33 months** (~**274** jobs/month).
- **Completion rate: 98.4%** (8,914 completed); cancellation **0.9%** (84).
- **3,728 distinct customers**; 1,056 jobs (11.7%) had no customer link.
- **Rework (rectify) rate: 0.3%** (30 jobs); **pauses: 17.3%** (1564 jobs).

## Job status

| Status | Jobs | Share |
| --- | ---: | ---: |
| Completed | 8,914 | 98.4% |
| Cancelled | 84 | 0.9% |
| Not Started | 34 | 0.4% |
| In-Progress | 14 | 0.2% |
| Pause | 9 | 0.1% |

## Monthly volume trend

```
2023-10     3  
2023-11   150  ████████████
2023-12   304  █████████████████████████
2024-01   279  ███████████████████████
2024-02   249  ████████████████████
2024-03   276  ███████████████████████
2024-04   260  █████████████████████
2024-05   308  █████████████████████████
2024-06   268  ██████████████████████
2024-07   260  █████████████████████
2024-08   301  █████████████████████████
2024-09   293  ████████████████████████
2024-10   304  █████████████████████████
2024-11   286  ███████████████████████
2024-12   302  █████████████████████████
2025-01   325  ███████████████████████████
2025-02   292  ████████████████████████
2025-03   320  ██████████████████████████
2025-04   320  ██████████████████████████
2025-05   341  ████████████████████████████
2025-06   306  █████████████████████████
2025-07   315  ██████████████████████████
2025-08   275  ███████████████████████
2025-09   299  █████████████████████████
2025-10   266  ██████████████████████
2025-11   289  ████████████████████████
2025-12   308  █████████████████████████
2026-01   316  ██████████████████████████
2026-02   255  █████████████████████
2026-03   321  ██████████████████████████
2026-04   288  ████████████████████████
2026-05   291  ████████████████████████
2026-06    85  ███████
```

## Service mix (keyword scan of Service Detail / Comment)

_A job can fall in more than one category; uncategorized = free-text with no keyword match._

| Category | Jobs | Share of all jobs |
| --- | ---: | ---: |
| Brakes | 1,469 | 16.2% |
| Shocks / suspension | 1,351 | 14.9% |
| Filters | 887 | 9.8% |
| Oil change / service | 693 | 7.7% |
| Steering / driveline | 619 | 6.8% |
| Cleaning / wash | 432 | 4.8% |
| Cooling / radiator | 257 | 2.8% |
| Belts | 234 | 2.6% |
| Alignment | 229 | 2.5% |
| Tyres / wheels | 207 | 2.3% |
| Transmission | 200 | 2.2% |
| Battery / electrical | 190 | 2.1% |
| _Uncategorized text_ | 4,376 | 48.3% |

## Oil type

| Oil type | Jobs | Share |
| --- | ---: | ---: |
| Not Servicing | 4,417 | 48.8% |
| Regular Oil | 2,308 | 25.5% |
| Liqui Moly | 2,289 | 25.3% |
| Amsoil | 41 | 0.5% |

Oil/lube performed on **4,638** jobs (51.2%); the rest are "Not Servicing".

## Technician workload

13 technicians appear; 1,076 jobs (11.9%) had 2+ technicians; 0 jobs (0.0%) had none/T.B.A.

| Technician | Jobs worked | |
| --- | ---: | --- |
| O.Josephs | 2,014 | ████████████████████ |
| M.Walker | 1,947 | ███████████████████ |
| O.Hamilton | 1,821 | ██████████████████ |
| K.Thomas | 1,524 | ███████████████ |
| D.Willis | 1,340 | █████████████ |
| J.Walters | 625 | ██████ |
| D.Dennis | 291 | ███ |
| T.B.A | 202 | ██ |
| D.Hibbert | 163 | ██ |
| W.Taylor | 88 | █ |
| C.Johnson | 76 | █ |
| T.Lewis | 75 | █ |
| R.Walker | 59 | █ |

## Repeat-customer distribution

| Jobs per customer | Customers |
| --- | ---: |
| 1 job | 2,038 |
| 2–5 | 1,453 |
| 6–10 | 214 |
| 11–20 | 23 |
| 21+ | 0 |

**Top customers by job volume (anonymous ids):**

| CustomerNo | Jobs |
| --- | ---: |
| #9013 | 17 |
| #7065 | 15 |
| #9693 | 14 |
| #7874 | 14 |
| #9708 | 13 |
| #9728 | 13 |
| #8233 | 13 |
| #10400 | 13 |
| #8723 | 12 |
| #5789 | 12 |

## Intake by day of week (job created)

```
Sun      1  
Mon   1439  ███████████████████████
Tue   1451  ███████████████████████
Wed   1420  ███████████████████████
Thu   1451  ███████████████████████
Fri   1533  ████████████████████████
Sat   1760  ████████████████████████████
```

## Process & data-quality notes

- **Pause/resume** is actively used (1564 pauses, 1386 resumes) — confirms the job state machine needs a first-class pause/resume concept.
- **Rework** (`RectifyStartTime`) on 30 jobs — low but real; the lifecycle needs a rectify/rework path.
- **Mileage** is unreliable: 54 of 5,953 non-zero readings exceed 400,000 — likely unit confusion or data entry. Treat current odometer values with caution.
- **Customer identity** absent (source list access-denied); names/models can be backfilled later (see docs/22).
