# bloxwap/font

- Source: https://github.com/bloxwap/font @ ede69974a95e601ea1f5deb82a4a4c590bf18df1 (2026-10-27)
- Licence: **OFL-1.1**, and it covers the code as well as the fonts. Where I found it:
  - Root `LICENSE`: SIL Open Font License 1.1, "Copyright 2026 Bloxwap, Inc., with Reserved Font Name 'Bloxwap'".
  - `package.json` "license" fields: root `@bloxwap/font-workspace` (private) is `OFL-1.1`. `packages/font` `@bloxwap/font-source` (private) is `OFL-1.1`. `packages/npm` `@bloxwap/font` (the published package) is `OFL-1.1`. The generated `apps/docs/public/fonts/*/variable/subsets/package.json` files are `{"private":true,"license":"OFL-1.1"}`. `apps/docs` and `apps/next-fixture` have no "license" field, so the root OFL `LICENSE` is the only licence that covers them.
  - `bench/LICENSE` is another copy of the OFL text.
  - Many Python tool docstrings say "(SIL OFL-1.1)", for example `packages/font/tools/build_pool.py`, `packages/npm/scripts/static_sources.py` and `packages/font/tools/test_robust.py`.
  - Third-party data: `packages/font/tools/bwfont/han/unihan_*.tsv` is derived from Unihan 15.1 and is © Unicode, Inc. under the Unicode License v3, as both the file headers and `packages/font/README.md` state. The `ids_*.txt` decomposition files say they are the project's own work ("our own IDS decompositions"). I found no other vendored third-party code.
  - No package uses a licence other than OFL. The build and tooling code (Python, `.mjs`, the TS docs app) is not under MIT or Apache.
  - **Can code be copied into an Apache-2.0/MIT project? No.** OFL is a font licence. It cannot be relicensed, and derivatives must stay under OFL. The font files may be used and redistributed only under OFL terms, with the "Bloxwap" Reserved Font Name rule applying to modified versions. Treat the Python and JS tooling as **ideas only**: re-implement independently and do not port it. The Unihan TSVs could be taken straight from Unicode under the Unicode License v3 instead.

## What it does

The repository builds and publishes the Bloxwap type families: Sans, Mono and Pixel, plus Arabic, Armenian, Georgian, Hebrew, JP, KR and SC companions. Every glyph is drawn in Python as a centre-line skeleton and expanded with an elliptical pen into UFO masters. fontmake/fontTools then compile these into variable and static OTF/TTF/WOFF/WOFF2 files. A post-process step subsets the web fonts by script and writes one CSS file. That CSS merges each companion into the base family name using `unicode-range`. The single npm package `@bloxwap/font` ships the web assets, `next/font` helpers and React Native TTF maps. A Next.js docs site (`apps/docs`) holds the type tester and glyph charts, plus Playwright accessibility and Unicode tests.

## How it is built

- **Layout**: a Bun workspace.
  - `packages/font`: the design and build in Python 3.12+, run through uv, with `requirements.txt`.
  - `packages/npm`: the published package. `scripts/build.mjs`, `faces.py`, `static_sources.py` and `static-sources.json` live here.
  - `apps/docs`: the Next.js docs site and type tester, with Playwright specs in `apps/docs/test/`.
  - `apps/next-fixture`: a consumer fixture app.
  - `bench/bench.py`: a benchmark harness.
- **Design core** (`packages/font/tools/bwfont/`):
  - `skeleton.py` is the glyph-drawing DSL.
  - `geometry.py` is the stroker (elliptical pen, round caps).
  - `glyphs/*.py` holds the per-script glyph modules.
  - `han/engine.py` composes Han characters from IDS decompositions (`ids_a.txt`, `ids_b.txt`, `ids_jp.txt`) and stroke-drawn components (`components_*.py`).
  - `hangul/jamo.py` is the jamo engine and `arabic/` is the rasm × joining-form kit.
  - `pixel/` contains the bitmap family.
  - `robust.py` handles overlap and winding validation.
  - `families.py` is the family catalogue.
