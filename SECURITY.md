# Security

## Reporting a problem

Do not open a public issue or pull request for a security problem. Report it privately to the Trillion-X maintainers of this repository instead. This repository does not yet publish a security contact address, so say in the report which tool id (`tool:<name>`) and which folder's `what-this-tool-does-and-how-to-run-it.json` it concerns.

## What the rows promise

- **Files and folders.** A program row runs with the files its row packs (`invoke.files`) and the folders and values it declares. The container runner runs a row the way `test-helpers/run-a-row.mjs` runs a sample: packed files at their places, its arguments and input filled, and only the values its row mounts.
- **Accounts and secrets.** No key, token, password or personal detail belongs in code, rows, tests or examples (`CONTRIBUTING.md`, rule 6). A tool that needs an account takes it from the person at run time through the credentials its row names.
- **Network.** Only a row that holds `"may_reach"` is started with a network route, and that route is the engine's loopback proxy (`test-helpers/stand-in-egress.json` describes the settings). Every other row declares no internet access.
- **Private addresses.** A request to an address this computer, a private or shared network, a link-local or cloud-metadata address, or a name only a private network resolves is refused. The rule and its ranges are data in `tools/refuse-requests-to-private-addresses/public-address.json`. A name is judged by the addresses it resolves to, and a redirect is judged again at every hop (`tools/http-client/do-work/resolved-address.mjs`, `tools/http-client/README.md`). The public page reader (`tools/browse-public-page`) applies the same ranges before it fetches.

This file states what the repository's rows and checks promise. It does not replace the engine's own security documentation.
