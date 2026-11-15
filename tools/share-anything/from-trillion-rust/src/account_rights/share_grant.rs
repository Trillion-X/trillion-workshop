// src/account_rights/share_grant.rs
//
// Purpose: A person's grant to someone else to read one of their records, honored on the person's own account routes. The grant
// lives in the sharer's own account as an ordinary workspace record (`<record_prefix><label>`, the setting
// share-grant.json `door_grant` beside this file): `{record, people: [{principal, key_blake3}], changed_at}`, kept by the sharer's
// client through the generic records write like any other record. `key_blake3` is the BLAKE3 of a bearer
// (`<token_prefix>` + 32 random bytes, base64url) the sharer hands the recipient; the recipient's engine presents it
// on the sharer's account routes to read that record. Nothing here names a record kind, a feature or a person.
//
// A share may also let its people act on the sharer's account routes (`Act`, DATA `door_grant.act`): the sharing record holds
// `grant` instead of `record` — the tools the bearer may run there, the records operations it may
// make (in a tool row's rights shape), what the sharer's side learns of who acts (`identity`: none, or the
// person's principal) and whether a run's journal keeps a digest of its input (`journal`). The sharer keeps the grant
// (`keep_operation`): the keeping party's cause name (`account_routes::SignIn::party_of`, never a credential) and the
// grant as declared then are kept in the sharer's secrets vault, and a bearer's call is admitted as that party now,
// narrowed to the grant. This is one primitive for every
// cross-account act: a pool that lets anyone add and withdraw their own results and ask the aggregate, a sharer that
// lets each member write only their own answers under a prefix, a member that lets the sharer leave work for their AI.
//
// A share may also reach a mixed collection of the sharer's typed records with no key of the sharer's at all (`reach`, the
// child module share_grant/reach.rs, DATA `door_grant.reach`): the sharing record holds `reach` entries (a record kind and
// at most an exact id or an id prefix) in place of `record` and `grant`, and the engine reads those records in its own
// process, as the account's owner, bounded to the entries of the one open sharing record that names the bearer's digest now.
// It answers the public data address and read-only page of a link or a named person's code, and a bearer's reads and lists
// at the account's records door, inside the entries only. A person or an AI is given their own bearer; stopping one is
// taking their digest out of `people`.
//
// Non-Negotiable Invariants:
// - A bearer reaches exactly the labels whose sharing record, read now, names its digest; a label the call names that
//   no such record grants refuses the whole call. Removing a person from `people` (or the record) ends their reads.
// - A sharing record is honored only for the label it names in `record`, and only when its own label is that record's
//   label under the declared prefix, so a record cannot grant a label it is not about.
// - A grant is read-only: only the account-routes operation `door_grant.operation` with a selection of labels (no prefixes, no
//   other input) is ever admitted; a sharing record itself is never shareable.
// - The bearer's bytes are never stored, logged or shown by Debug; only their digest is compared.
// - An act grant is admitted only while the sharing record's `grant` is exactly the one the sharer kept and its `people`
//   still name the bearer's digest: a changed grant reaches nothing until it is kept again, and taking the person out
//   ends their calls at once. The call is then admitted as the keeping party through the account routes' ordinary
//   gate and rights path, so a party that lost its rights (a key turned off, an app disconnected) acts no more.
// - An act grant reaches only what it declares: a tool it does not name, any other method of the tool route, a records
//   operation, kind or id outside its rights, and every read of the sharing records themselves, are refused.
// - `identity: none` tells the sharer's side nothing of who acts: no `self_mark` may stand in its rights and a tool
//   input's `identity_field` the caller sent is removed. `identity: self` puts the person's principal (only
//   A-Z a-z 0-9 _ -, so one person's prefix never holds another's) where the grant says, and nowhere else.
// - No credential of the sharer is kept: only the keeping party's cause name, which the account routes admit as that
//   party's live rights at every call, so a party that lost its rights reaches nothing.
//
// Key Concepts:
// - `Collection`, `Read`, `Page` (reach.rs): a reach share a bearer reaches now, what one read of it came to, and its page.
// - `Grants`: the DATA (`door_grant`), read once per process.
// - `reached`: the labels a bearer reaches in the sharer's current sharing records.
// - `narrow`: the labels one call asks, or a refusal.
// - `Act`, `Reach`: what one act grant allows, and one act grant a bearer reaches now with the person it names.
// - `keep`, `withdraw`, `kept_party`: the grant kept for the keeping party in the sharer's vault, and that party again.
//
// Security Considerations:
// - The bearer is 256 random bits; its digest is the only thing the sharer's record keeps, so a read of the record
//   never discloses a usable bearer.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod reach;
pub use reach::{Collection, NoViews, Page, Read, ViewMatcher};

use super::run_capability::{Issued, Issuer, ParentKey, Refusal as RunRefusal, Rights};
use crate::{
    mcp::{
        http::{AuthenticationFailure, BearerAuthenticator},
        Principal,
    },
    secrets::{Error as VaultError, Secrets},
    storage::Storage,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use unicode_normalization::UnicodeNormalization;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::OnceLock,
    time::Duration,
};
use zeroize::Zeroizing;

/// The trillion-local setting beside this owner: its `door_grant` block (moved from product/record-sharing.json, whose
/// record links left the engine with the decision screen that read them).
const DATA: &[u8] = include_bytes!("share-grant.json");
/// Random bytes in one bearer.
const TOKEN_BYTES: usize = 32;
/// Hex characters of a bearer's digest a share's sign-in names (enough to tell shares apart in a log of sign-ins).
const SIGN_IN_DIGEST_CHARS: usize = 32;
/// A share signs in as a grant (`grant:` is the sign-in kind every non-key authority uses), named for its share.
const SIGN_IN_KIND: &str = "grant";
const SIGN_IN_SHARE: &str = "share-";
/// The most tools one act grant may name.
const MOST_TOOLS: usize = 64;
/// The longest principal an act grant may name for a person.
const MOST_PRINCIPAL_BYTES: usize = 128;

