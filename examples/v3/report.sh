#!/usr/bin/env bash
# Exercise the declarative Agent API with curl, jq and OpenSSL.
set -euo pipefail

case "$#" in
  0) control=0 ;;
  1) [[ "$1" == --demo-control ]] || { echo "Usage: $0 [--demo-control]" >&2; exit 1; }; control=1 ;;
  *) echo "Usage: $0 [--demo-control]" >&2; exit 1 ;;
esac
read_config() {
  jq -er "$1" <<<"$config" 2>/dev/null ||
    { printf '%s\n' "$2" >&2; return 1; }
}
config="$(jq -ce -s 'select(length == 1 and (.[0] | type == "object")) | .[0]' quantbot.json 2>/dev/null)" ||
  { echo "Create a valid local quantbot.json using quantbot.example.json" >&2; exit 1; }
endpoint="$(read_config '
  .endpoint | strings | sub("/+$"; "") | select(contains("\\") | not) |
  select(test("^https?://[^/?#@\\s]+(/api/agent(/sandbox/[A-Za-z0-9_-]+)?)?$")) |
  if test("^https?://[^/]+$") then . + "/api/agent" else . end
' 'Set endpoint to a QuantBot HTTP or HTTPS URL in quantbot.json')"
token="$(read_config '
  (if .token == null then .secret else .token end) | strings | select(test("^qbt_[A-Za-z0-9_-]+$"))
' 'Paste the Agent Token into token in quantbot.json')"
instance="$(read_config '.instance_name | strings | select(test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$"))' 'Set a stable instance_name in quantbot.json')"
strategy="$(read_config '(.strategy_id // "") | strings' 'strategy_id must be a string')"
interval="$(read_config '
  (if has("heartbeat_seconds") then .heartbeat_seconds else 3 end) |
  numbers | select(. == floor and . >= 1 and . <= 15)
' 'heartbeat_seconds must be an integer from 1 to 15')"
read_config 'select((has("disconnect_policy") | not) or .disconnect_policy == "continue")' \
  "The demo supports only disconnect_policy 'continue'" >/dev/null
unset config
boot="$(openssl rand -hex 16)"
capabilities="$(cat "$(dirname "$0")/capabilities.json")"

call() {
  local method="$1" path="$2" bearer="$3" response
  shift 3
  response="$(curl --silent --show-error --max-time 8 --request "$method" \
    --write-out $'\n%{http_code}' --header @- \
    "$@" "$endpoint$path" <<<"Authorization: Bearer $bearer")" || { status=000; error_code=network_error; return 1; }
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
  if [[ -n "$strategy" && "$(jq -r '.strategyId // empty' <<<"$result")" != "$strategy" ]]; then
    echo "Session strategy does not match strategy_id in quantbot.json" >&2
    status=400
    return 1
  fi
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

for ((elapsed=0; ; elapsed+=interval)); do
  agent PUT /heartbeat
  if jq -e .executor <<<"$result" >/dev/null; then break; fi
  if ((elapsed + interval > 120)); then
    printf 'Assign %s as the paper executor\n' "$instance" >&2
    exit 1
  fi
  sleep "$interval"
done
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
next_heartbeat=$(( $(date +%s) + interval ))
for ((attempt=0; attempt<40; attempt++)); do
  if (( $(date +%s) >= next_heartbeat )); then
    agent PUT /heartbeat
    next_heartbeat=$(( $(date +%s) + interval ))
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
