//! crates/pointillist-film-core/examples/encode_target_animation.rs
//!
//! Generic build-time exporter for canonical target-animation bytes.

use std::env;
use std::fs;
use std::path::PathBuf;

use pointillist_film_core::TargetAnimationRequest;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let input_path = PathBuf::from(args.next().ok_or("missing animation request JSON path")?);
    let output_path = PathBuf::from(args.next().ok_or("missing animation output path")?);

    if args.next().is_some() {
        return Err("usage: encode_target_animation <request.json> <output.pfat>".into());
    }

    let request_bytes = fs::read(&input_path)?;
    let request: TargetAnimationRequest = serde_json::from_slice(&request_bytes)?;
    fs::write(output_path, request.target_animation_bytes()?)?;

    Ok(())
}
