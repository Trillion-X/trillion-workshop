# tools/check-a-packages-declared-permissions/

A declared permission list is worth something only if the host enforces it at the API the package calls. This is the shared owner of that: a package's manifest is checked against permission rows (data), its entry file is confined to its own folder, and the host API handed to package code is wrapped so each privileged call checks the manifest first.

- **The permission rows are data** (`read-data/manifest-permissions.json`): network egress, reading files, writing files, running programs, the microphone and the screen, each with the host calls it gates. A permission nobody wrote a row for is refused, never ignored.
- **It fails closed.** A call that no row gates is not exposed to package code at all: the guarded API has only gated calls and the ones the host lists as `open`, so forgetting to list a new privileged call keeps it away from packages.
- **The guard runs where the call is made**, in the host's function, not in the package's code or the screen.
- **An entry that leaves its package folder is refused**: `..`, an absolute path, or a symlink whose target is elsewhere.

```
checkManifest({ permissions }, settings)   -> { ok, unknown: [ids], needs: [rows], why? }
confinedEntry(root, entry)                 -> the absolute path, or throws when it leaves root
guardApi(api, manifest, { open })          -> a frozen copy of api where every gated call is checked
```

## Files

| Path | What it is |
|---|---|
| `read-data/manifest-permissions.mjs` | The three functions, moved from old trillion `src/manifest-permissions.mjs` unchanged. |
| `read-data/manifest-permissions.json` | The permission rows and words, moved from old trillion `src/manifest-permissions.json` unchanged. |
| `do-work/check-a-manifest.mjs` | `tool:check-a-packages-declared-permissions`: a manifest checked against the shipped rows or the caller's own. |
| `test/manifest-permissions.test.mjs` | The assertions moved from old trillion `test/manifest-permissions.test.mjs`, and the row's. |
