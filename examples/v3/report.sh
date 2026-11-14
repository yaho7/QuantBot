#!/usr/bin/env bash
# Exercise the declarative Agent API with curl, jq and OpenSSL.
set -euo pipefail

endpoint="${QB_AGENT_URL:?Set QB_AGENT_URL}"
token="${QB_TOKEN:?Set QB_TOKEN}"
instance="${QB_INSTANCE_ID:-curl-example}"
control="${QB_DEMO_CONTROL:-0}"
boot="$(openssl rand -hex 16)"
capabilities="$(cat "$(dirname "$0")/capabilities.json")"

call() {
  local method="$1" path="$2" bearer="$3" response
  shift 3
  response="$(curl --silent --show-error --max-time 8 --request "$method" \
    --write-out $'\n%{http_code}' --header "Authorization: Bearer $bearer" \
    "$@" "${endpoint%/}$path")" || { status=000; error_code=network_error; return 1; }
  status="${response##*$'\n'}"
  result="${response%$'\n'*}"
  error_code=""
  if [[ "$status" != 2[0-9][0-9] ]]; then
    error_code="$(jq -r '.code // empty' <<<"$result" 2>/dev/null || true)"
    printf '%s %s returned %s %s\n' "$method" "$path" "$status" "$error_code" >&2
    return 1
  fi
}

identity="$(jq -nc --arg instance "$instance" --arg boot "$boot" '{instanceId:$instance,bootId:$boot}')"
connect() {
  call POST /session "$token" --json "$identity" || return
  bearer="$(jq -er .session <<<"$result")"
  renew_at="$(jq -r '.renewAt // 0' <<<"$result")"
}
connect
current="$(jq -er .revision <<<"$result")"

renew() {
  local attempt delay=1
  for ((attempt=0; attempt<6; attempt++)); do
    if connect; then printf 'session renewed\n' >&2; return 0; fi
    if [[ "$status" != 000 && "$status" != 429 && "$status" != 5[0-9][0-9] ]]; then return 1; fi
    sleep "$delay"
    if ((delay < 8)); then delay=$(( delay * 2 )); fi
  done
  return 1
}

agent() {
  local method="$1" path="$2"
  shift 2
  if ((renew_at > 0 && $(date +%s) >= renew_at)); then renew || return; fi
  if call "$method" "$path" "$bearer" "$@"; then return 0; fi
  if [[ "$error_code" != session_expired ]]; then return 1; fi
  renew && call "$method" "$path" "$bearer" "$@"
}

agent PUT /heartbeat
heartbeat="$result"

for ((attempt=0; attempt<120; attempt++)); do
  if jq -e .executor <<<"$heartbeat" >/dev/null; then break; fi
  sleep 1
  agent PUT /heartbeat
  heartbeat="$result"
done
if ! jq -e .executor <<<"$heartbeat" >/dev/null; then
  printf 'Assign %s as the paper executor\n' "$instance" >&2
  exit 1
fi
if [[ "$control" == 1 ]]; then
  capabilities="$(jq -c '. + [{
    id:"demo-refresh",kind:"action",title:"Refresh demo state",value_type:"null",
    writable:true,timeout_seconds:30,presentation:{suggested:true,surface:["strategy"]}
  }]' <<<"$capabilities")"
fi
agent PUT /capabilities --json "$(
  jq -nc --argjson revision "$current" --argjson capabilities "$capabilities" '{$revision,$capabilities}'
)"
revision="$(jq -er .revision <<<"$result")"

send_state() {
  agent PUT /state --json "$(
    jq -nc --argjson revision "$revision" --argjson at "$1" --arg control "$control" '{
      $revision,states:([{id:"broker",value:true,observedAt:$at}] +
        if $control == "1" then [{id:"demo-refresh",value:null,observedAt:$at}] else [] end)
    }'
  )"
}

at="$(jq -n 'now * 1000 | floor')"
send_state "$at"
printf '%s\n' "$result"
send_record() {
  local path="$1" capability="$2" value="$3"
  agent POST "$path" --json "$(
    jq -nc --argjson revision "$revision" --arg id "$boot-$capability" --arg capabilityId "$capability" \
      --argjson observedAt "$at" --argjson value "$value" --arg trace "$boot" '{
        $revision,records:[{$id,$capabilityId,$observedAt,$value,associations:{correlation_id:$trace}}]
      }'
  )"
  printf '%s\n' "$result"
}
send_record /reports poll-latency '"2.50"'
send_record /events sample-event '{"message":"Paper demo started"}'

if [[ "$control" != 1 ]]; then exit 0; fi
next_heartbeat=$(( $(date +%s) + 15 ))
for ((attempt=0; attempt<40; attempt++)); do
  if (( $(date +%s) >= next_heartbeat )); then
    agent PUT /heartbeat
    next_heartbeat=$(( $(date +%s) + 15 ))
  fi
  agent GET '/commands?wait=2'
  id="$(jq -r 'map(select(.controlId == "demo-refresh")) | .[0].id // empty' <<<"$result")"
  if [[ -z "$id" ]]; then sleep 0.5; continue; fi
  if ! agent POST "/commands/$id/claim" --header "Idempotency-Key: claim-$id"; then
    [[ "$status" == 000 ]] || exit 1
    agent POST "/commands/$id/claim" --header "Idempotency-Key: claim-$id"
  fi
  grant="$result"
  at="$(jq -n 'now * 1000 | floor')"
  permit="$(jq -er --argjson at "$at" 'select(.command == "demo-refresh" and .deadline > $at) | .permit | select(length > 0)' <<<"$grant")"
  send_state "$at" >/dev/null
  receipt="$(jq -nc --arg permit "$permit" '{$permit,status:"succeeded",message:"Refreshed demo state"}')"
  agent POST "/commands/$id/result" --json "$receipt"
  agent POST "/commands/$id/result" --json "$receipt"
  jq -er .status <<<"$result"
  exit 0
done
printf 'Queue the Refresh demo state command on the paper strategy\n' >&2
exit 1
