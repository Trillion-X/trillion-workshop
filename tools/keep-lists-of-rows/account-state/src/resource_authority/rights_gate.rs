//! In-memory Mac-side rights state with a commit pause.
//!
//! The canonical policy owner signs snapshots, pauses and updates. This gate
//! verifies them with one configured Ed25519 public key; it has no signing
//! credential and does not persist authority across process restarts.
use crate::{
    mcp_current_policy::Reach,
    resource_authority::{Route, Scope},
    signed_authority::FreshRights,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, MutexGuard, RwLock},
};

const POLICY_DOMAIN: &[u8] = b"trillion.mac-rights-policy/v2\0";
/// The exact already-installed signing domain shared with the vault adapter.
pub fn signing_domain() -> &'static [u8] {
    POLICY_DOMAIN
}
const MAX_EVENT_BYTES: usize = 65_536;
const MAX_CLIENTS: usize = 4_096;
const MAX_USED_NONCES: usize = 16_384;

#[cfg(test)]
mod native_commit_barrier_controls {
    use super::*;
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };
    #[test]
    fn registry_cleanup_never_waits_for_another_resources_canonical_read() {
        let barrier = ResourceCommitBarrier::new();
        let canonical_read = barrier.state.lock().unwrap();
        let other = barrier.clone();
        let (sent, received) = mpsc::channel();
        let cleanup = thread::spawn(move || sent.send(other.idle_reapable()).unwrap());
        assert!(!received.recv_timeout(Duration::from_secs(2)).unwrap());
        drop(canonical_read);
        cleanup.join().unwrap();
    }
    #[test]
    fn another_resource_commits_while_first_resource_is_held() {
        let first = ResourceCommitBarrier::new();
        let second = ResourceCommitBarrier::new();
        let held = first.enter(|| Ok(())).unwrap();
        let (sent, received) = mpsc::channel();
        let writing = thread::spawn(move || {
            let _commit = second.enter(|| Ok(())).unwrap();
            sent.send(()).unwrap();
        });
        received.recv_timeout(Duration::from_secs(2)).unwrap();
        writing.join().unwrap();
        drop(held);
    }
    #[test]
    fn canonical_control_drains_output_custody_and_failed_control_stays_closed() {
        let barrier = ResourceCommitBarrier::new();
        let first = barrier.enter(|| Ok(())).unwrap();
        let last = barrier.enter(|| Ok(())).unwrap();
        let (sent, received) = mpsc::channel();
        let other = barrier.clone();
        let control = thread::spawn(move || {
            let paused = other.pause().unwrap();
            sent.send(()).unwrap();
            drop(paused);
        });
        let until = Instant::now() + Duration::from_secs(2);
        while barrier.state.lock().unwrap().0 && Instant::now() < until {
            thread::yield_now();
        }
        assert!(!barrier.state.lock().unwrap().0);
        assert!(barrier.enter(|| Ok(())).is_err());
        drop(first);
        assert!(received.recv_timeout(Duration::from_millis(30)).is_err());
        drop(last);
        received.recv_timeout(Duration::from_secs(2)).unwrap();
        control.join().unwrap();
        assert!(barrier.enter(|| Ok(())).is_err());
        assert!(!barrier.idle_reapable());
        barrier.pause().unwrap().publish().unwrap();
        assert!(barrier.enter(|| Ok(())).is_ok());
    }
    #[test]
    fn unknown_close_cannot_acknowledge_or_be_forgotten_as_idle() {
        let barrier = ResourceCommitBarrier::new();
        assert!(barrier.enter(|| Err(crate::cause!(crate::storage::Error::Moved))).is_err());
        assert!(barrier.idle_reapable());
        let permit = barrier.enter(|| Ok(())).unwrap();
        permit.mark_outcome_unknown();
        drop(permit);
        assert!(barrier.pause().is_err());
        assert!(!barrier.idle_reapable());
        assert!(barrier.enter(|| Ok(())).is_err());
    }
    #[test]
    fn expired_or_cancelled_control_never_acknowledges_held_custody() {
        use std::sync::atomic::AtomicBool;
        let barrier = ResourceCommitBarrier::new();
        let custody = barrier.enter(|| Ok(())).unwrap();
        let cancel = AtomicBool::new(false);
        assert!(matches!(
            barrier.pause_until(&cancel, Instant::now() + Duration::from_millis(30)),
            Err(crate::storage::Error::Deadline(_))
        ));
        assert!(!barrier.idle_reapable());
        assert!(barrier.enter(|| Ok(())).is_err());
        assert!(matches!(
            barrier.pause_until(
                &AtomicBool::new(true),
                Instant::now() + Duration::from_secs(2)
            ),
            Err(crate::storage::Error::Interrupted(_))
        ));
        drop(custody);
        barrier.pause().unwrap().publish().unwrap();
        assert!(barrier.enter(|| Ok(())).is_ok());
    }
    #[test]
    fn control_closes_admission_before_a_stalled_current_check_finishes() {
        use std::sync::atomic::AtomicBool;
        let barrier = ResourceCommitBarrier::new();
        let other = barrier.clone();
        let (entered, saw_enter) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let checking = thread::spawn(move || {
            other
                .enter(|| {
                    entered.send(()).unwrap();
                    wait.recv().unwrap();
                    Ok(())
                })
                .is_err()
        });
        saw_enter.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            barrier.pause_until(
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(2)
            ),
            Err(crate::storage::Error::Busy(_))
        ));
        assert!(!barrier.idle_reapable());
        release.send(()).unwrap();
        assert!(
            checking.join().unwrap(),
            "the earlier current read must not mint a late lease"
        );
        assert!(barrier.enter(|| Ok(())).is_err());
        barrier.pause().unwrap().publish().unwrap();
        assert!(barrier.enter(|| Ok(())).is_ok());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClientRight {
    pub client_id: String,
    pub rights_revision: String,
    pub allowed: bool,
    /// Current reach signed by the canonical policy owner. A legacy event
    /// without reach may decode, but cannot admit an allowed client.
    #[serde(default)]
    pub reach: Option<Reach>,
}

