# ui/motion

Shared motion for interactive UI components: the transitions they share, and the one way they load framer-motion's
animation features only when something first moves.

| File | Purpose |
|------|---------|
| `animation.ts` | Reusable transitions and variants (`springMedium`, `springFast`, the shared collapse), ported from bitfield-packages `ui/motion/animation.ts`. |
| `lazy-motion.tsx` | `MotionFeatures` (framer-motion `LazyMotion` whose features are fetched from `motion-features.ts`) and `motion`, a stand-in for framer-motion's `motion.<tag>` that draws `m.<tag>` inside `MotionFeatures`. A component imports `motion` from here, or wraps its tree in `MotionFeatures` and uses `m`. |
| `motion-features.ts` | `domMax` as its default export, the features `MotionFeatures` fetches the first time something moves. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `MotionFeatures` | `({children}) => ReactElement` | Lets every `m.<tag>` inside it animate once the features arrive; until then they draw still. |
| `motion` | `Record<tag, ForwardRefComponent>` | `motion.div` and the rest, each wrapped in `MotionFeatures`, for files that use a few moving elements. |

## Dependencies

**Depends on:** `framer-motion`.

**Depended on by:** `parts/screen-arrangement` (SplitTreeArranger, FreeformArranger), `parts/ui/show` (copy-button, coss/project-tree, expandable-tabs, usage-meter, layer-tree, collapsible-panel, delight-moment, file-tree, cult/rotating-carousel, tilt), `parts/chat` (ChatPanel, PlanSidebar), `parts/media-playback` (PlaybackControls), `src/workspace/sales-contract-builder-surface.tsx`.
