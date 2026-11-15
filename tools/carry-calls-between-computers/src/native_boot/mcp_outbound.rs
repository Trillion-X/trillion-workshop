//! Optional outbound composition on the original native host lifetime.
//! The private parent supplies an existing tc_ credential and bounded retry
//! DATA. The selected account supplies current registration; its signed app
//! configuration supplies the public service origin. None has a default.
use super::{forwarder_connection::SelectedMacDispatcher, mcp_credential::SelectedCredentialAdmission, SelectedAccount};
use crate::account::account_routes::Current as ParentConnectionCurrent;
use content_crypto::advanced::blake3;
use crate::{
    account_rights::resource_connection::credential::{self, IssuedCredential},
    native::ResourceConnectionSettings,
    native_host::{OwnedConnectionTask, ResourceConnectionSlot},
    forwarder::{session::{self, ConnectionAdmission, ConnectionGrant}, tls},
    record_log::{CanonicalLogIds, LogIds},
};
use std::{collections::HashMap, io, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};

/// The product's wall clock in milliseconds, read through the one clock trait (a test supplies its own).
fn now_ms() -> i64 {
    use crate::storage::time_source::Clock as _;
    crate::storage::time_source::RealClock.now_ms()
}

fn unavailable() -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, "resource connection unavailable") }

/// One stderr line per event of this computer's public session: the device it connects as and a reason word or the
/// computers rows it tells. Ids, revisions and reason words only: never a key, credential or content.
fn log_session(event: &str, device: &str, detail: &str) {
    crate::quiet_eprintln!("public-session event={event} device={device}{detail}");
}

fn endpoint(selected: &Arc<Mutex<SelectedAccount>>) -> Option<(String, u16)> {
    let owner = crate::workspace_session::owner_wait::acquire(selected, || false).ok()?;
    owner.selection.assert_current().ok()?;
    let service = owner.selection.selected_mcp_service_endpoints().ok()??;
    let endpoint = (service.tls_host().to_owned(), service.tls_port());
    owner.selection.assert_current().ok()?;
    Some(endpoint)
}

/// The check every check of a carried operation asks of the connection that carried it (`account_routes::Caller::also`): the
/// connection is not withdrawn or replaced (the host's current credential sets `cancelled` on both) and its grant has not expired. The
/// connection's registration is this account's own, kept by this program (`SelectedCredentialAdmission`, the same owner
/// the account routes' `/devices/resource-connections/admit` answers from), and it is read there before and after every message
/// (`current`). A check runs while the operation holds the account, so it reads only these lock-free facts: asking the
/// registration again there would wait on the account it already holds, and asking it through the public routes would
/// leave this computer to reach this same program through the internet, once per check.
fn parent_connection_current(grant: &ConnectionGrant, cancelled: Arc<AtomicBool>) -> ParentConnectionCurrent {
    let expires_at_ms = grant.expires_at_ms;
    Arc::new(move || {
        let now = now_ms();
        !cancelled.load(Ordering::Acquire) && now > 0 && now < expires_at_ms
    })
}

fn current(selected: &Arc<Mutex<SelectedAccount>>, admission: &SelectedCredentialAdmission,
    grant: &ConnectionGrant, expected: &(String, u16), cancelled: &AtomicBool) -> bool {
    !cancelled.load(Ordering::Acquire) && admission.is_current(grant, now_ms())
        && endpoint(selected).as_ref() == Some(expected)
}

