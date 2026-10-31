# pointillist-film

Square-grid pointillist film frames. A film is a grid of square cells, a set of target pictures (one colour, opacity and scale for each cell) and a timeline that says, at each moment, how much of each picture shows. Given the film and a time, the program works out every cell's colour, opacity and scale and writes them as packed bytes. The same film and time always give the same bytes.

The program is small Rust code a person's AI builds and runs on the person's own computer. It draws nothing: whatever shows the cells (a canvas, a video renderer, a printed sheet) reads the packed bytes.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | Three rows, all `on-your-computer`: `tool:render-a-pointillist-frame`, `tool:render-pointillist-frames-over-time`, `tool:render-a-pointillist-target-animation`. |
| `part.json` | Nothing here is imported by other code. |
| `Cargo.toml`, `Cargo.lock` | The crate: serde and thiserror, nothing else (serde_json for the tests). |
| `src/lib.rs` | The public pieces. |
| `src/config.rs` | `FilmConfig`: the grid, the limits and the style bounds, all checked before anything runs. |
| `src/grid.rs`, `src/target.rs`, `src/morph.rs`, `src/palette.rs` | Square-grid cells, target pictures, per-cell style blending, colour. |
| `src/field.rs`, `src/vector.rs`, `src/program.rs` | Small serialisable expressions: a scalar field (terms and a combiner), a vector field (two scalars) and a multi-output field program (a 4x4 transform and any number of channels). They say how a weight, a displacement or a material changes over time, with no named effects. |
| `src/timeline.rs`, `src/request.rs` | `FilmScript` (targets and timeline segments) and `frame_at`; `FilmFrameRequest` (config, script, time) and its packed bytes. |
| `src/sampling.rs` | Turns a source image's pixels into a target picture for a grid. |
| `src/wire.rs` | The packed frame file: PFCF, little-endian, `encode_frame` and `decode_frame`. |
| `src/animation.rs` | The target-animation file: PFAT, the pictures and the timeline with a frame rate. |
| `src/validation.rs` | The errors, each saying which value was out of range. |
| `examples/encode_frame_request.rs`, `examples/encode_frame_sequence.rs`, `examples/encode_target_animation.rs` | The three commands the rows run. |
| `test/composition_gauntlet.rs` | The crate's tests: grid, morph, fields, timeline, wire, animation. |
| `test/pointillist-film.test.mjs` | Runs the crate tests, then each command on a made-up two-cell film. Skips, saying why, when cargo is missing. |

## How to run it

```
cargo run --release --manifest-path Cargo.toml --example encode_frame_request -- request.json frame.pfcf
cargo run --release --manifest-path Cargo.toml --example encode_frame_sequence -- sequence.json frames/
cargo run --release --manifest-path Cargo.toml --example encode_target_animation -- animation.json animation.pfat
```

`request.json` is `{ config, script, time_seconds }`; `sequence.json` is `{ request, times_seconds }`; `animation.json` is `{ config, script, frame_rate }`. `config` is `{ grid {columns, rows, cell_gap_fraction}, limits {max_columns, max_rows, max_cells, max_targets, max_frame_bytes, max_cell_gap_fraction}, style {min_opacity, max_opacity, min_scale, max_scale} }`. Every limit is in the request: the program has no limits of its own beyond what the file formats can hold.

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `FilmFrameRequest` | `{ config, script, time_seconds }`, `packed_frame_bytes()` | One frame's worth of film state. |
| `FilmScript` | `{ targets: [{ cells: [{ color, opacity, scale }] }], segments: [{ start_seconds, duration_seconds, samples: [{ target, weight }] }] }` | The pictures and when each shows. |
| `ScalarField` | `{ terms: [expression], combiner: max \| sum \| sumClamped }` | A weight over time; an expression is `input`, `channel`, `constant`, `unary`, `binary` or `clamp`. |
| `frame_at` | `(script, config, time) -> PackedCellFrame` | The cells at one moment. |
| `encode_frame` / `decode_frame` | frame to bytes and back | The PFCF file. |
| `encode_target_animation` | `TargetAnimationRequest -> bytes` | The PFAT file. |

## Rules it keeps

- Cells are square-grid cells; there are no off-grid circles or drifting particles.
- Every tunable is in `FilmConfig` and checked before use; a value out of range is refused with a message that names it.
- Identical script, config and time give identical bytes.
- The effects are data: the fields have no named ripple, wave or glow, only expression terms, so a new effect is a new file, not new code.

## Overlap with other Workshop tools

`tools/media-composition` makes video from footage and overlays; it does not make pictures from a grid script. No other tool writes these frames.

## Dependencies

**Depends on:** Rust (cargo) to build, serde and thiserror from the crates registry the first time.

**Depended on by:** `tool-rows.json`, run on the person's computer by their AI.
