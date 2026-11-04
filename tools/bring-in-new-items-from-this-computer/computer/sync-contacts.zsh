#!/bin/zsh
# computer/sync-contacts.zsh
#
# Purpose: keeps the contacts on this Mac in the person's Trillion list. `install` puts the three files in the person's
# Trillion folder, keeps their key in the Keychain (asked once, never written to a file or a command line) and starts a
# LaunchAgent that runs `run` at login, whenever Contacts change and every `every_seconds`. `run` reads what changed
# (sync-contacts.js), sends it to POST <origin>/mcp/api/lists/<list>/people, says this Mac is present for the
# Connections screen, and answers any job handed to it that it cannot do. `remove` stops it.
#
# Setup, from Connections > Mac Contacts (every value is in sync-contacts.json beside this file):
#   curl -fsS --create-dirs --output-dir "$HOME/Library/Application Support/Trillion" \
#     -O https://app.gettrillion.ai/computer/sync-contacts.zsh -O https://app.gettrillion.ai/computer/sync-contacts.js \
#     -O https://app.gettrillion.ai/computer/sync-contacts.json \
#     && zsh "$HOME/Library/Application Support/Trillion/sync-contacts.zsh" install [<list id> <list name>]
#
# Non-Negotiable Invariants:
#   1. The key lives only in the Keychain and in this process's memory; it reaches curl through a pipe, never argv.
#   2. The last-sent state moves forward only after every request of the run was accepted, so a failed run is sent again.
#   3. Every failure prints one line from `words` saying what to do, and exits non-zero.
setopt err_exit no_unset pipe_fail

here=${0:A:h}
settings=$here/sync-contacts.json
setup=$here/sync-contacts-setup.json
state=$here/sync-contacts-state.json
pending=$here/sync-contacts-pending.json

