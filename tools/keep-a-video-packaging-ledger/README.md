# keep-a-video-packaging-ledger

A ledger of how videos are packaged: each video's titles, description, thumbnail image and the words on it, how the title and thumbnail work together, and the caption events where its opening and internal hooks are. Each value is pinned to the file it came from (BLAKE3 identity and size). Caption text is never copied: a hook is a caption file, an event index and its time span. Every change leaves the lines it does not target byte for byte as they were.

Four scripts, run by the person's AI on the person's own computer. Python 3 with the `blake3` package. All paths are arguments; the scripts hold no channel, folder or film of their own.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The four Workshop rows: `tool:add-reviewed-videos-to-a-packaging-ledger`, `tool:project-a-packaging-ledger-into-template-source`, `tool:check-a-packaging-intake-against-the-ledger`, `tool:check-a-compiled-packaging-template-against-the-ledger`. All `on-your-computer`. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/ingest_channel_intake.py` | Adds or reconciles explicitly admitted rows in the ledger (JSON Lines), and keeps its coverage summaries. |
| `do-work/project_packaging_ledger.py` | Projects one source key into an HTML file holding one inert JSON records block, plus a `word-template-spec@1` spec that points at it. |
| `do-work/readback_packaging_intake.py` | Checks an intake batch against the ledger before and after, writing nothing but its report. |
| `do-work/readback_compiled_packaging.py` | Checks a compiled template against the ledger and the files, and against an earlier compiled template and ledger. |
| `test/test_*.py` | 61 unit tests on made-up channels, videos, captions and thumbnails each test writes in a temporary folder. |
| `test/keep-a-video-packaging-ledger.test.mjs` | Runs the Python tests under `npm test`; skips, saying why, when python3 or blake3 is missing. |

## How to run it

```
python3 -m pip install -U blake3

# admit a reviewed batch (a new source key; --append-new for a later batch; --update-existing for unreviewed rows)
python3 -I tools/keep-a-video-packaging-ledger/do-work/ingest_channel_intake.py --root <folder> --ledger <ledger.jsonl> \
  --source-key <key> --intake <intake.json> --channel-catalog <catalog.json> --review <review.json> \
  --coverage <coverage.json> --source-coverage <source-coverage.json> --readback <readback.json>

# a pinned contract: stage first, then --apply once the person agrees
python3 -I tools/keep-a-video-packaging-ledger/do-work/ingest_channel_intake.py --root <folder> --ledger <ledger.jsonl> \
  --hook-enrichment <contract.json> --readback <readback.json> --preimage <preimage.json> \
  --expected-ledger-blake3 <current ledger blake3> --prospective-ledger <candidate.jsonl> [--apply]

python3 -I tools/keep-a-video-packaging-ledger/do-work/readback_packaging_intake.py --root <folder> --intake <intake.json> \
  --channel-catalog <catalog.json> --review <review.json> --source-key <key> --ledger <ledger.jsonl> \
  --before-ledger <earlier ledger.jsonl> --output <report.json> [--update-existing]

python3 -I tools/keep-a-video-packaging-ledger/do-work/project_packaging_ledger.py --root <folder> --ledger <ledger.jsonl> \
  --source-key <key> --output-html <source.html> --output-spec <spec.json> \
  [--previous-html <earlier source.html> --replace-video-id <id> ...]

python3 -I tools/keep-a-video-packaging-ledger/do-work/readback_compiled_packaging.py --root <folder> --source-key <key> \
  --ledger <ledger.jsonl> --compiled <TEMPLATE.json> --output <report.json> [--video-id <id> ...] \
  [--before-compiled <earlier TEMPLATE.json> --before-ledger <earlier ledger.jsonl> --expected-new-video-id <id> ...]
```

Every relative path in the ledger and the contracts is read against `--root`.

## The ledger and its modes

One JSON object per line, one line per video, keyed by `video_id` and grouped by `source_key` (the person's name for one channel or playlist batch). `ingest_channel_intake.py` admits a video only when it is in the intake manifest, the channel catalog and the review record, and only after the thumbnail image, metadata file and caption file it names exist and match. Its modes:

| Mode | What it changes |
|---|---|
| (none) | A new source key: inserts the batch's rows. Refuses when the key already has rows outside the batch. |
| `--append-new` | A later batch under an existing key and channel: writes only a byte suffix, so every earlier line stays exact. |
| `--update-existing` | Fills review fields into rows of the same key and channel that are still `unreviewed`; an exact re-run is a no-op. |
| `--direct-review-batch` | Applies a pinned `thumbnail-review-batch-readback@1` to existing rows (`--dry-run` with `--prospective-ledger` stages it). |
| `--identity-only-update` | Applies a pinned `youtube-packaging-identity-only-update@1` contract, keeping a preimage of each changed line. |
| `--hook-enrichment` | Applies a caption-evidence-pinned `youtube-packaging-hook-enrichment@1` contract. |
| `--source-reconciliation` | Applies a pinned `youtube-packaging-source-reconciliation@1` metadata/channel/review-status contract. |

The contract modes require `--expected-ledger-blake3` to match the ledger first. The identity-only, hook and source modes also write the original of every line they change to `--preimage` and check that putting those lines back reconstructs the earlier ledger exactly. The hook and source modes stage to `--prospective-ledger` and write the ledger only with `--apply`.

## Where the projection goes

`project_packaging_ledger.py` writes records (`id`, `unit`, `region`, `fields`, `source_provenance`) into `<script type="application/json" id="packaging">` and a spec whose `html_json_records` source names that block. `tool:make-a-word-template` (`tools/fill-a-template-without-changing-its-words/`) reads that spec and makes the template; `readback_compiled_packaging.py` then checks that template's records join back to the ledger. Nothing here imports that tool's code: the two meet only through those files.
