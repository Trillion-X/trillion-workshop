# check-a-videos-motion-against-a-reference

A script a person's AI runs by hand on the person's own computer. It says whether a video someone made moves about as much as the video it copies, against a bar the person passes in. The script holds no bar: how much the piece must move is the person's own record.

A motion measure that sets its "still" threshold from whatever window it is given moves the bar when a piece is trimmed. Here the threshold always comes from the whole reference, and the piece is measured from 0 to its end card at that threshold.

This tool measures how much the whole frame moves. Tracking a subject or an object through a clip is a different job: it belongs to bitfield-packages' motion-analysis, not to this tool.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:check-a-videos-motion-against-a-reference`: `on-your-computer`, with what it needs and the command. |
| `part.json` | The files other code may import: `read-data/motion-bar.mjs` and `read-data/measure-motion.mjs`. |
| `do-work/check-motion.mjs` | The command. Measures the reference and the piece, builds the bar from the person's rows, prints `{"result": ...}` or `{"error": ...}`. Exit 0 whether the piece passed or not; 2 when a flag, file or bar row is wrong. |
| `read-data/measure-motion.mjs` | The measure: `measureMotion(path, seconds, still)` decodes every frame as a small grey picture with ffmpeg, reads the change between neighbouring frames and returns `moving_share`, `longest_hold_s`, `holds_over_1s_per_min`, `seconds` and `still_threshold`. |
| `read-data/motion-measure.json` | The measure's own settings as DATA (frame width, the cut level, how the still level is read). They define how a video is read; they are no one's bar. |
| `read-data/motion-bar.mjs` | Pure: `rowsOf(record)`, `barFor(reference, rows)` and `judge(draft, bar, rows)`. |
| `test/check-motion.test.mjs` | Checks the rows, the verdict, the still level, the measure on small videos made with ffmpeg (a moving pattern, a still picture, a pattern that moves then holds) and the command's refusals, all with made-up bars. Skips, saying why, when ffmpeg or ffprobe is missing. |

## How it measures

ffmpeg decodes every frame as a small grey picture. The mean absolute change in grey between a frame and the one before it says how much the picture changed.

1. A change above the cut level is a cut, not movement.
2. A change above the still level, and not a cut, is movement. The still level is the amount below which nothing visibly changed. Grain and compression raise it, so it is twice the change a tenth of the way up the video's sorted changes, kept between a floor and a ceiling.
3. The reference sets the still level, and the piece is measured at that same level, so both are held to one eye.
4. A frame counts as moving when it or a neighbour changed, so animation drawn on twos or threes still counts.
5. A hold is a run of frames that are neither moving nor a cut, timed by the frame rate.

## The bar

A JSON record of kind `motion-bar`. A person keeps their own with their records and passes it in.

```json
{ "kind": "motion-bar", "rows": [
  { "name": "moving", "bar_key": "moving_min", "measure": "moving_share", "relation": "at_least", "times_reference": 0.5 },
  { "name": "hold", "bar_key": "hold_max_s", "measure": "longest_hold_s", "relation": "at_most", "times_reference": 3 }
] }
```

| Field | Meaning |
|---|---|
| `measure` | The name of a number the measuring module gives for a video: `moving_share` (the share of frames where the picture changes), `longest_hold_s`, `holds_over_1s_per_min`. |
| `relation` | `at_least` or `at_most`: which way the piece must stand against the bar. |
| `times_reference` or `value` | Exactly one: a multiple of the reference's own value for that measure, or a fixed number. |
| `name` | The key the row's yes or no is kept under in `pass`. |
| `bar_key` | The key the row's number is kept under in `bar`. |

The numbers above are examples. The person chooses the ones their work is held to; a bar set relative to the reference follows the reference when it is a very still or a very busy video. Moving-pixel share says how much the picture changes, not whether it reads well, so a pass means as lively as the reference and nothing more.

## How to run it

```
node do-work/check-motion.mjs --reference reference.mp4 --render mine.mp4 --end-card-start 44.2 --bar my-bar.json
```

## Dependencies


**Depended on by:** nothing in this repository; Trillion offers the row to a person's AI.
