//! Bounded reverse reads over the existing declared-parts index. Ports old trillion
//! src/record-scope.mjs:770-823: candidate work is one indexed page with lookahead,
//! whole holders are the continuation unit, and model backfill remains explicit.
//! There is no execution-specific query, body scan, index mutation or receipt write.
//!
//! The index proposes; the current logical value decides. Local-only holders never
//! leave to remote readers, and erased/sealed-away links are checked after opening.
//! Cursors encrypt the physical continuation, since skipped holders may be private.
//! They are bound to the caller/account scope and the entire query, invalid after
//! process restart, and never grant access: all current read checks run on every page.
use super::{account_routes::value_json, list::OrderedSupply, read, Error, Limits, Result};
use crate::{
    mcp::InputFault, record_model_policy::Installed, storage::record_store::referrers::parts_of,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{collections::BTreeSet, sync::OnceLock};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    pub(super) operation: String,
    limit: usize,
    most: usize,
    cursor_bytes: usize,
    target_chars: usize,
}
impl Settings {
    pub(super) fn valid(&self) -> bool {
        !self.operation.is_empty()
            && self.limit > 0
            && self.limit <= self.most
            && self.most < crate::records::MAX_PAGE_ITEMS
            && self.cursor_bytes > 0
            && self.target_chars > 0
    }
}
pub(super) struct Input<'a> {
    id: &'a str,
    kind: Option<&'a str>,
    role: Option<&'a str>,
    limit: usize,
    after: Option<&'a str>,
}
pub(super) fn input<'a>(
    fields: &'a Map<String, Value>,
    settings: &Settings,
) -> std::result::Result<Input<'a>, InputFault> {
    super::account_routes::closed(fields, &["id", "type", "role", "limit", "after"])?;
    let id = super::account_routes::required_text(fields, "id")?;
    if id.encode_utf16().count() > settings.target_chars || id.contains('/') || id.contains('\0') {
        return Err(InputFault::new("id", "a canonical record identity"));
    }
    let after = super::account_routes::optional_text(fields, "after")?;
    if after.is_some_and(|after| after.len() > settings.cursor_bytes) {
        return Err(InputFault::new(
            "after",
            "this query's bounded continuation",
        ));
    }
    Ok(Input {
        id,
        kind: super::account_routes::optional_text(fields, "type")?,
        role: super::account_routes::optional_text(fields, "role")?,
        limit: super::account_routes::count_of(
            fields,
            "limit",
            settings.most,
            Some(settings.limit),
        )?,
        after,
    })
}

fn random(bytes: &mut [u8]) -> Result<()> {
    #[cfg(not(host = "module"))]
    {
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), bytes)
            .map_err(|error| crate::carry_cause!(Error::Source, error))
    }
    #[cfg(host = "module")]
    {
        crate::host_clock::fill_random(bytes);
        Ok(())
    }
}
fn cursor_key() -> Result<&'static Zeroizing<[u8; 32]>> {
    static KEY: OnceLock<std::result::Result<Zeroizing<[u8; 32]>, Error>> = OnceLock::new();
    let key = KEY
        .get_or_init(|| {
            let mut key = Zeroizing::new([0; 32]);
            random(key.as_mut())?;
            Ok(key)
        })
        .as_ref()
        .map_err(Clone::clone)?;
    Ok(key)
}
fn cipher() -> Result<XChaCha20Poly1305> {
    XChaCha20Poly1305::new_from_slice(cursor_key()?.as_ref()).map_err(|error| crate::carry_cause!(Error::Source, error))
}
fn cursor(after: &str, binding: &[u8]) -> Result<String> {
    // Deterministic only for the exact same plaintext and associated data, so retrying byte pages has one stable
    // identity. Different inputs derive independent 192-bit nonces under the process-local secret key.
    let mut hash = content_crypto::advanced::blake3::Hasher::new_keyed(cursor_key()?);
    hash.update(b"generic record participation continuation nonce\0");
    hash.update(&(binding.len() as u64).to_be_bytes())
        .update(binding)
        .update(&(after.len() as u64).to_be_bytes())
        .update(after.as_bytes());
    let mut nonce = [0; 24];
    nonce.copy_from_slice(&hash.finalize().as_bytes()[..24]);
    let encrypted = cipher()?
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: after.as_bytes(),
                aad: binding,
            },
        )
        .map_err(|error| crate::carry_cause!(Error::Source, error))?;
    Ok(URL_SAFE_NO_PAD.encode([nonce.as_slice(), encrypted.as_slice()].concat()))
}
fn resume(after: &str, binding: &[u8]) -> Result<String> {
    let bytes = URL_SAFE_NO_PAD.decode(after).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    if bytes.len() < 24 {
        return Err(crate::cause!(Error::Invalid));
    }
    let opened = Zeroizing::new(
        cipher()?
            .decrypt(
                XNonce::from_slice(&bytes[..24]),
                Payload {
                    msg: &bytes[24..],
                    aad: binding,
                },
            )
            .map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
    );
    String::from_utf8(opened.to_vec()).map_err(|error| crate::carry_cause!(Error::Invalid, error))
}
fn page(records: &[Value], next: Option<String>, complete: bool, first: bool) -> Value {
    json!({"records":records,"next":next,"coverage":{"index_complete":complete,
        "complete":complete && first && next.is_none(),"pagination":"live_index","consistent_snapshot":false}})
}

