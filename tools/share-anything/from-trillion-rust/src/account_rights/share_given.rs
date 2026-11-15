// src/account_rights/share_given.rs
//
// Purpose: The receiving side of a share (`share_grant` is the giving side, honored at the sharer's own account routes). A person
// someone shared a record with keeps, in their own records, which shares they were given — the address of the sharer's account routes
// and the shared record's label — and the share key in their secrets vault only. Their trillion-local reads each given share
// at the sharer's account routes with that key, a read of exactly that label, and keeps the answer for a while. Nothing here
// names a record kind, a feature or a person: what a given share gives (`types_field`) and every prefix, address path
// and bound are the setting share-given.json beside this file.
//
// Non-Negotiable Invariants:
// - The share key is kept only in the person's secrets vault (`vault_prefix` + BLAKE3 of the routes address and label). It is
//   never in a record, an answer, a file, a log, an argument or a Debug output; the given record holds only the routes
//   address and the label, and the cache is keyed by a digest.
// - A given record is honored only when its own label is the digest of the routes address and label it holds, so one record
//   cannot stand for another share.
// - A share read asks exactly one label, the given one, as the share grant's read (`door_grant.resource`,
//   `door_grant.operation`, selection of labels only); the sharer's account routes decide from their sharing records now.
// - Account routes that refuse the key (the sharer stopped sharing, took the person out, or the key is wrong) give nothing:
//   the share is gone at the next read. Routes that cannot be reached, answer something unreadable, or a key the
//   vault does not hold makes the whole read unavailable — never "no rules", never an empty success.
// - A read is kept at most `keep_for` (the service records' `read_seconds`); a refused read is kept too, so routes
//   that refuse are not asked again on every read. A failed read is never kept.
//
// Key Concepts:
// - `Receiving`: the DATA (`given`), read once per process.
// - `Given`: one given share, the address of the sharer's account routes and the label there.
// - `SharerDoor`: the transport of one share read; `HttpsDoor` is the real one (the one MCP tool of those routes over HTTPS).
// - `Kept`: what given shares gave, per person, routes address, label and key digest, for `keep_for`.
//
// Security Considerations:
// - The key travels only as the bearer of the share read, over verified TLS (`https::post_json`).
// - A record written by the person's client may name any routes address: trillion-local only ever presents that share's own key
//   there, so wrong routes learn a key that the right routes already gave this person, nothing more.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::share_grant::Grants;
use crate::{
    secrets::{Error as VaultError, Secrets},
    storage::Storage,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    fmt,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

/// The trillion-local setting beside this owner: its `given` block.
const DATA: &[u8] = include_bytes!("share-given.json");

/// Why a receiving call or a given read was refused.
#[derive(Clone, Debug)]
pub enum Refusal {
    /// The DATA, the vault or the sharer's account routes are not available, or a given record or key is not readable: the read
    /// is unavailable, not empty.
    Unavailable(crate::refusal_cause::Cause),
    /// The input is not one a receive may take.
    Input(crate::refusal_cause::Cause),
}
impl Refusal { pub fn cause(&self) -> crate::refusal_cause::Cause { match self {
Self::Unavailable(cause)=>cause.clone(),
Self::Input(cause)=>cause.clone(),
} } }
crate::impl_caused!(Refusal);
impl PartialEq for Refusal {fn eq(&self, other:&Self)->bool {std::mem::discriminant(self)==std::mem::discriminant(other)}}
impl Eq for Refusal {}


/// The shape of the receiving side, from DATA.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receiving {
    #[serde(rename = "_what")]
    _what: String,
    record_prefix: String,
    vault_prefix: String,
    receive_resource: String,
    receive_operation: String,
    types_field: String,
    door_path: String,
    door_tool: String,
    most_given: usize,
    most_answer_bytes: usize,
    wait_seconds: u64,
    most_door_bytes: usize,
    most_label_bytes: usize,
}

#[derive(Deserialize)]
struct Data {
    given: Receiving,
}

/// One given share: the address of the sharer's account routes and the label of the shared record there.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Given {
    pub door: String,
    pub label: String,
}

/// What a receive asks: keep `key` for the given share, or (None) remove it.
pub struct Asked {
    pub given: Given,
    pub key: Option<Zeroizing<String>>,
}
impl fmt::Debug for Asked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Asked").field("given", &self.given).field("key", &self.key.as_ref().map(|_| "[redacted]")).finish()
    }
}

/// What one share read answered: the records it gave (label to value), or a refusal of the key.
#[derive(Clone, Debug)]
pub enum DoorAnswer {
    Records(BTreeMap<String, Value>),
    Refused(crate::refusal_cause::Cause),
}

