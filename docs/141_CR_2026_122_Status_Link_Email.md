# CR-2026-122 — Email the customer their status link, from the status-link card

**Date:** 2026-10-16
**Status:** Implemented, verified locally, committed to `master`
**Requested by:** Product owner — "For the customer status link have the option to send an email to the customer from that area with the link in that section as well."

---

## A. Objective

Where staff see the Customer Status Link — the card on the queue ticket, and the check-in confirmation — give them a button that emails that link to the customer, with the link in the email.

## B. Inputs used

`docs/96`-era composer (CR-2026-096), `docs/121` §C4 (one public URL), `docs/131` (email only), `docs/132`/`133` (purpose-based consent), `docs/136`/`140` (live routing), CLAUDE.md §9–§11.

## C. Design

Not a new send path. The link goes out through the **shared customer-notification composer**, so it is routed (live / test), consent-classified, logged in `NotificationLog`, audited, idempotent on double-click, and refuses a customer with no email on file with the same operational sentence every other email uses. The front desk reviews the wording before it leaves.

| Piece | Change |
|---|---|
| `NotificationReason` | new value `STATUS_LINK` (additive enum; migration `20261016170000_cr_2026_122_status_link_email`) |
| Template | `STATUS_LINK_EMAIL` in `default-templates.ts` — purpose TRANSACTIONAL (operational: about this customer's own visit; never gated on the optional-email preference), seeded create-if-missing by the API, manager-editable under Setup → Notifications |
| Placeholders | `{{statusUrl}}`, `{{statusLinkExpires}}` — filled from the visit's token and `tokenExpiresAt` (site timezone), never typed; `publicUrl()` builds the absolute link from `PUBLIC_APP_URL` as every customer link does |
| Guard | `assertStatusLink` on **compose and send**: refused when the request has no visit, or the visit has no token, or the token is past its 24-hour window. The renderer drops a missing-value line, so without the guard an expired link would produce a polite, link-less email. |
| Web | "Email to Customer" button in the status-link card on `queue/[id]` (withdrawn when the link is expired) and on the check-in confirmation panel; both open the composer with `reason: 'STATUS_LINK'`. "Status Link" added to the composer's visit template choices and to the two reason-label maps (communication history, Setup → Notifications). |
| Manual | "Give a customer their live status link" task rewritten; PDF rebuilt |

## D. Assumptions

- **A1.** The link's 24-hour life (CR-2026-085) is unchanged. Sending does not mint a fresh token; an expired link is refused rather than renewed. Renewal would be its own change to the token lifecycle.
- **A2.** The email prints the short customer number (`displayTicketNumber`, CR-2026-089) when the ticket has one, falling back to the long reference. This also corrects every other queue email, which had been printing the long reference.

## E. Verification (local, 2026-10-16)

- API and web typecheck clean; notifications specs 14 files / 182 tests pass, including six new cases (link and expiry in the draft; refused when expired, absent, or without a visit; refused on send so a stale draft cannot be forced; other reasons untouched).
- Live: `POST /notifications/compose` with `STATUS_LINK` → 201, draft contains `/status/<token>`, ticket number, expiry ("works until Saturday 11:08 AM"), `purpose: TRANSACTIONAL`, `consent.allowed: true`. With the token expired → 400 with the front-desk sentence. `GET /notifications/templates` lists 12 email templates including `STATUS_LINK_EMAIL`.
- The link in a local draft is `http://localhost:3000/...` because `PUBLIC_APP_URL` is unset on this machine; on Render it is the public address (docs/140 §G).

## F. Approval gate

Additive enum value on `NotificationLog.reason` and one new template; no change to routing, consent, audit or queue rules. Recorded here; no gate in `docs/21` is crossed.
