# ui/show/clipboard — copy produced bytes to the system clipboard

The universal "put produced content on the clipboard" capability — one shared implementation per content shape (image bytes, text), so every surface that makes something copyable (an exported board, a share link, an outline, a chart) lets the user paste it into Slack/a doc/an email with no file roundtrip, and the platform quirks (missing `navigator.clipboard` in WKWebView, permission rejections) are solved exactly once.

## Files

| File | Purpose |
|------|---------|
| `copy-blob.ts` | `copyImageBlobToClipboard` — blind image-Blob → clipboard writer; returns a success boolean, never throws. |
| `copy-blob.test.ts` | Happy path (one ClipboardItem with the blob mime), mime fallback, and the three degradation paths (write rejects, no clipboard, no `ClipboardItem`). |
| `copy-text.ts` | `copyTextToClipboard` — fail-closed text → clipboard writer: async Clipboard API first, legacy hidden-textarea `execCommand('copy')` fallback (the path that works in the macOS WKWebView presenter); returns true only on verified success, never throws. |
| `answer-copy.mjs`, `answer-copy.json`, `copy-answer.ts` | A copied answer keeps its sources (the chat's copy button uses it when the message names its file, `sourceBaseOf`): `[1:02]` citations and frame references become links that open the source at that second (`?at=`), as marked-up and plain text together; `copyAnswerToClipboard(answer, { base })` writes both. `test/answer-copy.test.mjs`. |
| `answer-copy.mjs` also exports `linkTo(base, seconds)`, the one form of "the source opened at this second" that a copied citation and a copied passage link both use. |
| `copy-text.test.ts` | Async-API success, missing-clipboard → fallback, writeText-rejects → fallback, exact-bytes staging, both-paths-fail → false, execCommand-throws → false, textarea cleanup. |
| `copy-guard.ts` / `copy-guard.json` | `installCopyGuard` — one capture-phase copy handler: when the selection is painted in the look's own ink and the look's scheme differs from the paste target's (DATA), writes plain text plus structure-only HTML instead of inlined colours. Pure decisions `ownInkShare`, `shouldGuard`, `structureBlocks`. Installed once by src/workspace/main.tsx. Tested by test/copy-guard.test.mjs. |

## Key Functions

| Function | Signature | Role |
|----------|-----------|------|
| `copyImageBlobToClipboard(blob)` | `(Blob) → Promise<boolean>` | `navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])`. Returns `true` on success; `false` (never throws) when the async Clipboard API / `ClipboardItem` is unavailable or the write is rejected (secure context + user gesture + permission required). Defaults the mime to `image/png` when the blob has no type. |
| `copyTextToClipboard(text)` | `(string) → Promise<boolean>` | Tries `navigator.clipboard.writeText` (awaited, rejection caught); on missing API or rejection falls back to a hidden readonly textarea + `document.execCommand('copy')`. Returns `true` only when one of the two paths verifiably succeeded — a caller must never report "copied" on `false` (fail-closed). |

## Dependencies

**Depends on:** the browser `navigator.clipboard` + `ClipboardItem` (blob) / `document.execCommand` fallback (text) only — no React, no other package.
**Depended on by:** `ui` barrel (`@/packages/ui`); the `group` package board "Copy as PNG" (`copyBoardPng`, which feeds it the `svgToPngBlob` output) and every group text-copy affordance (share links, outline copy, changelog copy, export panel Copy). Any surface that produces an image Blob or a copyable string.