/// Why a share call was refused.
#[derive(Clone, Debug)]
pub enum Refusal {
    /// The DATA, the vault or the random source is not available.
    Unavailable(crate::refusal_cause::Cause),
    /// The bearer is malformed, or the call is not one this bearer's grants allow now.
    NotGranted(crate::refusal_cause::Cause),
    /// A keep's input, or the grant it names, is not one a grant may be.
    Input(crate::refusal_cause::Cause),
}
impl Refusal { pub fn cause(&self) -> crate::refusal_cause::Cause { match self {
Self::Unavailable(cause)=>cause.clone(),
Self::NotGranted(cause)=>cause.clone(),
Self::Input(cause)=>cause.clone(),
} } }
crate::impl_caused!(Refusal);
impl PartialEq for Refusal {fn eq(&self, other:&Self)->bool {std::mem::discriminant(self)==std::mem::discriminant(other)}}
impl Eq for Refusal {}


/// The shape of a grant on the account's routes, from DATA.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grants {
    #[serde(rename = "_what")]
    _what: String,
    record_prefix: String,
    token_prefix: String,
    resource: String,
    operation: String,
    act: ActData,
    reach: reach::ReachData,
    public_link: PublicLinkData,
}

/// How public links are read, from DATA (`door_grant.public_link`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicLinkData {
    #[serde(rename = "_what")]
    _what: String,
    scope: String,
    can: String,
    answer: PublicAnswerData,
}

/// The row and link words of a public link's answer, from DATA (`door_grant.public_link.answer`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicAnswerData {
    #[serde(rename = "_what")]
    _what: String,
    first_words: usize,
    longest: usize,
    pattern: String,
    date_kinds: Vec<String>,
    link_parts: Vec<String>,
}

/// How act grants are kept and read, from DATA (`door_grant.act`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActData {
    #[serde(rename = "_what")]
    _what: String,
    keep_resource: String,
    keep_operation: String,
    vault_prefix: String,
    self_mark: String,
    identity_field: String,
}

/// What the sharer's side learns of who acts under an act grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Identity {
    /// Nothing: the person stays unnamed on the sharer's account routes.
    Withheld,
    /// The person's principal from the grant's `people`, where the grant says.
    Person,
}

/// What one sharing record's `grant` allows its people on the sharer's account routes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Act {
    tools: BTreeSet<String>,
    records: Option<Value>,
    identity: Identity,
    journal_input: bool,
}
impl Act {
    /// A `grant` value: `{tools?, records?, identity, journal}` with at least one of tools or records; None otherwise.
    fn declared(grant: &Value) -> Option<Self> {
        let fields = grant.as_object()?;
        if fields
            .keys()
            .any(|key| !matches!(key.as_str(), "tools" | "records" | "identity" | "journal"))
        {
            return None;
        }
        let tools = match fields.get("tools") {
            None => BTreeSet::new(),
            Some(tools) => {
                let tools = tools
                    .as_array()
                    .filter(|tools| !tools.is_empty() && tools.len() <= MOST_TOOLS)?;
                tools
                    .iter()
                    .map(|tool| {
                        tool.as_str()
                            .filter(|tool| !tool.is_empty())
                            .map(str::to_owned)
                    })
                    .collect::<Option<_>>()?
            }
        };
        let records = fields.get("records").cloned();
        if tools.is_empty() && records.is_none() {
            return None;
        }
        let identity = match fields.get("identity")?.as_str()? {
            "none" => Identity::Withheld,
            "self" => Identity::Person,
            _ => return None,
        };
        let journal_input = match fields.get("journal")?.as_str()? {
            "input" => true,
            "none" => false,
            _ => return None,
        };
        Some(Self {
            tools,
            records,
            identity,
            journal_input,
        })
    }

    /// Whether this grant lets its people run `tool`.
    pub fn runs(&self, tool: &str) -> bool {
        self.tools.contains(tool)
    }

    /// Whether a run under this grant keeps a digest of its input in the sharer's journal.
    pub fn journals_input(&self) -> bool {
        self.journal_input
    }

    /// What the sharer's side learns of who acts.
    pub fn identity(&self) -> Identity {
        self.identity
    }
}

/// One act grant a bearer reaches now: the shared label its record is under, what it allows, and the principal its
/// `people` entry names for this bearer.
#[derive(Clone, PartialEq, Eq)]
pub struct Reach {
    pub label: String,
    pub act: Act,
    person: String,
}
impl Reach {
    /// The identity this grant permits its holder to learn. Withheld grants
    /// never expose their person through native task metadata.
    /// Native-only recovery binding of the actual admitted reach. This is transient input to the private
    /// journal witness, never task context or a wire constructor. Public identity disclosure remains unchanged.
    pub(crate) fn recovery_source(&self) -> Value {
        json!({"label":self.label,"person":self.person,"tools":self.act.tools,"records":self.act.records,
            "identity":match self.act.identity {Identity::Withheld=>"none",Identity::Person=>"self"},
            "journal_input":self.act.journal_input})
    }

    pub(crate) fn disclosed_person(&self) -> Option<&str> {
        (self.act.identity == Identity::Person).then_some(self.person.as_str())
    }
}
impl fmt::Debug for Reach {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Reach")
            .field("label", &self.label)
            .field("act", &self.act)
            .finish_non_exhaustive()
    }
}

/// A principal an act grant may name: 1 to `MOST_PRINCIPAL_BYTES` of A-Z a-z 0-9 _ -, so put in a prefix it never
/// reaches into another person's.
fn principal_fits(principal: &str) -> bool {
    (1..=MOST_PRINCIPAL_BYTES).contains(&principal.len())
        && principal
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// The issuer of a run an act grant started: the keeping party's own issuer, and whether the run's journal keeps a digest
/// of its input (the grant's `journal`).
pub struct ActIssuer<'a> {
    pub parent: ParentKey<'a>,
    pub journal_input: bool,
}

impl fmt::Debug for ActIssuer<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ActIssuer([redacted])")
    }
}
impl Issuer for ActIssuer<'_> {
    fn issue(&self, records: &Value, lifetime: Duration) -> Result<Issued, RunRefusal> {
        self.parent.issue(records, lifetime)
    }

    fn journals_input(&self) -> bool {
        self.journal_input
    }
}

#[derive(Deserialize)]
struct Data {
    door_grant: Grants,
}

