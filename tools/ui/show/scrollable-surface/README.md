# ui/show/scrollable-surface/

Pure browser-local bounded surface shell for renderer-mounted package content.

`ScrollViewport` measures native horizontal/vertical overflow, including content/viewport resizing. Only edges with offscreen content fade; the last row is fully visible at the end. Appearance belongs to screen-look/show/scroll-edge-style.ts, following the licensed Coss scroll-fade anatomy. Keyboard focus, reduced transparency and forced colors remove the mask.

Every `Container` with `overflow="auto"`, `"x-auto"`, or `"y-auto"` also uses this shared measurement automatically. Two-axis containers fade all four edges; one-axis containers fade the two edges of their scroll direction. This keeps existing lists, tables, galleries, and boards on the same treatment without a feature-local wrapper.

`ScrollableSurface` owns the reusable package-surface scroll invariant: the outer glass card fills the host, clips only its chrome, and exposes a full-width `data-scrollable-surface-viewport` child with `overflow-y-auto`, `h-full`, and `min-h-0`.

| Path | Purpose |
|---|---|
| `ScrollableSurface.tsx` | Glass surface whose inner viewport owns vertical scrolling. |
| `ScrollableSurface.test.tsx` | Guards the `overflow-y-auto` plus `min-h-0` viewport contract. |
| `index.ts` | Local barrel export. |

Rules:

- No addressed reads.
- No target invokes.
- No durable state.
- No package-specific vocabulary.
- Callers own all content meaning; this component owns only the bounded scroll layout invariant.

A horizontal `ScrollViewport` turns a vertical mouse wheel into sideways scrolling, and no viewport draws a scrollbar (`screen-look/show/scroll-edge-style.ts`): the edge fade says there is more.
