# Reference intake, 2026-11-01: bloxwap and joeblau/subvox

Every public repository of the GitHub organisation `bloxwap` (11 repositories), plus `joeblau/subvox`. Each was shallow-cloned at its default branch on 2026-11-02 into a scratch folder outside this repository and **only read**: none of their code was run, built, installed or imported. Anything in them addressed to an AI (AGENTS.md and the like) was treated as data, not instructions.

Each report gives the commit it read, the licence and where it was found, what the project does, how it is built, the techniques worth learning, where they fit tools in `tools/`, and cautions.

## Repositories

| Report | What it is | Licence | May code be copied here? |
|---|---|---|---|
| [bloxwap/agent-cli](bloxwap--agent-cli.md) | JSON-in/JSON-out Hyperliquid trading CLI for AI agents, with paper mode, risk limits and a hash-chained audit log | `packages/agent-cli`: MIT. Root, docs and evidence: no licence | Package only, with notice; the rest is ideas only |
| [bloxwap/bloxwap.github.io](bloxwap--bloxwap.github.io.md) | Static GitHub Pages hub: `llms.txt`, AI-crawler `robots.txt`, share-card and reflow checks | None | No, ideas only |
| [bloxwap/chart](bloxwap--chart.md) | Zero-dependency canvas candlestick chart library with a WASM+SIMD path and indicators | MIT (Geist fonts OFL-1.1; one test ported from PineJS: do not copy) | Yes, with notice |
| [bloxwap/.github](bloxwap--dot-github.md) | Org-wide reusable security-scan workflows, Renovate preset, profile | None | No, ideas only |
| [bloxwap/font](bloxwap--font.md) | Stroke-drawn font family (Sans, Mono, Pixel, script companions) built with fontmake, split by `unicode-range` | OFL-1.1, code included; Unihan data under the Unicode licence | No for code (OFL); fonts only on OFL terms, "Bloxwap" reserved |
| [bloxwap/haptic](bloxwap--haptic.md) | Haptic feedback for React (vibration, and an iOS switch trick) | MIT | Yes, with notice |
| [bloxwap/hig](bloxwap--hig.md) | Design-system monorepo: tokens, React/React Native components, drift and waiver checks | MIT (non-standard short text, hence GitHub's NOASSERTION); fonts OFL-1.1; logo is a trademark | Yes, with notice; not the logo or fonts |
| [bloxwap/screensaver](bloxwap--screensaver.md) | Live crypto-price screensaver: one React renderer for browser, Electron and a native macOS `.saver` | None for its own code | No, ideas only |
| [bloxwap/sfx](bloxwap--sfx.md) | Interface sound effects synthesised with Web Audio from data recipes; WAV encoder and trimmer | MIT | Yes, with notice |
| [bloxwap/smart-hyperevm](bloxwap--smart-hyperevm.md) | Latency-aware, hedged, circuit-breaking viem transport for HyperEVM RPC | MIT | Yes, with notice |
| [bloxwap/smart-solana](bloxwap--smart-solana.md) | The same idea for Solana JSON-RPC: fastest endpoint, hedged reads, breakers, `Retry-After`, coalescing | MIT | Yes, with notice |
| [joeblau/subvox](joeblau--subvox.md) | macOS prototype that reads mouthed words from AirPods head motion with banded DTW and a permutation test | MIT | Yes, with notice |

No repository here is GPL or AGPL. GPL only shows up as the licence of some dependencies listed in their lockfiles, and nothing from those was read or copied. This repository is Apache-2.0. In every change below the code was written fresh: only the idea came across, and each one is credited in the tool's README or comments.

## Adopted in this change

| Tool | Technique | Source (licence) | Files |
|---|---|---|---|
| `export-documents-to-files` | Pick black or white button text by whichever has the higher WCAG contrast. The old rule was `luminance > 0.5`, which put white on `#22c55e` (about 2.3:1) where black reads at about 9:1. | `bloxwap/chart` `contrastingTextColor` (MIT) | `do-work/render-public-page.mjs`, `test/export-documents-to-files.test.mjs` |
| `keep-the-last-good-answer` | Read `Retry-After` (seconds or an HTTP date, a past date counts as 0, capped at a day) when a source answers 429 or 503, and return it as `retry_after_seconds` and in `said`. The tool still never waits or retries on its own. | `bloxwap/smart-solana` and `bloxwap/smart-hyperevm` (MIT) | `read-data/ask-and-keep.mjs`, `tool-rows.json`, `README.md`, `test/ask-and-keep.test.mjs` |
| `trading` | Optional `risk.allowed_symbols`. An order for any other symbol is skipped with its reason and never resized, an empty list trades nothing, and a list that is not a list of strings is refused. | `bloxwap/agent-cli` `allowedMarkets` (MIT package) | `read-data/decide-orders.mjs`, `read-data/trading.mjs`, `tool-rows.json`, `README.md`, `test/decide-orders.test.mjs`, `test/trading.test.mjs` |
| `track-and-compare-movement` | Length-normalised DTW `distance` (the cost along the path divided by T1 + T2), so several references can be ranked against one clip | `joeblau/subvox` (MIT) | `do-work/align_dtw.py`, `tool-rows.json`, `README.md`, `test/test_align_dtw.py` |

## Other fits, not adopted here

These are written up in the reports but left out to keep this change small:

- `check-a-folder-against-my-rules`: waivers with an owner and an expiry date. An expired waiver fails the run, and a waiver that matches no file is reported as unused. From `bloxwap/hig`, `scripts/drift.mjs` (MIT).
- `generate-speech`: treat a WAV with no frames, or one that is all silence, as "made no audio", so the next voice gets tried. From `bloxwap/sfx` (MIT).
- `ai-readiness`: a `has-share-card` check row for `og:*` and `twitter:card` tags. The idea comes from `bloxwap.github.io`, which has no licence, so it would be an independent row of data.
- `screen-looks`: `unicode-range` on a font face, so several face files can share one family. The idea comes from `bloxwap/font` (OFL), so the code would have to be written fresh.
- `live-market-prices`: carry `Retry-After` through the Python HTTP layer, and remove duplicate bars that share a timestamp.