impl Grants {
    /// The shipped DATA, read and checked once per process.
    pub fn shipped() -> Result<&'static Grants, Refusal> {
        static SHIPPED: OnceLock<Option<Grants>> = OnceLock::new();
        SHIPPED
            .get_or_init(|| {
                let data: Data = serde_json::from_slice(DATA).ok()?;
                let grants = data.door_grant;
                (!grants.record_prefix.is_empty() && !grants.token_prefix.is_empty())
                    .then_some(grants)
            })
            .as_ref()
            .ok_or(crate::cause!(Refusal::Unavailable))
    }

    /// Whether `bearer` is a share bearer at all (by its prefix; it may still be malformed or reach nothing).
    pub fn is_share(&self, bearer: &[u8]) -> bool {
        bearer.starts_with(self.token_prefix.as_bytes())
    }

    /// The prefix every sharing record's label starts with (a read of the sharer's grants on the account's routes selects it).
    pub fn record_prefix(&self) -> &str {
        &self.record_prefix
    }

    /// The route resource and operation of a share's read (`door_grant.resource`, `door_grant.operation`): what a
    /// person given a share asks on the sharer's account routes (`share_given`).
    pub fn read_call(&self) -> (&str, &str) {
        (&self.resource, &self.operation)
    }

    /// Who a share bearer with `digest` (`digest`) is on the routes of `account`: the account's own, signed in as a grant
    /// named for the share (the start of its digest).
    pub fn principal(&self, account: &str, digest: &str) -> Principal {
        Principal { kind: crate::mcp::PrincipalKind::Person,
            account_id: account.to_owned(),
            sign_in: format!("{SIGN_IN_KIND}:{SIGN_IN_SHARE}{}", &digest[..SIGN_IN_DIGEST_CHARS]),
            client_id: String::new(),
        }
    }

    /// The BLAKE3 a sharing record keeps for `bearer`, or None when it is not a well-formed share bearer.
    pub fn digest(&self, bearer: &[u8]) -> Option<String> {
        let rest = bearer.strip_prefix(self.token_prefix.as_bytes())?;
        let random = URL_SAFE_NO_PAD.decode(rest).ok()?;
        (random.len() == TOKEN_BYTES).then(|| {
            content_crypto::advanced::blake3::hash(bearer)
                .to_hex()
                .to_string()
        })
    }

    /// The labels `bearer` reaches in the sharer's sharing records now (`sharing`: label to value, as the sharer's
    /// store holds them under `record_prefix`).
    pub fn reached(&self, sharing: &BTreeMap<String, Value>, bearer: &[u8]) -> BTreeSet<String> {
        let Some(digest) = self.digest(bearer) else {
            return BTreeSet::new();
        };
        sharing
            .iter()
            .filter_map(|(label, value)| {
                let shared = label.strip_prefix(self.record_prefix.as_str())?;
                if value.get("grant").is_some() {
                    return None;
                }
                if self.is_public(value) && !self.open_public(value, Utc::now()) {
                    return None;
                }
                let named = value.get("record").and_then(Value::as_str)?;
                let people = value.get("people").and_then(Value::as_array)?;
                let names = people.iter().any(|person| {
                    person.get("key_blake3").and_then(Value::as_str) == Some(digest.as_str())
                });
                (named == shared
                    && !shared.is_empty()
                    && !shared.starts_with(self.record_prefix.as_str())
                    && names)
                    .then(|| shared.to_owned())
            })
            .collect()
    }

    /// Whether a sharing record is a public link (`public_link.scope`), whose one person is the link's code.
    fn is_public(&self, value: &Value) -> bool {
        value.get("scope").and_then(Value::as_str) == Some(self.public_link.scope.as_str())
    }

    /// Whether a public link's record is open at `now`: published (absent or true), not revoked (absent or null), not
    /// expired (absent or null, or a time still ahead), and `can` holds the link's view (absent means view, as in
    /// old trillion). Anything malformed is closed.
    fn open_public(&self, value: &Value, now: DateTime<Utc>) -> bool {
        let published = value.get("published").is_none_or(|published| published.as_bool() == Some(true));
        let revoked = value.get("revoked_at").is_none_or(Value::is_null);
        let expired = match value.get("expires_at") {
            None | Some(Value::Null) => false,
            Some(Value::String(at)) => match DateTime::parse_from_rfc3339(at) {
                Ok(at) => at.with_timezone(&Utc) <= now,
                Err(_) => true,
            },
            Some(_) => true,
        };
        let can = match value.get("can") {
            None | Some(Value::Null) => true,
            Some(Value::Array(can)) => can.iter().any(|ability| ability.as_str() == Some(self.public_link.can.as_str())),
            Some(_) => false,
        };
        published && revoked && !expired && can
    }

    /// The record a public link's code opens now: the one label the code reaches in the sharer's sharing records, when
    /// that label's sharing record is a public link open at this moment (`open_public`, through `reached`). None for any
    /// other code, a closed link, or a code that reaches more than one label.
    pub fn public_link(&self, sharing: &BTreeMap<String, Value>, code: &[u8]) -> Option<String> {
        let mut reached = self.reached(sharing, code).into_iter();
        let (Some(shared), None) = (reached.next(), reached.next()) else {
            return None;
        };
        let value = sharing.get(&format!("{}{shared}", self.record_prefix))?;
        self.is_public(value).then_some(shared)
    }

    /// The labels one call asks, when it is this grant's read at `resource` with a selection of labels only, every one
    /// of them in `reached`; otherwise `NotGranted`.
    pub fn narrow(
        &self,
        reached: &BTreeSet<String>,
        resource: &str,
        operation: &str,
        input: &Value,
    ) -> Result<Vec<String>, Refusal> {
        if resource != self.resource || operation != self.operation {
            return Err(crate::cause!(Refusal::NotGranted));
        }
        let fields = input
            .as_object()
            .filter(|fields| fields.len() == 1)
            .ok_or(crate::cause!(Refusal::NotGranted))?;
        let selection = fields.get("selection").ok_or(crate::cause!(Refusal::NotGranted))?;
        let labels = match selection {
            Value::Array(labels) => labels,
            Value::Object(object) if object.len() == 1 => object
                .get("labels")
                .and_then(Value::as_array)
                .ok_or(crate::cause!(Refusal::NotGranted))?,
            _ => return Err(crate::cause!(Refusal::NotGranted)),
        };
        let asked: Vec<String> = labels
            .iter()
            .map(|label| label.as_str().map(str::to_owned).ok_or(crate::cause!(Refusal::NotGranted)))
            .collect::<Result<_, _>>()?;
        if asked.is_empty() || !asked.iter().all(|label| reached.contains(label)) {
            return Err(crate::cause!(Refusal::NotGranted));
        }
        Ok(asked)
    }

    /// Whether a call at `resource` by `operation` is this grant's read (`shared_read`), the only call a read share
    /// makes; every other call of a share bearer is an act.
    pub fn reads(&self, resource: &str, operation: &str) -> bool {
        resource == self.resource && operation == self.operation
    }

    /// Whether a call at `resource` by `operation` is the sharer keeping or withdrawing an act grant.
    pub fn keeps(&self, resource: &str, operation: &str) -> bool {
        resource == self.act.keep_resource && operation == self.act.keep_operation
    }

    /// A keep's input: exactly `{label, on}`, the label a shared one (not under the record prefix).
    pub fn keep_asked<'a>(&self, input: &'a Value) -> Option<(&'a str, bool)> {
        let fields = input.as_object().filter(|fields| fields.len() == 2)?;
        let label = fields
            .get("label")?
            .as_str()
            .filter(|label| !label.is_empty() && !label.starts_with(self.record_prefix.as_str()))?;
        Some((label, fields.get("on")?.as_bool()?))
    }

    /// The act grants `bearer` reaches in the sharer's sharing records now: each record under the prefix about its own
    /// label that holds a well-formed `grant` (and no `record`) and a `people` entry naming the bearer's digest with a
    /// principal that fits.
    pub fn acting(&self, sharing: &BTreeMap<String, Value>, bearer: &[u8]) -> Vec<Reach> {
        let Some(digest) = self.digest(bearer) else {
            return Vec::new();
        };
        sharing
            .iter()
            .filter_map(|(label, value)| {
                let shared = label.strip_prefix(self.record_prefix.as_str())?;
                if shared.is_empty()
                    || shared.starts_with(self.record_prefix.as_str())
                    || value.get("record").is_some()
                {
                    return None;
                }
                let act = Act::declared(value.get("grant")?)?;
                let person = value
                    .get("people")
                    .and_then(Value::as_array)?
                    .iter()
                    .find_map(|person| {
                        (person.get("key_blake3").and_then(Value::as_str) == Some(digest.as_str()))
                            .then(|| {
                                person
                                    .get("principal")
                                    .and_then(Value::as_str)
                                    .filter(|principal| principal_fits(principal))
                            })
                            .flatten()
                    })?;
                Some(Reach {
                    label: shared.to_owned(),
                    act,
                    person: person.to_owned(),
                })
            })
            .collect()
    }

    /// The records rights `reach` grants, as a run capability takes them: the grant's `records` with the person's
    /// principal put in place of every `self_mark` in an id or prefix when its identity is `self`. None when it grants
    /// no records; `NotGranted` when a withheld identity's rights hold the mark or the rights are not grantable.
    pub fn rights_for(
        &self,
        reach: &Reach,
        state_root: &std::path::Path,
    ) -> Result<Option<Rights>, Refusal> {
        let Some(records) = &reach.act.records else {
            return Ok(None);
        };
        let mut records = records.clone();
        for right in records
            .get_mut("rights")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            for field in ["id", "prefix"] {
                let Some(text) = right.get(field).and_then(Value::as_str) else {
                    continue;
                };
                if !text.contains(self.act.self_mark.as_str()) {
                    continue;
                }
                if reach.act.identity == Identity::Withheld {
                    return Err(crate::cause!(Refusal::NotGranted));
                }
                let named = text.replace(self.act.self_mark.as_str(), &reach.person);
                right[field] = Value::String(named);
            }
        }
        let rights = Rights::declared(&records).map_err(|refusal| match refusal {
            RunRefusal::Unavailable(_) => crate::cause!(Refusal::Unavailable),
            _ => crate::cause!(Refusal::NotGranted),
        })?;
        // A share's people are other people: a kind that stays on this computer is never theirs to act on.
        if rights.device_only_kind(state_root).is_some() {
            return Err(crate::cause!(Refusal::NotGranted));
        }
        Ok(Some(rights))
    }

    /// The input of a tool run under `reach` (the tool route's `{tool, input, ...}`): with identity `self`, the tool's
    /// input gets `identity_field` = the person's principal; withheld, any `identity_field` the caller sent is removed,
    /// so the field only ever holds what the grant put there. A call whose `input` is not an object is refused.
    pub fn tool_input(&self, reach: &Reach, call_input: &Value) -> Result<Value, Refusal> {
        let mut call_input = call_input.clone();
        let fields = call_input.as_object_mut().ok_or(crate::cause!(Refusal::Input))?;
        let tool_input = fields
            .entry("input")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or(crate::cause!(Refusal::Input))?;
        match reach.act.identity {
            Identity::Person => {
                tool_input.insert(
                    self.act.identity_field.clone(),
                    Value::String(reach.person.clone()),
                );
            }
            Identity::Withheld => {
                tool_input.remove(&self.act.identity_field);
            }
        }
        Ok(call_input)
    }

    /// The vault name an act grant on `label` is kept under.
    fn vault_name(&self, label: &str) -> String {
        format!(
            "{}{}",
            self.act.vault_prefix,
            content_crypto::advanced::blake3::hash(label.as_bytes()).to_hex()
        )
    }

    /// Keep the act grant on `label` for the party that kept it, named by its cause name `party` (never a credential,
    /// `account_routes::SignIn::party_of`): `sharing` is its sharing record now, whose `grant` is kept beside the party's
    /// name (replacing an earlier keep). A bearer's call is then admitted as that party now, narrowed to the grant. A
    /// record that holds no act grant is `Input`.
    pub fn keep<S: Storage + Send>(
        &self,
        vault: &Secrets<S>,
        label: &str,
        party: &str,
        sharing: &Value,
    ) -> Result<(), Refusal> {
        let grant = sharing
            .get("grant")
            .filter(|grant| sharing.get("record").is_none() && Act::declared(grant).is_some())
            .ok_or(crate::cause!(Refusal::Input))?;
        if party.is_empty() {
            return Err(crate::cause!(Refusal::Input));
        }
        let held = Zeroizing::new(json!({"party": party, "grant": grant}).to_string());
        vault
            .put(&self.vault_name(label), held)
            .map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))
    }

    /// Withdraw the act grant kept on `label`; answers whether one was kept.
    pub fn withdraw<S: Storage + Send>(
        &self,
        vault: &Secrets<S>,
        label: &str,
    ) -> Result<bool, Refusal> {
        vault
            .remove(&self.vault_name(label))
            .map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))
    }

    /// Whether `reach`'s kept entry is still in the vault. Only its presence is read (`Secrets::holds`): no value is
    /// unsealed, so checking it again during a call costs no read of the vault's secret allowance. A re-keep under the
    /// same grant by another party is not seen here; the call already admitted is bounded by the party it was
    /// admitted as, which the account routes check again at every call.
    pub fn still_kept<S: Storage + Send>(&self, vault: &Secrets<S>, reach: &Reach) -> bool {
        // An unreadable vault keeps nothing: the grant is refused, as a name that is not held is.
        vault.holds(&self.vault_name(&reach.label)).unwrap_or(false)
    }

    /// The party `reach` is admitted as: the cause name kept for its label with exactly the grant the record declares
    /// now, else `NotGranted`. An entry kept before act grants kept a party (it holds a key) is no party.
    pub fn kept_party<S: Storage + Send>(
        &self,
        vault: &Secrets<S>,
        reach: &Reach,
    ) -> Result<String, Refusal> {
        let held = match vault.plain(&self.vault_name(&reach.label)) {
            Ok(held) => held,
            Err(VaultError::NotHeld(_, _)) => return Err(crate::cause!(Refusal::NotGranted)),
            Err(_) => return Err(crate::cause!(Refusal::Unavailable)),
        };
        let held: Value = serde_json::from_str(&held).map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
        if Act::declared(&held["grant"]).as_ref() != Some(&reach.act) {
            return Err(crate::cause!(Refusal::NotGranted));
        }
        held["party"]
            .as_str()
            .filter(|party| !party.is_empty())
            .map(str::to_owned)
            .ok_or(crate::cause!(Refusal::NotGranted))
    }
}

