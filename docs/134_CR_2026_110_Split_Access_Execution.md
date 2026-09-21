# CR-2026-110 — Split-access architecture: execution record

**Status:** Code and configuration work COMPLETE. Deployment + external UAT OUTSTANDING (owner).
**Date:** 2026-09-21
**Directive:** `docs/125_CR_2026_110_Public_Access_Split_Architecture.md` (recorded 2026-09-18, started on explicit instruction)

> Customer functions: internet-accessible and secure.
> Operational functions: authenticated / internal.
> Explicitly **not** "make the entire application public".

The directive predicted the real work would be "deployment and configuration
verification plus boundary auditing, rather than large application changes", and
offered that as a hypothesis to test. **The hypothesis held.** Two genuine holes
were found and closed; the rest was verification that produced evidence rather
than changes.

---

## 1. The public API boundary (§3) — audited, one hole closed

Every route in the API was enumerated with what stands in front of it. There is
no global guard and no `@Public` escape hatch: protection is per-controller
`@UseGuards(JwtAuthGuard, RbacGuard)`, so the audit is exact.

**284 routes. 268 authenticated. 16 anonymous.**

The 16, and why each is allowed to be:

| Route(s) | Why anonymous |
| --- | --- |
| `POST /auth/login`, `POST /auth/refresh` | You cannot authenticate to authenticate. |
| `POST /auth/dev-login`, `GET /auth/dev-login/profiles` | Double-gated in the service: `ALLOW_DEV_LOGIN === 'true'` **and** `NODE_ENV !== 'production'`. Unreachable in production even if the flag is set. Covered by `dev-login.spec.ts`. |
| `GET /health` | Deployment probe. |
| 9 × `/public/booking/*` | Exactly the customer surface §3 lists: site, services, availability, identify, confirm, manage-by-token, reschedule, cancel, UAT redeem. |
| `GET /display/:token` | Lobby screen, gated by an unguessable token from `display_board_token`. |
| `GET /status/:token` | Customer status page, gated by the per-visit status token. |

**The hole: `GET /service-types` and `GET /service-types/:code` were anonymous.**
They return the internal operational catalogue — required skill code, required
bay type, parts pre-positioning, overflow and light-slot eligibility, batching
family, stand/jack handling, durations. That is how the workshop is run. It
mattered little while the API was reachable only on Bert's network; it matters a
great deal the moment the API is on the public internet, which is the entire
point of this CR.

Every caller is an authenticated staff screen (service catalogue admin,
settings, staff detail, appointment wizard, check-in, visit detail, two reports).
The customer page uses its own narrower endpoint, `GET /public/booking/services`.
Both are now `QUEUE_VIEW` — held by every staff role, so no staff screen changed
behaviour.

Verified live against the built API:

```
GET /api/v1/health                   → 200   (public, intended)
GET /api/v1/service-types            → 401   (was 200 — closed)
GET /api/v1/public/booking/services  → 200   (customer flow unaffected)
```

## 2. CORS with credentials (§5) — hole closed, and now un-repeatable

The API sends `Access-Control-Allow-Credentials: true` and took its origin
straight from `API_CORS_ORIGIN` with no validation. `deploy:check` only asked
whether the variable was *set*.

So `API_CORS_ORIGIN=*` passed every check we had. It is also the first thing
anyone reaches for when a public page cannot talk to the API — and the directive
names it: **no wildcard credentialed CORS**. It does not even work (browsers
refuse a wildcard with credentials), which is what makes it dangerous: the
natural next step is reflecting whatever `Origin` arrives, and that hands every
site a signed-in staff member visits the ability to call this API as them.

Two changes, belt and braces:

- **The API refuses to boot** on a wildcard, an origin with a path, a
  non-absolute origin, plain `http` in production, or nothing at all — with a
  message naming the fix. A server that starts with an unusable CORS policy
  fails later, in someone's browser, as a symptom nobody traces back to this
  setting. Proven: starting with `API_CORS_ORIGIN=*` exits with
  *'contains "*" … List the exact web origin(s) instead'*.
- **`deploy:check` validates the value**, not its presence:

| `API_CORS_ORIGIN` | Production verdict |
| --- | --- |
| `*` | **FAIL** — wildcard cannot be used with credentials |
| unset | **FAIL** — no browser origin may call this API |
| `http://web.example.com` | **FAIL** — must be https in production |
| `https://web.example.com` | PASS — 1 origin |
| `https://a.example.com,https://b.example.com` | PASS — 2 origins |

14 unit tests cover the helper.

## 3. Verified, already correct — no change needed