fn attempt(selected: &Arc<Mutex<SelectedAccount>>, settings: &ResourceConnectionSettings,
    admission: &SelectedCredentialAdmission, credential: &IssuedCredential,
    runtime: &tokio::runtime::Handle, cancelled: Arc<AtomicBool>,
    on_admitted: impl FnOnce()) -> io::Result<()> {
    if cancelled.load(Ordering::Acquire) { return crate::io_operation!(Err(io::Error::new(io::ErrorKind::Interrupted, "resource connection cancelled"))); }
    let endpoint = crate::io_operation!((endpoint(selected).ok_or_else(unavailable)).map_err(std::io::Error::from))?;
    let now = now_ms();
    let grant = credential.grant();
    if !admission.is_current(grant, now) { return crate::io_operation!(Err(unavailable())); }
    let remaining = crate::io_operation!((grant.expires_at_ms.checked_sub(now)
        .and_then(|value| u64::try_from(value).ok()).filter(|value| *value > 0).ok_or_else(unavailable)).map_err(std::io::Error::from))?;
    let deadline = crate::io_operation!((Instant::now().checked_add(Duration::from_millis(remaining)).ok_or_else(unavailable)).map_err(std::io::Error::from))?;
    // Publish the exact local short credential before opening the public Mac session.
    // The callback stays local: it checks this current credential, grant and selected source,
    // and never recursively invokes remote parent authority validation.
    crate::io_operation!((super::mcp_selected_personal::resource_connection_publication::publish_current(
        selected, settings, credential, deadline,
        &|| current(selected, admission, grant, &endpoint, &cancelled),
    )).map_err(std::io::Error::from))?;
    if !current(selected, admission, grant, &endpoint, &cancelled) { return crate::io_operation!(Err(unavailable())); }
    let parent_current = parent_connection_current(grant, cancelled.clone());
    // Every operation the public routes carry here is admitted by the account's own sign-in.
    let dispatcher = crate::io_operation!((SelectedMacDispatcher::new_with_parent_current(
        selected.clone(), grant.route.clone(), parent_current.clone(), std::sync::Arc::new(crate::storage::time_source::RealClock),
    ).map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?;
    let stream = crate::io_operation!((tls::connect_mac_resource_wss_while(&endpoint.0, endpoint.1,
        Duration::from_millis(settings.connect_timeout_ms), Duration::from_millis(settings.io_timeout_ms),
        cancelled.clone(), deadline)).map_err(std::io::Error::from))?;
    // DNS/TLS can take time. Recheck the original registration and selected
    // origin before the first credential byte reaches the verified peer.
    if !current(selected, admission, grant, &endpoint, &cancelled) { return crate::io_operation!(Err(unavailable())); }
    // Only the issued short-lived token crosses WSS. The original tc_ computer
    // credential remains private to this process and the local selected issuer.
    // The session tells the account's own signed computers row and public key, naming this computer's admitted
    // device as copy keeper and a computer that may answer when the account has no row yet (forwarder_connection::told).
    let told = super::forwarder_connection::told(selected, &grant.route.device_id);
    let rows: String = told.iter().map(|row| row.log_words(&grant.route.device_id)).collect();
    log_session("opening", &grant.route.device_id, &rows);
    crate::io_operation!(session::connect_mac_session_telling_kept_accounts(stream, credential.as_bytes(), &told, &[], &grant.route, std::sync::Arc::new(crate::storage::time_source::RealClock),
        || {
            if !current(selected, admission, grant, &endpoint, &cancelled) { return Err(unavailable()); }
            // Admission ended the prior failure streak even when this healthy
            // session later expires or ends with an I/O error.
            log_session("admitted", &grant.route.device_id,
                &format!(" expires_in_ms={}", grant.expires_at_ms.saturating_sub(now_ms())));
            on_admitted();
            Ok(())
        },
        |bytes| dispatcher.readmits(bytes),
        |bytes| {
            if !current(selected, admission, grant, &endpoint, &cancelled) { return Err(crate::refusal_cause::CodedError::new(())); }
            let reply = runtime.block_on(dispatcher.dispatch(bytes))?;
            if !current(selected, admission, grant, &endpoint, &cancelled) { return Err(crate::refusal_cause::CodedError::new(())); }
            Ok(reply)
        }))
}

/// This host's retained mint identity and current token. Every state change
/// follows an authenticated selected-owner observation; contention is not
/// absence. This owns no persistence, timer, resource operation or scheduler.
#[derive(Default)]
pub(crate) struct CredentialState {
    active: Option<IssuedCredential>,
    pending: Option<(String, u64)>,
}
impl CredentialState {
    #[cfg(test)]
    pub(crate) fn with_pending(request_key: &str, revision: u64) -> Self {
        Self { active: None, pending: Some((request_key.to_owned(), revision)) }
    }
    #[cfg(test)]
    pub(crate) fn pending(&self) -> Option<(&str, u64)> {
        self.pending.as_ref().map(|(key, revision)| (key.as_str(), *revision))
    }
    pub(crate) fn active(&self) -> Option<&IssuedCredential> { self.active.as_ref() }
    /// The credential kept for the next session, handed to it; the next pass recovers it from the owner again.
    pub(crate) fn take_active(&mut self) -> Option<IssuedCredential> { self.active.take() }

    /// Keep a current credential that expires after `newer_than` (`now` for a first session; the expiry of the
    /// session in service when it is due to be replaced), issuing one when the owner holds none such.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn maintain(&mut self, admission: &SelectedCredentialAdmission, key: &[u8], now: i64, newer_than: i64,
        deadline: Instant, cancel: Arc<AtomicBool>, ids: &mut dyn LogIds) {
        let outlasts = |issued: &IssuedCredential| issued.grant().expires_at_ms > newer_than;
        let active_current = self.active.as_ref()
            .is_some_and(|issued| outlasts(issued) && admission.is_current(issued.grant(), now));
        let mut may_issue = false;
        if !active_current || self.pending.is_some() {
            match admission.recover_current(key, now) {
                Ok(Some(recovered)) if outlasts(&recovered) => {
                    // A current original result or later CAS successor makes
                    // the older expected revision unable to commit again.
                    let reconciled = self.pending.as_ref()
                        .is_none_or(|(_, expected)| recovered.revision() > *expected);
                    self.active = Some(recovered);
                    if reconciled { self.pending = None; }
                    else { may_issue = true; }
                },
                // Only authenticated positive absence/expiry, or a current
                // credential that ends with the session it would replace,
                // permits a fresh mint. Reconcile a pending unknown by exact
                // issue first.
                Ok(_) => { self.active = None; may_issue = true; },
                // Failed recovery preserves both retained values and can
                // never initiate issuance on this maintenance pass.
                Err(_) => {},
            }
        }
        if may_issue && self.active.is_none() && self.pending.is_none() {
            if let Ok(revision) = admission.current_revision(key, now) {
                if let Some(request_key) = ids.next_log_id() { self.pending = Some((request_key, revision)); }
            }
        }
        if let Some((request_key, revision)) = self.pending.as_ref().filter(|_| may_issue) {
            match admission.issue(key, request_key, *revision, session::MAX_SESSION_LIFE_MS as u64,
                now, deadline, cancel) {
                Ok(issued) => { self.active = Some(issued); self.pending = None; },
                // Exact issue conclusively reconciles expiration or the known
                // CAS successor. A subsequent pass may then create a new ID.
                Err(credential::Error::Expired(_) | credential::Error::Conflict(_)) => { self.pending = None; },
                // Unavailable/potentially committed issuance retains its exact
                // request identity and expected revision for reconciliation.
                Err(_) => {},
            }
        }
    }

}

fn connection_key_identity(key: &[u8]) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"resource-connection-key-v1\0");
    hasher.update(key);
    *hasher.finalize().as_bytes()
}

