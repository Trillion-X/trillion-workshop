# vision-board

The Vision Board PRODUCT package — the composition root that turns the generic `group` board primitive into the "Vision Board" surface, with image generation wired to its "Generate" affordance.

This package exists so the generic `group` primitive stays independently inventable (L106): `group` names neither "Vision Board" nor `image-generation`. This product package legitimately knows both, because composing them IS its job (inversion of control — the composition root provides the concretes; the primitive stays blind).

## Files

| File | Purpose |
|------|---------|
| `show/mount-vision-board.tsx` | Mount entry. Composes `GroupBoardPanel` (generic) + the image-generation producer (DATA, carrying the local provider's `image_command`) + the product config (board id `vision-board`, title, daily cadence). |
| `things-to-store-and-run.json` | Package boundary: the `vision-board` entry record (→ `mount-vision-board.tsx`) and the `placeable-surface::vision-board` record (docks into `main-workspace`, mounts `package::vision-board::entry-bytes::vision-board`). |

## Key Types / Functions

| Symbol | Signature / Shape | Role |
|--------|-------------------|------|
| `default mount` | `({ el, props }) => mountReactSurface(el, <VisionBoardMaterial/>)` | Entry the host calls to render the surface. |
| `VISION_BOARD_PRODUCER` | `ProducerSubmitDescriptor` | DATA: fire `action:submit-image-generation-request`, read result/error at `package::image-generation::{result,error}::{id}`, `baseInput.options.image_command = buildLocalImageProviderCommand()`. |

## Dependencies

**Depends on:** `@/packages/group/show/GroupBoardPanel` (the generic board primitive), `@/packages/group/do-work/submit-producer-request` (`ProducerSubmitDescriptor` type), `@/packages/image-generation/do-work/local-image-provider-command` (`buildLocalImageProviderCommand`), `@/packages/ui` (`ErrorBoundary`, `FloatingMaterialFrame`, `mountReactSurface`).

**Depended on by:** the studio dock (via the `placeable-surface::vision-board` record).

## Why This Design

Verified constraint: the shell passes only fixed mount props (`floating_frame`, `materialTarget`, `surfaceInput`, `target`) — custom placeable-surface props never reach a mount. So product config (board id, producer, title, cadence) MUST originate in a product-owned mount. A product package that owns its own entry + surface supplies that config locally, never crossing the shell boundary — sidestepping the prop limitation entirely. Swapping the local provider for a cloud/Ideogram command is one DATA change to `VISION_BOARD_PRODUCER.baseInput.options.image_command`, zero code edit.
