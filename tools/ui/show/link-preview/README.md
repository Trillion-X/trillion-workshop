# link-preview

A link drawn the way the page describes itself: its picture across the top, the site's icon and name, its title, a line or two of what it says, and the address in small type, with a slot for the caller's buttons (copy, remove).

## Files

| File | Purpose |
|------|---------|
| `LinkPreview.tsx` | The card. Every word and picture is the caller's; a picture or icon that fails to load is dropped; title and description stop after two lines. |
| `index.ts` | The one import point. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `LinkPreview` | `({ url, title, site?, icon?, picture?, description?, actions?, className? }) => JSX` | Draws one link. |
| `LinkPreviewProps` | the props above | For callers that build them. |

## Dependencies

**Depends on:** `../cn`, `../icon` (NamedIcon for a site with no icon), the coss colour tokens (`bg-card`, `text-muted-foreground`).

**Depended on by:** `extension/src/popup.tsx` (Send to Trillion). Public in `parts/ui/part.json`.
