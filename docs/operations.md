# Operations

## Service health

API liveness and readiness endpoints are exposed separately. Liveness reports whether the process event loop is serving requests; readiness additionally checks required dependencies as they are introduced.

## Shutdown

API and worker processes handle `SIGINT` and `SIGTERM`. They stop accepting new work, close owned resources, flush telemetry, and exit. A forced timeout prevents a deployment from waiting indefinitely.

## Secrets

Production secrets live in a VPS-side environment file or GitHub Actions secrets. They must never be committed, embedded in images, or included in logs.