- **Build pipeline**: `tools/generate.py` produces the UFO masters and designspaces. `tools/build_pool.py` is one bounded scheduler for generate, variable, instance and static work. `tools/compile_static.py` compiles OTF and TTF in memory as a pair. `tools/postprocess.py` handles hinting, WOFF/WOFF2 and zips. `tools/webfonts.py` produces the subsets, the CSS and the content-hash `FONT_VERSION`. `tools/site_data.py` writes the docs data and caches Hyperglot results.
- **Notable dependencies**: fontmake, fontTools, skia-pathops (`pathops`), numpy, Hyperglot, ttfautohint (named in `bench/README.md`), Next.js and Playwright.
- **Tests**:
  - Python `unittest` files under `packages/font/tools/test_*.py`: `test_build_pool`, `test_compile_static`, `test_robust`, `test_subsets`, `test_site_data` and `test_unicode`.
  - Node tests in `packages/npm/scripts/*.test.mjs`.
  - Playwright specs (`accessibility`, `unicode`, `hig`, `scripts` and others) run in Chromium and WebKit.
  - QA scripts (`qa.py`, `check_unicode.py`, `check_scripts.py`, `check_glyphs.py`, `check_cusps.py`, `han_check.py`).
- **Evidence**: `evidence/` holds before/after screenshots, `*-metrics.json`, `verification.md` (a table of gate, command and evidence file, plus an explicit "what was not tested" section), command logs and `capture.mjs`/`measure.mjs` scripts. The subfolders `evidence/hig-34/` and `evidence/hig-canonical-ownership/` are per-change evidence bundles.
- **`hig-drift.json`**: lists `paths: ["apps/docs"]` and 50 `canonical` entries, which are the exact `.woff2`/`.ttf` paths the repo owns. `obsoleteImports` and `exceptions` are empty. `.github/workflows/hig-drift.yml` checks it with a pinned commit of an external `bloxwap/hig` `scripts/drift.mjs`, and `docs/hig-ownership.md` explains the rules. The checker itself is not in this repo.

## Reusable techniques worth learning

1. **Hash-pinned release lock with per-member verification and atomic cache.** File: `packages/npm/scripts/static_sources.py` and `static-sources.json`. `lock` records the SHA-256 of each release zip and of every WOFF2 inside it. It refuses zips whose member set is incomplete, duplicated or unexpected, and zips that do not carry the repo's exact `LICENSE` bytes. `fetch` checks local files against the lock first and downloads a zip only when files are missing. It then verifies the whole zip and each member, and writes the cache through a temp file plus `replace()`, so readers never see a partial download. Each source carries a provenance string `asset:path@tag`. Why it's worth learning: it pins a two-level artifact (archive plus members), not just a single file, and it fails with an error message that says how to fix the problem.
2. **Priority heap scheduler where tasks return their follow-on tasks.** File: `packages/font/tools/build_pool.py` (`run_pool`, `Task`). Each `Task.action()` returns the list of tasks it has made ready, so dependency chains (generate → variable → statics) need no explicit DAG. A heap ordered by (priority, sequence) starts the longest families first, at most `JOBS` actions run at once, and the run reports the highest concurrency it reached. Every completed future is checked before its dependents are queued. Why it's worth learning: it is a small, testable way to bound mixed CPU work without nested pools (`test_build_pool.py` tests it).
3. **Explicit overlap policy for script subsets.** Files: `packages/font/tools/webfonts.py` (`core_subsets`, `SHARED_RANGES`) and `test_subsets.py`. The cmap is split by Unicode script property into latin, greek, cyrillic and other. Only an explicit list of Common/Inherited code points may appear in more than one subset. The tests check that the union covers the source cmap and that no other pair of subsets overlaps. The CSS then declares several face files under one family with `unicode-range`. Why it's worth learning: the overlap rule is written down as data and can be checked, rather than left to accident.
4. **Deterministic binary outputs.** File: `webfonts.py` (`write_subsets`). It sets `recalcTimestamp=False` and `recalcBBoxes=False`, keeps the source OS/2 table bytes as they are, and relies on fontTools' canonical table order, so running it again produces byte-identical WOFF2. Stale outputs are removed when coverage shrinks. Why it's worth learning: content-addressed pipelines need generated files to be byte-stable.
5. **Cache keyed by exact input bytes and tool version.** File: `packages/font/tools/site_data.py` (`languages_of`, `.hyperglot-cache/`, described in `packages/font/README.md`). Only successful language-analysis results are cached, under the font's SHA-256 combined with the Hyperglot version. Deleting the folder forces fresh analysis. Why it's worth learning: the cache invalidates itself on any change to the input or the analyser, and failures are never cached.
6. **Retained reference implementation as a differential-test oracle.** File: `packages/font/tools/test_robust.py`. When overlap validation in `bwfont/robust.py` was optimised, the old flattening and winding math was kept in the test file "as independent references", and the fast version is checked against it. Why it's worth learning: it is a cheap way to make performance rewrites safe.
7. **Unicode identity integrity check.** File: `packages/font/tools/check_unicode.py`. It rejects:
   - invalid scalars (surrogates or values above 0x10FFFF);
   - cmap subtables that disagree with each other;
   - code points mapped to missing glyphs or `.notdef`;
   - stylistic alternates (`.ss01`, `.cv02`, `.zero` and similar) that are directly encoded;
   - confusable sets (`Il1`, `0O`, `rnm`, `cld`) whose characters do not get distinct cmap entries.

   It also requires every GSUB-reachable glyph to trace back to valid source text. Why it's worth learning: it makes "copy/paste returns the same text" a test you can run.