/// Read one candidate page under an already admitted ordinary own-record read scope.
/// Runs cannot call this operation until a run rule can cover target and holders.
pub(super) fn answer(
    fields: &Map<String, Value>,
    settings: &Settings,
    supply: &mut impl OrderedSupply,
    model: &Installed,
    limits: Limits,
    fits: &dyn Fn(&Value) -> bool,
    remote: bool,
    scope: &str,
) -> Result<Value> {
    answer_with_most(
        fields, settings, supply, model, limits, fits, remote, scope, None,
    )
}

/// A byte-paged answer carries one whole holder while retaining the caller's original query binding.
pub(super) fn answer_first(
    fields: &Map<String, Value>,
    settings: &Settings,
    supply: &mut impl OrderedSupply,
    model: &Installed,
    limits: Limits,
    remote: bool,
    scope: &str,
) -> Result<Value> {
    answer_with_most(
        fields,
        settings,
        supply,
        model,
        limits,
        &|_| true,
        remote,
        scope,
        Some(1),
    )
}
fn answer_with_most(
    fields: &Map<String, Value>,
    settings: &Settings,
    supply: &mut impl OrderedSupply,
    model: &Installed,
    limits: Limits,
    fits: &dyn Fn(&Value) -> bool,
    remote: bool,
    scope: &str,
    most: Option<usize>,
) -> Result<Value> {
    let asked = input(fields, settings)?;
    let most = most.unwrap_or(asked.limit).min(asked.limit);
    supply.assert_current()?;
    // The target and any declaration used to resolve its public address use the same read policy as holders.
    // A file identity is just an admitted reference key: this does not open a file or create file-read authority.
    let target = {
        let mut admitted = Target {
            supply,
            model,
            remote,
        };
        super::reference::canonical_lookup(asked.id, &mut admitted, model, limits)?
    };
    // A participant identity need not be an own-record id (for example immutable bytes or a future resource).
    // The ordinary read owner cannot hold a longer id; the admitted own-record root still bounds that lookup.
    if super::valid_id(&target) {
        let mut admitted = Target {
            supply,
            model,
            remote,
        };
        if super::Supply::stored(&mut admitted, &target)?.is_some() {
            let _ = read(&target, &mut admitted, model.open_policy(), limits)?;
        }
    }
    let binding = serde_json::to_vec(&json!([
        scope,
        settings.operation,
        asked.id,
        target,
        asked.kind,
        asked.role,
        asked.limit
    ]))
    .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let after = asked
        .after
        .map(|after| resume(after, &binding))
        .transpose()?;
    let candidates = supply.referrers(&target, asked.role, after.as_deref(), most + 1)?;
    let mut holders = Vec::new();
    let mut seen = BTreeSet::new();
    for candidate in candidates.referrers {
        if seen.insert(candidate.id.clone()) {
            holders.push(candidate.id);
        }
    }
    let mut records = Vec::new();
    let mut last = after.clone();
    let mut cut = false;
    for (position, id) in holders.iter().enumerate() {
        if position == most {
            cut = true;
            break;
        }
        // Do not open or disclose a holder of another requested kind or a kind confined to this computer.
        let stored = supply.stored(id)?;
        let candidate = match stored {
            Some(stored)
                if asked.kind.is_none_or(|kind| kind == stored.record_type)
                    && (!remote || !model.stays(&stored.record_type)) =>
            {
                let mut admitted = Target {
                    supply,
                    model,
                    remote,
                };
                let opened = match read(id, &mut admitted, model.open_policy(), limits) {
                    Err(Error::Invalid(_)) => None, // a confined shared dependency grants no holder participation
                    opened => opened?,
                };
                match opened {
                    Some(record) => {
                        if record.record_type() != stored.record_type
                            || asked.kind.is_some_and(|kind| kind != record.record_type())
                            || (remote && model.stays(record.record_type()))
                        {
                            return Err(crate::cause!(Error::Source));
                        }
                        let parts = parts_of(
                            model.referrer_parts(),
                            Some(record.record_type()),
                            &value_json(&record)?,
                        );
                        let via: Vec<Value> = parts
                            .into_iter()
                            .filter(|part| {
                                part.id == target && asked.role.is_none_or(|role| role == part.role)
                            })
                            .collect::<BTreeSet<_>>()
                            .into_iter()
                            .map(|part| json!({"role":part.role,"ordinal":part.ordinal}))
                            .collect();
                        (!via.is_empty())
                            .then(|| json!({"id":id,"type":record.record_type(),"via":via}))
                    }
                    None => None,
                }
            }
            _ => None,
        };
        if let Some(candidate) = candidate {
            records.push(candidate);
            // Reserve the actual continuation as well as the row. A byte cut never skips this holder.
            let next = cursor(id, &binding)?;
            if !fits(&page(
                &records,
                Some(next),
                candidates.complete,
                asked.after.is_none(),
            )) {
                records.pop();
                if records.is_empty() {
                    return Err(crate::cause!(Error::Bounds));
                }
                cut = true;
                break;
            }
        }
        last = Some(id.clone());
    }
    let continuation = if cut { last } else { candidates.next };
    let next = continuation
        .as_deref()
        .map(|last| cursor(last, &binding))
        .transpose()?;
    supply.assert_current()?;
    let answer = page(&records, next, candidates.complete, asked.after.is_none());
    if fits(&answer) {
        Ok(answer)
    } else {
        Err(crate::cause!(Error::Bounds))
    }
}

