# CR-2026-124 — Lobby board: the plate on one line, the estimates presented properly, nothing cut off

**Date:** 2026-10-16
**Status:** Implemented, verified by rendering at 1080p / 768p / 4K, committed to `master`
**Requested by:** Product owner — "For the tickets being displayed on the customer waiting screen have the license plate formatted better and in one line. Have the contents fixed and presented better like the Est. Start and completion time."

---

## A. What was wrong (seen, not guessed)

The board was rendered at TV sizes with a realistic synthetic payload (six waiting cars with plates of different lengths, a delayed one, a no-plate one, two in service, one in quality check, two ready) before any change:

- **Plates wrapped** — "7777 / XY", "4455 / MN", and at 768p even "777 / 7 / XY" mid-plate. Cause: the status and the estimate lines sat to the *right* of the plate in a `shrink-0` block, and "Est. completion 11:20 AM–11:40 AM" or "READY FOR COLLECTION" took the width first.
- **Estimates were ragged** — right-aligned prose in two sizes, with "AM"/"PM" repeated on both ends of every range, lining up with nothing on the next card.
- **The fifth card was cut off** at 1080p: a fixed five rows per lane regardless of the screen, in a page that was `min-h-screen` (allowed to grow), so the footer was off-screen too.

## B. What changed — `apps/web/app/display/[token]/page.tsx`, `apps/web/lib/eta-format.ts`

1. **The plate is a plate.** A bordered badge in a fixed-width face, upper-case, `whitespace-nowrap`, the largest thing on the card and the first thing on its top row. The short ticket number sits beside it on the same baseline (the tie-break, never truncated in any rendered case). No plate recorded → the ticket leads, "No plate recorded" beside it.
2. **One card shape in every lane: top row + full-width detail row.** Nothing to the right of the plate is ever wide enough to break it, because the status is short and *stacked*: "#3 of 6" over "DELAYED"; "POSITION 1" over "DELAYED"; "QUALITY / CHECK". Two short lines fit inside the plate's own height, so a delayed card is no taller than its neighbours. The words "Waiting" and "In Service" were dropped from the cards — the lane header already says them.
3. **Est. start and Est. completion side by side**, label above value, in the same two places on every card; values bold, tabular figures; amber when delayed. Where there is no reliable estimate the row still renders and says "to follow" (§5.6C: never a made-up time), which also keeps every card in a lane the same height.
4. **Compact ranges** — `fmtEtaWindow` now does what its comment always promised: "10:30–10:50 AM", not "10:30 AM–10:50 AM"; across noon both periods stay ("11:50 AM–12:10 PM"). This is the one shared formatter, so the staff queue, dispatch, visit record and status page gain the same economy.
5. **Rows per lane are measured, not fixed.** Each lane measures its body height, its card height and its gap (`ResizeObserver`) and pages by what fits, capped at eight. The page is `h-screen` (exactly the screen, never taller) so the measurement is honest and the footer stays on screen. 1080p: three per lane; 4K: six; 768p: three.
6. Header and lane headers slimmed slightly; footer text says the ticket is *beside* the plate.

## C. Assumptions

- **A1.** Three well-presented cards per lane at 1080p, cycling every nine seconds with "Showing 1–3 of 6", is the right trade against five cramped ones that wrapped. A taller or portrait screen shows more automatically.
- **A2.** Plates are at most eight characters (Jamaican formats). The badge never wraps; an unexpectedly long plate would clip at the badge edge rather than break the row.
- **A3.** "Quality Check" is kept by name (CR-2026-118 §5.6B) and may break into its two words.

## D. Verification (local, 2026-10-16)

- `pnpm --filter @bsop/web typecheck`: clean. The CR-2026-105b surfaces test still finds `fmtEtaWindow(` on the board.
- Rendered with Playwright at 1920×1080, 1366×768 and 3840×2160 against an intercepted payload covering: 7- and 8-character plates with and without a space, no plate, delayed, no estimate, "Holding", in service with and without a bay, quality check, ready with and without a plate, and the Waiting lane's second page. Every plate on one line; every ticket number intact; estimates aligned; footer visible; no card clipped.
- Screenshots: `before-1080.png` / `after5-1080.png` (session scratchpad).

## E. Approval gate

Presentation only. The board's data, the ETA model, the plate masking rule and the 24-hour status-link rule are untouched. No gate in `docs/21` is crossed; recorded here.
