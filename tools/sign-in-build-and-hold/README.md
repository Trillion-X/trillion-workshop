# tools/sign-in-build-and-hold

Built, not wired: the sign-in decisions that the earlier code base made and that the port lost (calendar rows
`verify-every-port-sign-in-*`, lane vep-L05). Each item is a pure, storage-free rules module with its DATA beside it and a
test file. Nothing here is in `tool-rows.json`, `package-files.json`, a kit, a route or a screen mount; each item waits for the
owner's word before it is wired. The storage, the clock reads, the sign-in and the sending of notices stay with the caller.

## Files

| Item (read-data/<item>.mjs) | Ported from | Rules it decides | Tests |
|------|------|------|------|
| `verify-every-port-sign-in-call-limits` | `src/sign-in-calls.mjs` and `.json` (b6ae0ebf815f) | the tier a call falls in, the 429 answer, a counter of calls per minute by sign-in | 7 |
| `verify-every-port-sign-in-authenticator-setup` | `src/sign-in-methods.mjs` and `.json` (b6ae0ebf815f) | backup-code generation and reading form, fresh sign-in, the authenticator setup's first right code and its wait | 8 |
| `verify-every-port-sign-in-guarded-change-confirm` | `src/cap-change.mjs`, `src/passkey-authority.mjs` (b6ae0ebf815f) | the change key, the confirmation words, the held confirmation, the refusal for a change without a known passkey's confirmation | 8 |
| `verify-every-port-sign-in-hosting-window` | `src/account/sign_in/sessions.rs` (Rust, commit 2b8b821a4; no JavaScript counterpart) | the window's session row: start, live check, sliding | 6 |
| `verify-every-port-sign-in-keys-list-turn-off` | `src/personal-keys.mjs` and `.json` (b6ae0ebf815f) | what a key row shows, the bounded list, expiry rules, who may turn a key off | 9 |
| `verify-every-port-sign-in-known-passkey-authority` | `src/passkey-authority.mjs` and `.json` (b6ae0ebf815f) | a passkey's provenance and when it becomes known, recovery, delayed deletion or move, vouching, notice room, legacy classification | 11 |

Each `.json` file is the DATA the module reads (its `_what` says what it holds and which earlier file it came from).

## Changes from the earlier words

- The brand word is not used. Where an earlier message named the service, the message says "the service" or "your account".
- The authenticator app's issuer label is not in the DATA: the wiring owner names it.
- The plan tier in call limits is kept as the earlier code had it; the Rust port dropped it.

## Run

`node --test tools/sign-in-build-and-hold/test/<item>.test.mjs`