/// An address resolver may read one exact declaration. This wrapper applies the same remote-kind rule before
/// opening that declaration, so a private list cannot be used as an oracle for canonical row identities.
struct Target<'a, S> {
    supply: &'a mut S,
    model: &'a Installed,
    remote: bool,
}
impl<S: OrderedSupply> super::CurrentKeys for Target<'_, S> {
    fn assert_current(&mut self) -> Result<()> {
        self.supply.assert_current()
    }
    fn key(&mut self, id: &str) -> Result<super::KeyState> {
        self.supply.key(id)
    }
}
impl<S: OrderedSupply> super::Supply for Target<'_, S> {
    fn stored(&mut self, id: &str) -> Result<Option<crate::legacy_records::StoredRecord>> {
        let record = self.supply.stored(id)?;
        if self.remote
            && record
                .as_ref()
                .is_some_and(|record| self.model.stays(&record.record_type))
        {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record_value::{list::tests::Prefilled, CurrentIds, CurrentKeys, KeyState, Supply};

    struct Indexed {
        values: Prefilled,
        queries: Vec<(String, Option<String>, usize)>,
        omit_link: Option<String>,
        shared_link: Option<String>,
        changed_kind: Option<(String, usize)>,
    }
    impl CurrentKeys for Indexed {
        fn assert_current(&mut self) -> Result<()> {
            self.values.assert_current()
        }
        fn key(&mut self, id: &str) -> Result<KeyState> {
            self.values.key(id)
        }
    }
    impl Supply for Indexed {
        fn stored(&mut self, id: &str) -> Result<Option<crate::legacy_records::StoredRecord>> {
            let mut held = self.values.stored(id)?;
            if let Some((changed, count)) = self.changed_kind.as_mut() {
                if changed == id {
                    *count += 1;
                    if *count > 1 {
                        if let Some(held) = held.as_mut() {
                            held.record_type = "different-holder-kind".into();
                        }
                    }
                }
            }
            if self.shared_link.as_deref() == Some(id) {
                if let Some(held) = held.as_mut() {
                    held.value_json =
                        json!({"links":{super::super::SHARED_MARK:"private:dependency"}})
                            .to_string();
                }
            }
            if self.omit_link.as_deref() == Some(id) {
                if let Some(held) = held.as_mut() {
                    held.value_json = "{}".into();
                }
            }
            Ok(held)
        }
    }
    impl CurrentIds for Indexed {
        fn ids_of_type(
            &mut self,
            _: &str,
            _: Option<&str>,
            _: usize,
        ) -> Result<(Vec<String>, Option<String>)> {
            panic!("a reverse lookup must never scan a kind")
        }
    }
    impl OrderedSupply for Indexed {
        fn settings(&self) -> &'static crate::storage::record_store::settings::Settings {
            self.values.settings()
        }
        fn ordered(
            &mut self,
            _: &str,
            _: Option<&crate::storage::record_store::OrderCursor>,
            _: bool,
            _: usize,
        ) -> Result<crate::storage::record_store::Ordered> {
            panic!("a reverse lookup must not scan an order")
        }
        fn referrers(
            &mut self,
            target: &str,
            role: Option<&str>,
            after: Option<&str>,
            limit: usize,
        ) -> Result<crate::storage::record_store::referrers::Referrers> {
            self.queries
                .push((target.into(), role.map(str::to_owned), limit));
            self.values.referrers(target, role, after, limit)
        }
    }
    fn model() -> Installed {
        Installed::from_rows(&[json!({"record_model":{"reference_lookup":[{
            "pattern":"^(list:[^:]+):rows:(.+)$","declaration":"$1","row":"$2","join":":"
        }],"kinds":[
            {"type":"fixture-holder","stays_on_this_device":false,"parts":[{"role":"record_refs","path":["links","record_refs"]}]},
            {"type":"private-holder","stays_on_this_device":true,"parts":[{"role":"record_refs","path":["links","record_refs"]}]},
            {"type":"fixture-target","stays_on_this_device":false}
        ]}})],true).unwrap()
    }
    fn settings() -> Settings {
        serde_json::from_value::<Value>(
            serde_json::from_slice::<Value>(include_bytes!("records-routes.json")).unwrap()
                ["references"]
                .clone(),
        )
        .and_then(serde_json::from_value)
        .unwrap()
    }
    fn fixture(model: &Installed) -> Indexed {
        let mut values = Prefilled::new();
        values.set_model(model).unwrap();
        values.put(
            "fixture:target",
            "fixture-target",
            json!({"words":"source"}),
        );
        for (id, kind) in [
            ("a0-private-holder", "private-holder"),
            ("a1-visible", "fixture-holder"),
            ("a2-missing", "fixture-holder"),
            ("a3-visible", "fixture-holder"),
        ] {
            values.put(
                id,
                kind,
                json!({"links":{"record_refs":["fixture:target"]}}),
            );
        }
        values.hide("a2-missing");
        Indexed {
            values,
            queries: Vec::new(),
            omit_link: None,
            shared_link: None,
            changed_kind: None,
        }
    }
    fn ask(values: &mut Indexed, model: &Installed, input: Value, scope: &str) -> Result<Value> {
        answer(
            input.as_object().unwrap(),
            &settings(),
            values,
            model,
            Limits::default(),
            &|_| true,
            true,
            scope,
        )
    }
    #[test]
    fn reverse_read_uses_one_bounded_page_and_hides_private_missing_and_erased_links() {
        let model = model();
        let mut values = fixture(&model);
        values.omit_link = Some("a3-visible".into());
        let answer = ask(
            &mut values,
            &model,
            json!({"id":"fixture:target","role":"record_refs","limit":9}),
            "account:caller",
        )
        .unwrap();
        assert_eq!(
            answer["records"],
            json!([{"id":"a1-visible","type":"fixture-holder","via":[{"role":"record_refs","ordinal":0}]}])
        );
        assert!(!answer.to_string().contains("private-holder"));
        assert!(!answer.to_string().contains("examined"));
        assert_eq!(
            values.queries,
            [("fixture:target".into(), Some("record_refs".into()), 10)]
        );
        assert_eq!(answer["next"], Value::Null);
        assert_eq!(answer["coverage"]["complete"], true);
    }
    #[test]
    fn private_page_continuations_are_opaque_query_and_caller_bound_and_make_progress() {
        let model = model();
        let mut values = fixture(&model);
        let input = json!({"id":"fixture:target","role":"record_refs","limit":1});
        let first = ask(&mut values, &model, input.clone(), "account:caller").unwrap();
        assert_eq!(first["records"], json!([]));
        let token = first["next"].as_str().unwrap();
        let raw = URL_SAFE_NO_PAD.decode(token).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("a0-private-holder"));
        let mut resumed = input.clone();
        resumed["after"] = json!(token);
        let second = ask(&mut values, &model, resumed.clone(), "account:caller").unwrap();
        assert_eq!(second["records"][0]["id"], "a1-visible");
        for (field, value) in [
            ("id", json!("different:target")),
            ("type", json!("fixture-holder")),
            ("role", json!("other")),
            ("limit", json!(2)),
        ] {
            let mut changed = resumed.clone();
            changed[field] = value;
            assert_eq!(
                ask(&mut values, &model, changed, "account:caller"),
                Err(crate::cause!(Error::Invalid))
            );
        }
        assert_eq!(
            ask(&mut values, &model, resumed, "another:caller"),
            Err(crate::cause!(Error::Invalid))
        );
        let mut found = vec!["a1-visible".to_string()];
        let mut next = second["next"].as_str().map(str::to_owned);
        for _ in 0..4 {
            let Some(token) = next else { break };
            let mut query = input.clone();
            query["after"] = json!(token);
            let page = ask(&mut values, &model, query, "account:caller").unwrap();
            found.extend(
                page["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| r["id"].as_str().unwrap().to_owned()),
            );
            next = page["next"].as_str().map(str::to_owned);
        }
        assert_eq!(found, ["a1-visible", "a3-visible"]);
        assert!(next.is_none());
    }
    #[test]
    fn private_target_and_private_alias_declaration_refuse_before_index_read() {
        let model = model();
        let mut values = fixture(&model);
        values
            .values
            .put("private:target", "private-holder", json!({}));
        assert_eq!(
            ask(&mut values, &model, json!({"id":"private:target"}), "scope"),
            Err(crate::cause!(Error::Invalid))
        );
        values.values.put(
            "list:private",
            "private-holder",
            json!({"row_type":"fixture-holder"}),
        );
        assert_eq!(
            ask(
                &mut values,
                &model,
                json!({"id":"list:private:rows:one"}),
                "scope"
            ),
            Err(crate::cause!(Error::Invalid))
        );
        assert!(values.queries.is_empty());
    }
    #[test]
    fn parts_added_after_rows_report_incomplete_without_writing_during_inspection() {
        let model = model();
        let mut values = Prefilled::new();
        values.put(
            "old",
            "fixture-holder",
            json!({"links":{"record_refs":["fixture:target"]}}),
        );
        values.set_model(&model).unwrap();
        let mut values = Indexed {
            values,
            queries: Vec::new(),
            omit_link: None,
            shared_link: None,
            changed_kind: None,
        };
        let before = values.values.store.stamp("account", "own-records").unwrap();
        let page = ask(&mut values, &model, json!({"id":"fixture:target"}), "scope").unwrap();
        assert_eq!(page["coverage"]["index_complete"], false);
        assert_eq!(page["coverage"]["complete"], false);
        assert_eq!(
            values.values.store.stamp("account", "own-records").unwrap(),
            before
        );
    }
    #[test]
    fn remote_participation_cannot_come_from_a_confined_shared_dependency_or_changed_kind() {
        let model = model();
        let mut values = fixture(&model);
        values.values.put(
            "private:dependency",
            "private-holder",
            json!({"record_refs":["fixture:target"]}),
        );
        values.shared_link = Some("a3-visible".into());
        let page = ask(
            &mut values,
            &model,
            json!({"id":"fixture:target","role":"record_refs"}),
            "scope",
        )
        .unwrap();
        assert_eq!(page["records"].as_array().unwrap().len(), 1);
        assert_eq!(page["records"][0]["id"], "a1-visible");
        assert!(!page.to_string().contains("private:dependency"));
        let mut values = fixture(&model);
        values.changed_kind = Some(("a1-visible".into(), 0));
        assert_eq!(
            ask(&mut values, &model, json!({"id":"fixture:target"}), "scope"),
            Err(crate::cause!(Error::Source))
        );
    }

    #[test]
    fn byte_pages_keep_stable_identity_and_the_original_query_continuation() {
        let model = model();
        let mut values = Prefilled::new();
        values.set_model(&model).unwrap();
        let repeated = vec!["fixture:target"; 300];
        values.put(
            "a-first",
            "fixture-holder",
            json!({"links":{"record_refs":repeated}}),
        );
        values.put(
            "b-next",
            "fixture-holder",
            json!({"links":{"record_refs":["fixture:target"]}}),
        );
        let door = crate::record_value::account_routes::Door::shipped().unwrap();
        let mut query = json!({"id":"fixture:target","role":"record_refs","limit":3});
        let fits = |value: &Value| value.to_string().len() <= 800;
        let mut bytes = Vec::new();
        let mut identity = None;
        let mut offset = 0;
        loop {
            if offset > 0 {
                query["after_byte"] = json!(offset);
            }
            let part = door
                .answer_scoped(
                    door.references_operation(),
                    &query,
                    &mut values,
                    &model,
                    Limits::default(),
                    &fits,
                    true,
                    "account:reader",
                )
                .unwrap();
            let part = &part["byte_page"];
            assert_eq!(part["offset"], offset);
            let stamp = (part["blake3"].clone(), part["total"].clone());
            if let Some(ref expected) = identity {
                assert_eq!(&stamp, expected);
            } else {
                identity = Some(stamp);
            }
            bytes.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(part["base64"].as_str().unwrap())
                    .unwrap(),
            );
            match part["next_after_byte"].as_u64() {
                Some(next) => {
                    assert!(next > offset);
                    offset = next;
                }
                None => break,
            }
        }
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(page["records"][0]["id"], "a-first");
        assert_eq!(page["records"].as_array().unwrap().len(), 1);
        query.as_object_mut().unwrap().remove("after_byte");
        query["after"] = page["next"].clone();
        let next = door
            .answer_scoped(
                door.references_operation(),
                &query,
                &mut values,
                &model,
                Limits::default(),
                &|_| true,
                true,
                "account:reader",
            )
            .unwrap();
        assert_eq!(next["records"][0]["id"], "b-next");
    }

    #[test]
    fn long_future_reference_keys_remain_indexed_identities_without_becoming_record_reads() {
        let model = model();
        let mut values = fixture(&model);
        let target = format!("future-resource:{}", "x".repeat(5000));
        values.values.put(
            "long-key-holder",
            "fixture-holder",
            json!({"links":{"record_refs":[target]}}),
        );
        let page = ask(
            &mut values,
            &model,
            json!({"id":target,"role":"record_refs"}),
            "scope",
        )
        .unwrap();
        assert_eq!(page["records"][0]["id"], "long-key-holder");
        assert_eq!(values.queries.len(), 1);
    }
}
