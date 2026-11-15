// crates/slot-protocol/src/cas_reader.rs
//
//! CasReader trait — content-addressed storage read interface.
//!
//! Lives in slot-protocol (leaf crate) so apply_slot_config() can fetch
//! WASM binaries from CAS without depending on envelope-engine.
//! The implementation lives in envelope-engine.
//!
//! This trait is async because CAS reads are I/O — the implementation
//! sends through an actor channel and awaits a reply. Making this sync
//! would require blocking hacks (block_in_place) at every call site,
//! which is architectural dishonesty about the nature of the operation.

use crate::envelope_error::EnvelopeError;
use std::future::Future;
use std::pin::Pin;

/// Canonical RFC-7233 byte-range resolver — the ONE place the (offset, length)
/// → `[start, end)` math lives. `total` is the full blob length; `start` is
/// clamped to `[0, total]`; `end` is `min(start + length, total)` (or `total`
/// when `length` is `None`). A legacy full read (offset 0, length None) yields
/// `(0, total)` exactly. `start == end` means an empty range (zero-length blob,
/// zero-length request, or offset at/after EOF).
///
/// SSOT: the `read_cas_range` default below, `EnvelopeCasReader`'s seek override,
/// and the runner's `write_cas_read_responses` all resolve bounds through this —
/// no duplicated clamp logic that could drift between a range's producer and
/// consumer.
pub fn cas_range_bounds(total: usize, offset: u64, length: Option<u64>) -> (usize, usize) {
    let start = (offset as usize).min(total);
    let end = match length {
        Some(len) => start.saturating_add(len as usize).min(total),
        None => total,
    };
    (start, end)
}

/// Read-only interface to content-addressed storage.
///
/// The hash IS the lookup key. CAS is immutable — same hash always
/// returns the same bytes. Implementations may read from mmap log,
/// SQLite, filesystem, or network.
///
/// Async because CAS reads go through the engine actor channel —
/// the operation is fundamentally I/O, not computation.
pub trait CasReader: Send + Sync {
    /// Fetch bytes from CAS by content hash.
    ///
    /// Returns the raw bytes stored at `hash`, or EnvelopeError if
    /// the hash is not found or storage is unavailable.
    fn read_cas<'a>(
        &'a self,
        hash: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, EnvelopeError>> + Send + 'a>>;

    /// Fetch a byte RANGE from CAS: `length` bytes starting at `offset`
    /// (`None` length = to end of blob). Enables HTTP Range streaming of
    /// multi-GB media without materializing the whole blob.
    ///
    /// The default implementation reads the full blob and slices it — correct
    /// for small blobs and simple/test readers. Implementations backed by
    /// seekable storage (e.g. `EnvelopeCasReader` over the CAS content log)
    /// SHOULD override this to seek to `offset` and read only `length` bytes.
    fn read_cas_range<'a>(
        &'a self,
        hash: &'a str,
        offset: u64,
        length: Option<u64>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, EnvelopeError>> + Send + 'a>> {
        Box::pin(async move {
            let full = self.read_cas(hash).await?;
            let (start, end) = cas_range_bounds(full.len(), offset, length);
            Ok(full[start..end].to_vec())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::cas_range_bounds;

    #[test]
    fn full_read_legacy_offset0_no_length() {
        // The legacy full read MUST be byte-identical: (0, total).
        assert_eq!(cas_range_bounds(1000, 0, None), (0, 1000));
        assert_eq!(cas_range_bounds(0, 0, None), (0, 0));
    }

    #[test]
    fn closed_range_within_bounds() {
        // bytes=0-1023 → length 1024 → (0, 1024).
        assert_eq!(cas_range_bounds(5000, 0, Some(1024)), (0, 1024));
        // non-zero offset.
        assert_eq!(cas_range_bounds(5000, 500, Some(500)), (500, 1000));
    }

    #[test]
    fn open_ended_range_to_eof() {
        // bytes=4096- → from 4096 to end.
        assert_eq!(cas_range_bounds(10000, 4096, None), (4096, 10000));
    }

    #[test]
    fn length_past_eof_clamps_to_total() {
        // Asking for more than exists clamps end to total (no panic, no overread).
        assert_eq!(cas_range_bounds(500, 0, Some(100_000)), (0, 500));
        assert_eq!(cas_range_bounds(500, 400, Some(100_000)), (400, 500));
    }

    #[test]
    fn offset_at_or_past_eof_is_empty_range() {
        // start == end signals an empty range (caller answers 416 / terminal OK).
        assert_eq!(cas_range_bounds(500, 500, Some(10)), (500, 500));
        assert_eq!(cas_range_bounds(500, 9999, None), (500, 500));
        assert_eq!(cas_range_bounds(500, 9999, Some(10)), (500, 500));
    }

    #[test]
    fn zero_length_request_is_empty_range() {
        assert_eq!(cas_range_bounds(500, 100, Some(0)), (100, 100));
    }

    #[test]
    fn saturating_add_never_overflows() {
        // offset + length near usize::MAX must not wrap; clamps to total.
        assert_eq!(cas_range_bounds(500, u64::MAX, Some(u64::MAX)), (500, 500));
        assert_eq!(cas_range_bounds(500, 10, Some(u64::MAX)), (10, 500));
    }
}
