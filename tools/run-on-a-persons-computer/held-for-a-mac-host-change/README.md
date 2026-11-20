# tools/run-on-a-persons-computer/held-for-a-mac-host-change/

Old bytes from the old `from-an-older-version/` folder that no current code uses and whose outcome is still unported. They wait here under their old names until the Mac host change named in the table is made. Nothing in this folder is imported, packaged (not in `part.json` or any `package-files.json` kit) or run.

| Here | Was | Capability it held | Verdict | Task row |
|---|---|---|---|---|
| `loopback-executor.json`, `loopback-executor.mjs.held` | `computer/loopback-executor.*`, deleted by dc79bb0a87 | a page on an allowed origin sends requests through a 127.0.0.1 executor: single-use token, session, per-request TLS floor, byte caps | LOST | `record:calendar-task:verify-every-port-run-on-a-persons-computer-page-executor` |
| `diagnostics.mjs.held` | `computer/diagnostics.mjs`, deleted by dc79bb0a87 | prepare the sealed host log and send it to a signed slot the page hands over | LOST | `record:calendar-task:verify-every-port-run-on-a-persons-computer-diagnostics-upload` |
| `harness-setup.mjs.held` | `computer/harness-setup.mjs`, deleted by 7fd8838475 | harness changes only for the computer ID the owning account records | LOST | `record:calendar-task:verify-every-port-run-on-a-persons-computer-harness-owner-check` |
| `test/computer-host-tools.test.mjs.held` | `test/computer-host-tools.test.mjs`, deleted by dc79bb0a87 | tests of tool:manage-helpers and tool:check-device-files on the Mac host | LOST (both) | `record:calendar-task:verify-every-port-run-on-a-persons-computer-manage-helpers`, `record:calendar-task:verify-every-port-run-on-a-persons-computer-device-file-audit` |

The records file moved to `../records/workshop-mac-program-tool-records.json`. Its two Mac program records are kept by the carry and read tools (see the research row `verify-every-port/run-on-a-persons-computer`).

