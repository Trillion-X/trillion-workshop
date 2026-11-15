//! CasBlobWriter — durable immutable CAS publication interface.
//!
//! This is deliberately paired with [`crate::CasReader`]: a successful put
//! returns only after the content is readable by its returned hash. It creates
//! no Envelope record, live-state entry, Delta, or causal-log mutation.

use std::future::Future;
use std::pin::Pin;

use crate::{EnvelopeError, Hash};

/// Write immutable bytes to content-addressed storage.
///
/// Implementations own physical staging, durability, deduplication, and
/// hash-index publication. Callers receive the canonical content hash and
/// never receive a storage offset or an unpublished staging capability.
pub trait CasBlobWriter: Send + Sync {
    /// Store `content` and return its canonical immutable content hash.
    ///
    /// Success guarantees that a paired [`crate::CasReader`] can resolve the
    /// returned hash. The operation is idempotent for identical bytes.
    fn put_cas<'a>(
        &'a self,
        content: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = Result<Hash, EnvelopeError>> + Send + 'a>>;
}