/// The owner signs the serialized payload bytes, prefixed with POLICY_DOMAIN.
/// `kind` is `snapshot`, `fence`, or `update`; update events carry the complete
/// current client-rights set for the target epoch.
/// The one version of a signed policy event: written by the owner's signer and accepted by the Mac host's and the
/// rights gate's verifiers, so a change is made once.
pub const POLICY_EVENT_VERSION: u8 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PolicyEvent {
    /// Always `POLICY_EVENT_VERSION`: the version the owner writes and every verifier accepts.
    pub version: u8,
    pub kind: String,
    pub route: Route,
    pub nonce: String,
    pub epoch: u64,
    pub update_id: Option<String>,
    pub snapshot_identity: Option<String>,
    pub clients: Vec<ClientRight>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedPolicyEvent {
    pub key_id: String,
    pub payload: String,
    pub signature: String,
}

#[derive(Debug, Clone)]
pub enum RightsGateError {
    InvalidEvent(crate::refusal_cause::Cause),
    WrongKey(crate::refusal_cause::Cause),
    WrongRoute(crate::refusal_cause::Cause),
    WrongNonce(crate::refusal_cause::Cause),
    Replay(crate::refusal_cause::Cause),
    StaleEpoch(crate::refusal_cause::Cause),
    AlreadyConnected(crate::refusal_cause::Cause),
    PauseNotInstalled(crate::refusal_cause::Cause),
    PauseMismatch(crate::refusal_cause::Cause),
    OutcomeUnknown(crate::refusal_cause::Cause),
}
impl RightsGateError {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::AlreadyConnected(cause) => cause.clone(),
            Self::InvalidEvent(cause) => cause.clone(),
            Self::OutcomeUnknown(cause) => cause.clone(),
            Self::PauseMismatch(cause) => cause.clone(),
            Self::PauseNotInstalled(cause) => cause.clone(),
            Self::Replay(cause) => cause.clone(),
            Self::StaleEpoch(cause) => cause.clone(),
            Self::WrongKey(cause) => cause.clone(),
            Self::WrongNonce(cause) => cause.clone(),
            Self::WrongRoute(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(RightsGateError);
impl PartialEq for RightsGateError {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for RightsGateError {}

impl RightsGateError {
    /// The safe site at which unresolved effects prevented changing the rights fence.
    pub fn outcome_cause(&self) -> Option<crate::refusal_cause::Cause> {
        match self {
            Self::OutcomeUnknown(cause) => Some(cause.clone()),
            _ => None,
        }
    }
}

/// The native canonical owner shares the same commit-lifetime pause rule as
/// the signed connection gate. This barrier grants no authority: `enter`
/// checks independently selected current canonical evidence while admission
/// and the lease count are held together. Controls close admissions and drain
/// physical commits/output custody before changing that independent source.
pub(crate) struct ResourceCommitBarrier {
    control: Mutex<()>,
    closed: std::sync::atomic::AtomicBool,
    state: Mutex<(bool, usize, bool)>,
    drained: std::sync::Condvar,
}
impl ResourceCommitBarrier {
    pub(crate) fn idle_reapable(&self) -> bool {
        if self.closed.load(std::sync::atomic::Ordering::Acquire) {
            return false;
        }
        self.state
            .try_lock()
            .is_ok_and(|state| state.0 && state.1 == 0 && !state.2)
    }
    pub(crate) fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            control: Mutex::new(()),
            closed: std::sync::atomic::AtomicBool::new(false),
            state: Mutex::new((true, 0, false)),
            drained: std::sync::Condvar::new(),
        })
    }
    pub(crate) fn enter(
        self: &std::sync::Arc<Self>,
        current: impl FnOnce() -> crate::storage::Result<()>,
    ) -> crate::storage::Result<ResourceCommitLease> {
        if self.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(crate::cause!(crate::storage::Error::Unavailable));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?;
        if !state.0 || self.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(crate::cause!(crate::storage::Error::Unavailable));
        }
        current()?;
        if self.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(crate::cause!(crate::storage::Error::Unavailable));
        }
        state.1 = state
            .1
            .checked_add(1)
            .ok_or(crate::cause!(crate::storage::Error::TooBig))?;
        Ok(ResourceCommitLease(self.clone()))
    }
    #[cfg(test)]
    fn pause(&self) -> crate::storage::Result<ResourceCommitPause<'_>> {
        self.pause_until(
            &std::sync::atomic::AtomicBool::new(false),
            std::time::Instant::now() + std::time::Duration::from_secs(2),
        )
    }
    pub(crate) fn pause_until(
        &self,
        cancel: &std::sync::atomic::AtomicBool,
        deadline: std::time::Instant,
    ) -> crate::storage::Result<ResourceCommitPause<'_>> {
        fn lock_error<T>(error: std::sync::TryLockError<T>) -> crate::storage::Error {
            match error {
                std::sync::TryLockError::WouldBlock => crate::cause!(crate::storage::Error::Busy),
                std::sync::TryLockError::Poisoned(_) => crate::cause!(crate::storage::Error::Unavailable),
            }
        }
        let control = self.control.try_lock().map_err(lock_error)?;
        // Close before attempting the state lock: a slow canonical read must
        // not admit a late lease or make the control wait past its own budget.
        self.closed
            .store(true, std::sync::atomic::Ordering::Release);
        let mut state = self.state.try_lock().map_err(lock_error)?;
        state.0 = false;
        while state.1 != 0 {
            if cancel.load(std::sync::atomic::Ordering::Acquire) {
                return Err(crate::cause!(crate::storage::Error::Interrupted));
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(crate::cause!(crate::storage::Error::Deadline));
            }
            state = self
                .drained
                .wait_timeout(state, remaining)
                .map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?
                .0;
        }
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(crate::cause!(crate::storage::Error::Interrupted));
        }
        if std::time::Instant::now() >= deadline {
            return Err(crate::cause!(crate::storage::Error::Deadline));
        }
        if state.2 {
            return Err(crate::cause!(crate::storage::Error::Unavailable));
        }
        Ok(ResourceCommitPause {
            barrier: self,
            _control: control,
        })
    }
}
pub(crate) struct ResourceCommitLease(std::sync::Arc<ResourceCommitBarrier>);
impl ResourceCommitLease {
    pub(crate) fn mark_outcome_unknown(&self) {
        self.0
            .closed
            .store(true, std::sync::atomic::Ordering::Release);
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.0 = false;
        state.2 = true;
    }
}
impl Drop for ResourceCommitLease {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.1 -= 1;
        if state.1 == 0 {
            self.0.drained.notify_all();
        }
    }
}
pub(crate) struct ResourceCommitPause<'a> {
    barrier: &'a ResourceCommitBarrier,
    _control: MutexGuard<'a, ()>,
}
impl ResourceCommitPause<'_> {
    /// Called only after the exact canonical mutation committed (or an exact
    /// retry proved its outcome). Unknown/error drops keep admissions closed.
    pub(crate) fn publish(self) -> crate::storage::Result<()> {
        self.barrier
            .state
            .lock()
            .map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?
            .0 = true;
        self.barrier
            .closed
            .store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PauseAck {
    pub epoch: u64,
    pub generation: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishAck {
    pub epoch: u64,
    pub generation: String,
}

struct State {
    available: bool,
    paused: bool,
    route: Route,
    nonce: Option<String>,
    epoch: u64,
    pending_epoch: Option<u64>,
    pending_update: Option<String>,
    pause_acknowledged: bool,
    clients: HashMap<String, ClientRight>,
    used_nonces: HashSet<String>,
    unresolved_outcomes: HashSet<String>,
}

/// Synchronous local authority used at the resource's physical commit point.
/// A single mutex serializes commit permits with disconnect, reconnect, and
/// policy pause installation.
pub struct MacRightsGate {
    key_id: String,
    public_key: [u8; 32],
    state: RwLock<State>,
    serialization: Mutex<()>,
}

impl MacRightsGate {
    pub fn new(route: Route, key_id: impl Into<String>, public_key: [u8; 32]) -> Self {
        let key_id = key_id.into();
        Self {
            key_id,
            public_key,
            state: RwLock::new(State {
                available: false,
                paused: true,
                route,
                nonce: None,
                epoch: 0,
                pending_epoch: None,
                pending_update: None,
                pause_acknowledged: false,
                clients: HashMap::new(),
                used_nonces: HashSet::new(),
                unresolved_outcomes: HashSet::new(),
            }),
            serialization: Mutex::new(()),
        }
    }

    /// Compare the connection's admitted route before installing a signed
    /// snapshot, so a different gate cannot briefly open on that connection.
    pub fn matches_route(&self, route: &Route) -> bool {
        self.state.read().is_ok_and(|state| state.route == *route)
    }

    /// Clear all current rights and wait for any already admitted commit to
    /// leave its critical section before the disconnect is acknowledged.
    pub fn disconnect(&self) {
        {
            let mut state = self
                .state
                .write()
                .unwrap_or_else(|poison| poison.into_inner());
            state.paused = true;
        }
        let _serial = self
            .serialization
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        state.available = false;
        state.paused = true;
        state.nonce = None;
        // Retain a begun policy pause across connection loss. A new signed
        // snapshot may restore the connection, but cannot reopen admissions until
        // the original update is paused and published on that new connection.
        state.pause_acknowledged = false;
        state.clients.clear();
    }

    /// Retire only the connection that owns this signed nonce. A delayed old
    /// connection must not close a newer connection restored on the same gate.
    pub fn disconnect_if_nonce(&self, nonce: &str) -> bool {
        {
            let mut state = self
                .state
                .write()
                .unwrap_or_else(|poison| poison.into_inner());
            if !state.available || state.nonce.as_deref() != Some(nonce) {
                return false;
            }
            state.paused = true;
        }
        let _serial = self
            .serialization
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        if !state.available || state.nonce.as_deref() != Some(nonce) {
            return false;
        }
        state.available = false;
        state.paused = true;
        state.nonce = None;
        state.pause_acknowledged = false;
        state.clients.clear();
        true
    }

    /// Reconnect only from a never-used nonce and a signed current snapshot.
    pub fn reconnect(
        &self,
        nonce: &str,
        snapshot: &SignedPolicyEvent,
    ) -> Result<(), RightsGateError> {
        let event = self.verify(snapshot)?;
        if event.kind != "snapshot" || event.nonce != nonce {
            return Err(crate::cause!(RightsGateError::WrongNonce));
        }
        if !nonce.starts_with("grant:") {
            return Err(crate::cause!(RightsGateError::WrongNonce));
        }
        self.validate_route(&event)?;
        validate_clients(&event.clients)?;
        let _serial = self
            .serialization
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        if state.available {
            return Err(crate::cause!(RightsGateError::AlreadyConnected));
        }
        if !state.unresolved_outcomes.is_empty() {
            return Err(crate::cause!(RightsGateError::OutcomeUnknown));
        }
        if state.used_nonces.contains(nonce) {
            return Err(crate::cause!(RightsGateError::Replay));
        }
        if state.used_nonces.len() >= MAX_USED_NONCES {
            return Err(crate::cause!(RightsGateError::InvalidEvent));
        }
        if event.epoch < state.epoch {
            return Err(crate::cause!(RightsGateError::StaleEpoch));
        }
        state.used_nonces.insert(nonce.to_owned());
        let pending_epoch = state.pending_epoch;
        let pending_update = state.pending_update.clone();
        state.available = true;
        state.paused = pending_epoch.is_some();
        state.nonce = Some(nonce.to_owned());
        state.epoch = event.epoch;
        state.pending_epoch = pending_epoch;
        state.pending_update = pending_update;
        state.pause_acknowledged = false;
        state.clients = into_clients(event.clients);
        Ok(())
    }

    /// Install a signed policy pause. The state blocks new permits before this
    /// method waits on the serialization mutex, so the returned ACK means all
    /// previously issued permits have left and the pause is in force.
    pub fn install_pause(&self, signed: &SignedPolicyEvent) -> Result<PauseAck, RightsGateError> {
        let event = self.verify(signed)?;
        if event.kind != "fence" || !event.clients.is_empty() {
            return Err(crate::cause!(RightsGateError::InvalidEvent));
        }
        self.validate_route(&event)?;
        {
            let mut state = self
                .state
                .write()
                .unwrap_or_else(|poison| poison.into_inner());
            if !state.available || state.nonce.as_deref() != Some(event.nonce.as_str()) {
                return Err(crate::cause!(RightsGateError::WrongNonce));
            }
            if event.epoch < state.epoch
                || (event.epoch == state.epoch && state.pending_epoch != Some(event.epoch))
            {
                return Err(crate::cause!(RightsGateError::StaleEpoch));
            }
            if state.pending_epoch.is_some()
                && (state.pending_epoch != Some(event.epoch)
                    || state.pending_update != event.update_id)
            {
                return Err(crate::cause!(RightsGateError::PauseMismatch));
            }
            state.paused = true;
            state.pending_epoch = Some(event.epoch);
            state.pending_update = event.update_id.clone();
            state.pause_acknowledged = false;
        }
        let _serial = self
            .serialization
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let state = self
            .state
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        if !state.available
            || state.nonce.as_deref() != Some(event.nonce.as_str())
            || state.pending_epoch != Some(event.epoch)
            || state.pending_update != event.update_id
            || !state.paused
        {
            return Err(crate::cause!(RightsGateError::PauseMismatch));
        }
        drop(state);
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        if !state.available
            || state.nonce.as_deref() != Some(event.nonce.as_str())
            || state.pending_epoch != Some(event.epoch)
            || state.pending_update != event.update_id
            || !state.paused
        {
            return Err(crate::cause!(RightsGateError::PauseMismatch));
        }
        if !state.unresolved_outcomes.is_empty() {
            return Err(crate::cause!(RightsGateError::OutcomeUnknown));
        }
        state.pause_acknowledged = true;
        Ok(PauseAck {
            epoch: event.epoch,
            generation: state.route.generation.clone(),
        })
    }

    /// Publish the canonical owner's complete rights set for the paused epoch.
    /// The revision advances and permits resume atomically under serialization.
    pub fn publish_update(
        &self,
        signed: &SignedPolicyEvent,
    ) -> Result<PublishAck, RightsGateError> {
        let event = self.verify(signed)?;
        if event.kind != "update" {
            return Err(crate::cause!(RightsGateError::InvalidEvent));
        }
        self.validate_route(&event)?;
        validate_clients(&event.clients)?;
        let _serial = self
            .serialization
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        if !state.available || state.nonce.as_deref() != Some(event.nonce.as_str()) {
            return Err(crate::cause!(RightsGateError::WrongNonce));
        }
        if !state.paused
            || !state.pause_acknowledged
            || state.pending_epoch != Some(event.epoch)
            || state.pending_update != event.update_id
        {
            return Err(crate::cause!(RightsGateError::PauseNotInstalled));
        }
        state.clients = into_clients(event.clients);
        state.epoch = event.epoch;
        state.pending_epoch = None;
        state.pending_update = None;
        state.paused = false;
        state.pause_acknowledged = false;
        Ok(PublishAck {
            epoch: event.epoch,
            generation: state.route.generation.clone(),
        })
    }

    /// Acquire the serialization pause before starting a resource commit.
    /// Keep this permit alive through physical commit and receipt disclosure.
    pub fn enter_commit(&self, scope: &Scope) -> Option<CommitPermit<'_>> {
        self.enter_commit_inner(scope, None)
    }

    /// A connection may use only the rights installed for its own connection.
    pub fn enter_commit_for_connection(
        &self,
        scope: &Scope,
        nonce: &str,
    ) -> Option<CommitPermit<'_>> {
        self.enter_commit_inner(scope, Some(nonce))
    }

    fn enter_commit_inner(&self, scope: &Scope, nonce: Option<&str>) -> Option<CommitPermit<'_>> {
        let serial = self
            .serialization
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let state = self
            .state
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        if !state.available
            || state.paused
            || !scope_matches_route(scope, &state.route)
            || nonce.is_some_and(|nonce| state.nonce.as_deref() != Some(nonce))
        {
            return None;
        }
        Some(CommitPermit {
            _serial: serial,
            scope: scope.clone(),
            gate: self,
        })
    }

    /// Only the resource owner may clear an uncertain commit after reading its
    /// durable receipt or proving rollback on the same physical store. This
    /// does not reopen a policy pause; its original signed event must retry.
    pub(crate) fn resolve_outcome(&self, request_key: &str, scope: &Scope) -> bool {
        let _serial = self
            .serialization
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        scope_matches_route(scope, &state.route) && state.unresolved_outcomes.remove(request_key)
    }

    fn validate_route(&self, event: &PolicyEvent) -> Result<(), RightsGateError> {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        if event.route != state.route {
            Err(crate::cause!(RightsGateError::WrongRoute))
        } else {
            Ok(())
        }
    }

    fn verify(&self, signed: &SignedPolicyEvent) -> Result<PolicyEvent, RightsGateError> {
        if signed.key_id != self.key_id {
            return Err(crate::cause!(RightsGateError::WrongKey));
        }
        if !signed.key_id.starts_with("key:") {
            return Err(crate::cause!(RightsGateError::WrongKey));
        }
        let payload = URL_SAFE_NO_PAD
            .decode(&signed.payload)
            .map_err(|error| crate::carry_cause!(RightsGateError::InvalidEvent, error))?;
        let signature = URL_SAFE_NO_PAD
            .decode(&signed.signature)
            .map_err(|error| crate::carry_cause!(RightsGateError::InvalidEvent, error))?;
        if payload.len() > MAX_EVENT_BYTES || signature.len() != 64 {
            return Err(crate::cause!(RightsGateError::InvalidEvent));
        }
        let mut message = Vec::with_capacity(POLICY_DOMAIN.len() + payload.len());
        message.extend_from_slice(POLICY_DOMAIN);
        message.extend_from_slice(&payload);
        UnparsedPublicKey::new(&ED25519, &self.public_key)
            .verify(&message, &signature)
            .map_err(|error| crate::carry_cause!(RightsGateError::InvalidEvent, error))?;
        let event: PolicyEvent =
            serde_json::from_slice(&payload).map_err(|error| crate::carry_cause!(RightsGateError::InvalidEvent, error))?;
        if event.version != POLICY_EVENT_VERSION
            || event.epoch == 0
            || !event.nonce.starts_with("grant:")
            || event.nonce.len() > 256
            || match event.kind.as_str() {
                "snapshot" => event.update_id.is_some() || event.snapshot_identity.is_some(),
                "fence" => {
                    !valid_update_id(event.update_id.as_deref())
                        || event.snapshot_identity.is_some()
                }
                "update" => {
                    !valid_update_id(event.update_id.as_deref())
                        || !valid_snapshot_identity(event.snapshot_identity.as_deref())
                }
                _ => true,
            }
        {
            return Err(crate::cause!(RightsGateError::InvalidEvent));
        }
        Ok(event)
    }
}

