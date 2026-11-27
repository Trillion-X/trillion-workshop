# tools/check-a-computer-from-outside/

What anyone on the internet can see of one computer, compared with what its row declares (roadmap plan W2.1).

## Files

| File | Purpose |
|------|---------|
| `what-this-tool-does-and-how-to-run-it.json` | `tool:check-a-computer-from-outside`: input {name, address, declared_ports, names, also_try}, answer the ports, certificates, SSH version line, domains' registration expiry, connection times and findings. A container run with `may_reach`, no package and no held value. |
| `do-work/check-from-outside.mjs` | The check: every port of `settings.json` ports_to_try and every declared port through the run's own proxy (a CONNECT tunnel each), each name's certificate over TLS, the SSH version line, each name's registration expiry from RDAP (rdap.org: the name, then each parent, until its registry says one is registered), and the findings. |
| `settings.json` | What it tries and when a difference is a finding: the ports, the time to wait, the certificate and domain warning days. |
| `test/check-from-outside.test.mjs` | An undeclared open port and a declared closed port are one finding each (local ports), the domain of a name, and the row's packing. |
| `kits/check-a-computer-from-outside.json` | Its kit. |

It names no store: the caller hands the computers in as values, and `workflow:check-every-computer-from-outside` tells each finding as a computer-finding fact.

Not read from outside, so not here: disk free, backup freshness and the last restore drill (a computer reports those itself), and SSH's offered login methods (they need a key exchange). A Postgres login probe is the person's own database tool's job, with their held connection.
