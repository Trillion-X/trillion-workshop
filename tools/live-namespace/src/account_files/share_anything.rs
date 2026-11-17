//! The share authority that goes through share-anything (`tool:share-anything`, tools/share-anything).
//!
//! A share of a file is one record of the person's own, `namespace-shared-file:<id>`, that holds the file's facts (identity, name, size,
//! media type, end), and one share-anything share of that record, with a key anyone holding it can use and the share's own end.
//! share-anything keeps the share (`sharing:<id>`) and only its key's BLAKE3. The address answered is `<origin>/share/<id>/<key>`, which
//! the byte route (`share_bytes`) serves by range after reading the share again, so stopping the share (`tool:share-anything` `stop`)
//! is what stops the next reader. No link to the store is made or kept. Nothing is kept here but the audit row the caller writes.

use super::{
    objects::ObjectError,
    share_delivery::{ShareAuthority, ShareFile, SharedDelivery},
};
use crate::records_door::{DoorError, RecordsDoor};
use serde_json::{json, Value};

/// The record kind a shared file's facts and byte link are kept as.
pub const SHARED_FILE_KIND: &str = "namespace-shared-file";
/// The one Workshop tool that makes, stops and shows shares.
pub const SHARE_TOOL: &str = "tool:share-anything";
/// The prefix of the workspace label a share is kept at.
const GRANT_PREFIX: &str = "sharing:";

/// The two things this authority asks of the person's door.
pub trait Door: Send + Sync {
    /// `records:write` of one record under a request key.
    fn write(&self, record: Value, key: &str) -> Result<Value, DoorError>;
    /// One run of a Workshop tool under a request key; the tool's own output.
    fn run(&self, tool: &str, input: &Value, key: &str) -> Result<Value, DoorError>;
}

impl Door for RecordsDoor {
    fn write(&self, record: Value, key: &str) -> Result<Value, DoorError> {
        RecordsDoor::write(self, &[record], key)
    }
    fn run(&self, tool: &str, input: &Value, key: &str) -> Result<Value, DoorError> {
        RecordsDoor::run(self, tool, input, key)
    }
}

/// share-anything as the share authority: shares made at `origin`, an https address the person's pages are served from.
pub struct ShareAnything {
    door: Box<dyn Door>,
    origin: String,
}

impl ShareAnything {
    pub fn new(door: Box<dyn Door>, origin: &str) -> Self {
        Self { door, origin: origin.trim_end_matches('/').to_owned() }
    }
}

fn unavailable(error: DoorError) -> ObjectError {
    ObjectError::Unavailable(format!("share-anything: {error}"), crate::cause!())
}

