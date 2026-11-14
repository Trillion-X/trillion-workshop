# tools/media-identity/

Who is in a recording: media-identity signatures (a voice or a face as a stored signature), clusters of signatures, the profile a person binds a cluster to, and matches against it. Moved here byte for byte from bitfield-packages `packages/media-identity`, where Workshop held nothing of it. This folder is a prepared restore: the files are the originals and are not yet wired to a tool row.

## Files

| File | Purpose |
|------|---------|
| `moved-from.json` | The receipt for the files below. |
| `do-work/process-scripts/make-media-identity-records-from-command-output.py` | Turns the output of an external command into `media-identity.signature`, `.cluster`, `.profile-binding`, `.match` and `.error` records. Standard library only. |
| `do-work/submit-media-identity.ts` | Builds the request that asks for identity work on one recording. |
| `read-data/read-media-identity.ts` | Reads the evidence projection into profiles, requests and signatures. |
| `show/MediaIdentityPanel.tsx`, `show/mount-media-identity.tsx` | The screen. |

## What is held

- The `.ts` and `.tsx` files import `@/packages/content-media-evidence` (the shared staging of media evidence) and the retired package runtime; this tree holds neither, so they cannot load yet.
- The package boundary file (record contracts and the three actions `save-media-identity-profile`, `bind-media-identity-cluster`, `write-media-identity-record-from-command-run`) is not carried: it holds retired-runtime rows.
