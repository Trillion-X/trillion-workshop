# parts/ui/show/button

The one shared Button: variants, sizes, corner, loading and pressed state, painted only from the worn look's CSS variables.

## Files

| File | Purpose |
|---|---|
| `Button.tsx` | `Button` and `buttonVariants` (class-variance-authority): variants `primary`, `secondary`, `ghost`, `plain`, `chevron`, `outline`, `danger`, `accent`, `solid`, `success`, `confirm`; sizes `xs` to `lg`, `icon`, `icon-xs`, `nav`, `menu`, `option-row`; radius `md` (the look's `--radius-control`, the default), `full`, `inherit`. The primary fill carries the look's light top edge and drop (`--button-highlight`, `--button-shadow`), and a press swaps in `--button-pressed-highlight` and shrinks by `--button-pressed-scale`. Icon-only buttons with a label get a tooltip. |
| `press-work.tsx` | `usePressWork` and `PressWorkFace`: a press whose handler returns a promise says its work in the button (21st.dev Loading Button anatomy): the one loading animation and its pending words while it runs (no more presses), a check and "Done" (or `doneLabel`) on the look's good colour when it worked, a mark and "Try again" (or `errorLabel`) in its danger colour when it failed, then the button's own label after `PRESS_WORK_SETTLE_MS`. A wait that runs long says it is still working, its words changing as time passes and saying when it was asked again (`../still-working`). An icon-only button shows only the mark. The one owner for both shared buttons (`Button.tsx` and `../coss/ui/button.tsx`). |
| `index.ts` | Re-exports `Button`, `buttonVariants` and `ButtonProps`. |

## Key Types / Functions

| Name | Shape | Role |
|---|---|---|
| `Button` | `forwardRef<HTMLButtonElement, ButtonProps>` | Every button in the shared parts and the apps built from them (workspace, Mac, Chrome extension). |
| `ButtonProps` | `ButtonHTMLAttributes & { variant?, size?, radius?, fullWidth?, loading?, work?, pendingLabel?, doneLabel?, errorLabel?, active?, tone?, color?, targetRole? }` | `className` is for layout only. An `onClick` that returns a promise is the button's work; `work` is for work run elsewhere. |
| `usePressWork` | `(onClick, given?, loading?, settleMs?) => { work, onClick }` | Wraps a press so the promise it returns is tracked; a second press while it runs is ignored. |
| `PressWorkFace` | `({ work, iconOnly?, pendingLabel?, doneLabel?, errorLabel?, children })` | The button's face for its work: its children when nothing runs. |
| `ButtonWork` | `'pending' \| 'done' \| 'error'` | Written to the button as `data-work`, which its classes draw from. |
| `buttonVariants` | `cva(...)` | The class list for a variant/size/radius, for controls that must look like a button. |

## Dependencies

**Depends on:** `../cn`, `../spinner`, `lucide-react` (the check and the mark), `../tooltip`, `../control-target`; the button variables from `parts/screen-look/read-data/resolve-screen-look-palette.js` (`resolveScreenLookPalette`), written onto the page by screen-look (and, for the Chrome extension's first paint, by `scripts/build-extension.mjs` through `scripts/make-button-look.mjs`).

**Depended on by:** `parts/ui/index.ts` and every part and screen that imports `Button`; `../coss/ui/button.tsx` (its work states); `test/button-work.test.mjs` (both buttons over every variant, and that no Button press throws its promise away).
