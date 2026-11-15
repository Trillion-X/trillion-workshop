//! crates/composition-engine/src/lib.rs
//!
//! Composition Engine slot wrapper.
//!
//! This crate owns the slot boundary: incoming SharedBufferProtocol bytes,
//! scene/delta/snapshot boundary work, and browser realization assets. Reusable
//! composition physics lives in `composition-engine-core`.
//!
//! Two hosts call the same decision (`slot_work::answer_request`): the
//! SharedBufferProtocol slot ABI (`slot_entry`) and, built for a page
//! (wasm32-unknown-unknown), the wasm-bindgen entry `run_in_a_page`.

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod slot_entry;
mod slot_work;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod run_in_a_page;

pub use composition_engine_core::*;

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub use slot_entry::{handle_query, init};
