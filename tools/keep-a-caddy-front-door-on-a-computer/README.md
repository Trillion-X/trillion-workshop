# Keep a Caddy front door on a computer

Caddy's own part of a computer row: the site file Caddy reads, the routes and pools in it, and the pages it answers itself. start-a-computer knows no program; a computer runs this kit when its row names a Caddy unit whose `prepare` is `tools/keep-a-caddy-front-door-on-a-computer/prepare-a-caddy-site.mjs`. The kit came out of start-a-computer on Nov 18 2026 (K3 of the plan that no general tool knows a program).

## A Caddy unit in a computer row

```json
{
  "unit": "caddy.service",
  "user": "caddy",
  "prepare": "tools/keep-a-caddy-front-door-on-a-computer/prepare-a-caddy-site.mjs",
  "site": { "site_hosts": ["place.example.test"], "port": 7199 }
}
```

The unit names no `template`: Caddy's own unit file is the computer's (a package's, or the person's own, listed in the row's `unmanaged`). Its drop-ins are files the row names, like any unit's; `storage.conf` here gives Caddy an environment file (`storage_env`). `prepare` answers the unit with its `files`:

- `/etc/caddy/Caddyfile`, rendered from `site`. Before it replaces the live file, the Caddy the site names (`binary`, else `caddy`) validates it, and a change is applied by `systemctl reload <unit>`, so a call in flight is never dropped.
- Every page the request hands in (`pages_folder`), under `pages_root`. Writing a page restarts nothing.

## The site

A site with `site_hosts` and `port` gets one block per name (`sites/one-block-per-name.caddy`) sending to that port, with the site's `routes` first inside each block.

Every site that names its hosts (`site_hosts`, or `site_file: "single-name-front-door"`) ends with a catch-all (`sites/refuse-other-hosts.caddy`): a Host no block names gets 421 at Caddy. Without it Caddy answers that Host with an empty 200, which looked like a live front door.

A site that names `site_file` gets that whole file from `sites/`, each `{{field}}` filled from the site. A `{{routes}}` or `{{<name>_routes}}` slot is that list of route names (`routes/`), and a line that is only an empty routes slot is left out. Caddy's own `{placeholders}` are left as they are.

`site_file: "single-name-front-door"` makes a computer the front door of one name (`door_host`) with nothing between Caddy and the engine:
- Caddy keeps that name's certificate itself. There is no shared store, no attached names and no forwarder.
- It answers the person's own pages from `pages_root` and every other path with 404.
- It sends the paths in `engine_paths` to the `engine` pool, but only when `engine_routes` names `engine`.
- `grace_period` is how long a reload lets calls in flight finish.
- `request_max` bounds every request body but a raw upload (`Content-Type: application/octet-stream`), which `upload_max` bounds: the engine takes an upload in pieces of up to its `upload_most_bytes` (trillion-rust src/mcp/settings.json, 32 MiB), so `upload_max` is that and `request_max` stays small for JSON.
- It logs one JSON line per request to the journal: the method, the address without the query, the status and the duration. Every header, client address, cookie and query value is removed, so a sign-in attempt is visible without keeping anything private.

`site_file: "certificate-only"` keeps the certificate of one name or IP address (`door_host`) with the ACME profile `certificate_profile` and serves nothing (every request is 404), for another program on the computer that reads the certificate and key from Caddy's storage, such as a database server's TLS listener (its unit's `files_read_at_start`, restarted by a `watch-a-file` path when Caddy renews). Let's Encrypt issues an IP address only the `shortlived` profile.

`site_file: "each-name-its-own-folder"` answers every name that has a folder of its own under `pages_root` (`pages_root/<name>/`, with `www.<name>` sent on to `<name>` by a 308, or, for a bare name the site's `www_first_names` lists, answered itself while `<name>` is sent on to it), read-only, and gets each name's certificate the first time it is asked for (Caddy's on-demand certificates, after a loopback check that the folder exists, so a name with no folder gets none). The computer's own address (`door_host`) keeps its certificate (`certificate_profile`) and answers 404. A request no page answers (any method) goes to the site's own program when it has one: the program a unit of the row runs, listening on `programs_root/<name>/http.sock`, its folder made by that unit. Neither this file nor the computer's row's Caddy unit names a site: a site is a folder in the request's `pages_folder`, which may be a link to the folder its owner keeps, and a program of its own is its folder under `programs_root`.

A name whose site moved to another computer is listed in the site's `served_elsewhere` (`{ "to": "https://<address>", "names": [host names] }`): every request for it goes there whole, with its own Host and its own name for TLS (`routes/served-elsewhere.fragment`), before any page or program here. Each listed name is its own canonical name, so the www redirect never sends it on, and the certificate question answers 200 for it, so it keeps its certificate here. A visitor or crawler whose DNS still points at this computer gets the live site's answer instead of a stale copy (Nov 25 2026: two sites moved to another host, and the old copy of one here answered a page with 503 to a visitor whose DNS was stale). A name may not also be in `site_sockets` or `www_first_names`.

A name about to move to a computer whose front door gets its certificate on the first handshake, from an ACME HTTP-01 check, is listed in the site's `acme_challenge_elsewhere` (`{ "to": "http://<address>", "names": [host names] }`): only `/.well-known/acme-challenge/*` for it goes there, with its own Host (`routes/acme-challenge-elsewhere.fragment`), before any page or program here; every other request is served here as before. So the other computer gets its certificate while DNS still points here, and the name then moves with no moment without one (Nov 25 2026: a name moved before its new host had a certificate; the check reached this computer five times and the name was locked out of new certificates for an hour). The www rule's 308 never takes `/.well-known/acme-challenge/*`, so a name it sends on (www.<name> of a bare name that answers itself) is listed too and its check reaches the other computer at its own name; one `served_elsewhere` already sends there whole is refused.

A program that switches between two slots without a gap names both slots' sockets in the row's Caddy `site_sockets` (`{"<name>": ["/run/sites/<name>/http-a.sock", "/run/sites/<name>/http-b.sock"]}`, absolute `.sock` paths). Only names listed there use it (`routes/site-sockets.fragment`): requests go to the first socket that answers (`lb_policy first`), and a socket that refuses is skipped for 2 s (`fail_duration`), so the slot that is starting and the slot that is stopping overlap and no request waits. Without `fail_duration`, `first` keeps choosing the dead socket, and each request waits the whole 15 s try. Every other name keeps `programs_root/<name>/http.sock`. The two slot units say `runtime_preserve: "yes"` in start-a-computer, so the slot that stops does not remove the shared `/run` folder.

A site that asks for its request log (`access_log`) gets one JSON line per request in its `https://` block: the method, the address without the query, the status, the duration and the time (`ts`). Every header, cookie, TLS detail and query value is removed, and the client address too unless `keep_ip` is `true`.
- The lines go to the journal (`log journal`), where start-a-computer's apply-checked fact reads the failures of an apply window.
- When the row names `file` (`{"path": "/var/log/caddy/<name>.log", "roll_size": "10MiB", "roll_keep": 10}`), the same lines go to that file too (`log file`). Caddy starts a new file past `roll_size` and keeps `roll_keep` old ones, gzipped, beside it, so the log stays bounded.
- The file is in `/var/log/caddy`, the folder Caddy's package makes for its own user. The site file's check (`caddy validate`, run as root) makes the file owned by root, so a changed site file gives the folder and the file to the unit's `user` before the reload.
- The requests of each second: `jq -r '.ts | floor' /var/log/caddy/<name>.log | uniq -c` (or `journalctl -u caddy -o cat | jq -r 'select(.logger | startswith("http.log.access")) | .ts | floor' | uniq -c`).

## Routes and pools

A site names each route by path, like a unit's template: a file the program it sends to publishes (a relative path inside the Workshop, or an absolute path of the person's own), filled from the site's fields. A route that is a module (`.mjs`) answers its text from `route()`, so a program that computes its route from its own data keeps that data. This kit names no route of its own:
- The sign-in tool's routes are `tools/better-auth-official/on-a-computer/caddy-route-*`.
- The engine's route is `tools/keep-an-engine-on-a-computer/caddy-route-engine.caddy`: it sends `engine_paths` to the engine's pool.
- In `each-name-its-own-folder`, the site's `routes` go first in the `https://` block. `tools/keep-an-engine-on-a-computer/caddy-route-engine-at-names.caddy` sends `engine_paths` of only the names in `engine_hosts` to the engine's pool, so the engine answers a door at a site's own name (its `/mcp`, say) and every other path stays the site's.

Every slot of a program is one pool: `pools: {<name>: {listen: [every slot's address], health_uri, health_interval, try_duration, lines?}}`, filled into a route as `{<name>_proxy}`. The engine route uses `engine`; the sign-in routes use `auth`.
- Caddy sends each call to the first slot that answers its health page. A slot that is stopping answers 503 and gets no new call.
- A refused connection is tried at the next slot for up to `try_duration`.
- `lines` are the pool's own `reverse_proxy` lines, such as a Host header.

An inner door (`inner_doors: [{listen: "127.0.0.1:<port>", pool}]`) is a loopback address Caddy holds for programs on this computer, such as the engine's call to the sign-in tool's own listener. It sends to a pool, so that caller never follows a slot switch.

## Pages

The pages are the caller's own data, and this kit holds none. The request hands them in as `pages_folder`. A site that names `pages_root` gets every file of that folder under `pages_root`: a text file as its text, any other file as base64 that the computer decodes, so the bytes are the same. The site file serves a GET or HEAD for any of them through Caddy's `file_server`, and a path without `.html` finds its page. A site that names `pages_root` with no pages handed in is refused.

## Checks

`test/a-caddy-site.test.mjs` covers the site file in both shapes, the routes, pools and inner doors, the pages and their bytes, and how each file is applied, all with synthetic sites. Run `node --test tools/keep-a-caddy-front-door-on-a-computer/test/*.test.mjs`.
