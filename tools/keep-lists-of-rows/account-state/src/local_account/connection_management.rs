// One explicitly requested device-hosting change by the current own browser.
// The same state lock and original policy file remain authoritative.
// This is not a generic policy-management credential: the private witness is
// constructed for this exact registration input and cannot leave this call.
// HTTP callers must still enforce their existing Origin/page-account guard.
use super::*;
use crate::{
    account::{self, BrowserAdmission},
    account_rights::{
        self,
        resource_connection::{self as registration, Change, RegistrationOwner},
        CanonicalPolicyOwner,
    },
    storage::{
        sqlite::{self, Access},
        Storage,
    },
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

type NativeHistory = crate::storage::record_store_resources::domains::Identity;
type NativeSeal = crate::local_account::record_writer::native_command_context::SealedSourceProof;
use crate::resource_authority::rights_gate::{ResourceCommitBarrier, ResourceCommitLease};

/// Original independent canonical source custody, never obtained from a moved
/// domain or a caller path. Retaining its original state lock also prevents a
/// replacement native owner from acknowledging a transition while output from
/// this owner remains in custody.
struct NativeSource {
    account: AccountIdentity,
    history: NativeHistory,
    path: PathBuf,
    inode: Inode,
    _file: std::fs::File,
    state_lock: Arc<ExistingStateLock>,
    supply: Arc<dyn crate::storage::SelectedSource>,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl NativeSource {
    fn live(&self) -> account_rights::Result<()> {
        if self.cancel.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        self.state_lock
            .assert_current()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        self.inode
            .check(&self.path)
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        check_sqlite_sidecars(&self.path).map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))
    }
    fn open(&self, intent: crate::storage::Intent) -> account_rights::Result<Box<dyn Storage>> {
        self.live()?;
        let store = self.supply.open(intent, self.cancel.clone(), self.deadline)
            .map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?;
        store.custody().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        self.live()?;
        Ok(store)
    }
    fn observe(&self) -> account_rights::Result<registration::NativeRegistration> {
        let store = self.open(crate::storage::Intent::Read)?;
        let registration = registration::native_observe(&*store, &self.account, &self.history)
            .map_err(|error| {
                if matches!(error, account_rights::Error::NotCanonical(_)) {
                    crate::cause!(account_rights::Error::SourceChanged)
                } else {
                    error
                }
            })?
            .ok_or(crate::cause!(account_rights::Error::NotCanonical))?;
        self.live()?;
        Ok(registration)
    }
}

/// A native authority observation and a real current-source producer. A saved
/// registration is not a permit: every hold freshly reads the original
/// canonical source while the per-resource admission/transition barrier is
/// held. This handle stores no physical supply mapping and grants no caller
/// rights. Those remain with the original native request admission.
#[derive(Clone)]
pub(crate) struct NativeDomainAuthority {
    source: Arc<NativeSource>,
    observed: registration::NativeRegistration,
    barrier: Arc<ResourceCommitBarrier>,
}
impl NativeDomainAuthority {
    pub(crate) fn registration(&self) -> &registration::NativeRegistration {
        &self.observed
    }
    pub(crate) fn current_incarnation(&self) -> &str {
        &self.observed.current_incarnation
    }
    pub(crate) fn staged_incarnation(&self) -> Option<&str> {
        self.observed
            .staged
            .as_ref()
            .map(|stage| stage.target_incarnation.as_str())
    }
    pub(crate) fn hold_native(
        &self,
        incarnation: &str,
    ) -> crate::storage::Result<NativeAuthorityPermit> {
        self.hold(incarnation, true)
    }
    fn hold(
        &self,
        incarnation: &str,
        native: bool,
    ) -> crate::storage::Result<NativeAuthorityPermit> {
        let lease = self.barrier.enter(|| {
            let registration = self
                .source
                .observe()
                .map_err(|error| crate::carry_cause!(crate::storage::Error::Moved, error))?;
            let allowed = registration.current_incarnation == incarnation
                || (!native
                    && registration.staged.as_ref().is_some_and(|stage| {
                        stage.source_incarnation == incarnation
                            || stage.target_incarnation == incarnation
                    }));
            if !allowed {
                return Err(crate::cause!(crate::storage::Error::Moved));
            }
            Ok(())
        })?;
        Ok(NativeAuthorityPermit {
            _source: self.source.clone(),
            lease,
        })
    }
}
/// A domain-only canonical drain, acquired after releasing the account owner.
/// It cannot authorize a change to another original source or history.
pub(crate) struct NativeDomainControl<'a> {
    authority:&'a NativeDomainAuthority,
    pause:crate::resource_authority::rights_gate::ResourceCommitPause<'a>,
}
impl NativeDomainControl<'_> {
    pub(crate) fn publish_unchanged(self)->account_rights::Result<()> {
        self.authority.source.live()?;
        if self.authority.source.observe()?!=self.authority.observed {return Err(crate::cause!(account_rights::Error::SourceChanged));}
        self.pause.publish().map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))
    }
}
impl NativeDomainAuthority {
    pub(crate) fn drain_native(&self)->account_rights::Result<NativeDomainControl<'_>> {
        self.source.live()?;
        let pause=self.barrier.pause_until(&self.source.cancel,self.source.deadline).map_err(|error| crate::carry_cause!(account_rights::Error::NotDrained, error))?;
        self.source.live()?;
        Ok(NativeDomainControl {authority:self,pause})
    }
}

