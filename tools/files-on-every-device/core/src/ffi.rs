//! The C ABI: one opaque core, JSON events and commands, bytes beside them (include/files_core.h).
//!
//! Invariants
//!   - A core is used from one thread at a time; the shell serializes its calls.
//!   - A command is taken only when the caller's buffer holds it; otherwise its length is answered and it waits, so a
//!     shell retries with a buffer that size and nothing is lost.
//!   - Nothing here decides anything: every call is one `Core` method.

use std::slice;

use crate::core::Core;
use crate::data::Setup;
use crate::protocol::Event;

/// One core and the command a shell is taking.
pub struct FilesCore {
    core: Core,
    /// The command answered by the last `files_core_next_command`, waiting to be copied, and its bytes.
    waiting: Option<(Vec<u8>, Vec<u8>)>,
    /// The bytes of the last command taken.
    taken_bytes: Vec<u8>,
    refusal: Vec<u8>,
}

unsafe fn bytes_of<'a>(pointer: *const u8, length: usize) -> &'a [u8] {
    if pointer.is_null() || length == 0 {
        &[]
    } else {
        // SAFETY: the caller hands a buffer of `length` readable bytes that outlives the call (files_core.h).
        unsafe { slice::from_raw_parts(pointer, length) }
    }
}

unsafe fn copy_out(source: &[u8], out: *mut u8, capacity: usize) -> bool {
    if source.len() > capacity || (out.is_null() && !source.is_empty()) {
        return false;
    }
    if !source.is_empty() {
        // SAFETY: the caller hands a writable buffer of `capacity` bytes (files_core.h); `source` fits in it.
        unsafe { std::ptr::copy_nonoverlapping(source.as_ptr(), out, source.len()) };
    }
    true
}

/// A new core from its setup JSON; null when the setup is refused.
///
/// # Safety
/// Every pointer is null or valid for the length beside it, and `core` came from `files_core_new`, is not yet freed
/// and is used by one thread at a time (include/files_core.h).
#[no_mangle]
pub unsafe extern "C" fn files_core_new(setup: *const u8, setup_length: usize) -> *mut FilesCore {
    let Ok(setup) = serde_json::from_slice::<Setup>(bytes_of(setup, setup_length)) else { return std::ptr::null_mut() };
    match Core::new(setup) {
        Ok(core) => Box::into_raw(Box::new(FilesCore { core, waiting: None, taken_bytes: Vec::new(), refusal: Vec::new() })),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Free a core made by `files_core_new`.
///
/// # Safety
/// Every pointer is null or valid for the length beside it, and `core` came from `files_core_new`, is not yet freed
/// and is used by one thread at a time (include/files_core.h).
#[no_mangle]
pub unsafe extern "C" fn files_core_free(core: *mut FilesCore) {
    if !core.is_null() {
        // SAFETY: `core` came from `files_core_new` and is freed once (files_core.h).
        drop(unsafe { Box::from_raw(core) });
    }
}

/// One event (JSON) with the bytes it carries. Answers 0 when taken, else the length of the refusal text
/// (`files_core_refusal`).
///
/// # Safety
/// Every pointer is null or valid for the length beside it, and `core` came from `files_core_new`, is not yet freed
/// and is used by one thread at a time (include/files_core.h).
#[no_mangle]
pub unsafe extern "C" fn files_core_event(
    core: *mut FilesCore,
    event: *const u8,
    event_length: usize,
    bytes: *const u8,
    bytes_length: usize,
) -> usize {
    // SAFETY: `core` came from `files_core_new` and is used by one thread at a time (files_core.h).
    let Some(handle) = (unsafe { core.as_mut() }) else { return usize::MAX };
    match serde_json::from_slice::<Event>(bytes_of(event, event_length)) {
        Ok(event) => {
            handle.core.handle(event, bytes_of(bytes, bytes_length));
            0
        }
        Err(error) => {
            handle.refusal = error.to_string().into_bytes();
            handle.refusal.len()
        }
    }
}

/// The next command (JSON) into `out`. Answers its length: 0 when no command waits; a length above `capacity` means
/// nothing was copied and the same command waits for a buffer that long.
///
/// # Safety
/// Every pointer is null or valid for the length beside it, and `core` came from `files_core_new`, is not yet freed
/// and is used by one thread at a time (include/files_core.h).
#[no_mangle]
pub unsafe extern "C" fn files_core_next_command(core: *mut FilesCore, out: *mut u8, capacity: usize) -> usize {
    // SAFETY: as in files_core_event.
    let Some(handle) = (unsafe { core.as_mut() }) else { return 0 };
    if handle.waiting.is_none() {
        let Some((command, bytes)) = handle.core.next_command() else { return 0 };
        let text = serde_json::to_vec(&command).expect("a command is JSON");
        handle.waiting = Some((text, bytes));
    }
    let (text, _) = handle.waiting.as_ref().expect("a command waits");
    let length = text.len();
    if copy_out(text, out, capacity) {
        let (_, bytes) = handle.waiting.take().expect("a command waits");
        handle.taken_bytes = bytes;
    }
    length
}

/// The bytes of the last command taken (its `bytes` count) into `out`; answers their length, copying nothing when
/// `capacity` is too small.
///
/// # Safety
/// Every pointer is null or valid for the length beside it, and `core` came from `files_core_new`, is not yet freed
/// and is used by one thread at a time (include/files_core.h).
#[no_mangle]
pub unsafe extern "C" fn files_core_take_bytes(core: *mut FilesCore, out: *mut u8, capacity: usize) -> usize {
    // SAFETY: as in files_core_event.
    let Some(handle) = (unsafe { core.as_mut() }) else { return 0 };
    let length = handle.taken_bytes.len();
    copy_out(&handle.taken_bytes, out, capacity);
    length
}

/// The text of the last refused event into `out`; answers its length.
///
/// # Safety
/// Every pointer is null or valid for the length beside it, and `core` came from `files_core_new`, is not yet freed
/// and is used by one thread at a time (include/files_core.h).
#[no_mangle]
pub unsafe extern "C" fn files_core_refusal(core: *mut FilesCore, out: *mut u8, capacity: usize) -> usize {
    // SAFETY: as in files_core_event.
    let Some(handle) = (unsafe { core.as_mut() }) else { return 0 };
    copy_out(&handle.refusal, out, capacity);
    handle.refusal.len()
}
