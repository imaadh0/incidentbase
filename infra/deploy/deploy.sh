#!/usr/bin/env bash
set -Eeuo pipefail

image_prefix=${1:?image prefix is required}
commit_sha=${2:?commit SHA is required}
registry_user=${3:?registry user is required}

[[ $image_prefix =~ ^ghcr\.io/[a-z0-9_-]+/[a-z0-9_/-]+$ ]] || { echo 'Invalid image prefix' >&2; exit 1; }
[[ $commit_sha =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
[[ -f .env ]] || { echo 'Production .env is missing' >&2; exit 1; }

export WEB_IMAGE="$image_prefix-web:$commit_sha"
export API_IMAGE="$image_prefix-api:$commit_sha"
export WORKER_IMAGE="$image_prefix-worker:$commit_sha"
export MIGRATE_IMAGE="$image_prefix-migrate:$commit_sha"

export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
# Keep the small VPS from filling with images and build cache from prior releases.
# Docker retains images used by running containers.
docker builder prune --all --force
docker image prune --all --force
docker login ghcr.io --username "$registry_user" --password-stdin
docker compose pull
docker compose up -d --no-build --wait --wait-timeout 300
# Git may replace the bind-mounted config file without changing Compose's
# service definition. Recreate Nginx so it loads the checked-out config.
docker compose up -d --no-deps --force-recreate nginx
curl --fail --silent --show-error https://incidentbase.space/api/v1/health/ready
curl --fail --silent --show-error https://incidentbase.space/ >/dev/null

for service in WEB API WORKER MIGRATE; do
  name="${service}_IMAGE"
  value=${!name}
  if grep -q "^${name}=" .env; then
    sed -i "s|^${name}=.*|${name}=${value}|" .env
  else
    printf '%s=%s\n' "$name" "$value" >> .env
  fi
done

echo "Deployed GHCR images for $commit_sha"
