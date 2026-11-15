//! Field-key custody for planned original records. Key bytes never enter
//! envelopes, stored forms, command identities or public receipts. This module
//! does not mint keys or decide whether an existing/erased record can be
//! recreated; the store keeps an attached key beside the record it opens.
use super::*;
use crate::record_sealed::{self, SecretFieldKey};

/// Supplied platform bytes, held only for one caller-owned write transaction.
#[derive(Clone)]
pub struct OriginalKey(Zeroizing<[u8; 32]>);
impl fmt::Debug for OriginalKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OriginalKey([redacted])")
    }
}
impl OriginalKey {
    pub fn from_bytes(bytes: Zeroizing<[u8; 32]>) -> Self {
        Self(bytes)
    }
    /// The key bytes, for the store that keeps them beside their record.
    pub(crate) fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
    pub(crate) fn seal_under(&self, id: &str, field: &JsString, value: &Ecma, owner: &str) -> Result<Ecma> {
        let key = SecretFieldKey::from_bytes(Zeroizing::new(*self.0));
        record_sealed::prepare::seal(&key, id, field, value, Some(owner), Default::default()).map(Ecma::Object).map_err(|error| Error::Refused(error.cause()))
    }
    pub fn seal(&self, id: &str, field: &JsString, value: &Ecma) -> Result<Ecma> {
        let key = SecretFieldKey::from_bytes(Zeroizing::new(*self.0));
        record_sealed::prepare::seal(&key, id, field, value, None, Default::default())
            .map(Ecma::Object)
            .map_err(|error| Error::Refused(error.cause()))
    }
}
