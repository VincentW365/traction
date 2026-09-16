# Customer Booking — deployment UAT checklist

For the owner to run **after** a deploy, **on a phone using mobile data with Wi-Fi
turned off** (CR-2026-108 §13). Localhost or LAN success does not count: the whole
point is to prove a customer standing anywhere can complete a booking.

Do not mark external-access acceptance as passed until section C is done on a real
device off the Bert's network.

---

## A. Before you start — make it a TEST booking

So the confirmation is captured instead of being sent to anyone.

1. Sign in as Manager → **Setup → Deployment** and confirm:
   - `NOTIFICATION_MODE` reads **LIVE** (it must NOT be TEST in production —
     `deploy:check` now fails the deploy if it is).
   - Required forms: Job Sheet / Pre-Job Inspection / Vehicle Inspection all PASS.
2. Have an administrator create a **test run** and tag the customer + vehicle you
   will book with. Any booking whose customer, vehicle or visit belongs to a test
   run has its messages **captured, never transmitted**.
3. Note the test run label — you will filter by it in section D.

> If you book as a brand-new customer with a real phone number, that is a GENUINE
> record and the confirmation **will** be sent. That is deliberate.

---

## B. The booking itself (phone, mobile data, Wi-Fi OFF)

| # | Step | Pass |
| --- | --- | --- |
| B1 | The public booking page opens at the public URL | ☐ |
| B2 | The browser shows a valid padlock — **https**, no certificate warning | ☐ |
| B3 | No address anywhere on the page contains `localhost`, `10.`, `192.168.` or an internal host | ☐ |
| B4 | Identify with the test mobile + plate — it recognises you | ☐ |
| B5 | Your vehicle(s) are listed and selectable | ☐ |
| B6 | A service can be chosen | ☐ |
| B7 | **Next available** is shown prominently, with alternative times | ☐ |
| B8 | No start time later than the configured customer cutoff (15:00) is offered | ☐ |
| B9 | Booking completes and shows a reference (`BK-…`) | ☐ |
| B10 | Confirmation shows vehicle, service, date, time, duration, cancellation/reschedule rules and a manage link | ☐ |
| B11 | The whole flow worked with **no VPN and no LAN access** | ☐ |

## C. Manage the booking (same phone, still on mobile data)

| # | Step | Pass |
| --- | --- | --- |
| C1 | The manage link from the confirmation opens | ☐ |
| C2 | It did **not** ask you to create an account or set a password | ☐ |
| C3 | Reschedule to another offered time works | ☐ |
| C4 | The new time is reflected when the link is reopened | ☐ |
| C5 | Cancel works | ☐ |
| C6 | After cancelling, the booking shows as cancelled | ☐ |

## D. Notifications — confirm nothing reached a real person

| # | Step | Pass |
| --- | --- | --- |
| D1 | As Manager, open the captured-notifications view filtered by your test run label | ☐ |
| D2 | The confirmation appears there with full subject and body | ☐ |
| D3 | It shows the address it **would** have gone to, and is marked CAPTURED | ☐ |
| D4 | No message arrived at the test mailbox or phone | ☐ |
| D5 | The reschedule and cancellation messages were also captured | ☐ |

> API for D1 while the admin screen is pending (Stage 3):
> `GET /api/v1/notifications/captured?runLabel=<your-run-label>` as a Manager.

## E. Staff side — the booking behaves like any other appointment

| # | Step | Pass |
| --- | --- | --- |
| E1 | The booking appears on the staff appointments/schedule view | ☐ |
| E2 | It is distinguishable as self-service but needs no special handling | ☐ |
| E3 | Check-in works and produces a ServiceVisit | ☐ |
| E4 | The visit reaches the queue normally | ☐ |
| E5 | The vehicle shows an ETA | ☐ |
| E6 | It appears in the customer's and the vehicle's history | ☐ |
| E7 | It is counted in the Appointments report under self-service | ☐ |

## F. Clean up

| # | Step | Pass |
| --- | --- | --- |
| F1 | Remove the test run (its records are tagged and removable together) | ☐ |
| F2 | Confirm the Appointments report no longer counts the test booking | ☐ |

---

## What to report back

For anything that fails, note the step number, what you saw, and the booking
reference. Sections B2, B3 and B11 are the ones that cannot be verified from
inside the building — they are the reason this checklist exists.
