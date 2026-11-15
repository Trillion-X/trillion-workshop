//! Sealed record values: what a computer that only holds a copy of an account keeps of its records.
//!
//! A computer the computers row names as a copy keeper or a voter but not in `may_answer` never gets the secrets key
//! (`copies.rs`), so it must not be able to read the records it stores either. The writer (always a computer that may
//! answer, holding the secrets key) seals each record value and each record's kept request results before they go to such a
//! computer (`Copies` decides by the signed row); that computer checks every value it takes is sealed, stores it as it came,
//! and passes it on as it is. A computer that may answer and holds the secrets key opens what it takes from such a computer, and
//! opens what it already holds sealed once the secrets key reaches it (`RecordStore::open_sealed`, a computer named as one that may answer later).
//!
//! The seal: XChaCha20-Poly1305, a fresh random nonce each time, under a key derived from the secrets key
//! (BLAKE3 derive_key: `secrets_key_context` over the secrets key, then `account_context` over that key and the account's owner id).
//! The associated data binds the account, the resource, the record id, the version, the stamp the version was made at
//! (`valid_from`), the part (the value or the kept results) and the identity of the secrets key, so a sealed value moved to
//! another record, version, stamp or part does not open, and one secrets key's seal does not open under another.
//!
//! Every sealed value names the secrets key it was sealed under by its `key_identity` (src/secrets/secrets_key.rs), and every
//! open goes through `open_value`, which takes a set of secrets keys keyed by that identity (`SecretsKeys`: the current one and any
//! older ones). A later secrets key generation is added to the set (`SecretsKeys::add`); rows sealed under an older secrets key keep
//! opening while its secrets key is in the set, and are never sealed again for that.
//!
//! What a computer that only holds a copy still sees (not sealed): record ids, versions, stamps (which carry the time a
//! change was made), whether a version is deleted or erased, the size of each sealed value (within the padding of
//! base64 and the envelope), when changes arrive, and which secrets key a value is sealed under. Settings: `sealed.json`.

use crate::secrets::{secrets_key::key_identity, SecretsKey};
use base64::Engine as _;
use chacha20poly1305::{
    aead::{AeadInPlace, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use content_crypto::advanced::blake3;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::OnceLock};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    version: u32,
    write_version: u32,
    opened_versions: Vec<u32>,
    nonce_bytes: usize,
    secrets_key_context: String,
    account_context: String,
    opaque_token_context: String,
    associated_domain: String,
}

fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| {
        let settings: Settings = serde_json::from_slice(include_bytes!("sealed.json")).expect("computers/sealed.json is valid");
        assert_eq!(settings.nonce_bytes, 24, "computers/sealed.json names the XChaCha20-Poly1305 nonce size");
        settings
    })
}

/// Why a sealed value did not seal or open. Names no byte of a value, key or nonce.
#[derive(Clone, Debug, Eq)]
pub enum Refused {
    /// No secrets key to seal under: the set holds no current secrets key.
    NoSecretsKey(crate::refusal_cause::Cause),
    /// The value names a secrets key the set does not hold.
    UnknownSecretsKey(crate::refusal_cause::Cause),
    /// It is not a sealed value of this format.
    Unreadable(crate::refusal_cause::Cause),
    /// It did not open: another record, version, stamp or part, or damaged.
    NotOpened(crate::refusal_cause::Cause),
    /// A computer that may answer reports it cannot open the format this computer would write: it keeps the previous one
    /// (`choose_write_version`). Writes are never refused for it.
    PeerCannotOpen(crate::refusal_cause::Cause),
}

impl Refused {
    /// The content-free source condition; retained separately from public class equality.
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::NoSecretsKey(cause) => cause.clone(),
            Self::UnknownSecretsKey(cause) => cause.clone(),
            Self::Unreadable(cause) => cause.clone(),
            Self::NotOpened(cause) => cause.clone(),
            Self::PeerCannotOpen(cause) => cause.clone(),
        }
    }
}
impl PartialEq for Refused {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::NoSecretsKey(_), Self::NoSecretsKey(_)) => true,
            (Self::UnknownSecretsKey(_), Self::UnknownSecretsKey(_)) => true,
            (Self::Unreadable(_), Self::Unreadable(_)) => true,
            (Self::NotOpened(_), Self::NotOpened(_)) => true,
            (Self::PeerCannotOpen(_), Self::PeerCannotOpen(_)) => true,
            _ => false,
        }
    }
}


