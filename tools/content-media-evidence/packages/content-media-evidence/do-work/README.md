# Content Media Evidence Do Work

Shared content/media workflow request helpers for media-oriented Bitfield Studio packages.

## Rules

- This folder owns content-media staging, artifact references, workflow request assembly, and shared source-reference helpers.
- compute.process inline input encoding comes from `@bitfield/runtime-kit/protocol`; this folder must not own a generic process-source codec.
- Selected local paths are staged through compute.process outputs into addressed chunk storage before downstream workflows consume them.
