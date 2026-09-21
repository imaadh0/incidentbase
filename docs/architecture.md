# System Architecture

IncidentBase separates synchronous request handling from asynchronous delivery and escalation work:

```text
Browser -> Nginx -> Next.js
                 -> Express + Socket.io -> PostgreSQL
                                      \-> Redis/BullMQ -> Worker -> providers
```

The browser treats REST responses as authoritative. Socket.io events invalidate cached data and prompt resynchronization rather than acting as the sole record of a state change.

Tenant isolation, incident concurrency, and the transactional outbox are introduced with their database-backed milestones and are mandatory before incident workflows are considered complete.

