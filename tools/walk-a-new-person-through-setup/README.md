# tools/walk-a-new-person-through-setup

What a person's own devices report about themselves (which cameras a computer sees, whether a phone's switches are on), kept so a setup step whose Done rule passes on one device's facts can tick itself. Moved from Trillion-X/trillion `src/device-facts.mjs` (a9ee258, #76); its bounds and words came byte for byte from the old tree (`moved-from.json`).

## Files

| File | Purpose |
|------|---------|
| `device-facts.mjs` | `deviceFacts(store)` (report, all) and `passedOnSomeDevice`, unchanged from the old tree |
| `device-facts.json` | The bounds (devices, sources, facts, name pattern, lengths) and refusal words (from old trillion `src/device-facts.json`) |
| `report-device-facts.mjs` | `reportDeviceFacts({ devices?, reports, now? })`: reports applied in order over a store kept for the run, the devices as kept answered (what `tool-rows.json` runs) |
| `moved-from.json` | Where `device-facts.json` came from, and both identities |
| `tool-rows.json` | The row `tool:keep-what-my-devices-report-about-themselves`, with a sample run over a made-up computer and phone |
| `README.md` | This file |

## The row

`tool:keep-what-my-devices-report-about-themselves` runs `report-device-facts.mjs` in a small container with no internet, through `tools/records-door/do-work/run-an-export.mjs`. It keeps nothing after the run and writes nothing. Ticking setup steps from the facts (the checklist's rules and the formula engine) and the Get started, plan, account, security and business pages stay with the app and the account.
