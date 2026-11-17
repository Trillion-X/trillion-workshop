//! files-core: every rule a native folder of the person's files needs, written once for every OS, with no I/O.
//!
//! A shell (macOS and iOS File Provider, Windows cfapi, Android DocumentsProvider, Linux FUSE3) translates its OS
//! callbacks into `Event`s and carries out the `Command`s the core answers: it sends the requests, writes the bytes,
//! reads the local file being sent and shows the items. Rules, numbers and retries live here, never in a shell.
//! The C ABI (`ffi`, include/files_core.h) is the door every shell uses.

pub mod check;
pub mod core;
pub mod data;
pub mod errors;
pub mod ffi;
pub mod items;
pub mod link;
pub mod names;
pub mod protocol;
pub mod ranges;
pub mod rules;

pub use crate::core::Core;
pub use crate::data::{Bounds, Computer, Contract, Setup};
pub use crate::errors::Problem;
pub use crate::protocol::{Command, Event, EventKind};