const MAX_RETAINED_PENDING_CONNECTION_STATES: usize = 8;

/// Keep the state of the key in use (`current`), and of each other key only while it holds a pending issue and stopped
/// being in use less than `stale_after` ago (`retired`, filled here at the first pass a key is seen not in use).
fn retain_states(credentials: &mut HashMap<[u8; 32], CredentialState>, retired: &mut HashMap<[u8; 32], Instant>,
    current: [u8; 32], now: Instant, stale_after: Duration) {
    for key in credentials.keys().filter(|key| **key != current) {
        retired.entry(*key).or_insert(now);
    }
    retired.remove(&current);
    credentials.retain(|key, state| *key == current
        || (state.pending.is_some() && retired.get(key).is_none_or(|at| now.saturating_duration_since(*at) < stale_after)));
    retired.retain(|key, _| credentials.contains_key(key));
}

/// A session in service on its own thread, and when it is due to be replaced.
struct Serving<'scope> {
    session: std::thread::ScopedJoinHandle<'scope, io::Result<()>>,
    device_id: String,
    expires_at_ms: i64,
    replace_at_ms: i64,
    admitted: Arc<AtomicBool>,
    /// When the session was started, so one that was admitted and then ended at once is not followed at once.
    opened: Instant,
}

/// The wait before the next session after one ended, and the retry count after it. A session that was admitted and
/// served at least the first retry delay is followed at once, and the count starts again (a forwarder restart, a
/// replacement, its lifetime). One that was never admitted, or was admitted and then ended at once (the forwarder
/// retires it right after its acknowledgement: two processes connecting as one device, rows it would not take), waits
/// the next delay of the schedule and counts one more. Before, any admitted session reset the count and was followed
/// at once, so a forwarder that ends each session right after admitting it was reconnected to in a tight loop; and
/// the count was raised even when no wait was taken, so the next failure skipped the schedule's first delay.
fn after_session_ends(admitted: bool, served_ms: u64, retries: usize, delays: &[u64]) -> (Option<u64>, usize) {
    let first = delays.first().copied().unwrap_or(0);
    if admitted && served_ms >= first {
        return (None, 0);
    }
    let delay = delays.get(retries.min(delays.len().saturating_sub(1))).copied().unwrap_or(first);
    (Some(delay), retries.saturating_add(1))
}