| § | Requirement | Evidence |
| --- | --- | --- |
| §4 | One canonical public base URL | `publicUrl()` is the only builder; its five callers cover the booking link, both status URLs and the manage link. No customer link is built from the request host. |
| §9 | Notification links external | No notification template or seeded wording contains a literal URL; the manage link is passed in from `publicUrl()`. The two `window.location.origin` uses are the manager's own UAT launch link (documented fallback) and the customer's own browser showing their own manage link — neither is emailed. |
| §10 | Deployment fails on a bad public URL | Tested all four failure modes in production mode: unset → FAIL; `http://` → FAIL; `https://192.168.1.50` → FAIL; `https://localhost:3000` → FAIL; a real https host → PASS. |
| §6 | Cookies not weakened wholesale | There is no application auth cookie at all — the JWT travels in the `Authorization` header and refresh takes a body parameter. The only cookie is the UAT session: `httpOnly`, `secure` in production, `SameSite=Lax`, and `none` only when cross-site is genuinely required (CR-2026-108 §D). Nothing to relax, and nothing relaxed. |
| §7 | Privacy controls retained | Hashed manage tokens, single-use redemption, advisory-locked confirm, rate limiting and masked identity responses are untouched by this CR. |
| §8 | No internal navigation on customer pages | `/book`, `/status` and `/display` are siblings of `(dashboard)`, so they never render its chrome. No link from any of them points into `/queue`, `/dispatch`, `/admin`, `/reports`, `/customers`, `/appointments`, `/technician`, `/inspections` or `/vehicles`. |
| §12 | Internal LAN access preserved | Nothing here restricts staff access; the only tightening is that two catalogue endpoints now require the login staff already have. |

## 4. Outstanding — owner, not code (§1, §5 deployment, §11)

The remaining acceptance criteria cannot be met from this repository, and the
directive is explicit that they cannot be claimed from localhost or the LAN.

1. **Deployment topology is settled** — Render, both services, deployed by the
   owner as before. See §5.
2. **Set, in the deployed API environment:**
   - `PUBLIC_APP_URL` — the customer-facing https base (e.g.
     `https://service.bertsautoparts.com`)
   - `API_CORS_ORIGIN` — the exact web origin(s), https, never `*`
   - `NODE_ENV=production`, `ALLOW_DEV_LOGIN=false`
   Run `pnpm deploy:check`: it now fails the deployment for every bad
   combination above rather than generating unusable links.
3. **Run the external UAT** — `docs/123_Booking_UAT_Checklist.md`, on a phone on
   mobile data with Wi-Fi off. Twelve steps, and §11 is not satisfied without it.

## 5. Deployment topology — settled

**Vercel is not the target.** The owner deploys the platform himself, the way he
has before: Render, as `render.yaml` and `DEPLOYMENT_HANDOFF.md` describe.

That also closes out the three build failures of CR-2026-115. They happened
because a Next.js build was type-checking the NestJS API under ESM settings —
a shape that only arises on Vercel. It does not fit in any case: this API is a
long-running Nest server with a Redis/BullMQ worker and hourly cron sweeps, not
something the Next builder can host. The `tsconfig.portable.json` guard added in
CR-2026-115 stays regardless — it costs one `tsc` run and it catches the class
of error that produced those three failures.

So both services stay on Render, and this CR's configuration work is what it
always was:

- `PUBLIC_APP_URL` — the customer-facing https base
- `API_CORS_ORIGIN` — the web service's exact origin, https, never `*`
- `NODE_ENV=production`, `ALLOW_DEV_LOGIN=false`

Ideally both under one parent domain — `service.bertsautoparts.com` and
`api.bertsautoparts.com` — which keeps same-site `Lax` behaviour available and
gives customers a link that looks like the business rather than like a host.
`onrender.com` subdomains work today; they are on the Public Suffix List, so the
UAT cookie work from CR-2026-108 Stage 3 already accounts for them.

## 6. Acceptance status

| Criterion | State |
| --- | --- |
| `/book` works from outside Bert's network | Pending deployment + UAT |
| Customer manage links work externally | Pending deployment + UAT |
| Required public APIs work externally | Pending deployment + UAT |
| **Admin/internal pages remain protected** | **Done and evidenced** — 268/284 authenticated; the 16 anonymous routes are enumerated and justified; the catalogue hole is closed |
| Notifications contain external HTTPS links | Done in code; depends on `PUBLIC_APP_URL` at deploy |
| No customer-facing link contains an internal address | Done and evidenced |
| **Deployment checks validate public URL configuration** | **Done and evidenced** — URL and CORS, both tested |
| Mobile-data UAT passes | Outstanding — owner |
| Existing functionality not regressed | api 1773 · web 384 · `audit:operational` 80/80 |
