# next-step-card

Exactly one concrete next action shown where a person already looks: what to make, the few items it uses as small pictures, one line saying why, where it goes, and the actions to take it, try another or put it away.

## Files

| File | Purpose |
| --- | --- |
| `NextStepCard.tsx` | The card: thumbnails (each previewed through the shared hover preview), title, reason, destination switch (shared ActionMenu) and action buttons. |
| `mount-next-step-card.tsx` | `mountNextStepCard(host, props)`: mounts or redraws the card in any host and returns its release. |
| `index.ts` | Public exports. |

## Key Types / Functions

| Name | Signature / Shape | Role |
| --- | --- | --- |
| `NextStepCard` | `(props: NextStepCardProps) => JSX` | Draws the card. Every word, picture and action is caller DATA. |
| `NextStepCardProps` | `{title, reason?, media?, destination?, destinations?, actions, pending?, onAction, onDestination?, onMedia?, registry, label?}` | Card input; action ids come back through `onAction`. |
| `NextStepMedia` | `{id, src, alt, preview?: PreviewItem}` | One small picture. Every picture with a `preview` joins one carousel in the shared hover preview (`../hover-preview`), opened at the hovered picture; arrow keys, a sideways swipe or the buttons move across the set. |
| `NextStepDestination` | `{id, label, providerSlug?}` | Where it goes; the slug picks the logo from `registry`. |
| `NextStepAction` | `{id, label, primary?, disabled?}` | One button; at most one primary. |
| `mountNextStepCard` | `(host: HTMLElement, props: Omit<NextStepCardProps,'registry'> & {registry?}) => () => void` | Mount/redraw/release for callers outside React; `registry` defaults to the provider-icon rows this part ships (`provider-mark/shipped-provider-icons`), so destination logos draw without the caller passing them. |

Appearance: `parts/screen-look/show/next-step-card.css` (one compact row; `next-step-card-host>` raises specificity over the Card's column layout; narrow hosts wrap by container width).

## Dependencies

**Depends on:** `../hover-preview/HoverPreview` (the one hover card and carousel), `../coss/ui/card`, `../coss/ui/button`, `../action-menu/ActionMenu`, `../provider-mark/ProviderMark`, `../provider-mark/shipped-provider-icons`, `../coss/workspace-controls` (`mountSharedContent`), `../one-owner-per-node`.

**Depended on by:** the Media screen's suggestion row (`src/workspace/media-screen.tsx`, `/work/api/media/next-edit`); the Mac app's next-edit card (`media-workspace.js`, through `shared-controls-entry.ts`).

## Invariants

- Domain-blind; one primary action at most; while `pending` the card keeps its size and says so.
- Pictures preview only through the shared hover preview; this part draws no preview of its own.

Ported from bitfield-packages `packages/ui/show/next-step-card` (commits 9ac85acfb, 8433043bd) with the carousel across the set. References: composer rows beside media grids in Bloom, OpenAI Platform and ElevenLabs (https://mobbin.com/screens/8dd64604-12a1-46b1-b459-c815b01b3f01), pinned rather than floating.
