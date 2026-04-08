# ADR-005: WebSocket Notification-Refetch Pattern for Queue Board

## Status
Proposed

## Context
The live queue board must update in near-real-time (~2-3 seconds) when queue ranks change. Options include full state sync over WebSocket, server-sent events, polling, or a notification-refetch hybrid.

## Decision
Use **NestJS WebSocket gateway with Socket.IO** in a **notification-refetch** pattern:
1. Server broadcasts a lightweight `queue:updated` event over WebSocket after each recompute
2. Client receives the event and refetches the full board via `GET /queue/board?siteId=`
3. Redis adapter configured for horizontal scaling readiness

### WebSocket channel structure
- Room: `queue:site:{siteId}` — all clients watching a site's queue join this room
- Event: `queue:updated` — payload: `{ siteId, updatedAt, changedTicketIds? }`
- Auth: JWT extracted from Socket.IO handshake auth

## Options Considered
1. **Full state sync over WebSocket** — server pushes complete board state on every change
2. **Notification-refetch** (chosen) — server pushes signal, client refetches via REST
3. **Server-Sent Events (SSE)** — one-way push, simpler than WebSocket
4. **Polling** — client polls REST endpoint every N seconds

## Rationale
- **Notification-refetch avoids stale state bugs.** The REST endpoint is the single source of truth. Clients always get a consistent, complete board view. No risk of partial updates or out-of-order messages.
- **Simpler to debug and test.** Board data is always available via REST. WebSocket failures are non-fatal — client falls back to polling or manual refresh.
- **REST endpoint is cacheable and testable** with standard HTTP tools (curl, Supertest).
- **Full state sync** requires the server to maintain client state and handle reconnection/resync — significant complexity for minimal latency benefit.
- **SSE** is one-directional and doesn't support rooms natively. Socket.IO rooms are a natural fit for per-site broadcasting.
- **Polling** at 2-second intervals would work but wastes bandwidth and does not feel "live."

## Tradeoffs
- **Gain:** Simple server implementation, REST as single truth, graceful degradation if WebSocket fails, standard caching, easy testing
- **Lose:** Two round-trips per update (WS notification + HTTP fetch) vs one (full state push). Extra latency of ~100-200ms for the HTTP fetch.
- **Risk:** Under very high recompute frequency (e.g., 10+ per second), the client would refetch rapidly. Mitigated by server-side debounce (max 1 recompute per 2 seconds per site).

## Impact
- **Backend:** `queue.gateway.ts` with Socket.IO, `@nestjs/event-emitter` for internal events
- **Frontend:** `use-queue-socket.ts` hook that subscribes to room and invalidates TanStack Query cache on event
- **Infrastructure:** Redis adapter (`@socket.io/redis-adapter`) configured in all environments
- **Testing:** WebSocket gateway tested with Socket.IO client in integration tests

## Rollback / Migration
If latency is unacceptable, the pattern can be upgraded to full state sync by changing the WebSocket event payload from a signal to the full board state. The REST endpoint remains as fallback. This is a localized change in the gateway and the frontend hook.

## Approval Gate
AG-04 (architecture pattern, informational).
