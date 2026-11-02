# export-browser-login-cookies-for-yt-dlp

A script a person's AI runs on the person's own Mac. It writes one browser profile's YouTube and Google login cookies to a Netscape `cookies.txt` that yt-dlp reads with `--cookies`. yt-dlp's own Chrome reader asks the keychain for "Chrome Safe Storage"; other Chromium browsers keep their key under their own name (Arc: "Arc Safe Storage"), so this reads the key under the browser's own name.

The file it writes is the person's login: it is written readable by its owner only, and must never be shared or committed.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:export-browser-login-cookies-for-yt-dlp`: `on-your-computer`, with the commands that fetch it and run it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/export_cookies.py` | The command. The last line printed is `{"result": ...}` or `{"error": ...}`. |
| `test/test_export_cookies.py` | Builds a made-up profile with cookies encrypted the way Chromium does, using a made-up password from the environment, and checks the export, domain choice, both cookie-database places and the refusals. |
| `test/export-cookies.test.mjs` | Checks the row and runs the Python tests; skips, saying why, without python3 and cryptography. |

## How to run it

Run it in your own Terminal: macOS asks once to allow the browser's Safe Storage key (choose Always Allow).

```
python3 -m pip install -U cryptography
python3 -I tools/export-browser-login-cookies-for-yt-dlp/do-work/export_cookies.py --browser arc --profile Default --out ~/.config/yt-cookies/cookies.txt
yt-dlp --cookies ~/.config/yt-cookies/cookies.txt <url>
```

| Option | Meaning |
|---|---|
| `--browser` | `arc` (default), `chrome`, `chromium`, `brave`, `edge`, `vivaldi`: where its profiles are and its key's keychain name. |
| `--profile` | The profile folder: `Default`, `Profile 1` ... |
| `--out` | The cookies.txt to write. |
| `--domain` | Once per domain to export; default `youtube.com` and `google.com`. |
| `--user-data` | The browser's profiles folder, when it is not the usual one. |
| `--keychain-service` | The key's keychain name, when the browser uses another. |
| `--cookies-db` | A cookie database file to read, instead of `--user-data` and `--profile`. |
| `--password-env` | An environment variable holding the Safe Storage password, instead of asking the keychain. |

## Tests

```
node --test tools/export-browser-login-cookies-for-yt-dlp/test/*.test.mjs
```
