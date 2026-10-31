//! crates/pointillist-film-core/examples/encode_frame_request.rs
//!
//! Generic build-time exporter for `FilmFrameRequest` JSON.

use std::env;
use std::fs;
use std::path::PathBuf;

use pointillist_film_core::FilmFrameRequest;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let input_path = PathBuf::from(args.next().ok_or("missing input request JSON path")?);
    let output_path = PathBuf::from(args.next().ok_or("missing output packed-frame path")?);

    if args.next().is_some() {
        return Err("usage: encode_frame_request <request.json> <frame.pfcf>".into());
    }

    let request_bytes = fs::read(&input_path)?;
    let request: FilmFrameRequest = serde_json::from_slice(&request_bytes)?;
    let frame_bytes = request.packed_frame_bytes()?;

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output_path, frame_bytes)?;
    Ok(())
}
