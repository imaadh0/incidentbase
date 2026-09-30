#!/usr/bin/env bash
set -Eeuo pipefail

app_dir=/home/opc/IncidentBase
cert_dir="$app_dir/infra/nginx/certs"
contact_args=()
if [[ -n ${CERTBOT_EMAIL:-} ]]; then
  contact_args=(--email "$CERTBOT_EMAIL")
fi

cd "$app_dir"
[[ -f .env ]] || { echo 'Production .env is missing' >&2; exit 1; }

nginx_stopped=false
restore_nginx() {
  if [ "$nginx_stopped" = true ]; then
    docker compose start nginx
  fi
}
trap restore_nginx EXIT

# Standalone HTTP validation needs exclusive access to port 80. Keep the old
# certificate links in place until the new certificate has been issued.
docker compose stop nginx
nginx_stopped=true
docker run --rm --publish 80:80 --volume "$cert_dir:/etc/letsencrypt" \
  certbot/certbot:latest certonly --standalone --non-interactive --agree-tos \
  "${contact_args[@]}" --cert-name incidentbase.space \
  -d incidentbase.space -d www.incidentbase.space -d 129-154-225-87.nip.io

ln -sfn live/incidentbase.space/fullchain.pem "$cert_dir/fullchain.pem"
ln -sfn live/incidentbase.space/privkey.pem "$cert_dir/privkey.pem"

docker compose start nginx
nginx_stopped=false
trap - EXIT

openssl x509 -in "$cert_dir/fullchain.pem" -noout -subject -dates -ext subjectAltName
