# Artifact evidence

`ArtifactEvidence` presents caller-resolved artifacts through the existing shared `FilePreview`, with named source references and current context. It composes the existing licensed Coss `Container`, `Text` and `Button` adapters. It owns no record state, approval, publication or completion logic.

The caller resolves opaque Namespace identities through its authorized bytes owner and supplies the content type. Media never starts playing automatically. Callers sanitize external addresses with the shared `safeLinkedIdentityUrl` owner; references without an address remain readable text and have no Open action.

Current consumer: Waiting task cards. The component accepts arbitrary artifact/reference/context data and does not branch on post or task kinds. This extraction does not itself provide an editing surface; callers can mount the current owning screen through the existing `ScreenInPlace` owner.

Design source: the existing pinned MIT Coss extraction, documented in `<design-systems>/coss/DESIGN-SYSTEM.md`. The source-only projection regression is `test/waiting-post-evidence-projection.test.mjs`. Current live visuals and customer readback remain unproved.