impl Grants {
    /// What a public link answers for its record (old trillion src/record-share-pages.mjs, the `.json` page): the record's
    /// kind, title, about, changed day, fields, rows and files, and nothing else of it. `base` is the link's own address
    /// (`<origin>/share/<code>`): each row's url is `base/<row address>` and each file's is `base/files/<identity>`. A record
    /// with no rows or no fields answers its kind, title and preview only, as old trillion does. The record keeps these
    /// under `body` as a list copy does.
    pub fn public_answer(&self, record: &Value, base: &str) -> Value {
        let pick = |source: &Value, key: &str| source.get(key).cloned().unwrap_or(Value::Null);
        let body = record.get("body").unwrap_or(&Value::Null);
        let answer = &self.public_link.answer;
        let (Some(rows), Some(fields)) = (body.get("rows").and_then(Value::as_array), body.get("fields").and_then(Value::as_array)) else {
            return json!({"kind": pick(record, "kind"), "title": pick(record, "title"), "preview": pick(record, "preview")});
        };
        let pattern = regex::Regex::new(&answer.pattern).ok();
        let dates: Vec<&str> = fields.iter()
            .filter(|field| field.get("kind").and_then(Value::as_str).is_some_and(|kind| answer.date_kinds.iter().any(|date| date == kind)))
            .filter_map(|field| field.get("id").and_then(Value::as_str))
            .collect();
        let mut taken = BTreeSet::new();
        let mut changed: Option<String> = None;
        let rows: Vec<Value> = rows.iter().map(|row| {
            let title = pick(row, "title");
            let words = title.as_str().and_then(|words| answer.address_of(words, pattern.as_ref())).unwrap_or_else(|| "row".to_owned());
            let mut address = if answer.link_parts.contains(&words) { format!("{words}-row") } else { words.clone() };
            for n in 2.. {
                if !taken.contains(&address) { break; }
                address = format!("{words}-{n}");
            }
            taken.insert(address.clone());
            for id in &dates {
                let day = row.get("values").and_then(|values| values.get(*id)).and_then(Value::as_str).filter(|day| is_day(day));
                if let Some(day) = day.map(|day| day[..10].to_owned()) {
                    if changed.as_ref().is_none_or(|latest| &day > latest) { changed = Some(day); }
                }
            }
            json!({
                "id": pick(row, "id"),
                "title": title,
                "address": address,
                "url": format!("{base}/{address}"),
                "values": row.get("values").cloned().unwrap_or_else(|| json!({})),
            })
        }).collect();
        let files: Vec<Value> = body.get("files").and_then(Value::as_array).into_iter().flatten()
            .map(|file| {
                let identity = file.get("identity").and_then(Value::as_str).unwrap_or_default();
                let mut file = file.clone();
                if let Some(object) = file.as_object_mut() {
                    object.insert("url".to_owned(), json!(format!("{base}/files/{identity}")));
                }
                file
            })
            .collect();
        json!({
            "kind": pick(record, "kind"),
            "title": pick(record, "title"),
            "about": pick(body, "about"),
            "changed": changed,
            "fields": fields,
            "rows": rows,
            "files": files,
        })
    }
}