fn valid_update_id(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        !value.trim().is_empty() && value.len() <= 200 && !value.chars().any(char::is_control)
    })
}

fn valid_snapshot_identity(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// Non-cloneable permit with a private constructor; dropping it releases the
/// shared serialization pause.
pub struct CommitPermit<'a> {
    _serial: MutexGuard<'a, ()>,
    scope: Scope,
    gate: &'a MacRightsGate,
}

impl CommitPermit<'_> {
    pub fn assert_scope(&self, scope: &Scope) -> bool {
        scope == &self.scope
    }

    /// Confirm that this permit came from the exact in-memory gate, not a
    /// different gate configured with an equal route and signing key.
    pub fn belongs_to(&self, gate: &MacRightsGate) -> bool {
        std::ptr::eq(self.gate, gate)
    }

    pub(crate) fn mark_outcome_unknown(&self, request_key: &str) {
        let mut state = self
            .gate
            .state
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        state.unresolved_outcomes.insert(request_key.to_owned());
        state.paused = true;
    }
}

impl FreshRights for MacRightsGate {
    fn current_revision(&self, scope: &Scope, client_id: &str, _now_ms: i64) -> Option<String> {
        let state = self.state.read().ok()?;
        if !state.available || state.paused || !scope_matches_route(scope, &state.route) {
            return None;
        }
        let right = state.clients.get(client_id)?;
        // Every operation currently admitted by this generic device gate has
        // a private floor. The addressed own-record contract has the same
        // floor; shared-facing exceptions need an installed-method consumer
        // that binds this scope to the implementation and its output filter.
        (right.allowed && right.reach.as_ref().is_some_and(|reach| reach.private))
            .then(|| right.rights_revision.clone())
    }
}

fn scope_matches_route(scope: &Scope, route: &Route) -> bool {
    scope.account_id == route.account_id
        && scope.device_id == route.device_id
        && scope.resource_address == route.resource_address
        && scope.generation == route.generation
}

fn validate_clients(clients: &[ClientRight]) -> Result<(), RightsGateError> {
    if clients.len() > MAX_CLIENTS {
        return Err(crate::cause!(RightsGateError::InvalidEvent));
    }
    let mut ids = HashSet::with_capacity(clients.len());
    for client in clients {
        if client.client_id.trim().is_empty()
            || client.client_id.len() > 256
            || client.rights_revision.trim().is_empty()
            || client.rights_revision.len() > 160
            || (client.allowed && client.reach.is_none())
            || !ids.insert(client.client_id.as_str())
        {
            return Err(crate::cause!(RightsGateError::InvalidEvent));
        }
    }
    Ok(())
}

fn into_clients(clients: Vec<ClientRight>) -> HashMap<String, ClientRight> {
    clients
        .into_iter()
        .map(|client| (client.client_id.clone(), client))
        .collect()
}