/// The secrets keys a computer holds, keyed by their `key_identity`: the current one (which seals) and older ones
/// (which only open). Holds each secrets key's derived record key, never the secrets key itself. Debug shows identities only.
#[derive(Clone, Default)]
pub struct SecretsKeys {
    current: Option<String>,
    keys: BTreeMap<String, Zeroizing<[u8; 32]>>,
    /// The format a seal from this set takes (`choose_write_version`); None: the previous format.
    write: Option<u32>,
}

impl std::fmt::Debug for SecretsKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Roots").field("current", &self.current).field("held", &self.keys.keys().collect::<Vec<_>>()).finish()
    }
}

impl SecretsKeys {
    /// This set, sealing in `version` (the format `choose_write_version` picked for the peers).
    pub(crate) fn with_write_version(mut self, version: u32) -> Self {
        self.write = Some(version);
        self
    }

    fn write_version(&self) -> u32 {
        self.write.unwrap_or(settings().version)
    }

    /// The set holding `current` only.
    pub fn of(current: &SecretsKey) -> Result<Self, Refused> {
        let mut secrets_keys = Self::default();
        let identity = secrets_keys.add(current)?;
        secrets_keys.current = Some(identity);
        Ok(secrets_keys)
    }

    /// Add `secrets_key` to the set as a secrets key that opens (an older one, or the current one before `make_current`). Answers its
    /// identity.
    pub fn add(&mut self, secrets_key: &SecretsKey) -> Result<String, Refused> {
        let identity = key_identity(secrets_key).map_err(|error| Refused::Unreadable(error.cause()))?;
        self.keys.insert(identity.clone(), secrets_key.derive(&settings().secrets_key_context));
        Ok(identity)
    }

    /// Seal under the secrets key of `identity` from now on (it must be in the set).
    pub fn make_current(&mut self, identity: &str) -> Result<(), Refused> {
        if !self.keys.contains_key(identity) {
            return Err(crate::cause!(Refused::UnknownSecretsKey));
        }
        self.current = Some(identity.to_owned());
        Ok(())
    }

    /// The identity of the secrets key that seals now.
    pub fn current(&self) -> Option<&str> {
        self.current.as_deref()
    }

    /// Whether the set holds any secrets key.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Stable opaque addresses for physical row images. A stream fixes its
    /// initial token-key identity, while payload seals may use newer roots.
    /// No physical key hash leaves the computer without a secret keyed hash.
    pub(crate) fn opaque_token(&self, identity: &str, owner: &str, stream: &str, physical_key: &[u8]) -> Result<String, Refused> {
        let key=self.opaque_key(identity,owner,stream)?;
        Ok(blake3::keyed_hash(&key,physical_key).to_hex().to_string())
    }
    fn opaque_key(&self, identity:&str,owner:&str,stream:&str)->Result<Zeroizing<[u8;32]>,Refused> {
        let base=self.keys.get(identity).ok_or(crate::cause!(Refused::UnknownSecretsKey))?;
        let material=Zeroizing::new(serde_json::to_vec(&(owner,stream)).map_err(|error| crate::carry_cause!(Refused::Unreadable, error))?);
        let mut key_material=Zeroizing::new(Vec::with_capacity(base.len()+material.len()));
        key_material.extend_from_slice(base.as_ref());key_material.extend_from_slice(&material);
        Ok(Zeroizing::new(blake3::derive_key(&settings().opaque_token_context,&key_material)))
    }
    pub(crate) fn mint_opaque_key(&self,owner:&str,stream:&str)->Result<OpaqueTokenKey,Refused> {
        Ok(OpaqueTokenKey(self.opaque_key(self.current().ok_or(crate::cause!(Refused::NoSecretsKey))?,owner,stream)?))
    }

