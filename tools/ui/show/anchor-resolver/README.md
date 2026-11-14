# ui/show/anchor-resolver — walkthrough anchor + placement (M2)

Turns a step's opaque `target_ref` into a live rect and computes where its coachmark card sits — preferred side, auto-flip when it won't fit, the corner covering the least of the target when nothing fits, and a failure state when the target is absent (never throws).

## Files

| File | Purpose |
|------|---------|
| `anchor-resolver.ts` | Pure placement geometry (`computePlacement`) + blind ref-resolver registry (`createAnchorResolverRegistry`, `node-ref`/`selector` built-ins) + `resolveAnchorRect` (ref→rect, failure-as-state). |
| `AnchoredCoachmark.tsx` | `AnchoredCoachmark`: the tour card anchored to a target rect with its pointer. Non-modal: focus is never trapped in it, and it never takes focus from someone writing in a box (an input, textarea or editable text); otherwise its first control takes focus when it opens or its step changes (`focusKey`). Tested by `test/coachmark-focus-browser.test.mjs`. |
| `index.ts` | Barrel. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `Side` | `'above'｜'below'｜'left'｜'right'` | The 4 cardinal placements — closed by Physics (2D), not a Society enum. |
| `PlacementInput` | `{ prefer?: string, auto_flip?: boolean, gap?: number }` | DATA; `prefer` is open, mapped to a `Side`, defaults `below`. |
| `PlacementResult` | `{ x, y, side, flipped, overlapsTarget }` | Where the card goes + whether it flipped + whether it had to sit over the target (then it has no tail). |
| `computePlacement(target, card, viewport, placement)` | `→ PlacementResult` | Pure: try prefer → opposite → perpendicular, each side allowed to slide along the target's edge to stay on screen (a target at the screen edge gets its card above or below it); if nothing fits, each side clamped on screen and the four corners are compared and the one covering the least of the target wins (no line is drawn). Tested in Trillion by `test/walkthroughs.test.mjs`. |
| `coachmarkPointer(result, target, card)` | `→ { kind: 'tail', side, x, y } \| null` | Pure: where the card's tail sits, facing the target; null when the card sits over its target. |
| `AnchorRef` | `{ from: string, family?, parts?, query? }` | Opaque self-describing reference; `from` is open DATA. |
| `AnchorResolverRegistry` | `register / resolveElement / has` | Blind registry: `from` → resolver, dispatch by lookup (no `if from===`). |
| `createAnchorResolverRegistry()` | `→ registry` | Pre-seeded with `node-ref` (via `data-node-ref`) + `selector` resolvers. |
| `resolveAnchorRect(reg, ref, root?)` | `→ AnchorResolution` | `{status:'resolved',rect,element}` or `{status:'unresolved',reason}` (G9). |

## Why This Design (L090 / Physics-vs-Society)

`target_ref.from` is an **open string** dispatched through a registry — a new ref kind (`grid-cell`, a future addressing scheme) is one `register()` + zero change here. The placement *sides*, by contrast, are a genuinely closed set (2D geometry is Physics), so `Side` is a legitimate union, not an enum violation. `prefer`/`gap`/`auto_flip` are all DATA. Target-absent is a returned state, not an exception, so a tour degrades gracefully.

## Dependencies

**Depends on:** `ui/show/node-actions/node-ref` (`NODE_REF_ATTR`, `serializeNodeRef`).
**Depended on by (planned):** `AnchoredCoachmark` (N2/W4) for positioning, and the `guided-overlay` engine (M2).
