# local-files/do-work/

Actions that reach the machine's own filesystem through the native device-files capability, plus
the facts about a local file that other work needs to state.

## Files

| File | Purpose |
|---|---|
| `ask-local-file-display.ts` | Asks the native target how a local path should be displayed. |
| `choose-local-files.ts` | Opens the native operating-system file picker and returns selected files. |
| `choose-local-folder.ts` | Opens the operating-system folder picker through the native files target. |
| `create-local-directory.ts` | Creates a local directory through the native device-files capability. |
| `create-local-empty-file.ts` | Creates an empty local file through the native device-files capability. |
| `move-local-path-to-trash.ts` | Moves a local path to Trash through the native device-files capability. |
| `rename-local-path.ts` | Renames or moves a local path through the native device-files capability. |
| `reveal-local-path.ts` | Reveals a local path in the operating system's file browser. |
| `reveal-local-path.test.ts` | Test for the reveal action. |
| `send-local-file-selection.ts` | Sends a chosen file selection on to the target that asked for it. |
| `verify-selected-addressed-evidence.mjs` | CHECKS staged bytes against a digest and length the caller already knows, then emits the custody receipt. Throws on mismatch. |
| `ask-local-file-content-digest.mjs` | SAYS what the sha256 of a local file's bytes is. Prints `{path, byte_length, hex, prefixed}`. |

## Why asking and checking are separate files

`verify-selected-addressed-evidence.mjs` computes the same digest, but it can only check a value
you already have: it takes a request naming the expected digest and throws when they differ.
Asking "what is it?" and asserting "it is this" are different questions, and only the first can
be answered when the value is not known yet. The shared part is four lines, so each states them
rather than building an indirection between two callers.

## Why the digest capability exists here

Contracts elsewhere in this tree bind themselves to an exact text by carrying its sha256, and
their validator refuses anything that is not 64 hex characters. Nothing could produce one:
`shasum` is not a verb an agent may run, and `node -e` is refused as a one-off invoker, which is
correct, because a digest produced by a throwaway command is a digest nobody can reproduce. That
left fabricating 64 hex characters, which defeats the point of binding a contract to a
directive, or stopping. The gap was a missing CAPABILITY, not a missing permission, and facts
about a local file belong to the package that already owns local files.

It hashes the FILE's bytes, never a re-encoded string, because the whole value of such a field
is that anyone can recompute it from the artifact still sitting on disk.

## Usage

```
node <bitfield-packages checkout>/packages/local-files/do-work/ask-local-file-content-digest.mjs <absolute path>
```

One line, absolute path: the run guard matches the literal argv token.

## Dependencies

**Depends on:** `@bitfield/runtime-kit` `sendRequestToBitfieldTarget` for the actions that reach
the native target; `node:crypto` and `node:fs` for the two `.mjs` files, which touch the disk
directly and reach no target.
**Depended on by:** `../show/LocalFileTree.tsx` and other surfaces that pick, reveal, or alter
local paths; any contract or receipt that needs a reproducible content digest.