impl PublicAnswerData {
    /// A title's address words (old trillion src/readable-names.mjs `nameFromWords`): lowercase, accents taken off, every
    /// run of other characters a dash, the first `first_words` words joined and cut to `longest`, then checked against
    /// `pattern` and refused when it reads as a random code (twenty or more hex characters).
    fn address_of(&self, words: &str, pattern: Option<&regex::Regex>) -> Option<String> {
        let plain: String = words.to_lowercase().nfkd().filter(|character| !is_combining(*character)).collect();
        let joined = plain.split(|character: char| !character.is_ascii_alphanumeric())
            .filter(|word| !word.is_empty())
            .take(self.first_words)
            .collect::<Vec<_>>()
            .join("-");
        let cut: String = joined.chars().take(self.longest).collect();
        let slug = cut.trim_end_matches('-').to_owned();
        let looks_like_code = slug.len() >= 20 && slug.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        (pattern?.is_match(&slug) && !looks_like_code).then_some(slug)
    }
}

/// Whether a text starts with a `YYYY-MM-DD` day (old trillion's `/^\d{4}-\d{2}-\d{2}/`).
fn is_day(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 10 && bytes[..10].iter().enumerate().all(|(at, byte)| match at {
        4 | 7 => *byte == b'-',
        _ => byte.is_ascii_digit(),
    })
}

/// Whether a character is a combining mark (the accent NFKD splits off a letter).
fn is_combining(character: char) -> bool {
    ('\u{300}'..='\u{36f}').contains(&character)
}

