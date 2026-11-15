#!/bin/bash
# Carry an account's files work list from one store to another on a short-lived Hetzner Cloud server, with hard stops on
# time, traffic and requests, and leave no server behind.
#
# What runs where:
#   Mac:    account_files_move work-list (already run: WORK_LIST), then `remote-setup WORK_LIST` (origins' plain facts and
#           SigV4 day keys for today and tomorrow UTC: the stores' secrets never leave the Mac vault) piped with the
#           work list over ssh stdin; proof lines come back on stdout into OUT/proofs.jsonl.
#   Server: account_files_carry (examples/account_files_carry.rs, built for linux arm64): copies, BLAKE3-checks while reading,
#           proves each copy by its signed upload checksum and one HEAD (never a download back),
#           stops at its budget (110% of the work list's plan; at most 5 retries per key).
#
# Hard stops (Hetzner bills until a server is DELETED, not when it is off):
#   1. the server deletes itself through the API when the copier exits (any reason) or when CAP_SECONDS pass
#      (systemd timer on the server);
#   2. the watchdog here deletes it at CAP_SECONDS, when OUT/stop appears (copier ended or budget tripped), or when
#      outgoing traffic reaches 80% of the included traffic; it reports cost every 30 minutes into OUT/cost.log;
#   3. the script ends by checking that the project lists 0 servers.
#
# Secrets: the Hetzner token is read from the secrets vault into this shell's memory and handed to hcloud only in
# its own environment (never argv, never a file on the Mac); on the server it lives in /dev/shm (memory) and dies with
# the server. The SSH key is made for this run, kept in a private temporary folder, and moved to the Trash at the end.
#
# Usage: carry-on-a-cloud-server.sh STORE ACCOUNT FROM TO WORK_LIST OUT SERVER_TYPE LOCATION CONCURRENCY CAP_SECONDS
# Environment: MOVER (Mac account_files_move), CARRIER (linux arm64 account_files_carry), VAULT (secrets executable),
#              USD_PER_HOUR (server + IPv4, from the Hetzner pricing API), and PACK=pack to pack the
#              work list's keys into archives with manifests (`account_files_move remote-setup ... pack`).
set -euo pipefail
store=$1 account=$2 from=$3 to=$4 list=$5 out=$6 type=$7 location=$8 width=$9 cap=${10}
: "${MOVER:?}" "${CARRIER:?}" "${VAULT:?}" "${USD_PER_HOUR:?}"
mkdir -p "$out"
log="$out/cost.log"
stamp() { date '+%I:%M:%S %p %Z'; }
say() { echo "$(stamp) $*" | tee -a "$log"; }

token=$("$VAULT" secrets "$store" "$account" read hetzner-api-token 3>&1 1>/dev/null)
hc() { HCLOUD_TOKEN="$token" hcloud "$@"; }
[ "$(hc server list -o json | jq length)" = 0 ] || { say "the project already has servers; refusing to add one"; exit 1; }

# Whatever ends this script (a refused create, a lost connection, a signal), it leaves no server and no SSH key of
# its own behind: the exit trap deletes both (a second delete of what the watchdog already removed is a no-op) and
# reports what the project still holds.
server_id='' key_id='' keys=''
leave_nothing() {
  local code=$?
  [ -z "$server_id" ] || hc server delete "$server_id" >>"$log" 2>&1 || true
  [ -z "$key_id" ] || hc ssh-key delete "$key_id" >>"$log" 2>&1 || true
  [ -z "$keys" ] || trash "$keys" || true
  say "servers left in the project: $(hc server list -o json | jq length); SSH keys left: $(hc ssh-key list -o json | jq length)"
  exit "$code"
}
trap leave_nothing EXIT
trap 'exit 143' HUP INT TERM

keys=$(mktemp -d)
ssh-keygen -q -t ed25519 -N '' -C copier -f "$keys/key"
name="namespace-carrier-$(date +%s)"
key_id=$(hc ssh-key create --name "$name" --public-key-from-file "$keys/key.pub" -o json | jq -r '.ssh_key.id // .id')
created=$(hc server create --name "$name" --type "$type" --location "$location" --image ubuntu-24.04 --ssh-key "$key_id" -o json)
server_id=$(jq -r '.server.id' <<<"$created")
address=$(jq -r '.server.public_net.ipv4.ip' <<<"$created")
start=$(date +%s)
say "server $server_id ($type, $location, $address) created; \$$USD_PER_HOUR per started hour; cap $cap s"

