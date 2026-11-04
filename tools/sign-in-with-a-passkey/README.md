# tools/sign-in-with-a-passkey

The ways in on the sign-in pages: the passkey step, the emailed codes and the email-and-password form. The page script (`passkey.mjs`) is kept here as it was moved; it runs only in a browser. The row runs the part that needs no browser: how strong a new password reads, in the words the page shows under the new password's box.

## Files

| File | Purpose |
|------|---------|
| `passkey.mjs` | The sign-in pages' browser script from Trillion-X/trillion src/client/passkey.mjs (moved in a9ee258, #76); it imports `./password-strength.mjs` and `./passwords.json` from this folder, its other imports are not here |
| `password-strength.mjs` | `passwordScore(password)`, `passwordStrengthSaid(password)`: the score 0-3 and its words (brought in byte for byte, `moved-from.json`) |
| `passwords.json` | DATA: the password rules (kdf, lengths, tries), the strength words and every word a person reads (brought in byte for byte, `moved-from.json`) |
| `judge-a-new-password.mjs` | `judgeNewPassword({ password })`: score, words, length bounds and whether it is too long; the password is never kept or printed (what `tool-rows.json` runs) |
| `moved-from.json` | Where each brought-in file came from, with the identity of its bytes |
| `tool-rows.json` | The row `tool:judge-a-new-sign-in-password`, with a sample run on a made-up password |
| `README.md` | This file |
