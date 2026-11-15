//! Automatic computer enrollment through the retained own browser and Mac key.
//! Original device rows stay in APP_KV; a public prepared/published enrollment record in
//! the original policy directory recovers uncertain writes. The credential has
//! one home in secrets before private native-pipe delivery. Revocation,
//! missing published rows and removal of the held secret never mint another.
use super::*;
use crate::{
    account::{self, SecretNativeKey, SecretResourceKey},
    account_rights::resource_connection::{self, Change},
    storage::{self, sqlite, Intent, Read as Field, Scope, Storage, Value as Stored, When},
};
use content_crypto::advanced::blake3;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::{
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: String,
    account: String,
    native_key: String,
    device: String,
    held: String,
    created_at: String,
    generation: u64,
    published: bool,
}
fn enrollment_version() -> AccountResult<String> {
    Ok(format!("{}.native-computer-enrollment/v1", crate::account_files::identity::word().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?))
}
/// The key of the app that runs this engine, which a computer key is enrolled under, must be live in the account's own sign-in, and the channel's
/// session current.
fn same_key(owner: &mut LocalAccount, session: &str, key: &SecretNativeKey) -> AccountResult<()> {
    account::native_parent_key_current(owner, &key.identity())?;
    account::current_browser(owner, session)?;
    Ok(())
}
fn receipt(store: &dyn Storage, name: &str) -> AccountResult<Option<Receipt>> {
    store
        .get(
            "policy_directory",
            &[Stored::from(name)],
            &[Field::at_most("value", 8192)],
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?
        .map(|mut row| match row.take(0) {
            Stored::Text(text) => serde_json::from_str(&text).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error)),
            _ => Err(crate::cause!(AccountError::SourceUnavailable)),
        })
        .transpose()
}
fn check_receipt(
    r: &Receipt,
    account: &AccountIdentity,
    key: &SecretNativeKey,
    held: &str,
    generation: u64,
) -> AccountResult<()> {
    if r.version != enrollment_version()?
        || r.account != account.owner_id
        || r.native_key != key.identity()
        || r.held != held
        || r.generation != generation
        || !hex(&r.device, 64)
        || chrono::DateTime::parse_from_rfc3339(&r.created_at).is_err()
    {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    Ok(())
}
/// The record names of every computer enrollment (`native-computer-enrollment:<identity>`).
const RECEIPT_PREFIX: &str = "native-computer-enrollment:";
/// The most enrollment records read for one account state: one per key the app was ever issued there.
const MAX_ENROLLED: usize = 256;

/// The identity of the enrollment of the app key `native_key` (its identity) for the account `owner` in the state
/// `state`: its enrollment record is named `RECEIPT_PREFIX` + this, and its held computer key `native-resource-` + this.
fn enrollment_identity(owner: &str, state: &str, native_key: &str) -> AccountResult<String> {
    Ok(blake3::hash(&serde_json::to_vec(&[owner, state, native_key]).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?).to_hex().to_string())
}
/// The devices the enrollment records `named` ({record name, record}) name for the account `owner` in the state `state`, in
/// record order. Only a record whose own name is the enrollment identity of this owner, this state and its app key
/// was written by an enrollment of this state; one that does not parse, names another account, or was enrolled by
/// another state (a copy of this one, carried rows) names nothing.
fn devices_of(named: &[(String, String)], owner: &str, state: &str) -> Vec<String> {
    named.iter()
        .filter_map(|(name, text)| Some((name, serde_json::from_str::<Receipt>(text).ok()?)))
        .filter(|(name, receipt)| receipt.account == owner && hex(&receipt.device, 64)
            && enrollment_identity(owner, state, &receipt.native_key)
                .is_ok_and(|identity| **name == format!("{RECEIPT_PREFIX}{identity}")))
        .map(|(_, receipt)| receipt.device)
        .collect()
}
impl LocalAccount {
    /// Every device the hosting app's account enrolled in this state (its enrollment records, one per key the app
    /// was issued here): the earlier ids of this computer, which its tell may move the account's computers
    /// row from (`computers::told`).
    pub(crate) fn enrolled_devices(&mut self) -> AccountResult<Vec<String>> {
        let tx = self.source.policy.transaction()?;
        let store = sqlite::lend(&tx, "account_policy", sqlite::Access::Read).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let mut range = storage::Range::prefix(RECEIPT_PREFIX);
        range.limit = Some(MAX_ENROLLED);
        let rows = store.scan("policy_directory", &range, &[Field::at_most("name", 256), Field::at_most("value", 8192)])
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        drop(store);
        tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let named = rows.into_iter()
            .map(|mut row| match (row.take(0), row.take(1)) {
                (Stored::Text(name), Stored::Text(text)) => Ok((name, text)),
                _ => Err(crate::cause!(AccountError::SourceUnavailable)),
            })
            .collect::<AccountResult<Vec<(String, String)>>>()?;
        Ok(devices_of(&named, &self.source.account.owner_id, &self.source.state_identity))
    }
    fn enrollment_store(&self) -> AccountResult<sqlite::Supply<sqlite::Handle>> {
        self.assert_owned()?;
        sqlite::open_selected(
            &self.source.policy.path,
            "account_policy",
            sqlite::Selected {
                access: sqlite::Access::Write,
                trusted_schema: false,
                meter: Some(self.source.sql_work.clone()),
                bounds: sqlite::Bounds {
                    value_bytes: MAX_JSON,
                    work: 200_000,
                    deadline: Duration::from_secs(5),
                    spend: sqlite::Spend::WholeHandle,
                    cancel: None,
                    busy: Duration::ZERO,
                },
            },
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))
    }
    fn keep_enrollment_receipt(
        &mut self,
        session: &str,
        key: &SecretNativeKey,
        name: &str,
        expected: Option<&Receipt>,
        value: &Receipt,
        source: &dyn Fn() -> AccountResult<()>,
    ) -> AccountResult<()> {
        source()?;
        same_key(self, session, key)?;
        let store = self.enrollment_store()?;
        let tx = Scope::begin(&store, Intent::Write).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if receipt(&*tx, name)?.as_ref() != expected {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        tx.put(
            "policy_directory",
            &[
                ("name", Stored::from(name)),
                (
                    "value",
                    Stored::Text(serde_json::to_string(value).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?),
                ),
            ],
            When::Always,
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        same_key(self, session, key)?;
        source()?;
        tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        self.assert_owned()
    }
    pub(crate) fn enroll_native_resource_key(
        &mut self,
        session: &str,
        key: &SecretNativeKey,
        source: &dyn Fn() -> AccountResult<()>,
    ) -> AccountResult<Option<SecretResourceKey>> {
        source()?;
        same_key(self, session, key)?;
        let vault = crate::secrets::open_home(
            &self.source.selected.root,
            &self.source.account.owner_id,
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        self.enroll_native_resource_key_with_vault(session, key, source, &*vault)
    }
    pub(crate) fn enroll_native_resource_key_with_vault<S: Storage + Send>(
        &mut self,
        session: &str,
        key: &SecretNativeKey,
        source: &dyn Fn() -> AccountResult<()>,
        vault: &crate::secrets::Secrets<S>,
    ) -> AccountResult<Option<SecretResourceKey>> {
        source()?;
        same_key(self, session, key)?;
        let now = self.source.clock()?;
        let account = self.source.account.clone();
        let generation = u64::try_from(
            self.original_workspace_generation()
                .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?,
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let native_key = key.identity();
        let identity = enrollment_identity(&account.owner_id, &self.source.state_identity, &native_key)?;
        let name = format!("{RECEIPT_PREFIX}{identity}");
        let held_name = format!("native-resource-{identity}");
        let old = {
            let tx = self.source.policy.transaction()?;
            let store =
                sqlite::lend(&tx, "account_policy", sqlite::Access::Read).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            let value = receipt(&store, &name)?;
            drop(store);
            tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            value
        };
        let raw = match vault.plain(&held_name) {
            Ok(raw) => raw,
            Err(crate::secrets::Error::NotHeld(_, _)) if old.is_none() => {
                let mut bytes = Zeroizing::new([0u8; 32]);
                SystemRandom::new().fill(bytes.as_mut()).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
                let mut text = Zeroizing::new(String::from("tc_"));
                for byte in bytes.iter() {
                    use std::fmt::Write as _;
                    write!(&mut *text, "{byte:02x}").map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
                }
                vault.create_if_absent(&held_name, text).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
                vault.plain(&held_name).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?
            }
            Err(_) => return Err(crate::cause!(AccountError::KeyWithdrawn)),
        };
        let resource = SecretResourceKey::parse(raw)?;
        let prepared = if let Some(old) = old.as_ref() {
            check_receipt(old, &account, key, &held_name, generation)?;
            if old.device != resource.identity() {
                return Err(crate::cause!(AccountError::KeyWithdrawn));
            }
            old.clone()
        } else {
            let r = Receipt {
                version: enrollment_version()?,
                account: account.owner_id.clone(),
                native_key,
                device: resource.identity(),
                held: held_name,
                created_at: chrono::DateTime::from_timestamp_millis(now as i64)
                    .ok_or(crate::cause!(AccountError::SourceUnavailable))?
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                generation,
                published: false,
            };
            self.keep_enrollment_receipt(session, key, &name, None, &r, source)?;
            r
        };
        let device_key = format!("device-key:{}", prepared.device);
        let user_key = format!("user-device:{}:{}", account.user_id, prepared.device);
        let revoked = format!("native-device-revoked:{}", prepared.device);
        if self.source.read_kv(&revoked, now)?.is_some() {
            return Err(crate::cause!(AccountError::KeyWithdrawn));
        }
        let mut device_name = crate::account_files::identity::word().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?.to_owned();
        if let Some(first) = device_name.get_mut(..1) { first.make_ascii_uppercase(); }
        device_name.push_str(" on this Mac");
        let device = json!({"userId":account.user_id,"name":&device_name,"created_at":prepared.created_at,"native_key_id":prepared.native_key});
        let listed = json!({"name":&device_name,"ending":&resource.text()[resource.text().len()-4..],"created_at":prepared.created_at,"native_key_id":prepared.native_key});
        for (key, expected) in [(&device_key, &device), (&user_key, &listed)] {
            let saved = self.source.read_kv(key, now)?;
            if saved.as_ref().is_some_and(|value| value != expected)
                || (prepared.published && saved.is_none())
            {
                return Err(crate::cause!(AccountError::KeyWithdrawn));
            }
        }
        if !prepared.published {
            let kv = sqlite::open_selected(
                &self.source.kv.path,
                "original_app_kv",
                sqlite::Selected {
                    access: sqlite::Access::Write,
                    trusted_schema: false,
                    meter: Some(self.source.sql_work.clone()),
                    bounds: sqlite::Bounds {
                        value_bytes: MAX_JSON,
                        work: 100_000,
                        deadline: Duration::from_secs(5),
                        spend: sqlite::Spend::WholeHandle,
                        cancel: None,
                        busy: Duration::ZERO,
                    },
                },
            )
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            let tx = Scope::begin(&kv, Intent::Write).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            if storage::original_kv::read(&*tx, &self.source.blob_root, &revoked, now)
                .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?
                .is_some()
            {
                return Err(crate::cause!(AccountError::KeyWithdrawn));
            }
            for (key, value) in [(&device_key, &device), (&user_key, &listed)] {
                let bytes = serde_json::to_vec(value).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
                storage::original_kv::keep_public(&*tx, &self.source.blob_root, key, &bytes, now)
                    .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            }
            same_key(self, session, key)?;
            source()?;
            tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        }
        same_key(self, session, key)?;
        source()?;
        let current = {
            let tx = self.source.policy.transaction()?;
            let store =
                sqlite::lend(&tx, "account_policy", sqlite::Access::Read).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            let row =
                resource_connection::current(&store, &account, &prepared.device, "@own-records")
                    .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            drop(store);
            tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            row
        };
        match current {
            Some(ref row) if !row.active || row.resource_generation != generation => {
                return Err(crate::cause!(AccountError::KeyWithdrawn))
            }
            Some(_) => {}
            None if prepared.published => return Err(crate::cause!(AccountError::KeyWithdrawn)),
            None => {
                let change = Change {
                    device_id: prepared.device.clone(),
                    resource_address: "@own-records".into(),
                    resource_generation: generation,
                    expected_registration_revision: 0,
                    active: true,
                    request_key: format!("native-enroll:{identity}"),
                };
                self.change_resource_connection(
                    session,
                    &change,
                    Instant::now() + Duration::from_secs(5),
                    Arc::new(AtomicBool::new(false)),
                    &|| source().map_err(|error| crate::carry_cause!(crate::account_rights::Error::SourceChanged, error)),
                )
                .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            }
        }
        if !prepared.published {
            let mut published = prepared.clone();
            published.published = true;
            self.keep_enrollment_receipt(session, key, &name, Some(&prepared), &published, source)?;
        }
        let now = self.source.clock()?;
        self.resource_connection_for_key(resource.text().as_bytes(), now)?;
        same_key(self, session, key)?;
        source()?;
        Ok(Some(resource))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One enrollment record as an enrollment of `state` writes it: named by the identity of `owner`, `state` and its app key.
    fn receipt(owner: &str, state: &str, native_key: &str, device: &str) -> (String, String) {
        let name = format!("{RECEIPT_PREFIX}{}", enrollment_identity(owner, state, native_key).unwrap());
        let value = serde_json::to_string(&Receipt {
            version: "synthetic.native-computer-enrollment/v1".into(), account: owner.into(),
            native_key: native_key.into(), device: device.into(), held: "native-resource-synthetic".into(),
            created_at: "2026-11-03T12:00:00.000Z".into(), generation: 1, published: true,
        }).unwrap();
        (name, value)
    }

    #[test]
    fn the_enrolled_devices_are_this_states_own_receipts_only() {
        let (owner, other) = ("a".repeat(64), "b".repeat(64));
        let (state, copy) = ("5".repeat(64), "6".repeat(64));
        let (first, second) = ("e".repeat(64), "f".repeat(64));
        let mut renamed = receipt(&owner, &state, &first, &"7".repeat(64));
        renamed.0 = format!("{RECEIPT_PREFIX}{}", "0".repeat(64));
        let named = vec![
            receipt(&owner, &state, &first, &"1".repeat(64)),
            receipt(&other, &state, &first, &"2".repeat(64)),
            // Enrolled by another state of the same account (a copy): its device is not this state's computer.
            receipt(&owner, &copy, &second, &"4".repeat(64)),
            receipt(&owner, &state, &first, "not-a-device"),
            (format!("{RECEIPT_PREFIX}{}", "9".repeat(64)), "not a receipt".to_owned()),
            renamed,
            receipt(&owner, &state, &second, &"3".repeat(64)),
        ];
        assert_eq!(devices_of(&named, &owner, &state), vec!["1".repeat(64), "3".repeat(64)]);
        assert_eq!(devices_of(&named, &owner, &copy), vec!["4".repeat(64)], "the copy has only its own");
    }
}