watchdog() {
  local next_report=$(( start + 1800 ))
  gone() {
    hc ssh-key delete "$key_id" >>"$log" 2>&1 || true
    say "watchdog: server $server_id is gone ($1); servers left in the project: $(hc server list -o json | jq length)"
    exit 0
  }
  kill_server() { say "watchdog: deleting server $server_id: $1"; hc server delete "$server_id" >>"$log" 2>&1 || true; gone "deleted: $1"; }
  while :; do
    local now; now=$(date +%s)
    (( now - start >= cap )) && kill_server "hard cap of $cap s"
    [ -e "$out/stop" ] && kill_server "stop: $(head -c 200 "$out/stop")"
    local described
    if described=$(hc server describe "$server_id" -o json 2>/dev/null); then
      local sent included
      sent=$(jq '.outgoing_traffic // 0' <<<"$described"); included=$(jq '.included_traffic // 0' <<<"$described")
      (( included > 0 && sent * 100 >= included * 80 )) && kill_server "outgoing traffic $sent of included $included (80%)"
      if (( now >= next_report )); then
        next_report=$(( next_report + 1800 ))
        local hours=$(( (now - start + 3599) / 3600 ))
        say "cost: $(( (now - start) / 60 )) min up; $hours started h x \$$USD_PER_HOUR = \$$(jq -n "$hours * $USD_PER_HOUR"); outgoing $sent of $included bytes included; copier: $(grep '"proved"' "$out/carry.log" | tail -1)"
      fi
    elif listed=$(hc server list -o json 2>/dev/null) && [ "$(jq "[.[] | select(.id == $server_id)] | length" <<<"$listed")" = 0 ]; then
      gone "no longer listed: it deleted itself"
    fi
    sleep 60
  done
}
watchdog &
watchdog_pid=$!

ssh_box() { ssh -i "$keys/key" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$keys/known_hosts" -o ServerAliveInterval=30 -o ConnectTimeout=10 "root@$address" "$@"; }
for _ in $(seq 60); do ssh_box true 2>/dev/null && break; sleep 5; done
scp -q -i "$keys/key" -o UserKnownHostsFile="$keys/known_hosts" "$CARRIER" "root@$address:/root/namespace_carry"
# The server's own killer: its token in memory (/dev/shm), a delete of itself on exit of the copier and at the cap.
printf 'Authorization: Bearer %s\n' "$token" | ssh_box 'umask 077; cat > /dev/shm/hetzner-auth'
ssh_box "cat > /usr/local/bin/delete-this-server <<'EOF'
#!/bin/sh
id=\$(curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id)
curl -s -o /dev/null -X DELETE -H @/dev/shm/hetzner-auth https://api.hetzner.cloud/v1/servers/\$id
EOF
chmod 700 /usr/local/bin/delete-this-server /root/namespace_carry
systemd-run --quiet --on-active=${cap}s --unit=copier-cap /usr/local/bin/delete-this-server"
say "server ready; carrying $(wc -l <"$list") keys with $width workers"

set +e
( "$MOVER" "$store" "$account" "$from" "$to" remote-setup "$list" "$width" ${PACK:+"$PACK"}; cat "$list" ) \
  | ssh_box 'trap "sleep 10; /usr/local/bin/delete-this-server" EXIT HUP; /root/namespace_carry; code=$?; echo "copier-exit $code" >&2; exit $code' \
    >"$out/proofs.jsonl" 2>"$out/carry.log"
set -e
# The server deletes itself 10 s after the copier ends (the proof lines are through by then), so ssh's own exit
# status may be the dropped connection; the copier's is the line it wrote before.
code=$(sed -n 's/^copier-exit //p' "$out/carry.log" | tail -1)
code=${code:-255}
say "copier ended with exit $code ($(wc -l <"$out/proofs.jsonl") proof lines)"
echo "copier exit $code" >"$out/stop"
wait "$watchdog_pid" || true
exit "$code"
