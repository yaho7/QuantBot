#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: deploy/smoke.sh <local-image>}"
export QB_SMOKE_IMAGE="$image"
temp="$(mktemp -d)"
project="quantbot-smoke-$$"
compose() {
  docker compose -f compose.yml -f "$temp/override.yml" -p "$project" "$@"
}
cleanup() {
  compose --profile maintenance down --volumes >/dev/null || true
  rm -rf "$temp"
}
trap cleanup EXIT
cat > "$temp/override.yml" <<'YAML'
services:
  quantbot:
    image: ${QB_SMOKE_IMAGE}
    ports: !override
      - "127.0.0.1::8888"
  restore:
    profiles: [maintenance]
    image: ${QB_SMOKE_IMAGE}
    environment:
      QB_DOCKER_LOOPBACK: "1"
      QB_DATA_DIR: /data/recovered
    ports:
      - "127.0.0.1::8888"
    volumes:
      - restored:/data
      - data:/source:ro
volumes:
  restored:
YAML
compose up --pull never --wait --wait-timeout 60 quantbot
url="http://$(compose port quantbot 8888)"
curl -fsS --retry 3 "$url/healthz" | jq -e '.status == "ok"'
curl -fsS "$url/api/auth/setup" | jq -e '.required'
curl -fsS "$url/api/auth/setup" -H "Origin: $url" -H 'Content-Type: application/json' \
  --data '{"username":"smoke-admin","password":"quantbot-smoke-fixture"}' | jq -e '.userId == 1'
test "$(compose exec -T quantbot id -u)" = 10001
compose exec -T quantbot quantbot doctor
compose stop quantbot
compose run --rm --no-deps quantbot backup /data/smoke.zip
compose run --rm --no-deps restore restore /source/smoke.zip
compose run --rm --no-deps restore doctor
compose up --pull never --wait --wait-timeout 60 restore
restored_url="http://$(compose port restore 8888)"
curl -fsS "$restored_url/api/auth/login" -H "Origin: $restored_url" -H 'Content-Type: application/json' \
  --data '{"username":"smoke-admin","password":"quantbot-smoke-fixture"}' | jq -e '.userId == 1'
compose up --pull never --wait --wait-timeout 60 quantbot
url="http://$(compose port quantbot 8888)"
curl -fsS "$url/api/auth/setup" | jq -e '.required == false'
curl -fsS "$url/api/auth/login" -H "Origin: $url" -H 'Content-Type: application/json' \
  --data '{"username":"smoke-admin","password":"quantbot-smoke-fixture"}' | jq -e '.userId == 1'
