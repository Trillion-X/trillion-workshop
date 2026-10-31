# find-media-for-a-description

A script a person's AI runs on the person's own computer. Given a few words and whether it wants a still or a clip, it gets a file that fits: from one folder of the person's own tagged media, or from free-licence stock libraries. Which libraries, and which providers there are, are rows of data: adding one changes no code.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:find-media-for-a-description`: `on-your-computer`, with the command that fetches and runs it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/find_media.mjs` | The one entry point. Reads a request on standard input, looks its provider up in the table, checks the kind and licence the row offers, fills the row's argv from the request and runs it from this folder. No provider is named in it. |
| `do-work/bank-provider.mjs` | The `bank` provider: tagged lookup over one folder of the person's media (sidecar `<file>.tags.json`, plain word overlap over tags and file name); copies the best match, never changes the folder. |
| `do-work/stock-provider.mjs` | The `stock` provider: asks the libraries in `read-data/stock-sources.json` in order, with the person's key from the environment variable each row names, and downloads the first match. |
| `read-data/media-providers.json` | The provider table: id, kinds, licences and the argv template of each provider. |
| `read-data/stock-sources.json` | The free-licence libraries: where to search, how the key is sent, and where the file address is in each answer. |
| `read-data/stock-pick.mjs` | Pure readers of a library's answer: a dotted path, the largest file, the first address that is there, the encoded search. |
| `test/find-media.test.mjs` | The resolver: bank end to end on a made-up bank, kind, no match, unknown provider, constraints from data, no provider named in code, a made-up provider added as one row, the shipped table. |
| `test/stock-provider.test.mjs` | The stock provider against made-up libraries served from this computer: a row finds the largest file, the key goes on the search only, a source without a key is skipped, no result is a named failure, only the free licence is served. |

## How to run it

```
node do-work/find_media.mjs < request.json
```

`request.json`: `{ "provider": "bank", "description": "boats at sunrise", "kind": "clip", "bank_dir": "/folder/of/my/media", "out": "/folder/picked.mp4" }`. For `stock`, leave out `bank_dir`; the keys are in the environment variables named in `stock-sources.json`. `--providers FILE` uses another provider table. Exit codes: 2 unknown provider, 3 kind not offered, 4 licence not offered (or nothing found by the stock provider), 5 no `out`, 6 the provider made no file; the last line on success is `{"result": {provider, file, request}}`.

## Add a library or a provider

- A free-licence library: one row in `read-data/stock-sources.json` (`search` with `{query}` and `{key}`, `key_env`, `key_header` or `{key}` in the address, and for each kind a `pick`: `at` is a dotted path into the answer, `largest_by` chooses among files, `url` lists the paths that hold the address).
- A provider: one row in `read-data/media-providers.json`, for example a program that generates a clip from a description (`kind_support: ["clip"]`, `licenses: ["owned"]`, `run.argv` using `{request.description}`, `{request.seed}` and `{request.out}`).

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `pickUrl` | `(answer, { at, largest_by?, url[] }) => string \| null` | The file address a library's answer holds. |
| `searchUrl` | `(template, query, key) => string` | The search address, words and key encoded. |
| provider row | `{ id, kind_support[], licenses[], run: { argv[], timeout_ms } }` | One way to get a file. |

## Overlap with other Workshop tools

`tools/wikimedia-commons` and `tools/internet-archive` search one library each and read the rights of what they find; this fills a request from the person's own media or a ranked list of free-licence libraries and saves the file. `tools/media-composition` edits video and does not look for pictures to put in it.

## Dependencies

**Depends on:** Node 22 or later (standard library only). The stock provider reaches the libraries named in `stock-sources.json` with the person's own keys.

**Depended on by:** `tool-rows.json` (`tool:find-media-for-a-description`), run on the person's computer by their AI.