impl PartialEq for DoorAnswer {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Records(left), Self::Records(right)) => left == right,
            (Self::Refused(_), Self::Refused(_)) => true,
            _ => false,
        }
    }
}

/// The transport of one read at a sharer's account routes: `resource`, `operation` and `input` as those routes take them, with
/// `bearer` as the credential. A transport failure is `Refusal::Unavailable`; routes that refuse the bearer or the
/// call is `DoorAnswer::Refused`.
pub trait SharerDoor {
    fn read(&self, door: &str, resource: &str, operation: &str, input: &Value, bearer: &[u8])
        -> Result<DoorAnswer, Refusal>;
}

impl Receiving {
    /// The shipped DATA, read and checked once per process.
    pub fn shipped() -> Result<&'static Receiving, Refusal> {
        static SHIPPED: OnceLock<Option<Receiving>> = OnceLock::new();
        SHIPPED
            .get_or_init(|| {
                let data: Data = serde_json::from_slice(DATA).ok()?;
                let given = data.given;
                (!given.record_prefix.is_empty() && !given.vault_prefix.is_empty() && given.most_given > 0)
                    .then_some(given)
            })
            .as_ref()
            .ok_or(crate::cause!(Refusal::Unavailable))
    }

    /// The prefix every given record's label starts with (a read of the person's given shares selects it).
    pub fn record_prefix(&self) -> &str {
        &self.record_prefix
    }

    /// Whether a call at `resource` by `operation` is the person keeping or removing a given share's key.
    pub fn receives(&self, resource: &str, operation: &str) -> bool {
        resource == self.receive_resource && operation == self.receive_operation
    }

    /// How long one share read may take.
    pub fn wait(&self) -> Duration {
        Duration::from_secs(self.wait_seconds)
    }

    /// The digest one given share is named by, in its record label and its vault name.
    fn digest(given: &Given) -> String {
        content_crypto::advanced::blake3::hash(format!("{}\n{}", given.door, given.label).as_bytes()).to_hex().to_string()
    }

    /// The label of the person's record for `given`.
    pub fn record_label(&self, given: &Given) -> String {
        format!("{}{}", self.record_prefix, Self::digest(given))
    }

    fn vault_name(&self, given: &Given) -> String {
        format!("{}{}", self.vault_prefix, Self::digest(given))
    }

    /// A routes address a given share may name: `https://host[:port]` with no path, query, fragment or user.
    fn door_fits(&self, door: &str) -> bool {
        if door.is_empty() || door.len() > self.most_door_bytes {
            return false;
        }
        let Ok(url) = url::Url::parse(door) else { return false };
        url.scheme() == "https"
            && url.host_str().is_some_and(|host| !host.is_empty())
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && !door.ends_with('/')
    }

    fn given_fits(&self, door: &str, label: &str) -> Option<Given> {
        (self.door_fits(door) && !label.is_empty() && label.len() <= self.most_label_bytes)
            .then(|| Given { door: door.to_owned(), label: label.to_owned() })
    }

    /// A receive's input: exactly `{door, label, key}` (a well-formed share key) to keep, or `{door, label, on: false}`
    /// to remove.
    pub fn asked(&self, input: &Value) -> Option<Asked> {
        let fields = input.as_object().filter(|fields| fields.len() == 3)?;
        let given = self.given_fits(fields.get("door")?.as_str()?, fields.get("label")?.as_str()?)?;
        if let Some(on) = fields.get("on") {
            return (on == &Value::Bool(false)).then_some(Asked { given, key: None });
        }
        let key = fields.get("key")?.as_str()?;
        let grants = Grants::shipped().ok()?;
        grants.digest(key.as_bytes())?;
        Some(Asked { given, key: Some(Zeroizing::new(key.to_owned())) })
    }

    /// The person's record for `given`, as their client writes it through the generic records write:
    /// `{door, label, given_at}` (`given_at` in milliseconds). It holds no key.
    pub fn record(&self, given: &Given, given_at: i64) -> (String, Value) {
        (self.record_label(given), json!({"door": given.door, "label": given.label, "given_at": given_at}))
    }

    /// Keep `key` for `given` in the person's vault (replacing an earlier one), returning the record their client
    /// writes for it.
    pub fn receive<S: Storage + Send>(&self, vault: &Secrets<S>, given: &Given, key: &str, given_at: i64)
        -> Result<(String, Value), Refusal> {
        let grants = Grants::shipped().map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
        grants.digest(key.as_bytes()).ok_or(crate::cause!(Refusal::Input))?;
        vault.put(&self.vault_name(given), Zeroizing::new(key.to_owned())).map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
        Ok(self.record(given, given_at))
    }

    /// Remove the key kept for `given`; answers whether one was kept.
    pub fn forget<S: Storage + Send>(&self, vault: &Secrets<S>, given: &Given) -> Result<bool, Refusal> {
        vault.remove(&self.vault_name(given)).map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))
    }

    /// The given shares in the person's records (`records`: label to value, as their store holds them under
    /// `record_prefix`): each record whose label is the digest of the routes address and label it holds. A record that does not
    /// read as one, or more than `most_given`, is `Unavailable`: a given share is never quietly dropped.
    pub fn given(&self, records: &BTreeMap<String, Value>) -> Result<Vec<Given>, Refusal> {
        let mut given = Vec::new();
        for (label, value) in records {
            if !label.starts_with(self.record_prefix.as_str()) {
                continue;
            }
            let door = value.get("door").and_then(Value::as_str).ok_or(crate::cause!(Refusal::Unavailable))?;
            let shared = value.get("label").and_then(Value::as_str).ok_or(crate::cause!(Refusal::Unavailable))?;
            let one = self.given_fits(door, shared).ok_or(crate::cause!(Refusal::Unavailable))?;
            if &self.record_label(&one) != label {
                return Err(crate::cause!(Refusal::Unavailable));
            }
            given.push(one);
        }
        if given.len() > self.most_given {
            return Err(crate::cause!(Refusal::Unavailable));
        }
        Ok(given)
    }

    fn key<S: Storage + Send>(&self, vault: &Secrets<S>, given: &Given) -> Result<Zeroizing<String>, Refusal> {
        match vault.plain(&self.vault_name(given)) {
            Ok(key) => Ok(key),
            // A given record whose key is not held cannot be read: unavailable, not "nothing given".
            Err(VaultError::NotHeld(_, _)) | Err(_) => Err(crate::cause!(Refusal::Unavailable)),
        }
    }

    /// What `answer` gives for `given`: the shared record's `types_field` objects that carry a string id. A shared
    /// record the sharer's routes did not answer, or one without that field, gives nothing.
    fn types_in(&self, given: &Given, answer: &DoorAnswer) -> Result<Vec<Value>, Refusal> {
        let DoorAnswer::Records(records) = answer else {
            if let DoorAnswer::Refused(cause) = answer { crate::quiet_eprintln!("share-read-refusal cause={cause}"); }
            return Ok(Vec::new());
        };
        if records.keys().any(|label| label != &given.label) {
            return Err(crate::cause!(Refusal::Unavailable));
        }
        let Some(value) = records.get(&given.label) else {
            return Ok(Vec::new());
        };
        Ok(value
            .get(&self.types_field)
            .and_then(Value::as_array)
            .map(|types| {
                types.iter().filter(|ty| ty.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())).cloned().collect()
            })
            .unwrap_or_default())
    }
}