/// The account routes' bearer check with share bearers: a well-formed share bearer is the routes' own account, signed in as
/// a grant named for that share (the start of its digest), and reaches nothing until its call is narrowed against the sharer's
/// grants read at that moment (`Grants::reached`, `Grants::narrow`); every other bearer goes to `inner`.
pub struct Authenticator<A> {
    inner: A,
    account: String,
}
impl<A> Authenticator<A> {
    /// `account`: the one account these routes serve.
    pub fn new(inner: A, account: String) -> Self {
        Self { inner, account }
    }
}
impl<A: BearerAuthenticator> BearerAuthenticator for Authenticator<A> {
    fn authenticate(&self, token: &[u8]) -> Option<Principal> {
        self.authenticate_current(token).ok()
    }

    fn authenticate_current(&self, token: &[u8]) -> Result<Principal, AuthenticationFailure> {
        let grants = match Grants::shipped() {
            Ok(grants) if grants.is_share(token) => grants,
            Ok(_) => return self.inner.authenticate_current(token),
            Err(_) => return Err(crate::cause!(AuthenticationFailure::Unavailable)),
        };
        let digest = grants
            .digest(token)
            .ok_or(crate::cause!(AuthenticationFailure::Unauthorized))?;
        Ok(grants.principal(&self.account, &digest))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Every prefix, resource and operation comes from the shipped DATA, so the tests name none.
    fn grants() -> &'static Grants {
        Grants::shipped().expect("share-grant.json door_grant")
    }
    fn label(shared: &str) -> String {
        format!("{}{shared}", grants().record_prefix)
    }
    fn bearer(byte: u8) -> Vec<u8> {
        format!(
            "{}{}",
            grants().token_prefix,
            URL_SAFE_NO_PAD.encode([byte; TOKEN_BYTES])
        )
        .into_bytes()
    }
    fn record(shared: &str, people: &[&[u8]]) -> Value {
        json!({"record": shared, "people": people.iter().map(|key| json!({"principal": "someone", "key_blake3": grants().digest(key).unwrap()})).collect::<Vec<_>>()})
    }

    #[test]
    fn a_bearer_reaches_only_the_records_whose_grant_names_it() {
        let (b, c) = (bearer(1), bearer(2));
        let nested = label("x");
        let sharing = BTreeMap::from([
            (label("preset"), record("preset", &[&b])),
            (label("notes"), record("notes", &[&c])),
            (label("other"), record("not-this-one", &[&b])),
            (label(&nested), record(&nested, &[&b])),
        ]);
        assert_eq!(
            grants().reached(&sharing, &b),
            BTreeSet::from(["preset".to_owned()])
        );
        assert_eq!(
            grants().reached(&sharing, &c),
            BTreeSet::from(["notes".to_owned()])
        );
        assert!(
            grants().reached(&sharing, &bearer(3)).is_empty(),
            "a bearer nobody named reaches nothing"
        );
        let short = format!("{}short", grants().token_prefix);
        assert!(
            grants().reached(&sharing, short.as_bytes()).is_empty(),
            "a malformed bearer reaches nothing"
        );
    }

    #[test]
    fn a_call_is_admitted_only_as_a_read_of_reached_labels() {
        let shipped = grants();
        let reached = BTreeSet::from(["preset".to_owned()]);
        let read =
            |input: Value| shipped.narrow(&reached, &shipped.resource, &shipped.operation, &input);
        assert_eq!(
            read(json!({"selection": ["preset"]})),
            Ok(vec!["preset".to_owned()])
        );
        assert_eq!(
            read(json!({"selection": {"labels": ["preset"]}})),
            Ok(vec!["preset".to_owned()])
        );
        assert_eq!(
            read(json!({"selection": ["preset", "notes"]})),
            Err(crate::cause!(Refusal::NotGranted))
        );
        assert_eq!(
            read(json!({"selection": {"prefixes": ["pre"]}})),
            Err(crate::cause!(Refusal::NotGranted))
        );
        assert_eq!(
            read(json!({"selection": {"labels": ["preset"], "prefixes": []}})),
            Err(crate::cause!(Refusal::NotGranted))
        );
        assert_eq!(read(json!({"selection": []})), Err(crate::cause!(Refusal::NotGranted)));
        assert_eq!(read(json!({})), Err(crate::cause!(Refusal::NotGranted)));
        let other = format!("{}-other", shipped.operation);
        assert_eq!(
            shipped.narrow(
                &reached,
                &shipped.resource,
                &other,
                &json!({"selection": ["preset"]})
            ),
            Err(crate::cause!(Refusal::NotGranted))
        );
    }

    #[test]
    fn removing_the_person_ends_the_grant() {
        let b = bearer(1);
        let mut sharing = BTreeMap::from([(label("preset"), record("preset", &[&b]))]);
        assert!(!grants().reached(&sharing, &b).is_empty());
        sharing.insert(label("preset"), record("preset", &[]));
        assert!(grants().reached(&sharing, &b).is_empty());
    }

    #[test]
    fn the_shipped_shape_reads() {
        assert!(grants().is_share(&bearer(4)));
        assert!(grants().digest(&bearer(4)).is_some());
        assert!(!grants().record_prefix().is_empty());
    }

    // Act grants. The two shapes every cross-account act takes: a pool that lets anyone run its tools while staying
    // unnamed and unjournaled, and a sharer that lets each member write only under their own prefix.

    use crate::{
        account_rights::run_capability::{held, mint},
        mcp::Operation,
        record_value::account_routes::Door,
        secrets::{open_store, SecretsKey, VaultIdentity},
    };

    const SHARER: &str = "sharer-account";

