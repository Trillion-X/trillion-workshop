# make-a-lut-for-log-footage

A script a person's AI runs by hand on the person's own computer. It writes a `.cube` colour lookup table (LUT) that turns a camera's flat log footage into display colour. The script holds no camera, curve or look: all of that is one profile the person passes in. The same profile and settings always give the same file, byte for byte.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:make-a-lut-for-log-footage`: `on-your-computer`, with the commands that fetch it and run it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/make_lut.py` | The command. Reads the profile, builds the table and writes it; the last line printed is `{"result": ...}` or `{"error": ...}`. |
| `test/make-lut.test.mjs` | Runs the command with two profiles (a published-curve example and a made-up camera written in the test) and checks the file's shape, its grey ramp, each setting, the profile's own settings and refusals. Skips, saying why, when python3 or numpy is missing. |
| `test/fixture/published-slog3-example.profile.json` | An example profile built from one camera maker's published log curve and gamut matrix. A test fixture only; the script never reads it unless it is passed in. |
| `test/fixture/published-slog3-size5.cube` | The 5-point table that profile gives, the golden the test compares byte for byte. |

## The profile

A JSON record of kind `log-to-display-profile`. A person keeps one per camera with their own records and passes the one they need.

| Field | Meaning |
|---|---|
| `kind` | `"log-to-display-profile"` |
| `title` | Words for the table's `TITLE` line; the exposure and saturation are added after them. |
| `log_curve.code_scale` | The code-value range the curve is written in (1023 for 10-bit). |
| `log_curve.cut_code` | The code value where the straight toe ends and the log segment begins. |
| `log_curve.log` | `base`, `offset_code`, `slope_code`, `mid_grey`, `pedestal`: linear = `base ^ ((code - offset_code) / slope_code) * (mid_grey + pedestal) - pedestal`. |
| `log_curve.toe` | `origin_code`, `linear_at_cut`: under the cut, linear = `(code - origin_code) * linear_at_cut / (cut_code - origin_code)`. |
| `gamut_matrix` | 3 rows of 3 numbers: the camera's gamut to the display's primaries. |
| `luma_weights` | 3 numbers: how colour is weighed into brightness for saturation. |
| `video_range` | `black_code`, `white_code`: the limited range a decoder expands to full range. |
| `shoulder` | `a`, `b`, `c`, `d`, `e`: the soft shoulder `(x (a x + b)) / (x (c x + d) + e)`, kept in 0 to 1. |
| `display_gamma` | The display gamma the result is encoded for (the table applies `1 / display_gamma`). |
| `settings` | Optional: `exposure`, `saturation`, `size`, `red_gain`, `blue_gain`. |

A setting given neither in the profile nor by a flag is neutral (exposure 1, saturation 1, both gains 1) and `size` is 65.

## How to run it

```
python3 -m pip install -U numpy
python3 do-work/make_lut.py --profile ./camera.profile.json --out ./camera.cube
python3 do-work/make_lut.py --profile ./camera.profile.json --out ./brighter.cube --exposure 1.6 --saturation 0.9 --size 33
```

| Option | Meaning |
|---|---|
| `--profile FILE` | The profile JSON. Required. |
| `--out FILE` | The `.cube` file to write. Required. |
| `--exposure N` | Linear gain before the shoulder. Overrides the profile. |
| `--saturation N` | 1.0 keeps colour, 0 gives grey. Overrides the profile. |
| `--size N` | Points per side of the 3D table (2 or more). Overrides the profile. |
| `--red-gain N`, `--blue-gain N` | White balance: multiply red or blue. Override the profile. |

## What it does

1. Takes every point of the table as the colour a decoder gives after it expands limited-range video to full-range RGB, and undoes that expansion to get the code value.
2. Turns each code value into scene-linear light with the profile's curve.
3. Moves the colour to display primaries with the profile's matrix, then applies exposure and the white-balance gains.
4. Sets saturation around the profile's luma.
5. Applies the profile's shoulder and display gamma, and writes the points in `.cube` order, red changing fastest.

Use a table only on footage of the camera and curve its profile describes: on anything else it washes the picture out or blows it out.

## Dependencies

**Depends on:** Python 3 and numpy.

**Depended on by:** nothing in this repository; Trillion offers the row to a person's AI.