    fn cipher(&self, identity: &str, owner: &str, resource: &str, version: u32) -> Result<XChaCha20Poly1305, Refused> {
        let base = self.keys.get(identity).ok_or(crate::cause!(Refused::UnknownSecretsKey))?;
        let mut material = Zeroizing::new(Vec::with_capacity(32 + owner.len() + resource.len()));
        material.extend_from_slice(base.as_ref());
        material.extend_from_slice(owner.as_bytes());
        if version != settings().version {
            // A later format also derives per resource: a value sealed for one resource does not open under another.
            material.extend_from_slice(&(resource.len() as u64).to_be_bytes());
            material.extend_from_slice(resource.as_bytes());
        }
        let key = Zeroizing::new(blake3::derive_key(&settings().account_context, &material));
        XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|error| crate::carry_cause!(Refused::NotOpened, error))
    }
}

/// Which part of a record version a sealed value is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    /// The record's value.
    Value,
    /// The record's kept request results (the text of their ring, as the current row keeps it).
    Receipts,
}

/// The record version a sealed value belongs to: bound to the seal as associated data.
#[derive(Clone, Copy, Debug)]
pub struct At<'a> {
    /// The account's internal owner id.
    pub owner: &'a str,
    pub resource: &'a str,
    pub id: &'a str,
    pub version: i64,
    /// The stamp the version was made at (its `valid_from`).
    pub from: i64,
    pub part: Part,
}

impl At<'_> {
    fn associated(&self, identity: &str) -> Vec<u8> {
        let mut data = Vec::new();
        let mut field = |bytes: &[u8]| {
            data.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
            data.extend_from_slice(bytes);
        };
        field(settings().associated_domain.as_bytes());
        field(self.owner.as_bytes());
        field(self.resource.as_bytes());
        field(self.id.as_bytes());
        field(&self.version.to_be_bytes());
        field(&self.from.to_be_bytes());
        field(&[match self.part { Part::Value => 0, Part::Receipts => 1 }]);
        field(identity.as_bytes());
        data
    }
}

/// A single stream's secret token key. Its wrapped form survives retirement
/// of the initial root; payload/key wrapping can use the current root instead.
/// Neither Debug nor an opaque physical-row token exposes this material.
pub(crate) struct OpaqueTokenKey(Zeroizing<[u8;32]>);
impl std::fmt::Debug for OpaqueTokenKey {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {f.write_str("OpaqueTokenKey([redacted])")}
}
impl OpaqueTokenKey {
    pub(crate) fn identity(&self)->String {blake3::hash(self.0.as_ref()).to_hex().to_string()}
    pub(crate) fn token(&self,physical_key:&[u8])->String {blake3::keyed_hash(&self.0,physical_key).to_hex().to_string()}
    pub(crate) fn wrap(&self,roots:&SecretsKeys,at:&At<'_>)->Result<serde_json::Value,Refused> {
        seal_bytes(roots,at,Zeroizing::new(self.0.to_vec()))
    }
    pub(crate) fn open(roots:&SecretsKeys,at:&At<'_>,wrapped:&serde_json::Value,identity:&str)->Result<Self,Refused> {
        let bytes=open_bytes(roots,at,wrapped)?;
        let key=Self(Zeroizing::new(bytes.as_slice().try_into().map_err(|error| crate::carry_cause!(Refused::NotOpened, error))?));
        if key.identity()!=identity {return Err(crate::cause!(Refused::NotOpened));}
        Ok(key)
    }
}

/// A sealed value as it is stored and travels, instead of the plain value (a JSON object with only these fields).
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    /// The format version (`sealed.json` `version`).
    sealed: u32,
    /// The `key_identity` of the secrets key it is sealed under.
    key: String,
    nonce: String,
    data: String,
}

fn envelope(value: &serde_json::Value) -> Option<Envelope> {
    if !value.is_object() {
        return None;
    }
    serde_json::from_value::<Envelope>(value.clone()).ok()
}

/// Whether `value` is a sealed value (of any version).
pub fn is_sealed(value: &serde_json::Value) -> bool {
    envelope(value).is_some()
}

