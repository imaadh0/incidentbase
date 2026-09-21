# Operations

## Service health

API liveness and readiness endpoints are exposed separately. Liveness reports whether the process event loop is serving requests; readiness additionally checks required dependencies as they are introduced.

## Shutdown

API and worker processes handle `SIGINT` and `SIGTERM`. They stop accepting new work, close owned resources, flush telemetry, and exit. A forced timeout prevents a deployment from waiting indefinitely.

## Secrets

Production secrets live in a VPS-side environment file or GitHub Actions secrets. They must never be committed, embedded in images, or included in logs.

## Web build output

Local Windows builds use `NEXT_OUTPUT_MODE=default` because standalone tracing requires symlink privileges. Container builds set the validated value to `standalone` for a minimal production runtime image.

## Deployment prerequisites

The production GitHub environment requires `VPS_HOST`, `VPS_USER`, `VPS_APP_PATH`, `VPS_SSH_KEY`, and a pinned `VPS_KNOWN_HOSTS` entry. The VPS keeps its own Compose environment file and must already be authenticated to GHCR when images are private.

The current Nginx configuration serves HTTP. Add the production hostname and mounted TLS certificate paths before exposing port 443; certificate issuance remains an operator action because it requires control of DNS and the VPS.
