//! crates/pointillist-film-core/examples/encode_frame_sequence.rs
//!
//! Generic build-time exporter for a sequence of `FilmFrameRequest` frames.

use std::env;
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use pointillist_film_core::FilmFrameRequest;

#[derive(Deserialize)]
struct FilmFrameSequenceRequest {
    request: FilmFrameRequest,
    times_seconds: Vec<f32>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let input_path = PathBuf::from(args.next().ok_or("missing sequence request JSON path")?);
    let output_dir = PathBuf::from(args.next().ok_or("missing output directory")?);

    if args.next().is_some() {
        return Err("usage: encode_frame_sequence <sequence.json> <output-dir>".into());
    }

    let request_bytes = fs::read(&input_path)?;
    let sequence: FilmFrameSequenceRequest = serde_json::from_slice(&request_bytes)?;
    fs::create_dir_all(&output_dir)?;

    for (index, time_seconds) in sequence.times_seconds.iter().copied().enumerate() {
        let mut request = sequence.request.clone();
        request.time_seconds = time_seconds;
        let frame_bytes = request.packed_frame_bytes()?;
        fs::write(
            output_dir.join(format!("frame-{index:04}.pfcf")),
            frame_bytes,
        )?;
    }

    Ok(())
}
