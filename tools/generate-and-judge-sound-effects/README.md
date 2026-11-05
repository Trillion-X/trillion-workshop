# tools/generate-and-judge-sound-effects/

Find, judge and pick sound effects by ear, the way a film's sound palette is chosen. The scripts search two free libraries for sound effects under licences a film may use, download the chosen ones with their licences read first, and render the palette and check it. They judge every candidate with earshot, a sound-judging Python package, and pick one per sound, levelled to the real sound. They place a cue plan's effects into one track, bring a variant palette to the reference loudness, and score soundtrack variants at every cue. They also fit music windows to a film's loudness arc. Everything runs on the person's own computer (`on-your-computer` rows): the sounds, the listening models and the person's choices are there.

The candidates are not made here. Forged sounds (earshot's forge) and the sounds of local models (Stable Audio 3 Small-SFX, MOSS-SoundEffect v2.0, HunyuanVideo-Foley) are styles of `tools/media-composition`'s one runner, `do-work/make-pictures-and-sounds.mjs`, as old trillion made sound effects: `tool:make-<style>` rows (old trillion `records/workshop-media-generation-tool-records.json`:5). This tool judges what they make.

What belongs to one person is never in this folder. That includes the categories and their words, the palette's sources and trims, the queries, the tuned thresholds, the music brief and the licence verdicts. Each comes in as a request or brief file. The judge also takes the person's settings record (`settings_record`: their `record:setting:generate-and-judge-sound-effects~<scope>` row of `list:settings`), read with the one settings reader, `tools/settings/read-data/settings.py` (`setting(given, folder, [(film), (person, me), (account, main)])`).

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | 13 `on-your-computer` rows, one per command below. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/judge_sound_effects.py` | `tool:judge-sound-effect-candidates-and-pick-one-per-sound`. It trims each candidate: an event that earshot finds, with clean edges, or the whole sound for swells. It renders the trim in the palette's format and reads it (match z, realness, measure). A lead-in is cut to peak where the real one peaks. The pick is the highest match z that is not distorted, optionally not from another sound's source. The pick is levelled to the real sound's active loudness and A/B-compared with it. The tuned values may come from the settings record. Ported from the private launch-video repository's sound-effect generator (`ports/judge-sound-effects.json`). |
| `do-work/listen_to_sound_effects.py` | Rank each category's folder, find the cleanest trim of the best (edges moved out in 5 ms steps to -30 dB of the peak), describe, realness, measure. `refine` is used by the judge. |
| `do-work/listen_to_whole_sounds.py` | Judge one-shot files whole (onset at -40 dB less 5 ms to the last sample above -50 dB). `whole_trim` is used by the judge. |
| `do-work/make_sound_palette.py` | Render the palette (decode, trim, fades, peak, 24-bit) and read each final file. `decode` is used by the judge. |
| `do-work/check_sound_palette.py` | Check the rendered palette against its spec and the licence manifest; exit 1 on a failure. |
| `do-work/search_freesound.py`, `do-work/search_mixkit.py` | Search the libraries' public pages per category (CC0 and CC BY only on Freesound), one request every 1.5 s. |
| `do-work/fetch_free_sound_effects.py` | Download the chosen items, reading each Freesound licence on the sound's own page first; keep a manifest. |
| `do-work/place_cues_into_an_effects_layer.py` | A cue plan's effects alone, placed at whole milliseconds with their gains and summed; its integrated loudness. |
| `do-work/match_an_effects_layer_loudness.py` | One common gain on a variant palette so its effects layer has the reference layer's loudness (`level.json`). |
| `do-work/score_soundtrack_variants.py` | Each soundtrack variant: earshot critique with the picture, timeline sync, realness, and match z at every cue on the layer and in the mix. |
| `do-work/find_music_windows.py`, `do-work/listen_to_music_windows.py` | The music window of each track whose loudness follows the brief's arc, and each excerpt judged against the film's section words and a reference stem. |
| `ports/*.json` | The SOURCE_FIRST_PORT contracts: each script's first commit here is the byte copy of its source, named by path identity because the source repository is private. |
| `test/test_judge_sound_effects.py` | Every command run for real on tones written in the test and on made-up library pages, with the stand-in earshot in `test/stubs/earshot` (match z is how close a file's brightest frequency is to the one its description names). |
| `test/generate-and-judge-sound-effects.test.mjs` | The rows' shape, and the Python tests run from `node --test`. |

Each script prints `{"result": ...}` or `{"error": ...}` as its last line.

## Where it came from

The scripts were ported from the private launch-video repository (its sound-effect generator, its sound scripts and its sound-effect A/B scripts). Each script's port is listed in `ports/`. The film-specific mixer the A/B ran (the film's own `mix.py`) stays with the film. The generator's three model scripts and its forge plan runner became makers and a style of `tools/media-composition`. Old trillion had no listening judge to port: `parts/judge-words` judges words, `parts/content-media-evidence` reads media evidence records, and `parts/record-audio` records, so nothing here duplicates them.

## Dependencies

**Depends on:** Python 3 with `numpy` and `soundfile`; `ffmpeg` and `ffprobe` on PATH; earshot (installed by the person, with its listening models) for the commands whose rows say so; `tools/settings/read-data/settings.py` (a sibling folder in the checkout) for a settings record.

**Depended on by:** its rows only.
