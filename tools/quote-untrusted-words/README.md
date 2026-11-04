# tools/quote-untrusted-words/

The one way another party's words are quoted into a turn an AI reads. Mail, imported chats, web pages and titles other people wrote can carry characters that hide text from the person (bidi overrides, zero-width characters) or that write a tag around themselves (a `<` or one of its lookalikes). The quote normalises (NFC), strips control and format characters (keeping newline and tab), escapes `<` and its full-width and angle-bracket lookalikes, then truncates by code points. Every step is a row of `read-data/untrusted-text.json`; nothing here names a carrier, a tag or a character. The row runs in the tool container with no records door.

## Files

| File | Purpose |
|------|---------|
| `read-data/untrusted-text.mjs` | `quoteUntrusted(text, { max? })`. Moved byte for byte from Trillion-X/trillion `src/untrusted-text.mjs`. |
| `read-data/untrusted-text.json` | The steps as data: normal form, the stripped categories (`Cc`, `Cf`) and the kept characters, the escape rows, the ellipsis and the default limit (8000 code points). Moved byte for byte. |
| `read-data/quote-tools.mjs` | The row's function `quoteForTurn`: `{ text, max? }` in, `{ quoted, code_points }` out. |
| `tool-rows.json` | `tool:quote-untrusted-words`, a container row run by `tools/records-door`'s `run-an-export.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/untrusted-text.test.mjs` | Trillion's test of the quote with its assertions unchanged, and the row run as the container runs it. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `quoteUntrusted` | `(text, { max? }) => string` | Order is fixed: normalise, strip, escape, truncate. A cut never splits a surrogate pair or an escape, and the ellipsis is inside the limit. Anything but a string answers `''`. |
| `quoteForTurn` | `({ text, max? }) => { quoted, code_points }` | The row's function. |

## Moved from Trillion

Trillion-X/trillion `src/untrusted-text.mjs` and `src/untrusted-text.json`, with `test/untrusted-text.test.mjs`'s first test. Its other two tests run `src/inbound.mjs` (the inbound door that quotes a stranger's words, sender and title, and never the person's own), which stays in trillion until it moves; the old copy stays there until then.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library.

**Depended on by:** `tool-rows.json`. In Trillion-X/trillion, `src/quoted-words.mjs` and `src/inbound.mjs` still import their own copy.
