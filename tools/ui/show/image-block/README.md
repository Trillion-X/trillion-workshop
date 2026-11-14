# ui/image-block

## Purpose

ui/ wrapper for `<img>` elements with CVA variants for objectFit, rounded corners, and width — eliminates raw `<img>` with inline styles throughout feature code.

## Files

| File | Purpose |
|------|---------|
| `ImageBlock.tsx` | Typed image component with CVA variants; accepts `maxHeight` for dynamic constraint |
| `README.md` | This file |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|------------------|------|
| `ImageBlockProps` | `{ src?, alt?, maxHeight?, objectFit?, rounded?, width?, className?, style?, onLoad?, onError?, loading? }` | All img attributes plus CVA variant props |
| `ImageBlock` | `(props: ImageBlockProps) => JSX.Element` | Renders a styled img element |
| `imageBlockVariants` | `cva('', { variants: { objectFit, rounded, width } })` | CVA variant definition; exported for extension |

## CVA Variants

| Variant | Options | Default |
|---------|---------|---------|
| `objectFit` | `contain`, `cover`, `fill`, `none` | `contain` |
| `rounded` | `none`, `sm`, `md`, `lg`, `xl`, `full` | `lg` |
| `width` | `auto`, `full` | `auto` |

## Dependencies

**Depends on:**
- `../cn` — class merging utility
- `class-variance-authority` — CVA variant system
- `react` — `React.CSSProperties`, `React.ReactEventHandler` types

**Depended on by:**
- `ImageRenderer.tsx` (file-viewer) — primary consumer
- Any component needing a design-system-compliant image element

## Design Notes

- `maxHeight` is accepted as a prop and applied via `style={{ maxHeight }}` internally — dynamic values cannot be encoded in CVA and this is the correct pattern for physics-level constraints
- This is the canonical location for all `<img>` rendering in the application — feature code never uses raw `<img>` elements directly
