# ui/show/notice — transient status chip (provider-free)

A self-contained, blind status pill ("Copied to clipboard", "Exported as SVG", "Could not save") pinned to an edge of its `position:relative` container — the way a surface confirms a fire-and-forget action that left no on-canvas artifact, with NO `ToastProvider` ancestor required.

## Files

| File | Purpose |
|------|---------|
| `Notice.tsx` | `Notice` — given `text`/`tone`/`placement`, renders a glass chip; `null` text → nothing. The caller owns the message + dismiss timer. |
| `Notice.test.tsx` | null/empty → no render; message in a polite `role="status"` region; top vs bottom placement. |

## Key Components

| Component | Props | Role |
|-----------|-------|------|
| `Notice` | `{ text: string \| null, tone?: 'info'\|'success'\|'error', placement?: 'top-center'\|'bottom-center' }` | Blind transient chip. Absent text = no-op. `role="status"` `aria-live="polite"`. Colours are design tokens; positioning is absolute within the nearest positioned ancestor. |

## Why not `ui/show/toast`

The full toast stack needs a `ToastProvider` ancestor + `useToast`. `Notice` needs neither — a surface drives it from its own ephemeral state + `setTimeout`, so it works in every shell (WKWebView / web / studio), the same self-contained pattern the board panel uses for `askText`.

## Dependencies

**Depends on:** `ui/show/text/Text` (typography) only.
**Depended on by:** `ui` barrel (`@/packages/ui`); the `group` board export cluster (`showNotice` → "Copied to clipboard" / "Exported as SVG" / error / empty). Any surface needing a provider-free transient confirmation.
