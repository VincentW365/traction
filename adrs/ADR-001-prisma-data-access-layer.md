# ADR-001: Prisma as Typed Data Access Layer

## Status
Proposed

## Context
BSOP requires a typed data access layer for a 32-table PostgreSQL schema (29 original + 3 maintenance intelligence tables). The system must support strict TypeScript types, versioned migrations, and NestJS integration. `claude.md` specifies "Prisma or equivalent typed data access layer."

## Decision
Use **Prisma** as the primary data access layer with PostgreSQL native enums and `$queryRaw` for complex scheduler queries.

## Options Considered
1. **Prisma** — declarative schema, auto-generated types, migration system, mature NestJS integration
2. **Drizzle ORM** — lightweight, SQL-like syntax, excellent TypeScript inference, smaller runtime
3. **Raw SQL + pgtyped** — maximum control and performance, no ORM abstraction

## Rationale
- Prisma's declarative schema maps 1:1 to the SQL blueprint in `db/schema_outline.sql`. Translation is mechanical.
- Auto-generated TypeScript types from `prisma generate` prevent type drift between database and application.
- Migration system satisfies `docs/19_Repo_Structure_Delivery_Standards.md` section 8: "every schema change must be versioned."
- NestJS integration is well-established: `PrismaService extends PrismaClient` with `OnModuleInit/OnModuleDestroy`.
- The scheduling engine's recompute query (load all active visits with joins and scoring) may need `$queryRaw` for performance. This is an acceptable escape hatch, not a reason to reject Prisma.
- Development velocity matters for pilot delivery. Prisma's auto-complete and type generation accelerate CRUD development.

## Tradeoffs
- **Gain:** Type safety, migration discipline, fast CRUD development, `prisma studio` for debugging
- **Lose:** ORM overhead on complex queries (mitigated by `$queryRaw`), larger client bundle, some friction with PostgreSQL-specific features (partial indexes require raw SQL migration)
- **Risk:** If Prisma's query builder proves insufficient for the scheduler, the team must write raw SQL for that path. This is a localized risk, not a systemic one.

## Impact
- **Modules:** All backend modules depend on PrismaService
- **Entities:** All 32 entities defined in `prisma/schema.prisma`
- **APIs:** All CRUD endpoints use Prisma-generated types
- **Testing:** Integration tests use Testcontainers + Prisma migrations against real PostgreSQL
- **Infrastructure:** `prisma/` directory at repo root, shared by API app and seed scripts

## Rollback / Migration
If Prisma proves insufficient, migration to Drizzle is feasible because both generate SQL migrations. The Prisma schema is declarative and could be mechanically translated to Drizzle schema. Application code changes would be localized to service files.

## Approval Gate
AG-05 (new third-party dependency in core flow).
