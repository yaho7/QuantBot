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
  local method="$1" path="$2" bearer="$3" response status
  shift 3
  response="$(curl --silent --show-error --max-time 8 --request "$method" \
    --write-out $'\n%{http_code}' --header "Authorization: Bearer $bearer" \
    "$@" "${endpoint%/}$path")" || return
  status="${response##*$'\n'}"
  if [[ "$status" != 2[0-9][0-9] ]]; then
    printf '%s %s returned %s\n' "$method" "$path" "$status" >&2
    return 1
  fi
  printf '%s\n' "${response%$'\n'*}"
}

session="$(call POST /session "$token" --json "$(
  jq -nc --arg instance "$instance" --arg boot "$boot" '{instanceId:$instance,bootId:$boot}'
)")"
bearer="$(jq -er .session <<<"$session")"
current="$(jq -er .revision <<<"$session")"
heartbeat="$(call PUT /heartbeat "$bearer")"

if [[ "$control" == 1 ]]; then
  for ((attempt=0; attempt<120; attempt++)); do
    if jq -e .executor <<<"$heartbeat" >/dev/null; then break; fi
    sleep 1
    heartbeat="$(call PUT /heartbeat "$bearer")"
  done
  if ! jq -e .executor <<<"$heartbeat" >/dev/null; then
    printf 'Assign %s as the paper executor\n' "$instance" >&2
    exit 1
  fi
  capabilities="$(jq -c '. + [{
    id:"demo-refresh",kind:"action",title:"Refresh demo state",value_type:"null",
    writable:true,timeout_seconds:30,presentation:{suggested:true,surface:["strategy"]}
  }]' <<<"$capabilities")"
fi
revision="$(
  call PUT /capabilities "$bearer" --json "$(
    jq -nc --argjson revision "$current" --argjson capabilities "$capabilities" '{$revision,$capabilities}'
  )" | jq -er .revision
)"

send_state() {
  call PUT /state "$bearer" --json "$(
    jq -nc --argjson revision "$revision" --argjson at "$1" --arg control "$control" '{
      $revision,states:([{id:"broker",value:true,observedAt:$at}] +
        if $control == "1" then [{id:"demo-refresh",value:null,observedAt:$at}] else [] end)
    }'
  )"
}

at="$(jq -n 'now * 1000 | floor')"
send_state "$at"
send_record() {
  local path="$1" capability="$2" value="$3"
  call POST "$path" "$bearer" --json "$(
    jq -nc --argjson revision "$revision" --arg id "$boot-$capability" --arg capabilityId "$capability" \
      --argjson observedAt "$at" --argjson value "$value" --arg trace "$boot" '{
        $revision,records:[{$id,$capabilityId,$observedAt,$value,associations:{correlation_id:$trace}}]
      }'
  )"
}
send_record /reports poll-latency '"2.50"'
send_record /events sample-event '{"message":"Paper demo started"}'

if [[ "$control" != 1 ]]; then exit 0; fi
for ((attempt=0; attempt<32; attempt++)); do
  call PUT /heartbeat "$bearer" >/dev/null
  offers="$(call GET '/commands?wait=2' "$bearer")"
  id="$(jq -r 'map(select(.controlId == "demo-refresh")) | .[0].id // empty' <<<"$offers")"
  if [[ -z "$id" ]]; then sleep 0.5; continue; fi
  grant="$(call POST "/commands/$id/claim" "$bearer")"
  at="$(jq -n 'now * 1000 | floor')"
  permit="$(jq -er --argjson at "$at" 'select(.command == "demo-refresh" and .deadline > $at) | .permit | select(length > 0)' <<<"$grant")"
  send_state "$at" >/dev/null
  receipt="$(jq -nc --arg permit "$permit" '{$permit,status:"succeeded",message:"Refreshed demo state"}')"
  call POST "/commands/$id/result" "$bearer" --json "$receipt" >/dev/null
  call POST "/commands/$id/result" "$bearer" --json "$receipt" | jq -er .status
  exit 0
done
printf 'Queue the Refresh demo state command on the paper strategy\n' >&2
exit 1
