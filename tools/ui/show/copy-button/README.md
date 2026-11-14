# copy-button

The one copy control every screen uses: the mark turns into a drawn check and the words cross-fade to "Copied" on the
thing pressed (or a cross and the failure words), then go back. Adapted from 21st.dev's MIT Copy Button by Özer
(@ddoemonn, interior.dev); the unmodified source is retained in `upstream/` and pinned in `provenance.json`.

## Files

| File | Purpose |
|------|---------|
| `CopyButton.tsx` | `CopyButton`, and its pieces `useCopy`, `CopyMark`, `CopyWords`, `CopyStatusLine` for a control that copies as well as doing something else. |
| `upstream/copy-button.tsx` | The 21st.dev source as served, kept unmodified for provenance. Not imported. |
| `provenance.json` | Source address, author, licence, retained file's BLAKE3, what changed in the adaptation, where it is used. |
| `LICENSE.md` | The MIT licence of the source. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `CopyButton` | `{ text, label?, copiedLabel?, failedLabel?, iconOnly?, variant?, size?, timeout?, className?, onCopy? }` | A Coss button that copies `text`; labelled, or icon-only with the shared Tooltip. |
| `useCopy` | `({ timeout? }) → { copy(text): Promise<boolean>, status }` | Copies through `copyTextToClipboard`; `status` is `idle`, `pending`, `copied` or `failed`, back to idle after `timeout`. |
| `CopyMark` | `{ status, idle? }` | The copy, check and cross marks stacked in one cell; `idle` false shows nothing until copied. |
| `CopyWords` | `{ status, label, copiedLabel, failedLabel }` | The words, cross-fading with the state. |
| `CopyStatusLine` | `{ status, copiedLabel, failedLabel }` | The screen-reader status, and the alert on a refused write. |

## Dependencies

**Depends on:** `../coss/ui/button`, `../tooltip`, `../clipboard/copy-text`, `framer-motion`; appearance in
`screen-look/show/copy-button.css`.

**Depended on by:** `coss/guide.tsx` (code lines, cards, a section's prompt, and the app tabs that copy their setup
message when picked), `error-boundary/ErrorBoundary.tsx`, the extension popup
(`extension/src/popup.tsx`), and the workspace's sharing sheet and sales contract builder.