/// A non-cloneable native commit/output hold. No timeout releases custody that
/// might still disclose bytes. A physical close of unknown outcome explicitly
/// closes the resource barrier; dropping this permit cannot acknowledge it.
pub(crate) struct NativeAuthorityPermit {
    _source: Arc<NativeSource>,
    lease: ResourceCommitLease,
}
impl NativeAuthorityPermit {
    pub(crate) fn mark_outcome_unknown(&self) {
        self.lease.mark_outcome_unknown();
    }
}
impl crate::storage::record_store_resources::carry::live_adopt::FenceGuard
    for NativeAuthorityPermit
{
}
impl crate::storage::record_store_resources::carry::live_adopt::Fence for NativeDomainAuthority {
    fn hold(
        &self,
        incarnation: &str,
    ) -> crate::storage::Result<
        Box<dyn crate::storage::record_store_resources::carry::live_adopt::FenceGuard + '_>,
    > {
        Ok(Box::new(self.hold(incarnation, false)?))
    }
    fn hold_owned(
        self: Arc<Self>,
        incarnation: &str,
    ) -> crate::storage::Result<
        Box<
            dyn crate::storage::record_store_resources::carry::live_adopt::FenceGuard + Send + Sync,
        >,
    > {
        Ok(Box::new(self.hold(incarnation, false)?))
    }
}

impl crate::storage::record_store_resources::carry::live_adopt::portable::ActivationGuard
    for NativeAuthorityPermit
{
    fn mark_outcome_unknown(&self) {
        self.lease.mark_outcome_unknown();
    }
}
impl crate::storage::record_store_resources::carry::live_adopt::portable::TargetAuthority
    for NativeDomainAuthority
{
    fn hold_current(
        &self,
        incarnation: &str,
    ) -> crate::storage::Result<
        Box<dyn crate::storage::record_store_resources::carry::live_adopt::portable::ActivationGuard>,
    >{
        Ok(Box::new(self.hold_native(incarnation)?))
    }
}

fn native_barrier(
    owner: &LocalAccount,
    history: &NativeHistory,
) -> account_rights::Result<Arc<ResourceCommitBarrier>> {
    use std::sync::{Mutex, OnceLock, Weak};
    static ACTIVE: OnceLock<
        Mutex<
            std::collections::BTreeMap<
                String,
                (Weak<ExistingStateLock>, Arc<ResourceCommitBarrier>),
            >,
        >,
    > = OnceLock::new();
    // Process source identity only: never a routing/placement address, never
    // persisted as authority. The retained Arc prevents pointer reuse while a
    // lease from this owner exists. Dead entries leave on the next acquisition.
    let key = format!(
        "{:p}:{}",
        Arc::as_ptr(&owner.state_lock),
        serde_json::to_string(history).map_err(|error| crate::carry_cause!(account_rights::Error::Invalid, error))?
    );
    let mut active = ACTIVE
        .get_or_init(|| Mutex::new(Default::default()))
        .lock()
        .map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?;
    active.retain(|_, (source, gate)| {
        source.strong_count() != 0 && !(Arc::strong_count(gate) == 1 && gate.idle_reapable())
    });
    if let Some((_, barrier)) = active.get(&key) {
        return Ok(barrier.clone());
    }
    let barrier = ResourceCommitBarrier::new();
    active.insert(key, (Arc::downgrade(&owner.state_lock), barrier.clone()));
    Ok(barrier)
}

