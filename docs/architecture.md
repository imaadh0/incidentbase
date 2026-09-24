# System Architecture

IncidentBase separates synchronous request handling from asynchronous delivery and escalation work:

```text
Browser -> Nginx -> Next.js
                 -> Express + Socket.io -> PostgreSQL
                                      \-> Redis/BullMQ -> Worker -> providers
```

The browser treats REST responses as authoritative. A restricted worker relays committed transactional-outbox rows through Redis to Socket.io. Organization-room events invalidate incident queries, recipient user-room events create in-app toasts, and every connection or reconnection triggers a REST resynchronization plus audit-cursor timeline catch-up. Room joins and broadcasts revalidate active tenant membership.

Tenant isolation is enforced twice: tenant repositories require a transaction-local unit of work, and PostgreSQL forced RLS independently filters every tenant-owned table. Composite foreign keys include `organization_id`, preventing a valid identifier from one tenant from being related to a row in another. Incident concurrency and the transactional outbox remain mandatory parts of their later database-backed milestones.
