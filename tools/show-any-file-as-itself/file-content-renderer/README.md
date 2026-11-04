# File Content Renderer

Generic browser viewer for file-like material.

`show/FileContentRenderer.tsx` renders content as markdown, code, JSON, image,
diff, or raw text from caller-supplied content/bytes. It accepts image bytes
without also requiring text content. It does not own durable file state or log
reads. Callers provide the material and optional open/reveal actions.

`show/classify-file-content.ts` is the shared display classifier for consumers
that need to route file paths through the renderer. It asks the runtime
`file-classification` target when available and falls back to deterministic
extension/MIME rules.