/// What given shares gave, per person, routes address, label and key digest, each until its read is `keep_for` old.
pub struct Kept {
    entries: Mutex<BTreeMap<String, (Instant, Vec<Value>)>>,
}
impl fmt::Debug for Kept {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Kept([redacted])")
    }
}
impl Default for Kept {
    fn default() -> Self {
        Self { entries: Mutex::new(BTreeMap::new()) }
    }
}
impl Kept {
    /// The one per process.
    pub fn process() -> &'static Kept {
        static KEPT: OnceLock<Kept> = OnceLock::new();
        KEPT.get_or_init(Kept::default)
    }

    /// Every type the person's given shares give now, in the order of `given`: each read at its sharer's account routes with the
    /// key the person's vault holds for it, or as kept when its read is younger than `keep_for`. Any read that fails
    /// makes the whole answer `Unavailable`.
    #[allow(clippy::too_many_arguments)]
    pub fn types<S: Storage + Send>(&self, receiving: &Receiving, vault: &Secrets<S>, door: &dyn SharerDoor,
        person: &str, given: &[Given], keep_for: Duration, now: Instant) -> Result<Vec<Value>, Refusal> {
        let grants = Grants::shipped().map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
        let (resource, operation) = grants.read_call();
        let mut types = Vec::new();
        for one in given {
            let key = receiving.key(vault, one)?;
            let name = content_crypto::advanced::blake3::hash(
                format!("{person}\n{}\n{}\n{}", one.door, one.label, content_crypto::advanced::blake3::hash(key.as_bytes()).to_hex())
                    .as_bytes(),
            )
            .to_hex()
            .to_string();
            let fresh = {
                let entries = self.entries.lock().map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
                entries.get(&name).filter(|(at, _)| now.saturating_duration_since(*at) < keep_for).map(|(_, kept)| kept.clone())
            };
            let gave = match fresh {
                Some(kept) => kept,
                None => {
                    let input = json!({"selection": {"labels": [one.label]}});
                    let answer = door.read(&one.door, resource, operation, &input, key.as_bytes())?;
                    let gave = receiving.types_in(one, &answer)?;
                    let mut entries = self.entries.lock().map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
                    entries.retain(|_, (at, _)| now.saturating_duration_since(*at) < keep_for);
                    entries.insert(name, (now, gave.clone()));
                    gave
                }
            };
            types.extend(gave);
        }
        Ok(types)
    }
}

