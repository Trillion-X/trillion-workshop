# ui/code-block

## Purpose

Internal ui/ component for rendering Shiki-highlighted code HTML via dangerouslySetInnerHTML — the ONLY permitted location for this pattern in the design system.

## Files

| File | Purpose |
|------|---------|
| `CodeBlock.tsx` | Renders pre-sanitized Shiki HTML output; exposes CVA variants via `codeBlockVariants` |
| `README.md` | This file |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|------------------|------|
| `CodeBlockProps` | `{ html: string; className?: string }` | Props for the CodeBlock component |
| `CodeBlock` | `(props: CodeBlockProps) => JSX.Element` | Renders Shiki HTML with prose-content styling |
| `codeBlockVariants` | `cva('prose-content text-xs font-mono ...')` | CVA variant definition; exported for extension |

## Dependencies

**Depends on:**
- `../cn` — class merging utility
- `class-variance-authority` — CVA variant system

**Depended on by:**
- `CodeRenderer.tsx` (file-viewer) — primary consumer
- Any component rendering Shiki-highlighted code

## Design Notes

- `prose-content` is a `@layer components` composite class defined in `global.css` — it applies Shiki token colors
- Content MUST be pre-sanitized by Shiki before passing to this component (no user-controlled HTML)
- `dangerouslySetInnerHTML` is used here by design; this is the single sanctioned exception to the zero-raw-HTML rule
