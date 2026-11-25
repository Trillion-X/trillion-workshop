# tools/ui/show/button

The one shared Button: variants, sizes, corner, loading and pressed state, painted only from the worn look's CSS variables. Every button a site draws is this Button: the workspace, the members area, a sales or course page, the coss kit (`../coss/ui/button.tsx` only sets the coss defaults on it) and the marketing page parts (`../marketing-page`). A site's own look (the look CSS its sign-in page wears) gives it its colours, corner and sheen, so no site's look is written here. `one-button-face.test.mjs` refuses any other button face.

## Files

| File | Purpose |
|---|---|
| `Button.tsx` | `Button` and `buttonVariants` (class-variance-authority): variants `primary`, `secondary`, `quiet` (the second choice beside the strong one: card colour, firm line), `ghost`, `plain`, `chevron`, `outline`, `danger`, `accent`, `solid`, `success`, `confirm`, and the coss kit's words for them (`default`, `destructive`, `destructive-outline`, `link`; sizes `default`, `xl`, `icon-sm`, `icon-lg`, `icon-xl`) as rows of `NAMES_FROM_OTHER_KITS`; `href` draws it as a link with the same face, `render` on another element (Base UI `useRender`); every Button names its face on itself (`data-button-face`); sizes `xs` to `lg`, `icon`, `icon-xs`, `nav`, `menu`, `option-row`; radius `md` (the look's `--radius-control`, the default), `full`, `inherit`. The primary fill carries the look's light top edge and drop (`--button-highlight`, `--button-shadow`), and a press swaps in `--button-pressed-highlight` and shrinks by `--button-pressed-scale`. Icon-only buttons with a label get a tooltip. |
| `press-work.tsx` | `usePressWork` and `PressWorkFace`: a press whose handler returns a promise says its work in the button (21st.dev Loading Button anatomy): the one loading animation and its pending words while it runs (no more presses), a check and "Done" (or `doneLabel`) on the look's good colour when it worked, a mark and "Try again" (or `errorLabel`) in its danger colour when it failed, then the button's own label after `PRESS_WORK_SETTLE_MS`. A wait that runs long says it is still working, its words changing as time passes and saying when it was asked again (`../still-working`). An icon-only button shows only the mark. The one owner for both shared buttons (`Button.tsx` and `../coss/ui/button.tsx`). |
| `index.ts` | Re-exports `Button`, `buttonVariants` and `ButtonProps`. |
| `button-face-css.mjs` | `buttonFaceCss({ lookCss })`: the face as a stylesheet for a page built without the Workshop's part sheet (a sales, course or article page): the look's declarations the face reads, set on the Button only; a blank start for `[data-button-face]` in the base layer; the Button's own classes compiled by Tailwind against Screen Look's theme. |
| `faces-not-yet-moved.json` | The button faces still drawn outside this Button, each to move onto it; the list only shrinks. |
| `one-button-face.test.mjs` | Refuses a new button face anywhere under `tools/` (a `cva` named for a button, a `...Button` component drawing a raw button or anchor without this Button, a `...-button`/`-btn`/`-cta` rule painting a background), and checks the face sheet takes its colours from the look it is given. |

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

**Depends on:** `../cn`, `../spinner`, `lucide-react` (the check and the mark), `../tooltip`, `../control-target`; the button variables from `tools/screen-look/read-data/resolve-screen-look-palette.js` (`resolveScreenLookPalette`), written onto the page by screen-look (and, for the Chrome extension's first paint, by `scripts/build-extension.mjs` through `scripts/make-button-look.mjs`).

**Depended on by:** `tools/ui/index.ts` and every part and screen that imports `Button`; `../coss/ui/button.tsx` (its work states); `test/button-work.test.mjs` (both buttons over every variant, and that no Button press throws its promise away).
