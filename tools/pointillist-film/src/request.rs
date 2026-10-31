//! crates/pointillist-film-core/src/request.rs
//!
//! Request-level pure frame generation contract.

use serde::{Deserialize, Serialize};

use crate::config::FilmConfig;
use crate::timeline::{frame_at, FilmScript};
use crate::validation::FilmResult;
use crate::wire::encode_frame;

/// Data-owned request for one packed frame.
///
/// This type lives in the core crate because it is pure film state, not a
/// renderer concern. Wrappers only transport these
/// bytes and call this request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FilmFrameRequest {
    pub config: FilmConfig,
    pub script: FilmScript,
    pub time_seconds: f32,
}

impl FilmFrameRequest {
    pub fn packed_frame_bytes(&self) -> FilmResult<Vec<u8>> {
        let frame = frame_at(&self.script, &self.config, self.time_seconds)?;
        encode_frame(&frame, &self.config)
    }
}