/// When a session granted at `now` until `expires_at_ms` is replaced: with a third of its life left, so the next
/// session is admitted while this one still serves and the account is never without a live session between them.
fn replace_at(now: i64, expires_at_ms: i64) -> i64 {
    expires_at_ms.saturating_sub(expires_at_ms.saturating_sub(now) / 3)
}

/// How long the connection task sleeps while a session serves, so it notices one that ended early.
const SERVING_POLL: Duration = Duration::from_secs(1);

/// Own one reconnecting connection task on the native host's existing tokio executor. The
/// shared host's current credential publishes only validated boot/update/withdraw snapshots;
/// local account readiness does not wait for remote service setup.
/// Original resource retries stay with the client and are never resent here.
/// Each session serves on its own thread. Before it expires the next one is
/// opened with a fresh credential (make before break): the forwarder's
/// list of connected computers installs the new session and retires the old one, which ends at
/// its next message or its expiry, so a session's end is never a gap.
pub(crate) fn prepare(selected: Arc<Mutex<SelectedAccount>>) -> OwnedConnectionTask {
    Box::new(move |runtime, cancelled, slot: ResourceConnectionSlot| {
        let admission = SelectedCredentialAdmission::new(selected.clone());
        let mut ids = CanonicalLogIds::default();
        let mut credentials = HashMap::<[u8; 32], CredentialState>::new();
        // When each retained key stopped being the current credential's key.
        let mut retired_keys = HashMap::<[u8; 32], Instant>::new();
        let mut retries = 0usize;
        let mut observed_epoch = None;
        std::thread::scope(|scope| {
            let mut serving: Option<Serving<'_>> = None;
            // Replaced sessions still ending; each ends at its next message or its expiry.
            let mut replaced: Vec<std::thread::ScopedJoinHandle<'_, io::Result<()>>> = Vec::new();
            while !cancelled.load(Ordering::Acquire) {
                replaced.retain(|session| !session.is_finished());
                let snapshot = slot.snapshot();
                let new_epoch = observed_epoch != Some(snapshot.epoch);
                if new_epoch {
                    observed_epoch = Some(snapshot.epoch);
                    retries = 0;
                }
                let Some(settings) = snapshot.settings.clone() else {
                    if new_epoch { log_session("waiting", "none", " reason=no-device-key"); }
                    // Withdrawal means no old-key publication, mint or reconnect.
                    // Wait in the connection task while local host work stays ready.
                    slot.wait_change_or_timeout(snapshot.epoch, Duration::from_secs(60), &cancelled);
                    continue;
                };
                if snapshot.cancelled.load(Ordering::Acquire) || !settings.valid() {
                    slot.wait_change_or_timeout(snapshot.epoch, Duration::from_millis(100), &cancelled);
                    continue;
                }
                // A session that ended: one that was never admitted waits out the retry schedule first.
                if serving.as_ref().is_some_and(|current| current.session.is_finished()) {
                    let ended = serving.take().expect("a serving session");
                    let admitted = ended.admitted.load(Ordering::Acquire);
                    let outcome = ended.session.join().unwrap_or_else(|_| Err(io::Error::other("connection session failed")));
                    log_session("ended", &ended.device_id, &format!(" admitted={admitted} outcome={}",
                        outcome.as_ref().map_or_else(|error| format!("{:?}", error.kind()), |_| "closed".to_owned())));
                    let served_ms = u64::try_from(ended.opened.elapsed().as_millis()).unwrap_or(u64::MAX);
                    let (wait, next) = after_session_ends(admitted, served_ms, retries, &settings.retry_delays_ms);
                    retries = next;
                    if let Some(delay) = wait {
                        // A current-credential update or withdrawal wakes this wait and the next loop
                        // observes its new epoch and cancellation token immediately.
                        slot.wait_change_or_timeout(snapshot.epoch, Duration::from_millis(delay), &cancelled);
                        continue;
                    }
                }
                // A session in service and not yet due to be replaced: wait for that time, its end or a current credential change.
                if let Some(current) = serving.as_ref() {
                    let now = now_ms();
                    if now < current.replace_at_ms {
                        let left = u64::try_from(current.replace_at_ms - now).unwrap_or(0);
                        slot.wait_change_or_timeout(snapshot.epoch, SERVING_POLL.min(Duration::from_millis(left)), &cancelled);
                        continue;
                    }
                }
                let key_identity = connection_key_identity(settings.key.as_bytes());
                // Resolved identities can be rebuilt from the canonical owner. An
                // unresolved exact issue stays with its original key for recovery.
                // A key no longer in use keeps its pending issue only while a credential that issue may have made could
                // still be current: at most one session life (`session::MAX_SESSION_LIFE_MS`) after the key stopped being
                // used, which is after the issue was tried. Before, such states were kept for good, and after
                // `MAX_RETAINED_PENDING_CONNECTION_STATES` key changes with an unknown issue each, no new key could connect.
                let stale_after = Duration::from_millis(session::MAX_SESSION_LIFE_MS as u64);
                retain_states(&mut credentials, &mut retired_keys, key_identity, Instant::now(), stale_after);
                if !credentials.contains_key(&key_identity) {
                    if credentials.len() >= MAX_RETAINED_PENDING_CONNECTION_STATES {
                        // Every retained state is a key changed less than one session life ago: the wait ends before
                        // the oldest of them may be dropped.
                        slot.wait_change_or_timeout(snapshot.epoch, stale_after.min(Duration::from_secs(60)), &cancelled);
                        continue;
                    }
                    credentials.insert(key_identity, CredentialState::default());
                }
                let state = credentials.get_mut(&key_identity).expect("connection state inserted");
                let now = now_ms();
                // The next session's credential must outlast the one in service.
                let newer_than = serving.as_ref().map_or(now, |current| current.expires_at_ms);
                if endpoint(&selected).is_some() {
                    let deadline = Instant::now() + Duration::from_millis(settings.io_timeout_ms);
                    state.maintain(&admission, settings.key.as_bytes(), now, newer_than, deadline,
                        snapshot.cancelled.clone(), &mut ids);
                }
                let ready = state.active().is_some_and(|issued| issued.grant().expires_at_ms > newer_than)
                    && endpoint(&selected).is_some();
                let Some(issued) = ready.then(|| state.take_active()).flatten() else {
                    log_session("waiting", "none", &format!(" reason={}", if endpoint(&selected).is_some() { "no-credential" } else { "no-endpoint" }));
                    let delay = settings.retry_delays_ms[retries.min(settings.retry_delays_ms.len() - 1)];
                    retries = retries.saturating_add(1);
                    slot.wait_change_or_timeout(snapshot.epoch, Duration::from_millis(delay), &cancelled);
                    continue;
                };
                let admitted = Arc::new(AtomicBool::new(false));
                let expires_at_ms = issued.grant().expires_at_ms;
                let device_id = issued.grant().route.device_id.clone();
                let session = {
                    let (selected, admission, runtime) = (&selected, &admission, runtime.clone());
                    let (cancel, admitted) = (snapshot.cancelled.clone(), admitted.clone());
                    scope.spawn(move || attempt(selected, &settings, admission, &issued, &runtime, cancel,
                        || admitted.store(true, Ordering::Release)))
                };
                if let Some(previous) = serving.replace(Serving {
                    session, device_id, expires_at_ms, replace_at_ms: replace_at(now, expires_at_ms), admitted,
                    opened: Instant::now(),
                }) {
                    replaced.push(previous.session);
                }
            }
        });
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(expires_at_ms: i64) -> ConnectionGrant {
        ConnectionGrant {
            route: crate::resource_authority::Route {
                account_id: "a".repeat(64), device_id: "d".repeat(64),
                resource_address: "@own-records".into(), generation: "connection:synthetic".into(),
            },
            expires_at_ms,
            admission_identity: None,
        }
    }

    #[test]
    fn a_check_reads_only_the_connections_own_cancel_and_expiry() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let live = parent_connection_current(&grant(now_ms() + 60_000), cancelled.clone());
        let started = Instant::now();
        for _ in 0..1_000 {
            assert!(live());
        }
        assert!(started.elapsed() < Duration::from_millis(100), "a thousand checks took {:?}", started.elapsed());
        cancelled.store(true, Ordering::Release);
        assert!(!live(), "a withdrawn or replaced connection stops its operations at their next check");
        let expired = parent_connection_current(&grant(now_ms() - 1), Arc::new(AtomicBool::new(false)));
        assert!(!expired(), "an expired connection stops its operations at their next check");
    }

    #[test]
    fn a_pending_issue_of_a_key_no_longer_in_use_is_kept_one_session_life_only() {
        let life = Duration::from_millis(session::MAX_SESSION_LIFE_MS as u64);
        let start = Instant::now();
        let mut credentials = HashMap::new();
        let mut retired = HashMap::new();
        for old in 0..MAX_RETAINED_PENDING_CONNECTION_STATES as u8 {
            credentials.insert([old; 32], CredentialState::with_pending("request", 1));
        }
        credentials.insert([99; 32], CredentialState::default());
        let current = [100; 32];
        retain_states(&mut credentials, &mut retired, current, start, life);
        assert_eq!(credentials.len(), MAX_RETAINED_PENDING_CONNECTION_STATES, "pending issues are kept, a resolved old key is not");
        retain_states(&mut credentials, &mut retired, current, start + life / 2, life);
        assert_eq!(credentials.len(), MAX_RETAINED_PENDING_CONNECTION_STATES, "still within one session life");
        retain_states(&mut credentials, &mut retired, current, start + life, life);
        assert!(credentials.is_empty() && retired.is_empty(), "then a new key has room again");
        // A key that comes back into use keeps its pending issue for reconciliation.
        credentials.insert([1; 32], CredentialState::with_pending("request", 1));
        retain_states(&mut credentials, &mut retired, [2; 32], start, life);
        retain_states(&mut credentials, &mut retired, [1; 32], start + life * 2, life);
        assert!(credentials.contains_key(&[1; 32]) && retired.is_empty());
    }

    #[test]
    fn a_session_admitted_and_ended_at_once_waits_and_a_healthy_one_is_followed_at_once() {
        let delays = [1_000, 5_000, 60_000];
        // Healthy: admitted and served past the first delay. Followed at once; the count starts again.
        assert_eq!(after_session_ends(true, 80_000, 2, &delays), (None, 0));
        // Admitted and ended at once, again and again: the schedule grows as for a refusal, never a tight loop.
        let (mut retries, mut waits) = (0, Vec::new());
        for _ in 0..4 {
            let (wait, next) = after_session_ends(true, 10, retries, &delays);
            waits.push(wait.expect("a wait"));
            retries = next;
        }
        assert_eq!(waits, vec![1_000, 5_000, 60_000, 60_000]);
        // Never admitted after a healthy session: the first delay of the schedule, not the second.
        let (_, after_healthy) = after_session_ends(true, 80_000, 3, &delays);
        assert_eq!(after_session_ends(false, 0, after_healthy, &delays), (Some(1_000), 1));
    }

    #[test]
    fn the_next_session_opens_while_the_one_in_service_still_has_a_third_of_its_life() {
        let granted = 1_000_000;
        let life = session::MAX_SESSION_LIFE_MS;
        let at = replace_at(granted, granted + life);
        assert_eq!(at, granted + life - life / 3);
        // The longest a next session takes to be admitted is its TLS connect plus one I/O wait (the most the
        // connection settings allow: 1 s and 30 s); the old session still serves for all of it.
        assert!(granted + life - at > 1_000 + 30_000, "replacement starts {} ms before expiry", granted + life - at);
        assert_eq!(replace_at(granted, granted), granted, "an expired grant is replaced at once");
    }
}
