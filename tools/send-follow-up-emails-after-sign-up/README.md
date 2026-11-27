# tools/send-follow-up-emails-after-sign-up/

The existing sign-up follow-up policy, ported from old Trillion `src/follow-up-emails.mjs` at `old-trillion-before-worker-retire`. It sends at most the newest overdue step, claims all overdue steps before delivery, skips an account without email, and ends after a purchase, a valid stop token or the last step. Starting a sequence is explicit; account creation does not start one here.

`do-work/follow-up-emails.mjs` exports `makeFollowUps`, `followUpFacts`, `boughtSomething`, `offerWords` and `stepEmail`. All state operations are asynchronous. `followUpFacts(door, {type, id})` uses the current records door and conditions each write on the exact previous value. A competing wake loses its claim before sending.

The host supplies `settings` from its current content rows, `readOfferRecords()` with resolved current offers, `upgradeOfferId()`, `paidWorth()`, `postalAddress()`, the current account's `person` interface, and the admitted `send(message)` binding from `tools/send-messages`. No retired Worker, account-control or billing implementation is imported. The retained JSON file is historical input already present before this port; runtime code does not import it. Tests use it as a fixture. No content is newly stored as files.

This is an imported policy module with explicit host interfaces. It has no automatic scheduler, account-creation hook or runnable mail row, and does not claim live delivery. The source baseline and `ports/follow-up-emails.json` record the move. Tests cover all four days, changing prices, stop tokens, purchases, late wakes, missing email and competing claims without contacting a mail provider.

`src/follow-up-emails.json` was moved byte for byte from Trillion-X/trillion at tag `old-trillion-before-worker-retire` (b6ae0ebf81) by `tools/move-code-between-trees` (move row `move-rows/older-repository-tools-a-l-round-3.json`). `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. It is not a tool yet (no `what-this-tool-does-and-how-to-run-it.json`): its files are imported by path.

## Files

| File | From |
|------|------|
| `src/follow-up-emails.json` | `src/follow-up-emails.json` |
| `do-work/follow-up-emails.mjs` | `src/follow-up-emails.mjs`, ported onto the records door (see `ports/follow-up-emails.json`) |

## Dependencies

**Depends on:** the files its moved files import, at the paths those imports name.

**Depended on by:** nothing in this repository yet.
