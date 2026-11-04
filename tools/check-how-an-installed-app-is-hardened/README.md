# tools/check-how-an-installed-app-is-hardened/

Reads how an installed macOS app is hardened from its files on disk and the system's own `codesign`, without launching it, and says in words what falls short of `read-data/app-hardening.json`. An Electron app signed with the hardened runtime can still be run as Node, or have its code archive edited, when its fuses are left at their defaults. The signature alone does not show that. It runs on the person's own Mac as a `computer` row, over the app folder the person granted for reading. Moved from Trillion-X/trillion `computer/app-hardening.mjs` (deleted in dc79bb0a87; read at its parent).

## Files

| File | Purpose |
|------|---------|
| `read-data/app-hardening.mjs` | `readFuses` (the fuse block in a framework binary's bytes, found by its sentinel and read per wire version), `signingFacts` (code-signing flags and the entitlements that are true, from `codesign`), `auditApp` (the findings for one bundle) and `audit`, the tool function. Moved one to one; the only addition is the named export `audit` for `run-an-export.mjs`. |
| `read-data/app-hardening.json` | The sentinel, the byte-to-state table, the fuse names per wire version, where the framework and Info.plist sit, which fuse states and entitlements are findings and why, and every word said. Moved unchanged. |
| `tool-rows.json` | `tool:check-an-app`: a `computer` row with `capabilities: ["read-a-folder"]`, run by `tools/records-door`'s `run-an-export.mjs`. The id is the one the Mac host gave it. |
| `part.json` | Nothing here is imported by other code. |
| `test/app-hardening.test.mjs` | The original tests, repointed: fuse reading, a weak and a hardened made-up bundle, what cannot be read, codesign parsing on stand-in output, and a live read of a real installed Electron app that is skipped where none is installed. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `readFuses` | `(bytes, settings?) => { version, fuses: { name: 'on' \| 'off' \| 'removed' } \| null, raw } \| null` | `null` when the binary has no fuse block; `fuses: null` for a wire version with no table. |
| `signingFacts` | `(app, run?) => Promise<{ signed, hardened, entitlements }>` | Runs `/usr/bin/codesign` with an argument list (never a shell); `run` is handed in by the tests. |
| `auditApp` | `(app, { settings?, facts? }) => Promise<Finding[]>` | A finding is `{ kind, name?, state?, said }`; kinds are `no_app`, `unsigned`, `not_hardened`, `entitlement`, `no_sentinel`, `unknown_version`, `fuse`, `integrity_not_enforced`. Empty means every expectation is met. |
| `audit` | `({ app }) => Promise<{ app, findings, ok }>` | The tool function `tool:check-an-app` runs. |

## How to run it

```
echo '{"app":"/Applications/Sample.app"}' | node tools/records-door/do-work/run-an-export.mjs \
  tools/check-how-an-installed-app-is-hardened/read-data/app-hardening.mjs audit
```

## Not yet

- The row asks only for `read-a-folder` (the person grants the app, or the folder holding it). It also starts `/usr/bin/codesign`, which the engine's `base` sandbox lets a run execute, but whether `codesign -dv` and `--entitlements` can reach the Security services they look up under `deny default` has not been measured on the engine. No capability in the engine's `src/runtime/workshop/computer-capabilities.json` grants those lookups yet. If they are denied, `signingFacts` reads the bundle as unsigned, and the check says so in words rather than passing it.
- The run has not been proved end to end on the engine.

## Tests

```
node --test tools/check-how-an-installed-app-is-hardened/test/app-hardening.test.mjs
```

## Dependencies

**Depends on:** `tools/records-door` (the command that runs a function), `tools/content-identity`, Node's standard library, macOS `/usr/bin/codesign`.

**Depended on by:** `tool-rows.json`. In Trillion-X/trillion, finding F-0045 has a second half, `computer/switch-guard.mjs`. It stays there, called by `computer/end-with-the-app.mjs` in the Mac app, and is not moved here.
