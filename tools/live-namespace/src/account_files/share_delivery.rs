//! What a share of one file is made of: who authorizes it. There is no link to the store: the bytes of a share are served by
//! `share_bytes` (the public byte route), which reads them by range through the account files each time it is asked and asks
//! the person's own share record whether the share still stands, so a person who stops the share stops the next reader.

use super::objects::ObjectError;

/// What a share authority is told of the file it shares: immutable facts, no provider key and no credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShareFile {
    pub identity: String,
    pub name: String,
    pub byte_length: u64,
    pub media_type: String,
}

/// The share a share authority made: the address a holder opens and the share-anything grant that authorizes it.
pub struct SharedDelivery {
    pub url: String,
    pub grant_id: String,
}

/// Who authorizes a share. The share lasts `seconds`; the authority keeps the file's facts where the share's holders, and nobody
/// else, can read them, and answers the address the byte route serves the file at.
pub trait ShareAuthority: Send + Sync {
    fn authorize(&self, file: &ShareFile, seconds: u64) -> Result<SharedDelivery, ObjectError>;
}