/// Whether the text `text` (a record's kept request results) is sealed.
pub fn is_sealed_text(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).is_ok_and(|value| is_sealed(&value))
}

/// Seal the plain `value` of the record version `at` under the current secrets key of `secrets_keys`, with a fresh nonce.
pub fn seal_value(secrets_keys: &SecretsKeys, at: &At<'_>, value: &serde_json::Value) -> Result<serde_json::Value, Refused> {
    seal_bytes(secrets_keys,at,Zeroizing::new(serde_json::to_vec(value).map_err(|error| crate::carry_cause!(Refused::Unreadable, error))?))
}
fn seal_bytes(secrets_keys:&SecretsKeys,at:&At<'_>,mut data:Zeroizing<Vec<u8>>)->Result<serde_json::Value,Refused> {
    let identity = secrets_keys.current().ok_or(crate::cause!(Refused::NoSecretsKey))?;
    let version = secrets_keys.write_version();
    let mut nonce = [0u8; 24];
    SystemRandom::new().fill(&mut nonce).map_err(|error| crate::carry_cause!(Refused::NoSecretsKey, error))?;
    secrets_keys
        .cipher(identity, at.owner, at.resource, version)?
        .encrypt_in_place(XNonce::from_slice(&nonce), &at.associated(identity), &mut *data)
        .map_err(|error| crate::carry_cause!(Refused::NotOpened, error))?;
    let engine = base64::engine::general_purpose::STANDARD;
    let sealed = Envelope { sealed: version, key: identity.to_owned(), nonce: engine.encode(nonce), data: engine.encode(data.as_slice()) };
    serde_json::to_value(sealed).map_err(|error| crate::carry_cause!(Refused::Unreadable, error))
}

/// The seal formats this binary opens, reported to its peers (`OwnReport.sealed_versions`).
pub fn opened_versions() -> Vec<u32> {
    settings().opened_versions.clone()
}

/// The previous format: what a writer seals in until its peers can open the current one, and what a set seals in before any choice.
pub fn legacy_version() -> u32 {
    settings().version
}

/// The format a writer seals in, and the peer it holds back, if any. This binary writes `write_version` only when every peer
/// that may answer reports (`peers`: each computer and the versions it reports, None when it reports none) that it can open it;
/// otherwise it keeps the previous format and names the first peer that holds it back (`PeerCannotOpen`), for the caller to log.
pub fn choose_write_version(peers: &[(String, Option<Vec<u32>>)]) -> (u32, Option<(String, Refused)>) {
    let wanted = settings().write_version;
    if wanted == settings().version {
        return (wanted, None);
    }
    match peers.iter().find(|(_, versions)| !versions.as_ref().is_some_and(|versions| versions.contains(&wanted))) {
        None => (wanted, None),
        Some((computer, _)) => (settings().version, Some((computer.clone(), crate::cause!(Refused::PeerCannotOpen)))),
    }
}

