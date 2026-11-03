# tools/administer-a-rented-host/

A library, with no rows of its own: the SSH arguments that reach a rented Linux host as its administrator. Every tool that administers that host (building and installing the public receptionist, and later keeping a door tunnel open and renewing a TLS certificate) packs this one copy in its row's `invoke.files.package_files`. None of them keeps its own.

`do-work/administration-arguments.mjs` came from Trillion-X/trillion `scripts/portable-service-connection.mjs` (`administrationArguments`). It differs from the old copy in four ways:

- The host is the caller's input: `{ address, ssh_port, admin_user, host_key }`. The old copy always signed in as `root`, always used port 22 and read the key file from a config. This copy writes in no host, port or user.
- The host key is pinned from the input (`knownHostsLine`). The old copy pinned it with a first-use `ssh-keyscan`.
- The address can be an IPv4 address or a DNS name.
- Only the key file it is given is used: no agent, no password, no new host key accepted.

| Export | What it does |
|--------|--------------|
| `checkedHost(host)` | Returns the host, or throws a refusal that says which field to fix. |
| `knownHostsLine(host)` | Returns the one `known_hosts` line that pins the host (`[address]:port` for any port but 22). |
| `administrationArguments(host, { keyFile, knownHostsFile })` | Returns the `ssh` arguments that go before the remote command. |
| `port(n)` | Tells whether `n` is a port number. |

Tests: `node --test tools/administer-a-rented-host/test/`. Every host in them is synthetic (192.0.2.x, example.com).
