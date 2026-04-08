# 20_Sources_and_Rationale.md

## Purpose

Provide current-reference notes for stack and architecture choices.

This document is not meant to be exhaustive.
It exists so major stack choices are not based on stale assumptions.

---

## Reference Notes

| topic | url | note |
| --- | --- | --- |
| Next.js App Router | https://nextjs.org/docs/app | App Router uses React features such as Server Components, Suspense, and Server Functions. |
| Next.js Route Handlers | https://nextjs.org/docs/app/getting-started/route-handlers | Supports GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS in app-based route handlers. |
| NestJS Documentation | https://docs.nestjs.com/ | NestJS is positioned as an efficient, scalable Node.js server-side framework with TypeScript and modules, including WebSockets and OpenAPI. |
| NestJS OpenAPI | https://docs.nestjs.com/recipes/swagger | Swagger/OpenAPI generation is available from the framework. |
| PostgreSQL Row-Level Security | https://www.postgresql.org/docs/current/ddl-rowsecurity.html | PostgreSQL supports row security policies when needed. |
| PostgreSQL LISTEN / NOTIFY | https://www.postgresql.org/docs/current/sql-notify.html | PostgreSQL supports notifications for interprocess communication, useful for some internal signalling patterns. |
| Supabase Realtime | https://supabase.com/docs/guides/realtime/subscribing-to-database-changes | Supabase documents Broadcast as the recommended method for scalability and security, while Postgres Changes is simpler but less scalable. |
| Socket.IO Rooms / Redis Adapter | https://socket.io/docs/v4/rooms/ | Rooms can broadcast to subsets of clients, and Redis Adapter enables multi-server broadcasting. |
| BullMQ Job Schedulers | https://docs.bullmq.io/guide/jobs/repeatable | Repeatable APIs are deprecated in favor of Job Schedulers, which are more robust for recurring jobs. |
| Twilio Messaging API | https://www.twilio.com/docs/messaging/api | Twilio messaging API supports sending and receiving SMS, MMS, and WhatsApp with delivery tracking. |
| SendGrid API | https://app.sendgrid.com/docs/API_Reference/index.html | SendGrid provides API support for transactional email. |

---

## Architecture Takeaways from Current References

### Next.js
Use modern App Router patterns for the web application.
The framework supports current React capabilities that are well-suited for a modern operational web app.

### NestJS
NestJS remains a strong fit for a modular, TypeScript-first backend with clear support for modules, WebSockets, and OpenAPI.

### PostgreSQL
PostgreSQL remains a strong primary store for a transactional operational system with strong relational integrity and reporting needs.

### Realtime guidance
For this platform, purposeful application-level events and WebSocket broadcasts are a better primary model than letting raw DB changes drive the UI.
Supabase's own docs note that Broadcast is preferred over raw Postgres Changes for scalability and security when using its platform.
That reinforces the broader principle of not making raw DB change streams the primary business-event model.

### BullMQ
Current docs indicate the move toward Job Schedulers over older repeatable APIs.
Use the current scheduler pattern for reminders and recurring jobs.

### Socket.IO
Rooms plus Redis adapter remain a practical pattern for multi-instance real-time fan-out.

### Twilio + SendGrid
Both remain straightforward choices for SMS and transactional email adapter layers.

---

## Decision Summary

Based on the above, the blueprint recommends:
- Next.js frontend
- NestJS backend
- PostgreSQL source of truth
- WebSocket gateway with Redis-backed scale path
- BullMQ for scheduled jobs
- vendor adapter layer for notifications and external systems
