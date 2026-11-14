# Speech Generation Do Work

Workflow request builders and process-output adapters for speech generation.

## Rules

- This folder owns speech-generation request shape, fallback provider process descriptors, and speech result records.
- Shared content/media staging comes from content-media-evidence.
- compute.process inline input encoding comes from `@bitfield/runtime-kit/protocol`; this folder must not copy byte encoders.
