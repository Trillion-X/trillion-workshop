# run-an-installed-apps-command-line

A launcher a person's AI runs on the person's own computer. Some desktop apps ship a command-line program inside their own bundle (an Electron app often keeps a Node script under `Contents/Resources/app.asar.unpacked/node_modules/<name>/bin/`) but never put it on the PATH. This runs that entry as if it were installed. The app and the entry are the person's, passed in; nothing about any app is built in.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:run-an-installed-apps-command-line`: `on-your-computer`, with the command that runs it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/run-installed-cli` | The launcher (POSIX `sh`). Node runs a `.mjs`, `.cjs` or `.js` entry; any other entry runs as itself. Arguments, output and exit code pass through. |
| `test/run-installed-cli.test.mjs` | Builds a made-up app bundle and checks argument and exit-code passthrough, both kinds of entry, and the refusals. |

## How to run it

```
sh tools/run-an-installed-apps-command-line/do-work/run-installed-cli <installed app> <entry inside it> [app arguments ...]
sh tools/run-an-installed-apps-command-line/do-work/run-installed-cli /Applications/HyperFrames.app \
  Contents/Resources/app.asar.unpacked/node_modules/hyperframes/bin/hyperframes.mjs --help
```

To call an app's command line by name, save a two-line script on the PATH:

```
#!/bin/sh
exec sh <workshop>/tools/run-an-installed-apps-command-line/do-work/run-installed-cli /Applications/<Name>.app <entry> "$@"
```

A missing app or entry, too few arguments, or an entry that is neither JavaScript nor executable exits 2 with `{"error": ...}` on standard error saying what to pass.

## Tests

```
node --test tools/run-an-installed-apps-command-line/test/*.test.mjs
```
