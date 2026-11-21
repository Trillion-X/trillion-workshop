# tools/keep-secrets-out-of-answers/

The one place that takes sign-in secrets out of a service's answer before a tool hands it back. A service can put the
caller's own token inside its answer. Meta's Graph API writes `access_token=…` into every `paging.next` and
`paging.previous` link, and other services echo keys in URLs or headers. A tool that returns such an answer as it came
puts the token into the step answer, the run record and the chat that reads it. That is how an Instagram token reached a
chat transcript on Nov 21 2026.

`stripSecrets(value)` walks any JSON value and gives back a copy in which every secret reads `[removed]`:

- a query parameter that carries a secret (`access_token`, `token`, `key`, `api_key`, `client_secret`, `refresh_token`,
  `code`, `signature` and the like) in any URL string;
- a `Bearer …` or `Basic …` credential inside any string;
- the value of a field named like a secret (`access_token`, `api_key`, `authorization`, `cookie`, `password` and the
  like).

Every other value comes back unchanged, so ids, permalinks, cursors and messages stay usable. A library: it offers no
tool of its own, and every row whose code imports it packs `read-data` beside its own files. It reads no file and makes
no network or account call.

## Files

| File | What it does |
|------|--------------|
| `read-data/strip-secrets.mjs` | `stripSecrets(value)` and `stripSecretsFromText(text)` |
| `test/strip-secrets.test.mjs` | A Graph paging answer, headers, nested fields, and values that must stay |
