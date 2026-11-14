#!/usr/bin/env bash
# Report test strategy status with curl. jq is used to encode and read JSON.
set -euo pipefail

endpoint="${QB_AGENT_URL:?Set QB_AGENT_URL}"
token="${QB_TOKEN:?Set QB_TOKEN}"
instance="${QB_INSTANCE_ID:-curl-example}"
boot="$(openssl rand -hex 16)"
at="$(jq -n 'now * 1000 | floor')"

call() {
  local method="$1" path="$2" bearer="$3"
  shift 3
  curl --silent --show-error --fail --max-time 10 --request "$method" \
    --header "Authorization: Bearer $bearer" "$@" "${endpoint%/}$path"
}

session="$(
  call POST /session "$token" --json "$(
    jq -nc --arg instance "$instance" --arg boot "$boot" '{instanceId:$instance,bootId:$boot}'
  )" | jq -er .session
)"
call PUT /heartbeat "$session" >/dev/null
call POST /reports "$session" --json "$(
  jq -nc --arg id "$boot-status" --argjson at "$at" \
    '{version:1,records:[{id:$id,kind:"status",observedAt:$at,data:{state:"running"}}]}'
)"