value() { /usr/bin/plutil -extract "$1" raw -o - "$2" }
say() {
  local line
  line=$(value "words.$1" "$settings")
  shift
  while (( $# >= 2 )); do line=${line//\{$1\}/$2}; shift 2; done
  print -r -- "$line"
}
origin=$(value origin "$settings")
item=$(value keychain_item "$settings")
label=$(value launch_agent "$settings")
plist=$HOME/Library/LaunchAgents/$label.plist

key_now() { /usr/bin/security find-generic-password -s "$item" -w 2>/dev/null }

# POST <path> <body> with the key from the Keychain; prints the answer, returns 1 on anything but a 2xx.
post() {
  local key answer code
  key=$(key_now) || { say no_key >&2; return 1 }
  answer=$(print -r -- "$2" | /usr/bin/curl -sS -X POST "$origin/mcp/api$1" -H @<(print -r -- "authorization: Bearer $key") \
    -H 'content-type: application/json' -H 'x-trillion-app: sync-contacts' --data-binary @- -w $'\n%{http_code}')
  code=${answer##*$'\n'}
  answer=${answer%$'\n'*}
  print -r -- "$answer"
  if [[ $code == 401 || $code == 403 ]]; then say refused_key >&2; return 1; fi
  [[ $code == 2* ]]
}
field() { print -r -- "$1" | /usr/bin/plutil -extract "$2" raw -o - - 2>/dev/null || true }

do_run() {
  local list_id list_label bodies line answer computer agent_id changed=0 added=0 updated=0 people
  list_id=$(value list.id "$setup")
  list_label=$(value list.label "$setup")
  bodies=$(/usr/bin/osascript -l JavaScript "$here/sync-contacts.js" "$settings" "$setup" "$state" "$pending") \
    || { say not_sent reason "${$(say no_access)%.}"; return 1 }
  for line in ${(f)bodies}; do
    answer=$(post "/lists/$list_id/people" "$line") || { say not_sent reason "${$(field "$answer" error)%.}"; return 1 }
    added=$(( added + $(field "$answer" added) ))
    updated=$(( updated + $(field "$answer" updated) ))
    changed=$(( changed + $(field "$answer" added) + $(field "$answer" updated) + $(field "$answer" unchanged) ))
  done
  people=$(value people "$pending")
  /bin/mv -f "$pending" "$state"
  if (( changed )); then say sent changed $changed people $people list "$list_label" added $added updated $updated; else say nothing_new; fi

  # Present for the Connections screen: this Mac carries its contacts while it keeps running.
  computer=$(/usr/sbin/scutil --get ComputerName 2>/dev/null || hostname -s)
  agent_id="$(value source.id "$settings")-$(print -r -- "$computer" | tr -cs '[:alnum:]' '-' | tr '[:upper:]' '[:lower:]' | sed 's/-*$//')"
  post /agents/publish "$(/usr/bin/osascript -l JavaScript -e 'function run(a){ return JSON.stringify({ agent_id: a[0], name: a[1] + " on " + a[2], description: a[3], skills: [{ id: a[4], name: a[1] }], harness: "sync-contacts", where: a[2], takes_work: true, capacity: { max_concurrent: 1, ttl_minutes: Number(a[5]) } }) }' \
    "$agent_id" "$(value source.label "$settings")" "$computer" "$(value carrier.description "$settings")" "$(value carrier.skill.id "$settings")" "$(value carrier.ttl_minutes "$settings")")" >/dev/null
  # A job handed to this Mac is not one it can do: it says so, so nobody waits on it.
  local taken handoff job
  while taken=$(post /handoffs/take "{\"agent_id\":\"$agent_id\",\"only_mine\":true}") && handoff=$(field "$taken" handoff.handoff_id) && [[ -n $handoff ]]; do
    job=$(field "$taken" handoff.job)
    post /handoffs/finish "$(/usr/bin/osascript -l JavaScript -e 'function run(a){ return JSON.stringify({ handoff_id: a[0], agent_id: a[1], result: { error: a[2] }, summary: a[2] }) }' "$handoff" "$agent_id" "$(say not_a_job job "$job")")" >/dev/null
  done
}

do_install() {
  local list_id=${1:-$(value list.id "$settings")} list_label=${2:-$(value list.label "$settings")}
  /usr/bin/osascript -l JavaScript -e 'function run(a){ return JSON.stringify({ list: { id: a[0], label: a[1] } }) }' "$list_id" "$list_label" > "$setup"
  if ! key_now >/dev/null; then
    say ask_key
    # -w last: security asks for the key itself, so it is never on a command line.
    /usr/bin/security add-generic-password -U -a trillion -s "$item" -w < /dev/tty
  fi
  /bin/mkdir -p "${plist:h}"
  /usr/bin/osascript -l JavaScript -e 'function run(a){
    const plist = { Label: a[0], ProgramArguments: ["/bin/zsh", a[1], "run"], RunAtLoad: true, StartInterval: Number(a[2]),
      WatchPaths: [a[3]], ThrottleInterval: 60, StandardOutPath: a[4], StandardErrorPath: a[4] };
    const data = $.NSPropertyListSerialization.dataWithPropertyListFormatOptionsError($(plist), $.NSPropertyListXMLFormat_v1_0, 0, null);
    return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js }' \
    "$label" "$here/sync-contacts.zsh" "$(value every_seconds "$settings")" "$HOME/$(value watch "$settings")" "$here/sync-contacts.log" > "$plist"
  /bin/launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  /bin/launchctl bootstrap "gui/$(id -u)" "$plist"
  say installed list "$list_label"
}

do_remove() {
  /bin/launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  /bin/rm -f "$plist" "$state" "$pending"
  say removed
}

case ${1:-run} in
  install) shift; do_install "$@" ;;
  run) do_run ;;
  remove) do_remove ;;
  *) print -r -- "Use: zsh sync-contacts.zsh install [<list id> <list name>] | run | remove" >&2; exit 2 ;;
esac
