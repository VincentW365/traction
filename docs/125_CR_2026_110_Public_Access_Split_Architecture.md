# CR-2026-110 — Split-access architecture: public customer routes, internal operations

**STATUS: NOT STARTED — recorded on 2026-09-18 for later execution.**
Do not begin work on this without an explicit instruction to start.

The deployed web application currently works correctly only while connected to
Bert's company network. That is acceptable for internal operational
functionality. It is **not** acceptable for customer-facing booking and customer
notification links.

The target is:

> **Customer functions: internet-accessible and secure**
> **Operational functions: authenticated / internal**

and explicitly **not** "make the entire application public".

---

## Requirements, as given

### 1. Public customer routes

Securely accessible over the public internet:

- `/book`
- booking confirmation / manage-booking page
- reschedule flow
- cancellation flow
- customer-facing ETA/status page where applicable
- any customer-facing link sent through SMS or email

These must work from a normal customer device without Bert's Wi-Fi, company LAN,
VPN, internal DNS or private-IP access. HTTPS only.

### 2. Internal operational routes

Do not make the whole application anonymously public to make `/book` reachable.
These stay behind authentication and existing permissions:

Dispatch Board · Technician Workspace · customer database · appointments
administration · inspections · job sheets · reporting · Setup/Settings ·
Resources & Bays · Booking Simulator · UAT/test tooling · notification
administration · other manager/admin pages.

Where the deployment allows it, company-network/VPN restrictions may remain as an
*additional* protection. Authentication and authorization remain mandatory
regardless.

### 3. Public API boundary

Audit every endpoint the public booking flow uses. Only the minimum needed for
customer functionality may be anonymously reachable — public service catalogue,
public availability, customer identification/registration, booking confirmation,
manage-token validation, cancellation, rescheduling, applicable customer
ETA/status lookups.

Do not expose internal administration APIs merely because the API server becomes
internet-accessible. Maintain explicit public-versus-authenticated boundaries.

### 4. Public URL configuration

One canonical public base URL. All customer links generated from it. Never
generate a customer-facing link containing `localhost`, `127.0.0.1`,
`192.168.x.x`, `10.x.x.x`, an internal machine name or a Bert's-only DNS name.

Example: `https://service.bertsautoparts.com/book`, or the approved deployed
equivalent. Email and SMS manage links use the same external base URL.

### 5. Web/API deployment

If frontend and API deploy separately, verify: both publicly reachable where
required; HTTPS enabled; CORS allows only the intended frontend origin(s);
credentials/cookies configured correctly; **no wildcard credentialed CORS**; API
secrets never exposed to the frontend; public endpoints rate-limited and
validated.

Do not solve this by opening firewall ports on an employee workstation. Use the
production hosting / reverse-proxy configuration.

### 6. Cookie / session behaviour

The existing UAT and customer booking cookie behaviour must work on the deployed
domains. Review Secure, HttpOnly, SameSite, Domain, Path, expiry.

If frontend and API share a custom parent domain, prefer a configuration that
permits appropriate **Lax** same-site behaviour. If deployment uses separate
public-suffix domains, retain only the cross-site configuration genuinely
required. **Do not weaken all application cookies to make one public flow work.**

### 7. Security controls

Public availability must not weaken existing customer privacy protections.
Continue to prevent customer enumeration, partial-match probing, exposure of
customer details, unauthorized access to appointment information, manage-token
guessing and unrestricted admin API access.

Retain hashed manage tokens, token expiry, booking concurrency protection,
normalized identity matching, rate limiting where supported, and audit logging.

### 8. Public/customer and internal navigation

A public customer must not see links into internal operational areas. Customer
pages use a clean customer-facing layout rather than exposing admin navigation.
Internal staff continue to access the authenticated application normally.

### 9. Notification links

Audit every notification template that generates a link — at minimum booking
confirmation, booking management, rescheduling, cancellation, vehicle
pickup/status, and ETA/status links.

All externally intended links use the public HTTPS base URL. No notification may
rely on the recipient being connected to Bert's network.

### 10. Deployment health checks

Detect and **fail production deployment** for: missing production public base
URL; base URL set to localhost; private/internal IP configured as the production
customer URL; HTTP where HTTPS is required; incompatible frontend/API origin
configuration.

Fail rather than silently generating unusable links.

### 11. External UAT

After deployment, a real-device checklist run **from a phone on mobile data with
Wi-Fi disabled**. It cannot be accepted from localhost or the company LAN.

1. `/book` loads
2. service selection loads
3. availability loads
4. a UAT booking can be completed
5. SMS/email confirmation received, or safely captured per UAT mode
6. the manage link opens externally
7. rescheduling works
8. cancellation works
9. ETA/status page works if applicable
10. no internal URL appears
11. HTTPS certificate is valid
12. no VPN required

Do not mark external customer access complete until this passes.

### 12. Keep LAN access for internal users

This does not mean the internal system stops working on Bert's network. Staff
continue to access operational pages normally.

---

## Acceptance criteria

- `/book` works from outside Bert's network
- customer manage links work from outside Bert's network
- required public APIs work externally
- admin/internal pages remain protected
- notifications contain external HTTPS links
- no customer-facing link contains an internal address
- deployment checks validate public URL configuration
- mobile-data UAT passes
- existing booking/queue/dispatch functionality is not regressed

---

## Starting points (from earlier work — verify, do not assume)

Recorded so the CR does not begin by rediscovering what already exists. **None of
this has been re-checked against the requirements above**; treat every line as a
lead to confirm, not as a completed item.

| Area | What is believed to exist | Where |
| --- | --- | --- |
| §4 canonical public URL | `PUBLIC_APP_URL` is the single source for customer links | CR-2026-106; `docs/DEPLOYMENT_HANDOFF.md` owner step 1 |
| §10 deployment checks | `deploy:check` is documented as FAILING in production when `PUBLIC_APP_URL` is missing, not https, or an internal host; Admin → Deployment shows the verdict | `scripts/deploy-check.mjs`, docs/121 |
| §3 public API boundary | Customer endpoints already live under `/public/booking/*`; admin under permission-gated controllers | `apps/api/src/modules/public-booking/` |
| §6 cookies | UAT session cookie work, including Public Suffix List handling for `onrender.com` and a `UAT_COOKIE_CROSS_SITE` opt-in, was done in CR-2026-108 Stage 3; default is Lax | `apps/api/src/modules/booking-simulator/uat-session.ts`, docs/122 §D |
| §7 privacy | Hashed manage tokens, single-use redemption via audit log, advisory-locked confirm, rate limiting | CR-2026-105c / 106; docs/120, docs/121 |
| §11 external UAT | A real-device checklist already exists and explicitly requires mobile data with Wi-Fi off | `docs/123_Booking_UAT_Checklist.md` |
| §1 customer layout | `/book` and `/status` sit outside the `(dashboard)` layout, so they do not render admin navigation | `apps/web/app/book/`, `apps/web/app/status/` |

Known gap found while testing on 2026-09-18: `PUBLIC_APP_URL` is unset in the
development environment, so the server cannot build customer links there. The UAT
launch link now falls back to the browser's own origin for local testing
(CR-2026-108, commit `02823b9`) — that fallback is **for the manager's own
browser only** and is not a substitute for setting `PUBLIC_APP_URL` on the
deployment.

The likely shape of the real work is therefore deployment and configuration
verification plus boundary auditing, rather than large application changes. That
is a hypothesis to test at the start of the CR, not a scope commitment.
