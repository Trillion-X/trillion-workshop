# tools/measure-a-characters-voice-lines-and-staging/

Scripts a person's AI runs on the person's own computer to study one recurring character of a show: find when the character speaks in every recording (a speaker embedding plus pitch, from a few stretches the person labels, so a cast member's own voice pitched up is told from every other high voice), list what it says, measure how the show stages its turns, sum its time per video against how the videos did, count the show's running jokes in the captions, and collect and code the viewer comments that name it.

The tool holds no show, character, number or word of its own. The character's label and pitch gates, the show's formats, the stripped episodes, the running terms, the mention pattern and the codebook are the person's settings: a row of their `list:settings` (`record:setting:measure-a-characters-voice-lines-and-staging~<scope_kind>~<scope_id>`), read by the one settings reader, `tools/settings` (`read-data/settings.py` `setting`). `read-data/settings-keys.json` says what each key means.

## Layout a run reads

| Folder | Holds |
|---|---|
| `data_folder` | The show's folder: `catalog.tsv` (written by `catalog_videos.py`), `voice/` (`seeds.npz`, `<id>.emb.npz`, `<id>.turns.json`), and the tables the scripts write (`character-per-video.tsv`, `character-lines.tsv`, `character-caption-turns.tsv`, `staging.tsv`, `lore-terms.tsv`, `comments-character.tsv`, `comments-summary.tsv`, `comments-character-coded.tsv`). |
| `youtube_folder` | The person's yt-dlp library: `flat/<channel>-videos.json` and `-shorts.json`, `captions/` and `videos/` (`<id>.en.json3`, `<id>.info.json`), `comments/<id>.info.json`, `measure/<id>/rhythm.json` and `earshot-timeline.txt`. |

Every `do-work` script reads one JSON request on standard input (the folders, `settings_record`: the person's settings row as `records:read` answers it, or a file holding it, and optionally `settings` laid over it) and prints `{"result": ...}` as its last line, or `{"error": ...}` saying what to fix, with exit 2.

## Files

| File | Purpose |
|---|---|
| `tool-rows.json` | Ten rows. `computer` rows with a sample run each: catalog, lines in turns, staging, time per video, running terms, comments named, comments coded. `on-your-computer` rows (they need numpy, scikit-learn, librosa, torch, pyannote and ffmpeg): find when a character speaks, high-pitched stretches, turns from caption marks. |
| `do-work/find_voice.py` | Steps `embed`, `seed`, `score`, `batch`, `rescore`: the voice finder (speaker embeddings plus pitch; an adaptive voice of the character per recording). |
| `do-work/check_seed_model.py` | Leave one labelled recording out: window precision and recall of the seed model alone. |
| `do-work/check_voice_finder.py` | Leave one labelled recording out: the whole finder over pitch-gate ratios and cosine thresholds. |
| `do-work/find_voice_by_pitch.py` | Runs of voiced speech in the character's pitch band, by pitch alone. |
| `do-work/count_caption_turns.py` | A second count of the character's turns from the captions' `>>` marks and each turn's pitch. |
| `do-work/catalog_videos.py` | The channel's catalog: format per video and views against a rolling same-format baseline. |
| `do-work/list_lines_in_turns.py` | Every caption line inside the character's turns, for quoting. |
| `do-work/measure_staging.py` | Cuts at the turn's entry, shot lengths inside exchanges, music stop-downs before turns, each against chance. |
| `do-work/sum_per_video.py` | Time per video (opening, body, close, exchanges) and the tables by year against views. |
| `do-work/count_terms.py` | Running jokes, lore names and rituals across the captions. |
| `do-work/collect_mentions.py` | The comments that name the character, per video. |
| `do-work/code_mentions.py` | Those comments coded with the person's codebook. |
| `read-data/shared.py` | Caption lines, a video's caption file, the catalog, the request and its settings (`tools/settings/read-data/settings.py`; `scopes` [{kind, id}] choose among several rows), word rules judged by `tools/judge-words`, the answer line. |
| `read-data/settings-keys.json` | Every settings key with its type and meaning; a run missing a key it needs is refused, naming it. |
| `show/show_lines.py`, `show/show_turns.py`, `show/show_runs.py`, `show/show_line_pitch.py`, `show/pitch_by_line.py` | Views for reading and hand-labelling: caption lines, the turns or pitch runs with their words, lines with their window pitch, lines with their pyin pitch. |
| `ports/*.json` | One port contract per file: the source in trillion-launch-video (by `path_multihash`), its byte copy commit, what it preserves. |
| `test/measure-voice-lines.test.mjs` | Runs the Python tests and checks the rows. |
| `test/test_measures.py`, `test/test_word_rules.py`, `test/fixture_world.py` | Every script on a made-up show (a lighthouse keeper and his parrot). |

## Moved from

Ported from the character-cast scripts of the private trillion-launch-video repository at `5a9ba3988a` (the contracts in `ports/` name each source by the BLAKE3 identity of its path). The first commit here is the byte copy of each file's clean lines; the lines that held a show's or a person's name, a video id or a private path became settings and request folders. Old trillion had no voice, pitch or caption-turn finder (`parts/record-audio/README.md:30`: the recorder "does not own transcription, media analysis"; `parts/content-media-evidence` only projects evidence rows); its one word-rule engine, `parts/judge-words/do-work/judge-words.mjs` (pattern rules at lines 71-72, `makeJudge` at line 146), lives on as `tools/judge-words`, and every mention, code and term here is judged by it (`read-data/shared.py` `matches`), with no second matcher. Settings follow old trillion's `setting` record (`src/decision-store.mjs` 751-762), read through `tools/settings`.

Changed on purpose: `<id>.hf.json` and its `hf_s` are now `<id>.turns.json` and `character_s`; the thirds by character seconds print empty instead of stopping when no year has six videos; the quote finder and quote list checker moved to `tools/cite-principles-from-captions` (`find`, `verify`), which already did that job.

## Dependencies

**Depends on:** Python 3; `tools/settings` (`read-data/settings.py`) for `settings_record`; `tools/judge-words` (`do-work/judge-against-rules.mjs`, node) for the running terms, mentions and codes; numpy for the caption-turn count and the views; numpy, scikit-learn, librosa, torch, pyannote.audio and ffmpeg for the voice finder and the pitch runs.

**Depended on by:** `tool-rows.json`.
