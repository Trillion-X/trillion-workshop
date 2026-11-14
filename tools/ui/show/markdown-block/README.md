# ui/markdown-block

## Purpose

Internal ui/ component for rendering parsed markdown HTML (with Shiki-highlighted code blocks) via dangerouslySetInnerHTML — the ONLY permitted location for this pattern in markdown rendering.

## Files

| File | Purpose |
|------|---------|
| `MarkdownBlock.tsx` | Renders pre-sanitized markdown HTML output; exposes CVA variants via `markdownBlockVariants` |
| `MarkdownWords.tsx` | Words a person reads (a file's text, an email's body, an opened record, a post) as a readable passage through the one markdown renderer (document-page `markdownHtml`), with `#tag`, `@handle` and bare-address marks always on and `breaks` for words whose line breaks are meant |
| `MarkdownNodes.tsx` | Markdown tokens (marked's lexer) drawn as React elements, for chat messages (parts/chat MarkdownContent) |
| `README.md` | This file |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|------------------|------|
| `MarkdownBlockProps` | `{ html: string; className?: string }` | Props for the MarkdownBlock component |
| `MarkdownBlock` | `(props: MarkdownBlockProps) => JSX.Element` | Renders parsed markdown HTML with prose-content styling |
| `MarkdownWords` | `({ words: string; breaks?: boolean; links?: boolean; className? = 'file-preview-markdown' }) => JSX.Element` | The one reading surface for words; every caller that used to pair MarkdownBlock with markdownHtml uses it |
| `markdownBlockVariants` | `cva('prose-content max-w-none break-words ...')` | CVA variant definition; exported for extension |

## Dependencies

**Depends on:**
- `../cn` — class merging utility
- `class-variance-authority` — CVA variant system
- `../document-page/document-page-html.mjs` — `markdownHtml` (MarkdownWords)

**Depended on by:**
- `MarkdownWords` — the reading surface; used by file-preview, email-view, media-preview, record-views open-views and the Posts screen
- `MarkdownRenderer.tsx` (file-viewer) — primary consumer
- `MarkdownContent.tsx` (chat) — secondary consumer

## Design Notes

- `prose-content` is a `@layer components` composite class defined in `global.css` — it applies markdown typographic styles and Shiki token colors for fenced code blocks
- Content MUST be pre-sanitized by `parseMarkdown` / `parseMarkdownAsync` before passing to this component (no user-controlled HTML)
- `dangerouslySetInnerHTML` is used here by design; this is the single sanctioned exception to the zero-raw-HTML rule for markdown content
