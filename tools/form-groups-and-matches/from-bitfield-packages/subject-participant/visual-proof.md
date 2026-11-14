# Visual Proof: subject-participant

## State/Proof Matrix
| State | Expected UI | Evidence File / Command | Status |
|---|---|---|---|
| Empty | Boundary shell with header and summary text | `show/mount-subject-participant.js` render path using `readPackageBoundarySurface()` fallback arrays | Added |
| Sparse | One or two chips in "Owns/Actions/Source contract" cards | `read-data/subject-participant-surface.js` + `show/mount-subject-participant.js` | Added |
| Dense | Multiple chips with wrapped layout and bounded card radius | same as above | Added |
| Loading | No spinner exists in this surface | code-path inspection | Added (N/A) |
| Error | No async failure branch in this package surface | code-path inspection | Added (N/A) |
| Offline | Static descriptor-only render path still visible when data input absent | mount function with local descriptor source | Added |
| Mobile | Wrapped pill row and auto-fit card behavior from local flow | same source + viewport simulation | Added |
| Desktop | Multi-column spacing and full-width surface shell | same source + viewport simulation | Added |

## Screenshot Matrix
| State | Capture Target | Capture Path | Command | Notes |
|---|---|---|---|---|
| Empty | `subject-participant` show mount | Not captured in this run | `open-bitfield-app` + navigate to package surface | Blocker: no direct deep-link available in this session for package-specific route |
| Sparse | `subject-participant` with one action config | Not captured in this run | same | Blocker: no runtime assertion that can force sparse fixture on screen |
| Dense | `subject-participant` with rich descriptor config | Not captured in this run | same | Blocker: needs package fixture seeding |
| Error/Loading | simulated local variants only | Not captured | local rendering simulation | Blocker: no async paths in component |

## Evidence Trace
- Contract evidence: `subject-participant/claim.md`
- Reference-anatomy evidence: `subject-participant/reference-grounded-screen-contract.md`
- Runtime evidence:
  - `subject-participant/show/mount-subject-participant.js`
  - `subject-participant/read-data/subject-participant-surface.js`
  - `subject-participant/tests/subject-participant-surface.test.mjs`

## Screenshot/Reference Matrix
- Local reference: `tmp-tribes-shot.png` (repo root) not package-specific but can be used only as a broad tribal app baseline.
- Mobbin reference 1: `https://mobbin.com/screens/2bb7c096-e041-410f-abe2-26cc4eb4395f`
- Mobbin reference 2: `https://mobbin.com/screens/90aee5cc-88a2-47df-8de8-7fcedcf9624e`
- Mobbin reference 3: `https://mobbin.com/screens/35b29779-cf45-45de-bac7-18d97965d984`
