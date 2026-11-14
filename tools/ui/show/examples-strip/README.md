# parts/ui/show/examples-strip/

Ideas for what to do on a screen: a one-line header that opens into rows, each the shared listing card read whole (`listing-card`, form `row`) with its title, one quiet line, no placeholder icon and no badge saying it is an example (both were extra UI taking space, the owner 2026-09-29), "Do this for me" as its primary button (it hands the request to the person's own AIs, and copies it only when the caller answers that nothing can wait for them), and read more when it has an address. Every screen's ideas, the Spaces screen's included, are this one strip; there is no screen-only examples section.

## Files

| File | Purpose |
|------|---------|
| `ExamplesStrip.tsx` | The strip (React) and `mountExamplesStrip`, which draws it into a host node. |
| `index.ts` | The public exports (declared in `parts/ui/part.json`). |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `ExampleItem` | `{ id, title, detail?, do_this, from, href?, icon? }` | One idea; `from` says where it came from (`written`, `story`) and is never drawn as a mark; `icon` is a named icon, drawn only when the idea names one. |
| `ExamplesStripWords` | `{ do, not_copied, read_story?, [mark]: string }` | Every word the strip draws. |
| `ExamplesStrip` | `(props: ExamplesStripProps) => ReactNode` | Header with count and chevron; open, a `ListingGrid` of cards whose buttons are Do this for me (`onDo`, pressed once at a time) and read more. Draws nothing with no examples. |
| `mountExamplesStrip` | `(host, props) => unmount` | Draws the strip into a DOM host (one owner per node). |

## Dependencies

**Depends on:** `listing-card`, `button`, `container`, `text`, `icon`, ``coss/notifications`, `one-owner-per-node`, `lucide-react`.

**Depended on by:** Trillion's `src/workspace/screen-examples.ts` (every workspace pane).