impl ShareAuthority for ShareAnything {
    fn authorize(&self, file: &ShareFile, seconds: u64) -> Result<SharedDelivery, ObjectError> {
        let ends = chrono::Utc::now() + chrono::Duration::seconds(seconds as i64);
        let ends_at = ends.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_nanos());
        let id = format!(
            "{SHARED_FILE_KIND}:{}",
            &content_crypto::advanced::blake3::hash(format!("{}\n{ends_at}\n{nonce}", file.identity).as_bytes()).to_hex().as_str()[..32]
        );
        self.door
            .write(
                json!({
                    "id": id, "type": SHARED_FILE_KIND,
                    "value": {
                        "kind": SHARED_FILE_KIND, "identity": file.identity, "name": file.name, "byte_length": file.byte_length,
                        "media_type": file.media_type, "expires_at": ends_at,
                    },
                }),
                &format!("{id}:record"),
            )
            .map_err(unavailable)?;
        let grant = format!("{GRANT_PREFIX}{id}");
        let shared = self
            .door
            .run(
                SHARE_TOOL,
                &json!({ "op": "share", "grant": grant, "thing": { "type": SHARED_FILE_KIND, "id": id }, "link": true, "until": ends_at, "origin": self.origin, "title": file.name }),
                &format!("{id}:share"),
            )
            .map_err(unavailable)?;
        let key = shared.pointer("/link/key").and_then(Value::as_str).ok_or_else(|| ObjectError::Unavailable("share-anything made no link".into(), crate::cause!()))?;
        let url = format!("{}/share/{id}/{key}", self.origin);
        Ok(SharedDelivery { url, grant_id: shared.get("grant").and_then(Value::as_str).unwrap_or(&grant).to_owned() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A stand-in door that keeps what it was asked and answers share-anything as the tool does.
    #[derive(Default)]
    struct Kept(Mutex<Vec<(String, Value, String)>>);
    impl Door for std::sync::Arc<Kept> {
        fn write(&self, record: Value, key: &str) -> Result<Value, DoorError> {
            self.0.lock().unwrap().push(("write".into(), record, key.into()));
            Ok(json!({"changed": 1}))
        }
        fn run(&self, tool: &str, input: &Value, key: &str) -> Result<Value, DoorError> {
            self.0.lock().unwrap().push((tool.into(), input.clone(), key.into()));
            let origin = input["origin"].as_str().unwrap();
            Ok(json!({"op": "share", "grant": input["grant"], "link": {"key": "shr_k", "url": format!("{origin}/share/shr_k")}}))
        }
    }

    fn file() -> ShareFile {
        ShareFile { identity: "1f:aa".into(), name: "/Notes/a.txt".into(), byte_length: 5, media_type: "text/plain".into() }
    }

    #[test]
    fn a_share_is_a_record_of_the_file_and_its_link_and_a_share_anything_share_of_that_record() {
        let kept = std::sync::Arc::new(Kept::default());
        let authority = ShareAnything::new(Box::new(kept.clone()), "https://app.example.test/");
        let shared = authority.authorize(&file(), 600).unwrap();
        let calls = kept.0.lock().unwrap();
        assert_eq!(calls.len(), 2);
        let (_, record, record_key) = &calls[0];
        let id = record["id"].as_str().unwrap();
        assert!(id.starts_with("namespace-shared-file:") && id.len() == "namespace-shared-file:".len() + 32);
        assert_eq!(record["type"], SHARED_FILE_KIND);
        assert_eq!(shared.url, format!("https://app.example.test/share/{id}/shr_k"));
        assert!(record["value"].get("download").is_none() && !record.to_string().contains("X-Amz"), "no link to the store is kept");
        assert_eq!(record["value"]["identity"], "1f:aa");
        assert_eq!(record_key, &format!("{id}:record"));
        let (tool, input, share_key) = &calls[1];
        assert_eq!(tool, SHARE_TOOL);
        assert_eq!(input["grant"], format!("sharing:{id}"));
        assert_eq!(input["thing"], json!({"type": SHARED_FILE_KIND, "id": id}));
        assert_eq!((input["link"].as_bool(), input["op"].as_str()), (Some(true), Some("share")));
        assert_eq!(input["until"], record["value"]["expires_at"], "the share ends when the byte link does");
        assert_eq!(input["origin"], "https://app.example.test", "no double slash in the address");
        assert_eq!(share_key, &format!("{id}:share"));
        assert_eq!(shared.grant_id, format!("sharing:{id}"));
    }

    #[test]
    fn a_door_that_refuses_or_a_share_with_no_link_shares_nothing() {
        struct Refusing;
        impl Door for Refusing {
            fn write(&self, _: Value, _: &str) -> Result<Value, DoorError> {
                Err(DoorError::Refused { code: "current_workspace_rights_refused".into(), started: false })
            }
            fn run(&self, _: &str, _: &Value, _: &str) -> Result<Value, DoorError> {
                unreachable!("nothing is shared when the record was refused")
            }
        }
        assert!(ShareAnything::new(Box::new(Refusing), "https://app.example.test").authorize(&file(), 60).is_err());
        struct NoLink;
        impl Door for NoLink {
            fn write(&self, _: Value, _: &str) -> Result<Value, DoorError> {
                Ok(json!({}))
            }
            fn run(&self, _: &str, _: &Value, _: &str) -> Result<Value, DoorError> {
                Ok(json!({"op": "share", "people": []}))
            }
        }
        assert!(ShareAnything::new(Box::new(NoLink), "https://app.example.test").authorize(&file(), 60).is_err());
    }
}
