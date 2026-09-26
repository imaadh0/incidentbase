#!/usr/bin/env bash
set -Eeuo pipefail

app_dir=/home/opc/IncidentBase
cert_dir="$app_dir/infra/nginx/certs"

cd "$app_dir"

# Check daily, but only interrupt Nginx when the certificate has less than 30 days left.
if openssl x509 -checkend 2592000 -noout -in "$cert_dir/fullchain.pem"; then
  echo 'IncidentBase certificate is not due for renewal.'
  exit 0
fi

nginx_stopped=false
restore_nginx() {
  if [ "$nginx_stopped" = true ]; then
    docker compose start nginx
  fi
}
trap restore_nginx EXIT

docker compose stop nginx
nginx_stopped=true
docker run --rm --publish 80:80 --volume "$cert_dir:/etc/letsencrypt" \
  certbot/certbot:latest renew --standalone --non-interactive --no-random-sleep-on-renew --quiet
docker compose start nginx
nginx_stopped=false
trap - EXIT
