# file-content-renderer/show/

Browser-local file material rendering.

## Files

| File | Purpose |
|------|---------|
| `GuardedArtifactFileContent.tsx` | Account-bound guarded relation retrieval adapter; integrity verification and URL revocation remain with the existing guarded media owner. |
| `FileContentRenderer.tsx` | Routes already supplied file content/bytes to markdown, code, JSON, image, diff, or raw renderers; image bytes render even when there is no parallel text body. |
| `classify-file-content.ts` | Shared file display classification helper for renderer consumers; runtime target first, deterministic extension/MIME fallback second. Owns the classification shape (`FileContentRendererKind`, `FileContentRendererClassification`, `DEFAULT_FILE_CONTENT_RENDERER_CLASSIFICATION`), which `FileContentRenderer.tsx` re-exports, so a caller that only classifies loads no renderer. |
| `FileHeader.tsx` / `FileActions.tsx` | Header and copy/reveal/open controls; reveal/open callbacks stay caller-owned. |
| `MarkdownRenderer.tsx`, `CodeRenderer.tsx`, `ImageRenderer.tsx`, `DiffRenderer.tsx`, `RawRenderer.tsx` | Specialized renderers. |

## Boundary

This folder renders material. It does not decide which file/log/content source
is authoritative, and it does not fetch durable records. Callers pass content,
bytes, and source-owned actions. Record Board uses this boundary by resolving
attachments first, then handing the ready material here for preview.