/// THE way a sealed value opens: with any secrets key of `secrets_keys` its envelope names, for the record version `at`. Every other
/// open (`open_text`, `RecordStore::open_sealed` through `copies.rs`) goes through here.
pub fn open_value(secrets_keys: &SecretsKeys, at: &At<'_>, sealed: &serde_json::Value) -> Result<serde_json::Value, Refused> {
    serde_json::from_slice(&open_bytes(secrets_keys,at,sealed)?).map_err(|error| crate::carry_cause!(Refused::NotOpened, error))
}
fn open_bytes(secrets_keys:&SecretsKeys,at:&At<'_>,sealed:&serde_json::Value)->Result<Zeroizing<Vec<u8>>,Refused> {
    let envelope = envelope(sealed).ok_or(crate::cause!(Refused::Unreadable))?;
    if !settings().opened_versions.contains(&envelope.sealed) {
        return Err(crate::cause!(Refused::Unreadable));
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let nonce = engine.decode(&envelope.nonce).map_err(|error| crate::carry_cause!(Refused::Unreadable, error))?;
    if nonce.len() != settings().nonce_bytes {
        return Err(crate::cause!(Refused::Unreadable));
    }
    let mut data = Zeroizing::new(engine.decode(&envelope.data).map_err(|error| crate::carry_cause!(Refused::Unreadable, error))?);
    secrets_keys
        .cipher(&envelope.key, at.owner, at.resource, envelope.sealed)?
        .decrypt_in_place(XNonce::from_slice(&nonce), &at.associated(&envelope.key), &mut *data)
        .map_err(|error| crate::carry_cause!(Refused::NotOpened, error))?;
    Ok(data)
}

/// Seal a record's kept-results text (part `Receipts`): the sealed value, as text.
pub fn seal_text(secrets_keys: &SecretsKeys, at: &At<'_>, text: &str) -> Result<String, Refused> {
    serde_json::to_string(&seal_value(secrets_keys, at, &serde_json::Value::String(text.to_owned()))?).map_err(|error| crate::carry_cause!(Refused::Unreadable, error))
}

/// Open a record's sealed kept-results text, through `open_value`.
pub fn open_text(secrets_keys: &SecretsKeys, at: &At<'_>, sealed: &str) -> Result<String, Refused> {
    let value: serde_json::Value = serde_json::from_str(sealed).map_err(|error| crate::carry_cause!(Refused::Unreadable, error))?;
    match open_value(secrets_keys, at, &value)? {
        serde_json::Value::String(text) => Ok(text),
        _ => Err(crate::cause!(Refused::NotOpened)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::secrets_key::generate;
    use serde_json::json;

    fn at(id: &str, version: i64, from: i64) -> At<'_> {
        At { owner: "owner-1", resource: "own-records", id, version, from, part: Part::Value }
    }

    #[test]
    fn a_sealed_value_opens_only_with_its_root_and_at_its_own_record_version() {
        let secrets_key = generate().unwrap();
        let secrets_keys = SecretsKeys::of(&secrets_key).unwrap();
        let value = json!({"kind": "note", "text": "plain marker"});
        let sealed = seal_value(&secrets_keys, &at("r1", 2, 40), &value).unwrap();
        assert!(is_sealed(&sealed) && !sealed.to_string().contains("plain marker"));
        assert_eq!(sealed["key"], json!(key_identity(&secrets_key).unwrap()), "it names the secrets key it is sealed under");
        assert_eq!(open_value(&secrets_keys, &at("r1", 2, 40), &sealed).unwrap(), value);
        // Another record, version, stamp, part, owner or root: it does not open.
        assert_eq!(open_value(&secrets_keys, &at("r2", 2, 40), &sealed), Err(crate::cause!(Refused::NotOpened)));
        assert_eq!(open_value(&secrets_keys, &at("r1", 3, 40), &sealed), Err(crate::cause!(Refused::NotOpened)));
        assert_eq!(open_value(&secrets_keys, &at("r1", 2, 41), &sealed), Err(crate::cause!(Refused::NotOpened)));
        assert_eq!(open_value(&secrets_keys, &At { part: Part::Receipts, ..at("r1", 2, 40) }, &sealed), Err(crate::cause!(Refused::NotOpened)));
        assert_eq!(open_value(&secrets_keys, &At { owner: "owner-2", ..at("r1", 2, 40) }, &sealed), Err(crate::cause!(Refused::NotOpened)));
        let other = SecretsKeys::of(&generate().unwrap()).unwrap();
        assert_eq!(open_value(&other, &at("r1", 2, 40), &sealed), Err(crate::cause!(Refused::UnknownSecretsKey)));
        // Each seal has its own nonce.
        assert_ne!(seal_value(&secrets_keys, &at("r1", 2, 40), &value).unwrap(), sealed);
    }

    #[test]
    fn an_older_root_in_the_set_still_opens_what_it_sealed() {
        let old = generate().unwrap();
        let new = generate().unwrap();
        let sealed = seal_value(&SecretsKeys::of(&old).unwrap(), &at("r1", 1, 5), &json!("v")).unwrap();
        let mut secrets_keys = SecretsKeys::of(&new).unwrap();
        assert_eq!(open_value(&secrets_keys, &at("r1", 1, 5), &sealed), Err(crate::cause!(Refused::UnknownSecretsKey)));
        secrets_keys.add(&old).unwrap();
        assert_eq!(open_value(&secrets_keys, &at("r1", 1, 5), &sealed).unwrap(), json!("v"));
        // New seals use the current secrets key.
        assert_eq!(seal_value(&secrets_keys, &at("r1", 1, 5), &json!("w")).unwrap()["key"], json!(key_identity(&new).unwrap()));
    }

    #[test]
    fn opaque_row_tokens_stay_keyed_to_one_account_stream_and_initial_root() {
        let old = generate().unwrap();
        let new = generate().unwrap();
        let initial = SecretsKeys::of(&old).unwrap();
        let token_key = initial.current().unwrap().to_owned();
        let physical = br#"["versions",["owner","resource","row",1]]"#;
        let token = initial.opaque_token(&token_key,"owner","stream-a",physical).unwrap();
        assert_ne!(token,blake3::hash(physical).to_hex().to_string());
        let mut rotated = SecretsKeys::of(&new).unwrap();
        assert_eq!(rotated.opaque_token(&token_key,"owner","stream-a",physical),Err(crate::cause!(Refused::UnknownSecretsKey)));
        rotated.add(&old).unwrap();
        assert_eq!(rotated.opaque_token(&token_key,"owner","stream-a",physical).unwrap(),token);
        assert_ne!(rotated.opaque_token(&token_key,"other-owner","stream-a",physical).unwrap(),token);
        assert_ne!(rotated.opaque_token(&token_key,"owner","stream-b",physical).unwrap(),token);
        assert_ne!(rotated.opaque_token(rotated.current().unwrap(),"owner","stream-a",physical).unwrap(),token);
    }

    #[test]
    fn wrapped_stream_key_survives_initial_root_retirement_and_binds_exact_history() {
        let initial=SecretsKeys::of(&generate().unwrap()).unwrap();
        let key=initial.mint_opaque_key("owner-1","history-a").unwrap();
        let identity=key.identity();let token=key.token(b"physical row key");
        let before=key.wrap(&initial,&at("opaque-map-key",0,0)).unwrap();
        let opened=OpaqueTokenKey::open(&initial,&at("opaque-map-key",0,0),&before,&identity).unwrap();
        assert_eq!(opened.token(b"physical row key"),token);
        let current=SecretsKeys::of(&generate().unwrap()).unwrap();
        let after=opened.wrap(&current,&at("opaque-map-key",0,0)).unwrap();
        drop(initial);drop(opened);drop(key);
        let retained=OpaqueTokenKey::open(&current,&at("opaque-map-key",0,0),&after,&identity).unwrap();
        assert_eq!(retained.token(b"physical row key"),token);
        assert!(OpaqueTokenKey::open(&current,&at("another-history",0,0),&after,&identity).is_err());
        assert!(OpaqueTokenKey::open(&current,&at("opaque-map-key",0,0),&after,&"0".repeat(64)).is_err());
        assert!(OpaqueTokenKey::open(&SecretsKeys::default(),&at("opaque-map-key",0,0),&after,&identity).is_err());
        assert_eq!(format!("{retained:?}"),"OpaqueTokenKey([redacted])");
    }

    #[test]
    fn receipts_text_round_trips_and_an_empty_set_cannot_seal() {
        let secrets_keys = SecretsKeys::of(&generate().unwrap()).unwrap();
        let at = At { part: Part::Receipts, ..at("r1", 1, 5) };
        let text = r#"[{"request":"write-r1"}]"#;
        let sealed = seal_text(&secrets_keys, &at, text).unwrap();
        assert!(is_sealed_text(&sealed) && !sealed.contains("write-r1"));
        assert_eq!(open_text(&secrets_keys, &at, &sealed).unwrap(), text);
        assert!(!is_sealed_text(text));
        assert_eq!(seal_value(&SecretsKeys::default(), &at, &json!(1)), Err(crate::cause!(Refused::NoSecretsKey)));
    }
}

crate::impl_caused!(Refused);
