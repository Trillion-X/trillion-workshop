//! Device hosting registration in the existing canonical policy directory.
//! A computer credential alone never authorizes hosting. The original account
//! management owner must admit the exact change and actual resource generation.
//! This module issues no key, opens no database and creates no new auth store.
pub(crate) mod credential;
use super::{
    canonical_account, physical, put, read, AccountIdentity, CanonicalPolicyOwner, Error, Result,
    MAX_SAFE,
};
use crate::{
    resource_authority::Route,
    storage::{Intent, Scope, Storage},
};
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};

const VERSION: &str = "trillion.resource-connection-registration/v1";
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn resource(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

/// Independent authority for one complete logical history. This is held in
/// the existing canonical policy directory and contains no supply, path or
/// location. Restoring record bytes cannot restore a retired physical token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeRegistration {
    version: String,
    account: String,
    pub history: crate::storage::record_store_resources::domains::Identity,
    pub revision: u64,
    pub current_incarnation: String,
    pub staged: Option<NativeTransfer>,
    created_by: String,
    last_request: String,
    last_identity: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeTransfer {
    pub move_id: String,
    pub source_incarnation: String,
    pub target_incarnation: String,
    pub activated: bool,
}
pub trait NativeRegistrationOwner: CanonicalPolicyOwner {
    /// The native source owner must recheck its non-forgeable sealed-source
    /// proof against this exact history and transfer, not an arbitrary move.
    fn assert_native_seal(
        &mut self,
        history: &crate::storage::record_store_resources::domains::Identity,
        transfer: &NativeTransfer,
    ) -> Result<()>;
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "change", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeChange {
    Enroll {
        request_key: String,
    },
    Prepare {
        request_key: String,
        expected_revision: u64,
        source_incarnation: String,
        move_id: String,
    },
    Activate {
        request_key: String,
        expected_revision: u64,
        move_id: String,
    },
}
impl NativeChange {
    pub fn request_key(&self) -> &str {
        match self {
            Self::Enroll { request_key }
            | Self::Prepare { request_key, .. }
            | Self::Activate { request_key, .. } => request_key,
        }
    }
    pub fn identity(
        &self,
        history: &crate::storage::record_store_resources::domains::Identity,
    ) -> Result<String> {
        native_key(history)?;
        if !resource(self.request_key()) {
            return Err(crate::cause!(Error::Invalid));
        }
        match self {
            Self::Prepare {
                expected_revision,
                source_incarnation,
                move_id,
                ..
            } => {
                if *expected_revision == 0
                    || *expected_revision >= MAX_SAFE
                    || !resource(source_incarnation)
                    || !resource(move_id)
                {
                    return Err(crate::cause!(Error::Invalid));
                }
            }
            Self::Activate {
                expected_revision,
                move_id,
                ..
            } => {
                if *expected_revision == 0 || *expected_revision >= MAX_SAFE || !resource(move_id) {
                    return Err(crate::cause!(Error::Invalid));
                }
            }
            Self::Enroll { .. } => {}
        }
        Ok(blake3::hash(
            &serde_json::to_vec(&("native-resource-authority/v1", history, self))
                .map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
        )
        .to_hex()
        .to_string())
    }
}
fn native_key(
    history: &crate::storage::record_store_resources::domains::Identity,
) -> Result<String> {
    if !resource(&history.id)
        || !resource(&history.incarnation)
        || !(1..=MAX_SAFE as i64).contains(&history.generation)
    {
        return Err(crate::cause!(Error::Invalid));
    }
    Ok(format!(
        "native-resource-incarnation:{}",
        blake3::hash(&serde_json::to_vec(history).map_err(|error| crate::carry_cause!(Error::Invalid, error))?).to_hex()
    ))
}
fn native_stored(
    store: &dyn Storage,
    account: &AccountIdentity,
    history: &crate::storage::record_store_resources::domains::Identity,
) -> Result<Option<NativeRegistration>> {
    let value = read(store, &native_key(history)?)?;
    if value.is_null() {
        return Ok(None);
    }
    let registration: NativeRegistration =
        serde_json::from_value(value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if registration.version != "native-resource-authority/v1"
        || registration.account != account.owner_id
        || registration.history != *history
        || registration.revision == 0
        || registration.revision > MAX_SAFE
        || !resource(&registration.current_incarnation)
        || !resource(&registration.created_by)
        || !resource(&registration.last_request)
        || !digest(&registration.last_identity)
        || registration.staged.as_ref().is_some_and(|stage| {
            !resource(&stage.move_id)
                || !resource(&stage.source_incarnation)
                || !resource(&stage.target_incarnation)
                || stage.source_incarnation == stage.target_incarnation
                || registration.current_incarnation
                    != if stage.activated {
                        stage.target_incarnation.as_str()
                    } else {
                        stage.source_incarnation.as_str()
                    }
        })
    {
        return Err(crate::cause!(Error::NotCanonical));
    }
    Ok(Some(registration))
}

/// Fresh independent authority metadata. The actual native source owner must
/// retain its source and admission custody; this grants no record permission.
pub fn native_current(
    store: &dyn Storage,
    owner: &mut impl CanonicalPolicyOwner,
    account: &AccountIdentity,
    history: &crate::storage::record_store_resources::domains::Identity,
) -> Result<Option<NativeRegistration>> {
    owner.assert_current(account, store)?;
    physical(store)?;
    let tx = Scope::begin(store, Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    available(&*tx, account)?;
    let registration = native_stored(&*tx, account, history)?;
    owner.assert_current(account, &*tx)?;
    physical(&*tx)?;
    tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok(registration)
}

/// Read-only evidence for an already retained original native source. Like
/// `current`, this never grants operation or management rights. The caller
/// must retain and recheck original source ownership at the physical hold.
pub(crate) fn native_observe(
    store: &dyn Storage,
    account: &AccountIdentity,
    history: &crate::storage::record_store_resources::domains::Identity,
) -> Result<Option<NativeRegistration>> {
    physical(store)?;
    let tx = Scope::begin(store, Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    available(&*tx, account)?;
    let registration = native_stored(&*tx, account, history)?;
    physical(&*tx)?;
    tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok(registration)
}

/// Mutate only behind the real native gate's drained control. The owner must
/// prove the retained command admission and (for Activate) the exact durable
/// source seal before calling this operation. It never deletes source bytes.
pub fn native_change(
    store: &dyn Storage,
    owner: &mut impl NativeRegistrationOwner,
    account: &AccountIdentity,
    history: &crate::storage::record_store_resources::domains::Identity,
    change: &NativeChange,
) -> Result<NativeRegistration> {
    let identity = change.identity(history)?;
    owner.assert_current(account, store)?;
    owner.assert_management_admission(account, change.request_key(), &identity)?;
    physical(store)?;
    if store.scoped() {
        return Err(crate::cause!(Error::SourceChanged));
    }
    let tx = Scope::begin(store, Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    available(&*tx, account)?;
    let previous = native_stored(&*tx, account, history)?;
    let result = if let Some(prior) = previous
        .as_ref()
        .filter(|prior| prior.last_request == change.request_key())
    {
        if prior.last_identity != identity {
            return Err(crate::cause!(Error::DifferentChange));
        }
        prior.clone()
    } else {
        let mut next = match change {
            NativeChange::Enroll { request_key } => {
                if previous.is_some() {
                    return Err(crate::cause!(Error::SourceChanged));
                }
                NativeRegistration {
                    version: "native-resource-authority/v1".into(),
                    account: account.owner_id.clone(),
                    history: history.clone(),
                    revision: 1,
                    current_incarnation: format!(
                        "incarnation:{}",
                        blake3::hash(
                            &serde_json::to_vec(&(&account.owner_id, history, &identity))
                                .map_err(|error| crate::carry_cause!(Error::Invalid, error))?
                        )
                        .to_hex()
                    ),
                    staged: None,
                    created_by: request_key.clone(),
                    last_request: String::new(),
                    last_identity: String::new(),
                }
            }
            NativeChange::Prepare {
                expected_revision,
                source_incarnation,
                move_id,
                ..
            } => {
                let mut prior = previous.ok_or(crate::cause!(Error::NotCanonical))?;
                if prior.revision != *expected_revision
                    || prior.current_incarnation != *source_incarnation
                    || prior.staged.as_ref().is_some_and(|stage| !stage.activated)
                {
                    return Err(crate::cause!(Error::SourceChanged));
                }
                let target = format!(
                    "incarnation:{}",
                    blake3::hash(
                        &serde_json::to_vec(&(
                            &account.owner_id,
                            history,
                            prior.revision,
                            &identity
                        ))
                        .map_err(|error| crate::carry_cause!(Error::Invalid, error))?
                    )
                    .to_hex()
                );
                prior.staged = Some(NativeTransfer {
                    move_id: move_id.clone(),
                    source_incarnation: source_incarnation.clone(),
                    target_incarnation: target,
                    activated: false,
                });
                prior.revision += 1;
                prior
            }
            NativeChange::Activate {
                expected_revision,
                move_id,
                ..
            } => {
                let mut prior = previous.ok_or(crate::cause!(Error::NotCanonical))?;
                if prior.revision != *expected_revision {
                    return Err(crate::cause!(Error::SourceChanged));
                }
                let stage = prior.staged.as_mut().ok_or(crate::cause!(Error::SourceChanged))?;
                if stage.move_id != *move_id || stage.activated {
                    return Err(crate::cause!(Error::SourceChanged));
                }
                owner.assert_native_seal(history, stage)?;
                stage.activated = true;
                prior.current_incarnation = stage.target_incarnation.clone();
                prior.revision += 1;
                prior
            }
        };
        next.last_request = change.request_key().into();
        next.last_identity = identity.clone();
        put(
            &*tx,
            &native_key(history)?,
            &serde_json::to_value(&next).map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
        )?;
        next
    };
    owner.assert_management_admission(account, change.request_key(), &identity)?;
    if matches!(change, NativeChange::Activate { .. }) {
        owner.assert_native_seal(history, result.staged.as_ref().ok_or(crate::cause!(Error::SourceChanged))?)?;
    }
    owner.assert_current(account, &*tx)?;
    physical(&*tx)?;
    tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok(result)
}
fn name(device: &str, address: &str) -> Result<String> {
    if !digest(device) || !resource(address) {
        return Err(crate::cause!(Error::Invalid));
    }
    Ok(format!(
        "resource-connection:{}",
        blake3::hash(&serde_json::to_vec(&(device, address)).map_err(|error| crate::carry_cause!(Error::Invalid, error))?).to_hex()
    ))
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    version: String,
    pub account_id: String,
    pub device_id: String,
    pub resource_address: String,
    pub resource_generation: u64,
    pub registration_revision: u64,
    pub active: bool,
    last_request_key: String,
    last_input_identity: String,
}
impl Registration {
    fn valid(&self) -> bool {
        self.version == VERSION
            && digest(&self.account_id)
            && digest(&self.device_id)
            && resource(&self.resource_address)
            && (1..=MAX_SAFE).contains(&self.resource_generation)
            && (1..=MAX_SAFE).contains(&self.registration_revision)
            && !self.last_request_key.is_empty()
            && self.last_request_key.len() <= 512
            && !self.last_request_key.chars().any(char::is_control)
            && digest(&self.last_input_identity)
    }
    pub fn route(&self) -> Result<Route> {
        if !self.valid() || !self.active {
            return Err(crate::cause!(Error::NotAuthorized));
        }
        // The route incarnation changes on re-enrollment even when the actual
        // record generation stays the same. A revoked old session cannot revive.
        let bytes = serde_json::to_vec(&(
            VERSION,
            &self.account_id,
            &self.device_id,
            &self.resource_address,
            self.resource_generation,
            self.registration_revision,
        ))
        .map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        Ok(Route {
            account_id: self.account_id.clone(),
            device_id: self.device_id.clone(),
            resource_address: self.resource_address.clone(),
            generation: format!("connection:{}", blake3::hash(&bytes).to_hex()),
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub device_id: String,
    pub resource_address: String,
    pub resource_generation: u64,
    /// Zero means independently observed absence. Tombstones are never erased.
    pub expected_registration_revision: u64,
    pub active: bool,
    pub request_key: String,
}
impl Change {
    pub fn identity(&self) -> Result<String> {
        name(&self.device_id, &self.resource_address)?;
        if !(1..=MAX_SAFE).contains(&self.resource_generation)
            || self.expected_registration_revision >= MAX_SAFE
            || self.request_key.is_empty()
            || self.request_key.len() > 512
            || self.request_key.chars().any(char::is_control)
        {
            return Err(crate::cause!(Error::Invalid));
        }
        let bytes = serde_json::to_vec(&(VERSION, self)).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        Ok(blake3::hash(&bytes).to_hex().to_string())
    }
}

/// Extends the existing management witness; it is not an authorization default.
/// The real owner must verify the original device credential registration and
/// the current physical resource generation for activation, not caller labels.
pub trait RegistrationOwner: CanonicalPolicyOwner {
    fn assert_resource_binding(
        &mut self,
        account: &AccountIdentity,
        policy: &dyn Storage,
        change: &Change,
    ) -> Result<()>;
}

fn available(store: &dyn Storage, account: &AccountIdentity) -> Result<()> {
    canonical_account(store, account)?;
    for key in ["update", "account-erasure", "account-erasure-continuation"] {
        if !read(store, key)?.is_null() {
            return Err(crate::cause!(Error::NotDrained));
        }
    }
    Ok(())
}
fn stored(
    store: &dyn Storage,
    account: &AccountIdentity,
    device: &str,
    address: &str,
) -> Result<Option<Registration>> {
    let value = read(store, &name(device, address)?)?;
    if value.is_null() {
        return Ok(None);
    }
    let value: Registration = serde_json::from_value(value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if !value.valid()
        || value.account_id != account.owner_id
        || value.device_id != device
        || value.resource_address != address
    {
        return Err(crate::cause!(Error::NotCanonical));
    }
    Ok(Some(value))
}

/// Current metadata only. Callers retain their original source/state lock and device
/// credential checks; this never grants operation rights or opens record state.
pub fn current(
    store: &dyn Storage,
    account: &AccountIdentity,
    device: &str,
    address: &str,
) -> Result<Option<Registration>> {
    physical(store)?;
    if !store.scoped() {
        let tx = Scope::begin(store, Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        available(&*tx, account)?;
        let result = stored(&*tx, account, device, address)?;
        physical(&*tx)?;
        tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        return Ok(result);
    }
    available(store, account)?;
    let result = stored(store, account, device, address)?;
    physical(store)?;
    Ok(result)
}

/// Original computer-key lifecycle: revocation remains in APP_KV; account-wide
/// retirement/deletion/disconnect remains in the canonical account source.
pub fn accepts_device_issued_at(
    store: &dyn Storage,
    account: &AccountIdentity,
    issued_at: u64,
) -> Result<bool> {
    let source = canonical_account(store, account)?;
    let life = &source["lifecycle"];
    if issued_at == 0 || issued_at > MAX_SAFE {
        return Err(crate::cause!(Error::Invalid));
    }
    for key in ["retired_into", "deleting_since", "erased_at"] {
        if !life[key].is_null() && life[key] != false && life[key] != "" {
            return Ok(false);
        }
    }
    if life["disconnected_at"].is_null()
        || life["disconnected_at"] == false
        || life["disconnected_at"] == ""
    {
        return Ok(true);
    }
    let disconnected = super::source_timestamp(&life["disconnected_at"])?;
    Ok(issued_at > disconnected)
}

/// Compare-and-swap the original directory, with admission checked both before
/// and inside its transaction. Exact retry returns the saved row; changed input
/// or stale revision cannot renew/recreate a revoked connection.
pub fn change(
    store: &dyn Storage,
    owner: &mut impl RegistrationOwner,
    account: &AccountIdentity,
    change: &Change,
) -> Result<Registration> {
    let identity = change.identity()?;
    owner.assert_current(account, store)?;
    owner.assert_management_admission(account, &change.request_key, &identity)?;
    if change.active {
        owner.assert_resource_binding(account, store, change)?;
    }
    physical(store)?;
    if store.scoped() {
        return Err(crate::cause!(Error::SourceChanged));
    }
    let tx = Scope::begin(store, Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    available(&*tx, account)?;
    let previous = stored(&*tx, account, &change.device_id, &change.resource_address)?;
    let value = if let Some(prior) = previous
        .as_ref()
        .filter(|r| r.last_request_key == change.request_key)
    {
        if prior.last_input_identity != identity {
            return Err(crate::cause!(Error::DifferentChange));
        }
        prior.clone()
    } else {
        if previous.as_ref().map_or(0, |r| r.registration_revision)
            != change.expected_registration_revision
        {
            return Err(crate::cause!(Error::SourceChanged));
        }
        let value = Registration {
            version: VERSION.into(),
            account_id: account.owner_id.clone(),
            device_id: change.device_id.clone(),
            resource_address: change.resource_address.clone(),
            resource_generation: change.resource_generation,
            registration_revision: change.expected_registration_revision + 1,
            active: change.active,
            last_request_key: change.request_key.clone(),
            last_input_identity: identity.clone(),
        };
        put(
            &*tx,
            &name(&change.device_id, &change.resource_address)?,
            &serde_json::to_value(&value).map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
        )?;
        value
    };
    if change.active {
        owner.assert_resource_binding(account, &*tx, change)?;
    }
    owner.assert_management_admission(account, &change.request_key, &identity)?;
    owner.assert_current(account, &*tx)?;
    physical(&*tx)?;
    tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok(value)
}
