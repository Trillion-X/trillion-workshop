# cite-principles-from-captions

A script a person's AI runs on the person's own computer. It keeps the principles people state or show in captioned videos, each with the exact words and the second they are said, proves every quote is really in the captions, and ranks each principle by how many independent channels back it and how well their videos did. With a chat model on the same computer (or any OpenAI-compatible one the person names) it also reads every part of every video and writes the rows the person asks for, from any domain, each quote put back onto the exact caption words and seconds it came from.

What the principles are about, how advice sounds, what rows a model is asked for and how they are shaped, and how rows group and name their stages are the person's own, passed in at run time: as files, or as one row of their `list:settings` (`--settings-record`, read through [`tools/settings`](../settings/)). The tool holds none of them.

## Files

| File | Purpose |
|------|---------|
| `what-this-tool-does-and-how-to-run-it.json` | The Workshop row `tool:cite-principles-from-captions`: `on-your-computer`, with the command that fetches and runs it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/cite_principles.py` | The command: `corpus`, `coverage`, `candidates`, `extract`, `find`, `verify`, `registry`, `index`. Each prints its account and a last line `{"result": ...}`. `verify` and `find` exit 1 (2 for a video with no captions) when a quote is not found. |
| `read-data/captions.py` | Pure readers: caption files to timed lines, exact-quote search, how a video did against its channel's usual, scoring of passages, evidence strength. |
| `../settings/read-data/settings.py` | The shared reader for the person's `list:settings` row (`--settings-record`). |
| `read-data/registry.py` | Pure: merges working rows into the ranked registry, and writes its Markdown index. |
| `read-data/extraction.py` | Pure: cuts videos into the parts a model reads (short videos packed together), fills the person's prompt, reads the model's reply, and places each quote on the caption words it came from. |
| `ports/index-template.json`, `ports/settings-record.json` | The port contracts for the grown `registry.py` (index into the person's template; the job of launch-video `tools/principles/make_index.py`) and `cite_principles.py` (`--settings-record`). |
| `test/cite-principles.test.mjs` | Runs every command on synthetic captions made here, from files and from a made-up `list:settings` row. |
| `test/test_captions.py`, `test/test_extraction.py` | The pure readers. |
| `test/test_verify.py` | The quote check against the corpus and caption files outside it. |
| `test/fake_chat.py` | A stand-in OpenAI-compatible chat server for the `extract` test. |
| `test/make_fixture.py`, `test/write_json.py` | Make the synthetic inputs. |

## How to run it

A captions folder holds, per video, `<id>.info.json` and `<id>.en.json3` (for example saved with `yt-dlp --write-subs --write-auto-subs --write-info-json --skip-download`).

```
python3 do-work/cite_principles.py corpus --captions ./captions --views-table ./views.tsv --out ./work/corpus.jsonl
python3 do-work/cite_principles.py candidates --corpus ./work/corpus.jsonl --terms ./terms.json --out ./work/candidates
python3 do-work/cite_principles.py verify --corpus ./work/corpus.jsonl --rows './work/rows/*.jsonl'
python3 do-work/cite_principles.py registry --corpus ./work/corpus.jsonl --rows './work/rows/*.jsonl' --out ./principles.jsonl --merge ./merge.json --lanes ./lanes.json --id-map ./work/map.json
python3 do-work/cite_principles.py index --registry ./principles.jsonl --corpus ./work/corpus.jsonl --views-table ./views.tsv --id-map ./work/map.json --template ./index-template.md --out ./INDEX.md
```

Every part of every video, read by a model:

```
python3 do-work/cite_principles.py corpus --captions ./captions --transcripts ./transcripts --infos ./infos --out ./work/corpus.jsonl
python3 do-work/cite_principles.py coverage --corpus ./work/corpus.jsonl --rows './principles.jsonl' --out ./work/coverage.json
python3 do-work/cite_principles.py extract --corpus ./work/corpus.jsonl --asks ./asks.json --model ./model.json --out ./rows --channels 'Channel One' --max-load 80
python3 do-work/cite_principles.py verify --corpus ./work/corpus.jsonl --rows './rows/*.jsonl'
```

The person's files:

| File | Shape |
|------|-------|
| `views.tsv` | A header line `channel`, `kind` (`short` or `video`), `views`, then one video per line. Optional: without it each channel's usual is the median of its videos in the folder. |
| `terms.json` | `{ "topic": "word\|word", "title": "word\|word", "advice": ["phrase", ...] }`: what the principles are about (regular-expression parts), which titles are about it, and how advice sounds in the speakers' words. |
| rows | JSON lines: `id`, `principle`, `kind` (`stated`, `demonstrated`, `stated+demonstrated`), `lanes`, `sources` `[{video, t, quote}]`, `demonstrated_in` `[{video, t, how}]`, `test`, `do_it`, `transfer`, and optionally `paraphrase` and `contradicts` `[{id_or_text, how}]`. |
| `merge.json` | `{ "groups": [{ "ids": [...], "text": "wording of the merged principle" }], "contradictions": [[id, id, "how"]], "recorded_by": "..." }`. A row in no group stands alone. |
| `lanes.json` | `{ "stages": { "stage name": ["lane", ...] }, "lane_names": { "lane": "canonical lane" } }`. |
| transcripts | `<id>.json` with `segments` `[{start, text}]` or `words` `[{text, start, type}]` (`type` `word` or `spacing`), and `<id>.info.json` beside it or in an `--infos` folder. Words become lines that end at a sentence's end or after 12 words. |
| caption lines | `--caption-lines FILE ...`: one video per line, `{ video_id, url, status, lines: [[second, words]], info }` (a harvester's `captions.jsonl`). The lines are kept as they are; `info` gives the video's details; a video whose `status` is not `ready` counts as without captions. |
| `asks.json` | `system` (what to ask for), `user` (`{parts}` and `{parts_count}` are filled), `part_header` (filled per part from the video's fields: `{part}`, `{channel}`, `{title}`, `{from_second}`, `{desc}`, ...), `reply_schema` (a JSON Schema the server holds the answer to, when it can), `rows_key`, `part_field`, `quote_field`; optionally `drop_when` (`{field: [values]}`: a row whose field holds one of the values is set aside, with the reason, before its quote is looked for), `carried_by_quote` (`{field, words, ignore?, neighbour_lines?, least_words?, also_in?}`: every match of the `words` pattern in the row's `field` (numbers and names, say; a capital that starts a sentence is not a match) must be in the quote or in the video fields `also_in` names; one said only on the caption lines beside the quote makes the shortest run of words there holding it the quote, at least `least_words` long; one said nowhere near sets the row aside with the missing words), `guest_from` (`[{field, pattern}]`, a named group `name`: the guest a video's own fields name, first match wins, else null), `chunk_words` (default 1500), `quote_most_words` (25), `quote_match_at_least` (0.8), `description_chars` (400), `name`. Every other field of a reply row is the person's and is kept as it is. |
| `index-template.md` | The person's own Markdown for the index. A section is the lines from `<!-- cite-principles:NAME [N] [missing="..."] -->` to `<!-- /cite-principles:NAME -->`, NAME one of `top`, `demonstrated`, `contradictions`, `stages`, `channels`, `silent-channels`, `lanes` (N rows for `top`, `demonstrated` and `lanes`; `missing` is what `channels` says for a channel the views table does not list, default `n.a.`). A section's table header (its lines up to the `\|---\|` rule) is kept as written and every line after it is written anew. Everything outside the sections is kept as written, with `{ids:A-1,B-2}` the principle ids those working rows went into (from `--id-map`), `{count:NAME}` one of the registry's counts (`principles`, `stated`, `demonstrated`, `both`, `with-demonstrations`, `quotes`, `demonstrations`, `merged`, `multi-channel`, `contradiction-pairs`, `one-sided`, `videos-read`, `channels-read`, `lanes`) and `{evidence:ID.FIELD}` one principle's evidence (`independent_channels`, `videos`, `quotes`, `demonstrations`, `strength`). The written index is a template again. Without one, every section is written under plain headings. |
| `model.json` | `{ "url": "http://127.0.0.1:11434/v1", "model": "...", "key_env"?: "VARIABLE", "max_tokens"?, "body"?: { more request fields } }`: any OpenAI-compatible chat server (Ollama, llama.cpp, MLX, LM Studio, a rented one). |

Alternatively, an explicit Workshop profile uses the existing model owner:

```json
{"transport":"workshop","job":"do-a-task-step","max_tokens":2000,"body":{"temperature":0,"seed":20261123}}
```

This resolves the installed site's command through the shared shell owner's strict `installedSiteCommand` export, then calls only `{cli} call tool:ask-a-model -`, passing the unchanged prompt messages as JSON on stdin. The signed-in CLI and owner choose the route and model; this tool neither launches a server nor selects a private endpoint. The profile accepts no tool, command, argv, URL or model override. `body` accepts only `temperature` and `seed`. The owner may apply a lower token cap or its own output format. In particular, `do-a-task-step` currently asks for a JSON object and requests an output cap of 2000 tokens; this is not parity with an HTTP profile requesting 2500 tokens and native JSON Schema enforcement. Keep differing phases and output directories explicit rather than changing an existing pinned run in place.

Extraction with `asks.reply_schema` requires `jsonschema` and `referencing` for either transport (see `requirements-extract.txt`). The unchanged schema and all references are checked before generation; only locally registered schema resources can resolve and no schema URL is fetched. The complete strict JSON reply is validated locally before any part can succeed. Duplicate members and non-finite constants are refused. Missing dependencies, invalid schemas, malformed JSON, invalid row containers, schema-invalid output or missing actual model/route identity fail the part. Workshop requires the configured rows array. HTTP retains its existing row-container, bare-array and standalone-row shapes when they satisfy the person's schema; with a schema it accepts exactly one complete JSON value, and without a schema it also permits multiple row values. An explicit rows member must always be an array. This does not prove the statements' semantic support or completeness. Both transports require `finish_reason: "stop"` and refuse truncated, tool-call, refusal, error and empty answers. HTTP request fields and native schema requests remain as configured; HTTP servers must now report the completion reason.

Each kept row records `extracted_by` from that reply and `extraction_model` with its transport and model evidence. Each video's `done.jsonl` entry also keeps `model_replies`, including zero-row answers. A single model remains a string in `model`; differing models are listed. Identity is returned per call, so concurrent replies cannot overwrite one another. Existing row IDs, whole-video writes, failed-part retries and finished-video skipping remain the same. The HTTP path labels a model absent from its response as the requested model with `model_reported: false`; Workshop requires both actual `model` and `served_by`. It also checks the whole CLI receipt's successful integer `exit_code` and exact tool identity before reading its nested answer, and retains the owner's replay evidence. An error receipt containing success-shaped text cannot complete a part.

Every new extraction directory has `extraction-phase.json`, bound by BLAKE3 to the loaded corpus, asks, model profile and selectors. A changed binding is refused before model calls or output writes; use a separate directory for a changed phase. The directory is locked during a run so another extractor cannot write it concurrently. Existing nonempty unbound directories are refused by default. `--legacy-unbound-http` explicitly continues an old HTTP directory without inventing a binding for its old rows; it never permits Workshop adoption of old data. Original pinned runs need their original settings and an independently qualified continuation. A phase binding identifies inputs; it does not establish source truth or model equivalence.

Rejected attempts retain sanitized model, route, finish and owner-receipt evidence in `failed.jsonl`, including failures before a later successful retry. Diagnostic JSON uses Unicode escapes independently of admission. Reply strings must encode as UTF-8, floats must remain finite in Python's numeric representation, and token counters must be nonnegative exact JSON wire integers at most 2**53-1. These are representation checks, not a token budget. HTTP keeps its supported thinking/fence framing around locally validated JSON; a configured schema permits one complete value, while schema-free HTTP also keeps the existing multiple-value row shapes. Workshop requires a bare object. Kept-row deduplication excludes call evidence and retains contributing evidence separately. Rows and checkpoint metadata are serialized before appending; this prevents metadata errors leaving orphan rows, and is not a multi-file filesystem transaction. Requested token limits and provider-reported usage are distinct evidence, not a guaranteed hard budget or HTTP/Workshop parity.

`extracted_by`, `extraction_model`, `extraction_models`, `extraction_phase` and `asks` are controller-owned fields; reply rows cannot supply their provenance. JSONL readback uses physical file lines so Unicode separators inside strings survive coverage and resume. HTTP thinking and code-fence frames are recognized only between JSON values; literal tags inside strings are kept unchanged. Malformed frames and extra scalar values are refused. Explicit rows members must be arrays, and fields consumed as quote or carried statement text must be strings.

Coverage destinations are checked before extraction dispatch against loaded inputs, phase metadata, ledgers, channel outputs and their `.nxn.json` sidecars, including symlink and hardlink aliases. Future path names are conservatively case-folded to protect case-insensitive filesystems. The full protected set is checked again immediately before replacing the report. Coverage uses a uniquely created temporary report rather than an overwriteable fixed `.part` name. Known checkpoint and internally selected row paths are read literally, so brackets in a directory name do not change which files resume or coverage reads. User-supplied row patterns remain globs. HTTP code-fence openers take an empty language marker or `json`; extra text on that delimiter is refused.

`extract` options: `--channels` (only these, in this order), `--videos FILE` (ids in reading order), `--limit N` (videos this run), `--chunk-words`, `--concurrency N` (requests in flight; a server with several slots or batching answers them together), `--max-load L` (wait before each request while the one-minute load average is above L), `--attempts` (answers that cannot be read, or that the server refuses, before the video is left for the next run), `--retry-seconds`, `--wait-for-model` (seconds to keep waiting, without spending an attempt, for a server that cannot be reached, default 1800), `--report-every`.

`extract --coverage-out FILE` atomically refreshes coverage after each progress report and at the end, including a `row_files` manifest (`{path, sidecar?}`, relative to that coverage file). Downstream importers can consume each channel without naming channels in code or reading extraction ledgers as knowledge. `coverage --done FILE` separately counts completed videos, including videos that yielded no kept rows; `mined_videos` counts videos cited by kept rows. Completed, rejected and failed extraction outcomes do not inflate kept-row coverage. A source's original URL is retained when the corpus supplies one, including other platforms.

The same settings as one row of the person's `list:settings` (`record:setting:cite-principles-from-captions~account~main`, or a film's or piece's row), saved from `records:read`:

```
python3 do-work/cite_principles.py candidates --corpus ./work/corpus.jsonl --settings-record ./setting.json --out ./work/candidates
python3 do-work/cite_principles.py registry --corpus ./work/corpus.jsonl --rows './work/rows/*.jsonl' --settings-record ./setting.json --out ./principles.jsonl --id-map ./work/map.json
python3 do-work/cite_principles.py index --registry ./principles.jsonl --corpus ./work/corpus.jsonl --settings-record ./setting.json --id-map ./work/map.json --out ./INDEX.md
```

Its `settings` object holds any of `terms`, `caps`, `lanes`, `merge` (each the JSON its file flag takes) and `index-template` (the Markdown `--template` takes). `--scope KIND:ID ...` picks the row, most specific first (default `account:main`); a retired row is refused; a file flag given beside it wins for that one setting.

Options: `candidates --caps FILE` (`{channel: most passages to keep}`), `--window-seconds`, `--per-video`, `--opening-seconds`, `--openings-per-channel`, `--openings-per-large-channel`; `verify --caption-files GLOB` (json3 files for videos not in the corpus; `{video}` is the video id); `registry --id-map FILE`, `--url-template`; `index --template FILE`.

Floating-point literals must retain the same decimal value when Python serializes the parsed float again; a literal that would round into a different value is refused before schema validation. This keeps a fractional part index from rounding into a schema-valid integer. Ordinary values such as `0.1` remain supported. This guard is not a claim of exact arbitrary-precision schema arithmetic. Coverage expands each input glob once and reads that frozen list as literal paths. Reports may live beneath the extraction directory, but cannot be placed beneath a protected file path.

Reports directly in the extraction directory cannot use `.jsonl` or `.nxn.json` suffixes, in any letter case; those names belong to retained extraction data. Use a report name such as `coverage.json`. A report's parent directory must already exist or be an output directory or ancestor that extraction setup will create. These checks happen before model dispatch.

Report writes and returned report paths use the resolved parent directory while preserving the named leaf and its atomic replacement semantics. The parent is checked again after extraction setup, before dispatch.

Extraction strictly decodes the asks and model-profile JSON before dispatch. Embedded schema resources are checked under their own dialect without changing the schema sent to the model or used for runtime validation. HTTP protocol/body-read failures enter the recorded rejection and retry path.

Internal extraction coverage treats channel files as kept rows and counts their controller-owned `sources`; arbitrary user fields are not ledger markers. For a separate coverage command over known kept extraction rows, use `--kept-rows`. Default mixed-input coverage retains outcome filtering and tolerates unrelated optional citation-field shapes. Content deduplication preserves JSON value types, including Boolean versus number, and phase binding retains the effective order of `drop_when` rules.

## What it does

1. **Corpus.** One line per video that has captions: channel, title, views, kind, the captions as `[second, text]` lines and `xmed`, the video's views divided by its channel's usual views for that kind (the median from the views table, else from the folder).
2. **Candidates.** Each video is cut into windows of 40 seconds. A window scores 1.5 for each distinct topic word (first six letters), 1 for each advice phrase, 1.5 when the title matches, and 0.7 times log2 of `xmed`. A window under 25 words is dropped. Each channel keeps its best windows (3 per video; at most `3 x videos`, or `min(220, 25 + 0.12 x videos)` for more than 8 videos, unless `--caps` names it) and the first 45 seconds of its best videos by `xmed`.
3. **Verify.** A quote must be an exact substring of the video's captions after case, runs of white space and curly apostrophes are folded. `BAD` is a quote that is not said; `MISSING` is a video with no captions (never taken for a wrong quote); `TOFF` is a quote said more than 3 seconds from the row's `t`.
4. **Coverage.** Per platform and channel: videos, shorts, words, and how many videos the given rows already cite (a row's `video`, `sources[].video` or `demonstrated_in[].video`).
5. **Extract.** Each channel's videos are cut at caption lines into parts of at most `chunk_words` words; consecutive short parts are packed into one request, each under its own header. The model answers rows naming their part. Each row's quote is matched to the caption words of its part (case, punctuation and apostrophes ignored): an exact run, else the window holding the most of its words in order when at least `quote_match_at_least` of them are there. The kept quote is the caption's own words over that span, cut to `quote_most_words`, with `t` (its first line's start) and `t_end` (the start of the line after its last, else the video's end) and `quote_match`. A row whose quote is not in its part goes to `dropped.jsonl` with the reason. Rows are written per channel to `<channel>.jsonl` as `{id, ...the reply row's fields, extracted_by, asks, sources: [{video, platform, channel, guest, title, t, t_end, quote, quote_match, requoted?}]}`, `id` = `<video>@<t>#<n>`. A video is written whole when its last part is answered, with one line in `done.jsonl` (rows, dropped, tokens, seconds, model); a part that fails every attempt keeps all that video's rows back (its failed answers go to `failed.jsonl`), and the next run asks for that video again and skips every finished one, so a stop loses only the videos in flight.
6. **Registry.** Working rows in one group become one principle: sources and demonstrations without repeats, lanes in first-seen order, kind from the union. Evidence strength is the sum over independent channels of the best of `log2(1 + min(xmed, 64))`, halved when the quote only demonstrates the principle, so more channels and better-performing videos raise it and one outlier cannot. Principles are ranked by strength, then quotes, and numbered `P-001`. A row's `contradicts` that names other working ids becomes links to their principles; contradictions from `merge.json` are added both ways.

7. **Index.** A Markdown page of the registry written into the person's template: counts (principles by kind, quotes, demonstrations, merged, multi-channel, contradiction pairs and one-sided notes, videos read), the strongest N principles with one source per channel, demonstration-only principles, every contradiction pair once (with the first disagreement the registry records for it, so the same registry always gives the same page), principles per stage, per channel the videos read, the videos the views table lists, and principles stated and demonstrated (a channel a principle cites is listed even when none of its videos were read), the channels the views table lists with nothing read, and the most used lanes. The person's own words around the sections stay as they wrote them.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------------|
| `CaptionText` | `(segs).second_of(quote) => second \| None` | The exact-quote search. |
| `passages` | `(video, craft, advice, title_pattern, window, per_video) => [passage]` | The best windows of one video. |
| `evidence_strength` | `([(channel, xmed, weight)]) => (strength, {channel: best})` | The evidence rule. |
| `build_registry` | `(rows, corpus, stages, lane_names, groups, contradictions, recorded_by, url_template) => (principles, id map)` | The merge. |
| `index_markdown` | `(principles, {channel: videos read}, {channel: listed} \| None, template \| None, id map) => markdown` | The index page, written into the person's template. |
| `place_quote` | `(Captions, quote, within, at_least, most_words) => {quote, t, t_end, match} \| None` | Puts a model's quote on the caption words it came from. |
| `parts_of` | `(videos, most_words) => [[part]]` | The parts a model reads, short videos packed together. |
| `rows_of_reply` | `(asks, chunk, videos, captions_of, reply, base) => (kept, dropped)` | A reply's rows, each with its placed source. |

## Dependencies

**Depends on:** Python 3.10 or later; `extract` also needs `blake3` for phase identity and, when a reply schema is configured, `jsonschema` and `referencing` (declared in `requirements-extract.txt`). Other commands use the standard library; `tools/settings/read-data/settings.py` (beside it in the same clone) for `--settings-record`. Only `extract` sends anything: each part's words go to the chat model the person's `model.json` names (on their own computer when its url is local); a key, when needed, is read from the environment variable it names and never written down.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json` (`tool:cite-principles-from-captions`), run on the person's computer by their AI.

Extraction refuses channel names whose normalized output filenames collide with `done.jsonl`, `failed.jsonl`, `dropped.jsonl` or another channel, before creating phase state or calling a model. Bound resumes also require each checkpoint to name the verified phase; explicit legacy unbound HTTP continuation remains separate. Internal extraction coverage uses the in-memory bound corpus even if the input file changes during the run; standalone coverage reads its supplied corpus file. A response-body connection failure consumes a recorded reply attempt rather than a connection-establishment wait.

`--wait-for-model` waits only on identifiable connection-establishment failures (refused connection, name resolution or unreachable network/host). Resets and failures with an unknown stage consume recorded attempts. Every visited schema resource or resolved target with an explicit `$schema` must name a supported dialect; omission still inherits its containing dialect.

While holding the output-directory lock, extraction checks existing planned append targets and its manifest before phase setup: they must be private regular files, cannot be symlinks or hard links, and cannot alias loaded inputs. Bound retained channel rows must name that phase before resume dispatch or internal coverage publication; explicit unbound legacy continuation and standalone coverage do not acquire a new phase requirement. Provider-supplied `id` values do not split otherwise identical findings: final IDs remain controller-assigned. This is cooperative directory locking and preflight validation, not a guarantee against an unrelated process replacing files during a run or a multi-file power-loss transaction.

Supported schemas may use mixed dialects, but a reference crossing dialects to an object fragment must put its effective supported `$schema` on that target. Otherwise preflight refuses the schema before generation: the dependency's runtime fragment descent cannot guarantee the inherited dialect. The original request schema is never rewritten. Strictly rejected documents may retain individually safe, unique diagnostic model/route/status claims; these claims never admit rows, and duplicate syntax prevents diagnostic reconstruction. Internal sidecars must also be private regular files without aliases to inputs or extraction state. Guest matching keeps its Python-text convention with deterministic nested object key order, consistent with phase identity.

Phase manifest version 2 binds the guest-rendering and content-identity conventions as well as inputs. Earlier bound manifests are refused, never migrated or rewritten; explicit legacy unbound HTTP continuation retains its existing exception. Content deduplication treats equal admitted JSON numbers as equal (`1`, `1.0`, `1e0`) while keeping Booleans distinct, without changing the first retained row's values. Schema-reference preflight derives target dialects from structural locations, including pointers through embedded declarations without `$id`; unsupported cross-dialect inheritance still refuses before dispatch. A timed-out Workshop process remains rejected even if its captured output contains a complete receipt: safe claims may be retained diagnostically, with `cli_timed_out` and no invented subprocess exit code.

Reference preflight incorporates schema subtrees discovered through local references, including annotation locations, before accepting fragment dialect compatibility. Ambiguous effective dialects are refused. Rejected-reply diagnostics keep only model, route, finish and usage claims at the reply level; Workshop tool/status/replay claims stay inside `owner_receipt` and cannot replace controller-owned invocation evidence.

Content keys use an explicit-stack typed encoding and are computed once in the worker before a part succeeds. Collection uses those keys and retains the first original row; the key encoder adds no recursive representation layers to admitted nested custom data.

Schema preflight discovers explicit dialect boundaries reachable through local references to a stable set before checking inherited targets. Provisional inherited dialects are not committed as declarations. Supported same-dialect annotation targets work in either reference order; unsupported implicit crossings still refuse. The diagnostic reply-field policy is shared by strict replies and diagnostic recovery, with outer Workshop receipt claims kept separately. The request schema remains unchanged; preflight and its local registry use an equivalent JSON-value copy.

Schema discovery rebuilds reachable declarations and errors on each pass, discarding paths that cease to be schema-bearing under the settled dialect. Repeated nonconverging boundary sets refuse before generation. Diagnostic recovery uses the same finite, lossless float conversion as strict decoding, retaining representable type claims while keeping failed conversions unavailable and duplicate syntax refused.

HTTP JSON and frame boundaries accept only JSON whitespace (space, tab, carriage return, line feed). Other Unicode whitespace outside values or in a fence-language opener is refused; characters inside JSON strings and supported frame contents are preserved.

Workshop extraction needs Node.js and the existing `use-your-tools-from-a-shell` sibling owner. No product command is built into this shared tool: the shell owner reads its installed-site DATA, and missing or ambiguous installations refuse. The resolved command is cached for a run, included in dispatch evidence and phase-profile identity, and cannot be supplied by a model profile or reply. A different installed-site command refuses an existing bound phase; input profile files remain unchanged.

The strict installed-site reader belongs to `use-your-tools-from-a-shell/read-data/installed-site.mjs`. It reuses that owner's discovery and settings, requires readable JSON with an explicit valid command matching the installation, and never uses the ordinary invocation-name fallback. Existing fallback callers are unchanged. Outer and nested reply `isError` fields may be absent or exact Boolean false; all other present values refuse completion.
