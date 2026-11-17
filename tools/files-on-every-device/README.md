# tools/files-on-every-device/

The person's files as a native folder on every device: Finder and Files on macOS and iOS, Explorer on Windows, the Files app on Android, a mounted folder on Linux. Every rule the folder needs lives once, in `core/`; each OS adds only a thin shell that translates its callbacks (plan PLAN-files-on-every-device, task F2).

## Files

| File | Purpose |
|------|---------|
| `part.json` | What other trees import: the C ABI header, the crate, the contract DATA (imported by trillion-apps' shells) |
| `core/` | The files core, a Rust crate with no I/O; see `core/README.md` |

## How a shell uses it

```
OS callback / network answer / time  --event JSON (+bytes)-->  files_core_event
files_core_next_command  --command JSON (+bytes)-->  shell: send a request, write bytes, show items, read the local file
```

A shell holds no rule, number, retry or conflict policy: if it needs one, the rule belongs in the core. It adds only what only the OS has: its callbacks, the temp file the OS reads, its HTTP client, the device credential in its keychain, and the "turn it on" page Apple requires.

## Dependencies

**Depends on:** `tools/formula-engine` (`crates/compile-rules`, `crates/evaluate-over-rows`) for ignore rules; the files contract of `tools/live-namespace` (`src/account_files`), whose operations, fields and bounds `core/contract.json` names.

**Depended on by:** the OS shells (trillion-apps; lane finder-folder for macOS and iOS first).
