# 10_Architecture_Tech_Stack.md

## Purpose

Define the recommended implementation architecture for the unified platform.

The architecture should optimize for:
- maintainability
- clear domain ownership
- real-time operational visibility
- testability
- future integration
- safe scaling

---

## 1. Recommended Architecture Style

## Modular monolith

### Why this is the right choice
A modular monolith gives:
- one deployable core business system
- one shared database
- clear internal module boundaries
- lower operational overhead than microservices
- easier transaction boundaries for queue + scheduling + service operations
- faster delivery for a pilot and early scale

### Why not microservices first
Microservices would introduce:
- distributed transactions
- cross-service consistency pain
- duplicated status truth risk
- slower development speed
- higher ops burden

That is the wrong tradeoff for this stage.

---

## 2. Recommended Stack

### Frontend
- **Next.js**
- TypeScript
- Tailwind CSS
- shadcn/ui or equivalent component baseline
- React Hook Form + Zod
- TanStack Query for server-state handling
- Zustand or local state only where truly needed

### Backend
- **NestJS**
- TypeScript
- REST API
- WebSocket gateway for live queue / workshop updates
- Swagger / OpenAPI generation
- background jobs / integration workers

### Data
- **PostgreSQL** as primary system of record
- Redis for queues, jobs, ephemeral caching, and horizontal real-time fan-out support
- S3-compatible object storage if document/photo attachments are added later

### Background and async
- BullMQ job schedulers
- outbox / integration job pattern for external systems

### Notifications
- Twilio for SMS
- SendGrid for email
- provider abstraction layer so vendors can change later

### Auth
- OIDC/JWT boundary
- provider-agnostic integration
- RBAC enforced in API
- optional provider choices later: Clerk, Auth0, or equivalent

### Observability
- structured logs
- error tracking
- health checks
- audit logs
- metrics for queue recompute and notification jobs

---

## 3. Recommended Monorepo Shape

```text
/apps
  /web            # Next.js app
  /api            # NestJS app
/packages
  /ui             # shared UI components
  /types          # shared domain and DTO types
  /config         # shared config helpers and environment schema
  /eslint-config  # lint rules
  /tsconfig       # base tsconfig
/docs
/api
/db
/templates
```

### Why monorepo
- shared types reduce contract drift
- easier synchronized refactors
- shared CI pipeline
- easier documentation discipline

---

## 4. Runtime Architecture

### Web app
- staff UI
- customer booking / status UI
- manager dashboard
- transport dashboard

### API app
- domain modules
- scheduling engine
- realtime gateway
- worker producers
- integration endpoints

### Worker processes
- reminder scheduling
- delay alerts
- transfer polling / sync
- outbox dispatch
- report aggregation jobs if needed later

### Database
- transactional source of truth
- operational queries
- history and audit

### Redis
- BullMQ
- Socket.IO Redis adapter when horizontally scaled
- small caching only where justified

---

## 5. Realtime Strategy

### Primary recommendation
Use:
- NestJS WebSocket gateway
- Socket.IO rooms
- Redis adapter when running multiple API instances

### Why this is preferred
- direct control over event model
- site-specific room broadcasts
- staff and public board updates in near real time
- does not force the frontend into direct DB subscriptions for core writes
- aligns well with modular monolith and API-owned business logic

### When to avoid direct DB-change subscriptions as primary pattern
Direct DB change subscriptions can be useful, but the platform should not make database events the main source of UI behavior for core operational flows.
Business logic should emit purposeful domain events after validated state changes.

---

## 6. API Strategy

### REST-first
Use REST for:
- CRUD-like domain actions
- workflow transitions
- admin configuration
- reporting queries
- integrations

### WebSockets for live operational views
Use WebSockets for:
- queue board changes
- rank and ETA updates
- technician work queue changes
- transport board changes
- manager live ops

### Internal domain event pattern
Inside the app:
- emit domain events after successful state changes
- use those events to trigger notifications, recomputations, and projections

---

## 7. Database Design Strategy

### Write model
- normalized
- transaction-safe
- strong foreign keys
- status history
- audit trail
- constrained enums or reference tables

### Read model
- optimized views or query services for:
  - queue board
  - manager dashboard
  - parts readiness board
  - transport board

### Why PostgreSQL
- strong relational integrity
- mature transactional behavior
- good indexing and reporting flexibility
- supports row-level security if later needed
- supports notifications useful for some internal patterns

---

## 8. Integration Layer Strategy

Create adapters for:
- POS
- inventory / stock system
- SMS provider
- email provider
- possible payment gateway later
- future WhatsApp or CRM

### Rules
- no domain module should speak vendor APIs directly
- integration requests should be queued / retried when necessary
- use idempotency keys
- preserve vendor reference IDs
- failures should not silently corrupt operational truth

---

## 9. Configuration Strategy

Configurable items should live in:
- environment variables for infrastructure secrets
- business rule config tables for operational policy

### Environment config examples
- DB connection
- Redis connection
- Twilio credentials
- SendGrid credentials
- auth provider settings

### Business config examples
- grace period
- early-arrival threshold
- operating hours
- reminder cadence
- fairness threshold
- transport eligibility thresholds

---

## 10. Recommended Hosting Path

### MVP / pilot-friendly
- Vercel for frontend if desired
- Render / Railway / Fly.io / AWS for API
- managed PostgreSQL
- managed Redis

### Enterprise-ready path
- AWS or Azure with:
  - containerized API
  - managed DB
  - managed cache
  - object storage
  - centralized logging and alerting

The platform should not be written in a way that makes migration painful.

---

## 11. Performance Priorities

Most important performance targets:
- check-in write actions feel instant
- queue recomputation is fast
- live board updates appear quickly
- appointment slot search is responsive
- manager dashboard is query-efficient

### Practical guidance
- index by site, date, status, rank
- precompute some board projections if needed
- avoid N+1 patterns in queue views
- keep heavy analytics out of operational request paths

---

## 12. Recommended Package / Library Choices

### Frontend
- Next.js
- Tailwind CSS
- shadcn/ui
- TanStack Query
- Zod
- React Hook Form

### Backend
- NestJS
- Prisma (or equivalent typed ORM)
- BullMQ
- Socket.IO
- class-validator / Zod / DTO validation stack

### Testing
- Vitest or Jest
- Supertest
- Playwright

### Documentation
- OpenAPI / Swagger
- ADR files
- Mermaid diagrams

---

## 13. Non-Functional Requirements Baseline

- clear RBAC
- full audit on privileged actions
- retryable integrations
- backup and recovery plan
- structured logs
- health checks
- test coverage on core rules
- support pilot load with room to scale

---

## 14. Strong Recommendation on Optimization Models

Do **not** begin with:
- ML scheduling
- opaque recommendation engines
- solver-heavy dispatch

Begin with:
- deterministic rules
- explicit score components
- data capture
- later predictive extensions

That sequence gives trust first, sophistication second.

---

## 15. Official-Reference Notes

See `docs/20_Sources_and_Rationale.md` for current official-reference notes behind:
- Next.js App Router
- NestJS
- PostgreSQL
- Supabase Realtime guidance
- Socket.IO rooms / Redis adapter
- BullMQ job schedulers
- Twilio messaging
- SendGrid email
