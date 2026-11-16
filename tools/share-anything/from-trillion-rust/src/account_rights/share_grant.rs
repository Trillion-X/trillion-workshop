// src/account_rights/share_grant.rs
//
// Purpose: A person's grant to someone else to read one of their records, honored on the person's own account routes. The grant
// lives in the sharer's own account as an ordinary workspace record (`<record_prefix><label>`, the setting
// share-grant.json `door_grant` beside this file): `{record, people: [{principal, key_blake3}], changed_at}`, kept by the sharer's
// client through the generic records write like any other record. `key_blake3` is the BLAKE3 of a bearer
// (`<token_prefix>` + 32 random bytes, base64url) the sharer hands the recipient; the recipient's engine presents it
// on the sharer's account routes to read that record. Nothing here names a record kind, a feature or a person.
//
// A share that lets its people act on the sharer's account routes (`Act`, the run grant: `grant` instead of `record`) returned
// to the engine (trillion-rust src/account_rights/share_grant.rs, its DATA src/account_rights/share-grant.json `act`, lane
// run-grant-at-the-owners-door), where the engine reads it from the sharer's vault alone and honors it in its check of who
// calls; the share bearer's sign-in and its bearer check (`principal`, `Authenticator`) returned with it. Its records
// operations (`rights_for`) have no home there, since the engine answers no records operation; they are in this file's
// history (trillion-workshop d6df86771) for the task that brings records back to the door. This file keeps the read
// shares, the reach shares and the public links, which read the sharer's records.
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
//
// Key Concepts:
// - `Collection`, `Read`, `Page` (reach.rs): a reach share a bearer reaches now, what one read of it came to, and its page.
// - `Grants`: the DATA (`door_grant`), read once per process.
// - `reached`: the labels a bearer reaches in the sharer's current sharing records.
// - `narrow`: the labels one call asks, or a refusal.
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

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use unicode_normalization::UnicodeNormalization;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

/// The trillion-local setting beside this owner: its `door_grant` block (moved from product/record-sharing.json, whose
/// record links left the engine with the decision screen that read them).
const DATA: &[u8] = include_bytes!("share-grant.json");
/// Random bytes in one bearer.
const TOKEN_BYTES: usize = 32;

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
        let answer = grants().public_answer(&record, "https://app.example.com/share/synthetic-share-code-0001");
        assert_eq!(answer["changed"], "2026-11-09");
        assert_eq!(answer["rows"][0]["address"], "first-synthetic-row");
        assert_eq!(answer["rows"][0]["url"], "https://app.example.com/share/synthetic-share-code-0001/first-synthetic-row");
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