/// The real share read: the one MCP tool of the sharer's account routes (`door_tool` at `door_path`), over verified TLS, with the key
/// as the bearer.
pub struct HttpsDoor;
impl SharerDoor for HttpsDoor {
    fn read(&self, door: &str, resource: &str, operation: &str, input: &Value, bearer: &[u8])
        -> Result<DoorAnswer, Refusal> {
        let receiving = Receiving::shipped()?;
        if !receiving.door_fits(door) {
            return Err(crate::cause!(Refusal::Unavailable));
        }
        let url = url::Url::parse(door).map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
        let host = url.host_str().ok_or(crate::cause!(Refusal::Unavailable))?.to_owned();
        let port = url.port_or_known_default().ok_or(crate::cause!(Refusal::Unavailable))?;
        let bearer = Zeroizing::new(std::str::from_utf8(bearer).map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?.to_owned());
        let request_key = content_crypto::advanced::blake3::hash(
            format!("{door}\n{resource}\n{operation}\n{input}\n{:?}", std::time::SystemTime::now()).as_bytes(),
        )
        .to_hex()
        .to_string();
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": receiving.door_tool,
            "arguments": {"resource": resource, "operation": operation, "input": input, "request_key": request_key},
        }});
        let body = serde_json::to_vec(&body).map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
        let answer = crate::https::post_json(
            &host, port, &receiving.door_path, &bearer, &body, receiving.most_answer_bytes, receiving.wait(), None,
        )
        .map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
        let reported = answer.header("x-trillion-refusal-cause").and_then(crate::refusal_cause::Cause::from_wire);
        door_answer_reported(answer.status, &answer.body, reported)
    }
}

/// One share answer, read: an HTTP refusal of the bearer, or a tool result the routes refused for rights, is `Refused`;
/// a workspace read's `{records: {label: value}}` is `Records`; anything else is `Unavailable`.
#[cfg(test)]
fn door_answer(status: u16, body: &[u8]) -> Result<DoorAnswer, Refusal> {
    door_answer_reported(status, body, None)
}
fn door_answer_reported(status: u16, body: &[u8], reported: Option<crate::refusal_cause::Cause>) -> Result<DoorAnswer, Refusal> {
    let reported = reported.or_else(|| serde_json::from_slice::<Value>(body).ok()
        .and_then(|answer| answer.get("cause").and_then(Value::as_str).and_then(crate::refusal_cause::Cause::from_wire)));
    if matches!(status, 401 | 403) {
        return Ok(DoorAnswer::Refused(reported.unwrap_or_else(|| crate::cause!(condition: upstream_share_refusal_has_no_recorded_source))));
    }
    if status != 200 {
        return Err(Refusal::Unavailable(reported.unwrap_or_else(|| crate::cause!(condition: upstream_share_status_has_no_recorded_source))));
    }
    let answer: Value = serde_json::from_slice(body).map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
    let result = answer.get("result").ok_or(crate::cause!(Refusal::Unavailable))?;
    let content = result.get("structuredContent").ok_or(crate::cause!(Refusal::Unavailable))?;
    if result.get("isError") == Some(&Value::Bool(true)) {
        let cause = reported.or_else(|| content.get("cause").and_then(Value::as_str).and_then(crate::refusal_cause::Cause::from_wire))
            .unwrap_or_else(|| crate::cause!(condition: upstream_share_tool_refusal_has_no_recorded_source));
        return match content.get("code").and_then(Value::as_str) {
            Some("current_workspace_rights_refused") => Ok(DoorAnswer::Refused(cause)),
            _ => Err(Refusal::Unavailable(cause)),
        };
    }
    if content.get("status").and_then(Value::as_u64) != Some(200) {
        return Err(crate::cause!(Refusal::Unavailable));
    }
    let text = content.get("text").and_then(Value::as_str).ok_or(crate::cause!(Refusal::Unavailable))?;
    let read: Value = serde_json::from_str(text).map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
    let records: &Map<String, Value> = read.get("records").and_then(Value::as_object).ok_or(crate::cause!(Refusal::Unavailable))?;
    Ok(DoorAnswer::Records(records.iter().map(|(label, value)| (label.clone(), value.clone())).collect()))
}

#[cfg(test)]
mod tests;