struct NativeManagement<'a> {
    owner: &'a mut LocalAccount,
    source: Arc<NativeSource>,
    /// Exact handle returned by the independently selected supplier. A path or
    /// location label cannot substitute another handle in the authority update.
    policy: &'a dyn Storage,
    request: &'a str,
    identity: String,
    current: &'a mut dyn FnMut(&mut LocalAccount) -> account::AccountResult<()>,
    seal: Option<&'a NativeSeal>,
}
impl CanonicalPolicyOwner for NativeManagement<'_> {
    fn assert_current(
        &mut self,
        account: &AccountIdentity,
        policy: &dyn Storage,
    ) -> account_rights::Result<()> {
        self.source.live()?;
        (self.current)(self.owner).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        self.owner
            .assert_owned()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        if *account != self.source.account
            || self.owner.source.policy.path != self.source.path
            || !std::ptr::eq(policy, self.policy)
            || self.owner.source.account != self.source.account
        {
            return Err(crate::cause!(account_rights::Error::SourceChanged));
        }
        policy
            .custody()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))
    }
    fn assert_management_admission(
        &mut self,
        account: &AccountIdentity,
        request: &str,
        identity: &str,
    ) -> account_rights::Result<()> {
        if *account != self.source.account || request != self.request || identity != self.identity {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        (self.current)(self.owner).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        self.source.live()
    }
}
impl registration::NativeRegistrationOwner for NativeManagement<'_> {
    fn assert_native_seal(
        &mut self,
        history: &NativeHistory,
        transfer: &registration::NativeTransfer,
    ) -> account_rights::Result<()> {
        self.source.live()?;
        self.seal
            .ok_or(crate::cause!(account_rights::Error::NotDrained))?
            .assert_matches(
                &self.source.account.owner_id,
                history,
                &transfer.move_id,
                &transfer.source_incarnation,
                &transfer.target_incarnation,
            )
            .map_err(|error| crate::carry_cause!(account_rights::Error::NotDrained, error))
    }
}