8. **Evidence bundle with an explicit "not tested" statement.** File: `evidence/verification.md`. Each gate lists its command, its result and the log file it points to. The document ends by listing what was **not** observed (no physical devices, no screen readers). Why it's worth learning: it records the limits of the claims as clearly as the passes.

## Fit with trillion-workshop tools

- **`tools/screen-looks`** (`read-data/look-document-css.js`, `lookFontFacesCss`). This is the closest real fit, and it is idea-level only. Today each face `{ family, weight, style, format, data }` becomes one `@font-face` with a single numeric weight and no `unicode-range`. Technique 3 suggests an optional `unicode_range` field on a face. It would be validated against a strict pattern such as `U+[0-9A-F]{1,6}(-[0-9A-F]{1,6})?` joined by commas and emitted as `unicode-range:…`. This lets a look carry, for example, a Latin face and a CJK face under one family name, and the browser fetches only what it needs. It is small and independently written, and it can be tested in `test/resolve-a-look.test.mjs` with a safe range kept and an unsafe one dropped. Variable-weight ranges (`font-weight: 100 900`) are a similar small idea.
- **`tools/pin-files-by-content`**. Technique 1 (archive-plus-member pins, and refusing an archive whose member set differs from what is expected) is a possible future extension. The tool currently pins only plain files in a folder, so this would be new scope rather than a small change.
- **`tools/check-a-rendered-video`** and **`tools/keep-a-record-library-valid`**. These already use BLAKE3 pins and evidence. Technique 8 (stating what was not tested) is a writing practice for them, not a code change.
- None of the font code can be ported, because of OFL.

## Cautions

- The code is OFL. Do not copy any Python, JS or TS from this repo into workshop tools, and do not ship modified Bloxwap fonts under the "Bloxwap" name (Reserved Font Name).
- The Unihan TSVs are under the Unicode License v3. Take them from Unicode directly if they are ever needed.
- The HIG drift checker used by `hig-drift.yml` lives in a separate `bloxwap/hig` repo at a pinned commit. Only its config is here.
- CI workflows run on self-hosted macOS runners and gate fork PRs off them. That setup is specific to this project.
- The build needs a heavy Python font toolchain (fontmake, skia-pathops, Hyperglot). Nothing here was run. All of the above comes from reading files.
