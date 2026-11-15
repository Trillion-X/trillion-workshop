// crates/screen-arrangement/src/lib.rs
//
// PURPOSE
//   The screen arrangement's transitions (arrange/): a layout plus one command in, the next layout plus what changed
//   out. The workspace page asks this for every pane and tab change, so the arrangement is decided in one place.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: bytes in, bytes out. No clock, no storage, no host calls except entropy for new ids.
//   2. The page entry (run_in_a_page) is the only host seam; the math never names its host.

pub mod arrange;

pub use arrange::{arrange_screen_bytes, arrange_screen_request, ArrangementCommand, ScreenArrangementReply, ScreenArrangementRequest};

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod run_in_a_page;