    fn write_operation() -> &'static str {
        crate::record_write_model::write_command::Command::shipped()
            .unwrap()
            .operation()
    }
    fn pool_grant() -> Value {
        json!({"tools": ["add-a-result", "how-similar-results-turned-out"], "identity": "none", "journal": "none"})
    }
    /// A synthetic kind the tests write, and ids made of parts joined by a separator no principal may hold.
    const ANSWER: &str = "answer";
    fn id(parts: &[&str]) -> String {
        parts.join(":")
    }
    fn answers_grant() -> Value {
        json!({"records": {"rights": [{"kind": ANSWER, "operations": [write_operation()],
            "prefix": id(&[ANSWER, "c1", &grants().act.self_mark, ""])}]}, "identity": "self", "journal": "input"})
    }
    fn act_record(grant: Value, people: &[(&str, &[u8])]) -> Value {
        json!({"grant": grant, "people": people.iter().map(|(principal, key)| json!({"principal": principal, "key_blake3": grants().digest(key).unwrap()})).collect::<Vec<_>>()})
    }
    fn sharing(records: &[(&str, Value)]) -> BTreeMap<String, Value> {
        records
            .iter()
            .map(|(shared, value)| (label(shared), value.clone()))
            .collect()
    }
    fn vault(dir: &tempfile::TempDir) -> Secrets<impl Storage + Send> {
        let root = SecretsKey::new(Zeroizing::new(format!(
            "nm_{}_{}",
            "c".repeat(64),
            "a".repeat(64)
        )))
        .unwrap();
        Secrets::open(
            open_store(&dir.path().join("held.sqlite")).unwrap(),
            SHARER,
            &root,
            VaultIdentity::new("testhost").unwrap(),
        )
        .unwrap()
    }
    /// One write of one record of `kind` under `id`.
    fn write(kind: &str, id: &str) -> Operation {
        Operation {
            person_present: None,
            resource: Door::shipped().unwrap().resource().to_owned(),
            operation: write_operation().to_owned(),
            input: json!({"records": [{"id": id, "type": kind, "value": {"answer": "yes"}}]}),
            request_key: "k".to_owned(),
        }
    }
    fn as_sharer() -> Principal {
        Principal { kind: crate::mcp::PrincipalKind::Person,
            account_id: SHARER.to_owned(),
            sign_in: "sharer key".to_owned(),
            client_id: String::new(),
        }
    }

    #[test]
    fn a_bearer_reaches_only_the_act_grants_that_name_it_with_a_principal_that_fits() {
        let (member, other) = (bearer(11), bearer(12));
        let records = sharing(&[
            ("pool", act_record(pool_grant(), &[("anyone-1", &member)])),
            (
                "answers",
                act_record(
                    answers_grant(),
                    &[("member-a", &member), ("member-b", &other)],
                ),
            ),
            (
                "unfit",
                act_record(answers_grant(), &[(&id(&["member", "a"]), &member)]),
            ),
            (
                "both",
                json!({"record": "both", "grant": pool_grant(), "people": [{"principal": "x", "key_blake3": grants().digest(&member).unwrap()}]}),
            ),
            (
                "loose",
                act_record(
                    json!({"tools": ["t"], "identity": "none", "journal": "none", "extra": true}),
                    &[("x", &member)],
                ),
            ),
            (
                "empty",
                act_record(
                    json!({"identity": "none", "journal": "none"}),
                    &[("x", &member)],
                ),
            ),
        ]);
        let reached: Vec<String> = grants()
            .acting(&records, &member)
            .into_iter()
            .map(|reach| reach.label)
            .collect();
        assert_eq!(reached, vec!["answers".to_owned(), "pool".to_owned()]);
        assert!(
            grants().acting(&records, &bearer(13)).is_empty(),
            "a bearer nobody named acts on nothing"
        );
        assert!(
            grants().reached(&records, &member).is_empty(),
            "an act grant is never a read share"
        );
    }

    #[test]
    fn a_share_never_grants_a_kind_that_stays_on_this_computer() {
        let member = bearer(51);
        let grant = |kind: &str| {
            json!({"records": {"rights": [{"kind": kind, "operations": [write_operation()],
            "prefix": id(&[kind, ""])}]}, "identity": "none", "journal": "none"})
        };
        let records = sharing(&[
            (
                "flagged",
                act_record(grant("kept-here"), &[("someone", &member)]),
            ),
            ("plain", act_record(grant(ANSWER), &[("someone", &member)])),
        ]);
        let reached = grants().acting(&records, &member);
        let rights_of = |shared: &str| {
            grants().rights_for(
                reached.iter().find(|reach| reach.label == shared).unwrap(),
                crate::record_model_policy::test_state(),
            )
        };
        assert_eq!(rights_of("flagged"), Err(crate::cause!(Refusal::NotGranted)));
        assert!(matches!(rights_of("plain"), Ok(Some(_))));
    }

    #[test]
    fn a_pool_grant_runs_only_its_tools_withholds_the_person_and_keeps_no_input_digest() {
        let member = bearer(21);
        let records = sharing(&[("pool", act_record(pool_grant(), &[("anyone-1", &member)]))]);
        let reach = grants().acting(&records, &member).pop().unwrap();
        assert!(
            reach.act.runs("add-a-result") && !reach.act.runs("read-every-result"),
            "an undeclared tool is refused"
        );
        assert_eq!(reach.act.identity(), Identity::Withheld);
        assert!(!reach.act.journals_input());
        assert_eq!(
            grants().rights_for(&reach, crate::record_model_policy::test_state()),
            Ok(None),
            "a pool grant reaches no records: a caller can't read rows"
        );
        let mut sent = json!({"tool": "add-a-result", "input": {"worked": 1}});
        sent["input"][grants().act.identity_field.as_str()] = json!("pretending-to-be-someone");
        let input = grants().tool_input(&reach, &sent).unwrap();
        assert_eq!(
            input["input"],
            json!({"worked": 1}),
            "the sharer's side learns nothing of who acts"
        );
        assert!(!input.to_string().contains("anyone-1"));
        // A withheld identity may not name the person anywhere in its rights.
        let marked =
            json!({"records": answers_grant()["records"], "identity": "none", "journal": "none"});
        let marked = grants()
            .acting(
                &sharing(&[("marked", act_record(marked, &[("anyone-1", &member)]))]),
                &member,
            )
            .pop()
            .unwrap();
        assert_eq!(
            grants().rights_for(&marked, crate::record_model_policy::test_state()),
            Err(crate::cause!(Refusal::NotGranted))
        );
    }

    #[test]
    fn an_answers_grant_writes_only_under_the_persons_own_prefix_and_names_them_there() {
        let (a, b) = (bearer(31), bearer(32));
        let records = sharing(&[(
            "answers",
            act_record(answers_grant(), &[("member-a", &a), ("member-b", &b)]),
        )]);
        let reach = grants().acting(&records, &a).pop().unwrap();
        assert_eq!(reach.act.identity(), Identity::Person);
        let rights = grants()
            .rights_for(&reach, crate::record_model_policy::test_state())
            .unwrap()
            .unwrap();
        let capability = mint(
            SHARER,
            b"sealed-sharer-key",
            rights,
            None,
            Duration::from_secs(60),
        )
        .unwrap();
        let run = held(capability.token().as_bytes()).unwrap().unwrap();
        let own = id(&[ANSWER, "c1", "member-a", "q1"]);
        assert!(run.narrow(&as_sharer(), &write(ANSWER, &own)).is_ok());
        let outside = [
            (ANSWER, id(&[ANSWER, "c1", "member-b", "q1"])),
            (ANSWER, id(&[ANSWER, "c1", "member-a"])),
            (ANSWER, id(&[ANSWER, "c2", "member-a", "q1"])),
            ("note", id(&["note", "member-a"])),
        ];
        for (kind, outside) in outside {
            assert!(
                run.narrow(&as_sharer(), &write(kind, &outside)).is_err(),
                "an undeclared prefix is refused: {outside}"
            );
        }
        let read = Operation {
            operation: Door::shipped().unwrap().read_operation().to_owned(),
            input: json!({"id": id(&[ANSWER, "c1", "member-b", "q1"])}),
            ..write(ANSWER, &own)
        };
        assert!(
            run.narrow(&as_sharer(), &read).is_err(),
            "a write grant reads nothing"
        );
        let input = grants()
            .tool_input(&reach, &json!({"tool": "t", "input": {}}))
            .unwrap();
        assert_eq!(
            input["input"][grants().act.identity_field.as_str()],
            "member-a"
        );
    }

    #[test]
    fn a_grant_acts_only_as_the_party_it_was_kept_for_and_only_while_it_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let vault = vault(&dir);
        let member = bearer(41);
        let kept = act_record(pool_grant(), &[("anyone-1", &member)]);
        let reach = || {
            grants()
                .acting(&sharing(&[("pool", kept.clone())]), &member)
                .pop()
                .unwrap()
        };
        assert_eq!(
            grants().kept_party(&vault, &reach()).err(),
            Some(crate::cause!(Refusal::NotGranted)),
            "never kept, it acts as no party"
        );
        assert_eq!(
            grants().keep(&vault, "pool", "party:sharer", &json!({"record": "pool"})),
            Err(crate::cause!(Refusal::Input))
        );
        grants().keep(&vault, "pool", "party:sharer", &kept).unwrap();
        assert_eq!(grants().kept_party(&vault, &reach()).unwrap(), "party:sharer");
        // An entry kept before act grants kept a party holds a key: it is no party.
        vault.put(&grants().vault_name("pool"), Zeroizing::new(json!({"key": "a-kept-key", "grant": kept["grant"]}).to_string())).unwrap();
        assert_eq!(grants().kept_party(&vault, &reach()).err(), Some(crate::cause!(Refusal::NotGranted)));
        grants().keep(&vault, "pool", "party:sharer", &kept).unwrap();
        // The record widened after the keep: it reaches nothing until it is kept again.
        let widened = act_record(
            json!({"tools": ["add-a-result", "how-similar-results-turned-out", "read-every-result"], "identity": "none", "journal": "none"}),
            &[("anyone-1", &member)],
        );
        let wider = grants()
            .acting(&sharing(&[("pool", widened)]), &member)
            .pop()
            .unwrap();
        assert_eq!(
            grants().kept_party(&vault, &wider).err(),
            Some(crate::cause!(Refusal::NotGranted))
        );
        // Taking the person out ends their calls; another person added reaches the same kept grant.
        assert!(grants()
            .acting(
                &sharing(&[("pool", act_record(pool_grant(), &[]))]),
                &member
            )
            .is_empty());
        assert_eq!(grants().withdraw(&vault, "pool"), Ok(true));
        assert_eq!(
            grants().kept_party(&vault, &reach()).err(),
            Some(crate::cause!(Refusal::NotGranted))
        );
        assert_eq!(
            grants().keep_asked(&json!({"label": "pool", "on": true})),
            Some(("pool", true))
        );
        assert_eq!(
            grants().keep_asked(&json!({"label": label("pool"), "on": true})),
            None,
            "a sharing record is never kept as a grant label"
        );
        assert_eq!(grants().keep_asked(&json!({"label": "pool"})), None);
        assert!(
            !format!("{:?}", reach()).contains("anyone-1"),
            "Debug never shows the person"
        );
    }

    #[test]
    fn a_public_answer_matches_old_trillion_for_the_same_synthetic_list() {
        // The record of old trillion's synthetic render (.git/scratch/share-baseline/render.mjs); the answer is old-trillion's
        // `old-answer.json` with the origin given here.
        let record = json!({"kind": "list", "title": "Synthetic week plan", "body": {
            "about": "A synthetic list used to compare pages.",
            "fields": [{"id": "day", "label": "Day", "kind": "date"}, {"id": "note", "label": "Note", "kind": "text"}],
            "rows": [
                {"id": "row-1", "title": "First synthetic row", "values": {"day": "2026-11-02", "note": "alpha"}},
                {"id": "row-2", "title": "Second synthetic row", "values": {"day": "2026-11-09", "note": "beta"}}],
            "files": []}});
        let answer = grants().public_answer(&record, "https://app.gettrillion.ai/share/synthetic-share-code-0001");
        assert_eq!(answer["changed"], "2026-11-09");
        assert_eq!(answer["rows"][0]["address"], "first-synthetic-row");
        assert_eq!(answer["rows"][0]["url"], "https://app.gettrillion.ai/share/synthetic-share-code-0001/first-synthetic-row");
        assert_eq!(answer["rows"][1]["address"], "second-synthetic-row");
        assert!(answer["rows"][0].get("changed").is_none(), "a row carries no changed day");
    }

    #[test]
    fn a_title_that_reads_as_a_code_or_repeats_gets_a_numbered_address() {
        let record = json!({"kind": "list", "title": "x", "body": {"fields": [], "rows": [
            {"id": "a", "title": "Same words", "values": {}},
            {"id": "b", "title": "Same words", "values": {}},
            {"id": "c", "title": "0123456789abcdef0123456789", "values": {}},
            {"id": "d", "title": "items", "values": {}}], "files": []}});
        let answer = grants().public_answer(&record, "https://x/share/c");
        assert_eq!(answer["rows"][0]["address"], "same-words");
        assert_eq!(answer["rows"][1]["address"], "same-words-2");
        assert_eq!(answer["rows"][2]["address"], "row");
        assert_eq!(answer["rows"][3]["address"], "items-row");
    }

}
