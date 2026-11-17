//! What a share of one file is made of: the link that reads its bytes, and the authority that says who may be given it.
//!
//! The byte link is the only thing minted here: a GET of the file's one object, signed into the URL for as long as the share lasts
//! (`presigned_link`). What authorizes anyone to hold it is not decided here: it is a share-anything record (`share_anything.rs`), the
//! person's own, whose reach names the record that holds the link, so a person who stops the share stops the next reader. A file kept in
//! chunks has no single object to link and is refused.

use super::{objects::{ObjectError, Objects}, text, Record};

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

/// Who authorizes a share. `download` is the signed byte link, lasting `seconds`; the authority keeps it only where the share's holders,
/// and nobody else, can read it.
pub trait ShareAuthority: Send + Sync {
    fn authorize(&self, file: &ShareFile, download: &str, seconds: u64) -> Result<SharedDelivery, ObjectError>;
}

/// The signed link that reads the whole object of `file` for `seconds`: a file kept as one object at a store.
pub fn presigned_link(objects: &dyn Objects, file: &Record, seconds: u64) -> Result<String, ObjectError> {
    let spans = file.value.get("spans").and_then(serde_json::Value::as_u64).unwrap_or(0);
    match (text(&file.value, "origin"), text(&file.value, "key")) {
        (Some(origin), Some(key)) if spans == 0 && !key.is_empty() => objects.presign_get(origin, key, seconds),
        _ => Err(ObjectError::Unavailable("a file kept in chunks has no single object to link".into(), crate::cause!())),
    }
}