impl LocalAccount {
    fn native_authority_source(
        &mut self,
        history: &NativeHistory,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> account_rights::Result<Arc<NativeSource>> {
        self.assert_owned()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        if history.generation
            != self
                .original_workspace_generation()
                .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?
        {
            return Err(crate::cause!(account_rights::Error::SourceChanged));
        }
        let path = self.source.policy.path.clone();
        let (file, inode) =
            open_regular(&path).map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        if inode != self.source.policy.inode {
            return Err(crate::cause!(account_rights::Error::SourceChanged));
        }
        let source = Arc::new(NativeSource {
            account: self.source.account.clone(),
            history: history.clone(),
            path,
            inode,
            _file: file,
            state_lock: self.state_lock.clone(),
            supply: self.source.canonical_policy_supply().map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?,
            cancel,
            deadline,
        });
        source.live()?;
        Ok(source)
    }
    pub(crate) fn native_domain_authority(
        &mut self,
        history: &NativeHistory,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        current: &mut dyn FnMut(&mut LocalAccount) -> account::AccountResult<()>,
    ) -> account_rights::Result<NativeDomainAuthority> {
        current(self).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        let source = self.native_authority_source(history, cancel, deadline)?;
        let observed = source.observe()?;
        current(self).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        let barrier = native_barrier(self, history)?;
        source.live()?;
        Ok(NativeDomainAuthority {
            source,
            observed,
            barrier,
        })
    }
    pub(crate) fn change_native_domain_authority_drained(&mut self,history:&NativeHistory,
        change:&registration::NativeChange,cancel:Arc<AtomicBool>,deadline:Instant,
        current:&mut dyn FnMut(&mut LocalAccount)->account::AccountResult<()>,seal:Option<&NativeSeal>,
        control:NativeDomainControl<'_>)->account_rights::Result<NativeDomainAuthority> {
        let identity=change.identity(history)?;
        current(self).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        let source=self.native_authority_source(history,cancel,deadline)?;
        let barrier=native_barrier(self,history)?;
        if control.authority.source.account!=source.account || control.authority.source.history!=*history
            || !Arc::ptr_eq(&barrier,&control.authority.barrier) {return Err(crate::cause!(account_rights::Error::SourceChanged));}
        control.authority.source.live()?;
        let store=source.open(crate::storage::Intent::Write)?;let account=source.account.clone();
        let mut management=NativeManagement {owner:self,source:source.clone(),policy:&*store,request:change.request_key(),identity,current,seal};
        let observed=registration::native_change(&*store,&mut management,&account,history,change)?;
        source.live()?;control.pause.publish().map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?;
        Ok(NativeDomainAuthority {source,observed,barrier})
    }

    pub(crate) fn change_native_domain_authority(
        &mut self,
        history: &NativeHistory,
        change: &registration::NativeChange,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        current: &mut dyn FnMut(&mut LocalAccount) -> account::AccountResult<()>,
        seal: Option<&NativeSeal>,
    ) -> account_rights::Result<NativeDomainAuthority> {
        let identity = change.identity(history)?;
        current(self).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        let source = self.native_authority_source(history, cancel, deadline)?;
        let barrier = native_barrier(self, history)?;
        let pause = barrier
            .pause_until(&source.cancel, source.deadline)
            .map_err(|error| crate::carry_cause!(account_rights::Error::NotDrained, error))?;
        let store = source.open(crate::storage::Intent::Write)?;
        let account = source.account.clone();
        let mut management = NativeManagement {
            owner: self,
            source: source.clone(),
            policy: &*store,
            request: change.request_key(),
            identity,
            current,
            seal,
        };
        let observed =
            registration::native_change(&*store, &mut management, &account, history, change)?;
        source.live()?;
        pause
            .publish()
            .map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?;
        Ok(NativeDomainAuthority {
            source,
            observed,
            barrier,
        })
    }
}

struct Management<'a> {
    owner: &'a mut LocalAccount,
    admitted: BrowserAdmission,
    session: &'a str,
    request: &'a str,
    input_identity: String,
    policy_path: PathBuf,
    policy_inode: Inode,
    deadline: Instant,
    cancel: Arc<AtomicBool>,
    device_record: Option<Zeroizing<Vec<u8>>>,
    source_current: &'a dyn Fn() -> account_rights::Result<()>,
}
impl Management<'_> {
    fn live(&self) -> account_rights::Result<()> {
        (self.source_current)()?;
        if self.cancel.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        self.owner
            .assert_owned()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        if self.owner.source.policy.path != self.policy_path {
            return Err(crate::cause!(account_rights::Error::SourceChanged));
        }
        self.policy_inode
            .check(&self.policy_path)
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        check_sqlite_sidecars(&self.policy_path).map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))
    }
    fn browser(&mut self) -> account_rights::Result<()> {
        self.live()?;
        let current = account::current_browser_read_only(self.owner, self.session)
            .map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        if current.account != self.admitted.account || !self.admitted.still() {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        self.live()
    }
}
impl CanonicalPolicyOwner for Management<'_> {
    fn assert_current(
        &mut self,
        account: &AccountIdentity,
        policy: &dyn Storage,
    ) -> account_rights::Result<()> {
        self.live()?;
        if account != &self.admitted.account || policy.location() != self.policy_path.to_str() {
            return Err(crate::cause!(account_rights::Error::SourceChanged));
        }
        policy
            .custody()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))
    }
    fn assert_management_admission(
        &mut self,
        account: &AccountIdentity,
        request: &str,
        identity: &str,
    ) -> account_rights::Result<()> {
        if account != &self.admitted.account
            || request != self.request
            || identity != self.input_identity
        {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        self.browser()
    }
}
impl RegistrationOwner for Management<'_> {
    fn assert_resource_binding(
        &mut self,
        account: &AccountIdentity,
        policy: &dyn Storage,
        change: &Change,
    ) -> account_rights::Result<()> {
        self.assert_current(account, policy)?;
        if change.identity()? != self.input_identity || change.resource_address != BROWSER_RESOURCE
        {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        let now = self
            .owner
            .source
            .clock()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let bytes = self
            .owner
            .source
            .read_kv_bytes_bounded(&format!("device-key:{}", change.device_id), now, 4096)
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?
            .ok_or(crate::cause!(account_rights::Error::NotAuthorized))?;
        if self
            .device_record
            .as_ref()
            .is_some_and(|earlier| earlier.as_slice() != bytes.as_slice())
        {
            return Err(crate::cause!(account_rights::Error::SourceChanged));
        }
        let device: Value =
            serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?;
        if device["userId"] != account.user_id {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        let issued = chrono::DateTime::parse_from_rfc3339(
            device["created_at"]
                .as_str()
                .ok_or(crate::cause!(account_rights::Error::Unavailable))?,
        )
        .map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?
        .timestamp_millis();
        let issued = u64::try_from(issued).map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        if issued > now || !registration::accepts_device_issued_at(policy, account, issued)? {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        let generation = self
            .owner
            .original_workspace_generation()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        if u64::try_from(generation).ok() != Some(change.resource_generation) {
            return Err(crate::cause!(account_rights::Error::SourceChanged));
        }
        self.device_record = Some(bytes);
        self.live()
    }
}
impl LocalAccount {
    /// Apply one explicit enrollment/revocation from the retained own browser.
    /// An nm_ key, a tc_ credential, a computer ID, readiness, or a route label
    /// cannot call through this admission. It does not issue a device key.
    /// Only @own-records has an actual selected resource header in this owner.
    pub(crate) fn change_resource_connection(
        &mut self,
        session: &str,
        change: &Change,
        deadline: Instant,
        cancel: Arc<AtomicBool>,
        source_current: &dyn Fn() -> account_rights::Result<()>,
    ) -> account_rights::Result<registration::Registration> {
        let input_identity = change.identity()?;
        source_current()?;
        if change.resource_address != BROWSER_RESOURCE
            || cancel.load(Ordering::Acquire)
            || Instant::now() >= deadline
        {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        let admitted = account::current_browser(self, session)
            .map_err(|error| crate::carry_cause!(account_rights::Error::NotAuthorized, error))?;
        self.assert_owned()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        // Open exactly the independently selected ORIGINAL policy only after
        // own-browser admission; never promote/replace the read observer.
        let policy_path = self.source.policy.path.clone();
        let policy_inode = self.source.policy.inode.clone();
        let (_held_file, current_inode) =
            open_regular(&policy_path).map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        if current_inode != policy_inode {
            return Err(crate::cause!(account_rights::Error::SourceChanged));
        }
        check_sqlite_sidecars(&policy_path).map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let duration = deadline.saturating_duration_since(Instant::now());
        if duration.is_zero() {
            return Err(crate::cause!(account_rights::Error::NotAuthorized));
        }
        let store = sqlite::open_selected(
            &policy_path,
            "account_policy",
            sqlite::Selected {
                access: Access::Write,
                trusted_schema: false,
                meter: Some(self.source.sql_work.clone()),
                bounds: sqlite::Bounds {
                    value_bytes: MAX_JSON,
                    work: 200_000,
                    deadline: duration,
                    spend: sqlite::Spend::WholeHandle,
                    cancel: Some(cancel.clone()),
                    busy: Duration::ZERO,
                },
            },
        )
        .map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?;
        let account = admitted.account.clone();
        let mut management = Management {
            owner: self,
            admitted,
            session,
            request: &change.request_key,
            input_identity,
            policy_path,
            policy_inode,
            deadline,
            cancel,
            device_record: None,
            source_current,
        };
        registration::change(&store, &mut management, &account, change)
    }

    pub(crate) fn resource_connection_management_result_current(
        &mut self,
        expected: &registration::Registration,
    ) -> account_rights::Result<()> {
        self.assert_owned()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))?;
        let account = self.source.account.clone();
        let tx = self
            .source
            .policy
            .transaction()
            .map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?;
        let policy = sqlite::lend(&tx, "account_policy", Access::Read)
            .map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?;
        let current = registration::current(
            &policy,
            &account,
            &expected.device_id,
            &expected.resource_address,
        )?;
        if current.as_ref() != Some(expected) {
            return Err(crate::cause!(account_rights::Error::SourceChanged));
        }
        drop(policy);
        tx.commit()
            .map_err(|error| crate::carry_cause!(account_rights::Error::Unavailable, error))?;
        self.assert_owned()
            .map_err(|error| crate::carry_cause!(account_rights::Error::SourceChanged, error))
    }
}
