# tools/start-a-place/

Makes one Trillion place on the person's own computer and starts it. A place is the engine running on its own from one place config file, with no app around it (trillion-rust `src/native_entry/place.rs`).

This tool makes the place key once, writes the engine's place config, asks the engine for the place's id (`trillion-local place id CONFIG`) and starts `trillion-local serve CONFIG` in the background. It uses the person's own engine program. The request can name it in `trillion_local`, or the tool finds it on the PATH. The tool never builds it.

- **The key is made once and never shown.** The place key is `key_bytes` random bytes, written as base64 on one line, and only the person can read the file. A key file already in the folder is kept as it is. The tool never reads it, prints it or puts it in an answer. The place id is the place's public key, which the engine works out from this key.
- **The config is the engine's shape.** It holds `listen`, `accounts`, `place_key_file`, `public_origin`, `report`, `sign_in`, `sign_up` and `new_accounts`. It holds `router`, `access` and `default_places` only when the request gives them. The engine refuses unknown fields, so the tool writes no others.
- **The engine's rules are checked before anything runs.** `listen` must be an IP address and a fixed port. `public_origin` must be `https://` plus the host, with nothing else. `router` must be `host:port`. Folders must be absolute paths with no `.` or `..` parts. `report` may hold only the engine's report fields.
- **`default_places` must be a valid places list.** These are the places a new account that signs up here starts in.
  - `holders` names one place at least and `most_places` at most. `voters` names at most `most_places`.
  - Each entry is a place id (64 lowercase hex) or the word `this-place`. `this-place` stands for the place being started, whose id exists only once its key is made.
  - No place is named twice in one list, and every answering place is also a holder.
  - Once the id is known, `this-place` is replaced by the id, and the tool refuses unless this place is in both `holders` and `answering`. A sign-up here makes the account's door here, which is the engine's `DefaultPlaces::answers_at` rule.
  - The engine (`src/account/places.rs`) checks all of this again when it starts.
- **Steps run in order.**
  1. Check the request.
  2. Make the folder and the accounts folder.
  3. Make the key, if there is none.
  4. Write the config without `default_places`.
  5. Run `place id`.
  6. Fill in the id and check `default_places`, then write the config again with them.
  7. Run `serve`.

  If `default_places` is refused at step 6, the key and the first config stay. Nothing is started. Send the request again with the places fixed.
- **A place that stops at once is told.** The serve runs detached, and its output goes to `place.log` in the folder. If it exits within `settle_ms`, the answer is a refusal. The refusal gives the exit code and the log's last lines, which are the engine's stage words (`config`, `place-key`, `listener`, ...). The engine never logs a key or a value. If the place is still running after `settle_ms`, the answer gives its `pid` and how to stop it (`kill -TERM <pid>`). The engine stops on SIGTERM or SIGINT.
- **`start: false`** makes the key and the config and answers the id, without starting the place.

## Request and answer

Request on standard input:

```json
{
  "folder": "/srv/place-one",
  "accounts": "/srv/place-one/accounts",
  "listen": "0.0.0.0:7199",
  "public_origin": "https://place.example.test",
  "router": "router.example.test:7443",
  "report": { "takes_new_accounts": true },
  "default_places": { "holders": ["this-place", "<another place id>"], "answering": ["this-place"], "voters": ["this-place", "<another place id>", "<a third place id>"] },
  "trillion_local": "/opt/trillion/bin/trillion-local"
}
```

The last line printed is `{ "result": { place_id, folder, config_file, key_file, key_made, accounts, listen, public_origin, router?, default_places?, started, pid?, log_file?, stop? } }` or `{ "error": "what to change" }` (exit code 1).

Values the request leaves out come from `read-data/settings.json`:

- `report`: storage keeps 10 GiB free, cost 0, no contained tools, takes no new accounts, and `reach` is the public origin. Set `report.takes_new_accounts: true` for a place people sign up at.
- `sign_in` and `sign_up`: the engine's test place values (trillion-rust `tests/place_router.rs`).
- `new_accounts`: the product's own starting rows, `read-data/new-accounts.json`.

## Files

| File | Purpose |
|------|---------|
| `do-work/start-a-place.mjs` | The command. It exports `planOf(request)`, which checks the request and gives the config with nothing touched; `checkDefaultPlaces(lists)`; `placesFor(lists, placeId)`, which fills in `this-place` and applies the answering rule for this place; `programOf(named, env)`; and `startAPlace(request, { env })`. |
| `read-data/settings.json` | Numbers and names: the file names, the program name, the key size, the file mode, the https scheme, the places limit, the id length, the `this-place` word, how long the serve is watched, and the default report, sign-in and sign-up values. |
| `read-data/words.json` | Every refusal's words. |
| `read-data/new-accounts.json` | The starting rows of an account the place makes, a byte copy of trillion-rust `tests/fixtures/new-accounts.json`. |
| `tool-rows.json` | The row `tool:start-a-place`, which runs `on-your-computer`. |
| `ports/start-a-place.json` | The `NO_PRIOR_OWNER` claim for the command, with the search that found no other owner of this job. |
| `part.json` | No public files. |
| `test/start-a-place.test.mjs` | Checks that the config is the engine's shape. Checks the refusals: an http or non-bare origin, a bad listen or router, folders, report fields, and default_places (empty holders, answering outside holders, repeats, ids that are not 64-hex, over the limit, this place missing). Runs the steps in order against the stand-in engine, keeps an existing key, covers `start: false`, a serve that stops at once, a refused `place id`, a missing program, and the command's last line. |
| `test/fake-trillion-local` | A stand-in for the engine (POSIX `sh`). It writes each call down, prints a made-up id for `place id`, and for `serve` either keeps running or stops with a stage word. |

## Tests

```
node --test tools/start-a-place/test/*.test.mjs
```

## Dependencies

**Depends on:** the engine's `trillion-local` (trillion-rust `src/main.rs`: `serve PLACE_CONFIG_FILE`, and `place id PLACE_CONFIG` from `src/native_entry/place/join.rs`), and Node's standard library.

**Depended on by:** Trillion's deploy reads `tool-rows.json`.
