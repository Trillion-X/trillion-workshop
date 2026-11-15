//! An account files share issued by the existing grant-aware delivery owner.
//!
//! The account files resolves an immutable file; the caller's owner supplies the
//! recipient/sponsor grant and a revocable delivery URL. The engine does not
//! choose that commercial policy or return provider credentials to the owner.

use super::objects::ObjectError;

/// Immutable file facts an admitted share issuer needs. No provider object key,
/// vault name, credential or file content crosses this seam.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShareFile {
    pub identity: String,
    pub byte_length: u64,
    pub media_type: String,
}

/// A grant-bound URL from the actual delivery owner, never a raw origin URL
/// minted by this byte port. Its grant owns current rights and bounded replay.
pub struct SharedDelivery {
    pub url: String,
    pub grant_id: String,
}

pub trait ShareDelivery: Send + Sync {
    fn mint(&self, file: &ShareFile, seconds: u64) -> Result<SharedDelivery, ObjectError>;
}
