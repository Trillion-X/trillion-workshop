// src/forwarder/session.rs
//
// Purpose: Message bounded request/reply sessions initiated by the Mac over a supplied confidential deadline-bound stream.
//
// Non-Negotiable Invariants:
// - Require trusted connection admission before a route becomes ready.
// - Bound credentials, messages, acknowledgements and session lifetime.
// - Stream possession and framing never grant client resource rights.
//
// Key Concepts:
// - ConnectionGrant, ForwarderConnection and explicit admission acknowledgement.
// - Mac-side dispatch, current registration and original invocation identity.
// - Each message carries its deadline; the Mac answers a message whose deadline has passed with a refusal and never
//   dispatches it, so messages the forwarder gave up on cannot delay a fresh one.
// - The registration is re-read once per message, at the send boundary where a client credential leaves; readiness,
//   connected computers and the reply are judged on local facts (acknowledgement, retirement, lifetime, deadline), so no route
//   lookup waits on the canonical owner or on another message in flight.
// - The registration read has three answers (Registration): current sends, withdrawn retires the session, and an
//   owner that could not be read refuses only that message, so a network blip never ends a healthy session.
//
// Security Considerations:
// - The caller supplies confidentiality and I/O deadlines; this module does not establish TLS.
// - Retire failed or expired sessions and keep resource rights checks at actual commitment.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Bounded request/reply framing on a connection initiated by the Mac.
//! The caller supplies a confidential stream with read/write deadlines and a
//! trusted connection admitter. Neither framing nor possession of a stream
//! grants client resource rights; the Mac dispatcher checks those at commit.
use super::ComputerConnections;
use crate::account::computers::{self, KeptAccount};
use zeroize::Zeroize;
use crate::resource_authority::{decode_message, Route};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use zeroize::Zeroizing;

/// The most bytes one session message may carry: one account request in base64 inside its envelope
/// (`crate::mcp::carried_message_bytes`, from src/mcp/settings.json `request_bytes`).
fn max_message_bytes() -> usize {
    crate::mcp::carried_message_bytes()
}
const MAX_CREDENTIAL_BYTES: usize = 8_192;
pub(crate) const MAX_SESSION_LIFE_MS: i64 = 120_000;
const MAX_ACK_BYTES: usize = 4_096;
const ACK_VERSION: &str = "trillion.resource-connection-admitted/v1";

#[derive(Serialize, Deserialize)]
struct ConnectionAck {
    version: String,
    route: Route,
    expires_at_ms: i64,
}

#[derive(Clone)]
pub struct ConnectionGrant {
    pub route: Route,
    pub expires_at_ms: i64,
    /// Optional opaque current-credential identity owned by the supplied
    /// admitter. It is transient; the existing wire ACK remains unchanged.
    /// It must never contain the raw credential, an operation or user content.
    pub admission_identity: Option<String>,
}

/// What the registration owner says of a grant now. `Unknown` is an owner that
/// could not be read (unreachable, timed out, an answer that cannot be read):
/// nothing is sent on such a read, and nothing is retired by it, because a
/// network blip is not a withdrawal.
#[derive(Clone, Debug)]
pub enum Registration {
    Current,
    Withdrawn(crate::refusal_cause::Cause),
    Unknown(crate::refusal_cause::Cause),
}
impl Registration {
    pub fn cause(&self) -> Option<crate::refusal_cause::Cause> {
        match self { Self::Current => None, Self::Withdrawn(cause) | Self::Unknown(cause) => Some(cause.clone()) }
    }
}
impl PartialEq for Registration {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Registration {}

/// Implemented by the current device-registration authority. It must consume
/// a one-device credential and return only the exact currently admitted route.
pub trait ConnectionAdmission: Send + Sync {
    fn admit(&self, credential: &[u8], now_ms: i64) -> Option<ConnectionGrant>;
    /// Re-read the current registration/route. Unavailable state denies. A
    /// forwarder connection asks it when it acknowledges a session and once per message,
    /// before the message's bytes are written; it may be a remote read, so
    /// nothing else (readiness, connected computers, a route lookup) waits on it.
    fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool;
    /// The same read with its third answer: an owner that can be unreachable
    /// answers `Unknown` then, so the forwarder connection refuses that one message and keeps
    /// the session. An owner read in this process is never unreachable.
    fn registration(&self, grant: &ConnectionGrant, now_ms: i64) -> Registration {
        if self.is_current(grant, now_ms) { Registration::Current } else { crate::cause!(Registration::Withdrawn) }
    }
}

/// Whether `route` is a computer's own session rather than one account's: its credential names the computer itself as the
/// account (`ComputerSigner::session_credential(computer_id)`), so the route's account is its device. One such session
/// carries every account the computer told on it (src/native_entry/computer.rs `serve_computer_session`); each message names
/// its account, which must be one the session told.
pub(crate) fn computer_wide(route: &Route) -> bool {
    route.account_id == route.device_id
}

fn valid(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.bytes().any(|byte| byte < 32)
}

fn valid_route(route: &Route) -> bool {
    valid(&route.account_id, 512)
        && valid(&route.device_id, 160)
        && valid(&route.resource_address, 512)
        && valid(&route.generation, 512)
}

fn valid_admission_identity(grant:&ConnectionGrant)->bool {
    grant.admission_identity.as_deref().is_none_or(|value|valid(value,160))
}

/// Read one length-prefixed message. `Ok(None)` is a clean end: the peer closed before the first length byte. An end
/// inside a message (in its length or its body) is `UnexpectedEof`, never a clean end, so a cut message is never
/// taken for a closed session. An error at the first byte is never read again here, `Interrupted` included: the Mac's
/// deadline-bound stream answers every read of a withdrawn or replaced connection with `Interrupted`
/// (src/forwarder/tls.rs `current_connection`), so reading again would spin on it and the session would never end.
fn read_message(stream: &mut impl Read, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut size = [0_u8; 4];
    if crate::io_operation!((stream.read(&mut size[..1])).map_err(std::io::Error::from))? == 0 {
        return Ok(None);
    }
    crate::io_operation!((stream.read_exact(&mut size[1..])).map_err(std::io::Error::from))?;
    let size = u32::from_be_bytes(size) as usize;
    if size == 0 || size > limit {
        return crate::io_operation!(Err(io::Error::new(
            io::ErrorKind::InvalidData,
            crate::refusal_cause::CodedError::new("invalid session message"),
        )));
    }
    let mut message = vec![0_u8; size];
    crate::io_operation!((stream.read_exact(&mut message)).map_err(std::io::Error::from))?;
    Ok(Some(message))
}

fn write_message(stream: &mut impl Write, message: &[u8]) -> io::Result<()> {
    crate::io_operation!(write_message_within(stream, message, max_message_bytes()))
}

/// `write_message` with its own bound: the list it tells a computer sends when its session opens is bounded by
/// `kept_accounts_max_bytes` (one session carries every account the computer holds), every other message by `max_message_bytes`.
fn write_message_within(stream: &mut impl Write, message: &[u8], limit: usize) -> io::Result<()> {
    if message.is_empty() || message.len() > limit {
        return crate::io_operation!(Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            crate::refusal_cause::CodedError::new("invalid session message"),
        )));
    }
    crate::io_operation!((stream.write_all(&(message.len() as u32).to_be_bytes())).map_err(std::io::Error::from))?;
    crate::io_operation!((stream.write_all(message)).map_err(std::io::Error::from))?;
    crate::io_operation!(stream.flush())
}

/// One admitted, route-bound connection. On any I/O ambiguity it is retired;
/// the caller must establish a fresh admitted connection before retrying with
/// the same original resource request key. It keeps the placement rows the
/// computer told when the session opened; the forwarder verifies them.
pub struct ForwarderConnection<S> {
    grant: ConnectionGrant,
    stream: Mutex<Option<S>>,
    acknowledged: AtomicBool,
    /// Set once the stream is given up (I/O ambiguity, refusal, lifetime). Read
    /// without the stream lock, so readiness never waits on a message in flight.
    retired: AtomicBool,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    admitted_at_ms: i64,
    authority: Arc<dyn ConnectionAdmission>,
    /// What the computer told when the session opened, and what it told again since (`tell_again`).
    told: Mutex<Vec<KeptAccount>>,
    /// The told accounts (by address) this session's computer does not answer yet: it has not caught up with the
    /// account's writer (`computers::kept_accounts_bytes_catching_up`). The forwarder sends their calls elsewhere.
    catching_up: Mutex<std::collections::HashSet<String>>,
    /// The socket address the connection was accepted from, for the log (`connected-computers`). Empty when unknown.
    peer: Mutex<String>,
}

impl<S: Read + Write + Send> ForwarderConnection<S> {
    /// Admit a credential carried on the already confidential, deadline-bound
    /// connection, then read the computer's list it tells of its placement rows
    /// (the message after the credential). The owner of the routes and the connected computers calls
    /// `acknowledge` while it holds the computer's turn and publishes the forwarder connection
    /// right after; no invoke is sent and the computer remains unready until then.
    pub fn admit_from_stream(
        mut stream: S,
        authority: Arc<dyn ConnectionAdmission>,
        now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    ) -> Option<Self> {
        // One stderr line for a session that is not admitted, with its reason word (never the credential).
        let refused = |reason: &str, cause: crate::refusal_cause::Cause| crate::quiet_eprintln!("session-admission event=refused reason={reason} cause={cause}");
        let credential = match read_message(&mut stream, MAX_CREDENTIAL_BYTES) {
            Ok(Some(credential)) => Zeroizing::new(credential),
            Ok(None) => { refused("credential-unreadable", crate::cause!(condition: credential_stream_ended)); return None; }
            Err(error) => { refused("credential-unreadable", crate::refusal_cause::Caused::cause(&error)); return None; }
        };
        let kept_accounts = match read_message(&mut stream, computers::settings().kept_accounts_max_bytes) {
            Ok(Some(accounts)) => accounts,
            Ok(None) => { refused("kept-accounts-unreadable", crate::cause!(condition: kept_accounts_stream_ended)); return None; }
            Err(error) => { refused("kept-accounts-unreadable", crate::refusal_cause::Caused::cause(&error)); return None; }
        };
        let Some(told) = computers::read_kept_accounts_catching_up(&kept_accounts) else {
            refused("kept-accounts-unreadable", crate::cause!(condition: kept_accounts_not_decodable)); return None;
        };
        let (told, catching_up) = told;
        let admitted = Self::admit(stream, &credential, authority, now_ms, told);
        if let Some(admitted) = &admitted {
            if let Ok(mut held) = admitted.catching_up.lock() {
                held.extend(catching_up);
            }
        }
        admitted
    }

    /// The accounts this session's computer told (each account's computers row
    /// and public key). Unbelieved: the forwarder checks each one
    /// (`KeptAccount::believed`) before using it.
    pub fn told(&self) -> Vec<KeptAccount> {
        self.told.lock().map(|told| told.clone()).unwrap_or_default()
    }

    /// The socket address this connection was accepted from (`set_peer`), empty when it is not known.
    pub fn peer(&self) -> String {
        self.peer.lock().map(|peer| peer.clone()).unwrap_or_default()
    }

    /// Record the socket address the connection was accepted from, once, before it is published.
    pub fn set_peer(&self, peer: &str) {
        if let Ok(mut held) = self.peer.lock() {
            *held = peer.to_owned();
        }
    }

    /// Whether this session's computer said it does not answer the account at `address` yet (it is catching up).
    pub fn catching_up(&self, address: &str) -> bool {
        self.catching_up.lock().map_or(true, |held| held.contains(address))
    }

    /// The computer says again whether it answers the account at `address` (`messages::TellAgain::catching_up`).
    pub fn set_catching_up(&self, address: &str, catching_up: bool) {
        if let Ok(mut held) = self.catching_up.lock() {
            if catching_up {
                held.insert(address.to_owned());
            } else {
                held.remove(address);
            }
        }
    }

    /// The computer tells `told` again while its session stays open (its computers row was edited): it takes the
    /// computer of what this session told for the same account, when that is not a newer revision; a row for an
    /// account this session never told is added, within `max_told_rows`. Unbelieved here, as at the open: the
    /// forwarder checks each row (`KeptAccount::believed`) before it uses it. Answers whether it was taken.
    pub fn tell_again(&self, told: KeptAccount) -> bool {
        let Ok(mut held) = self.told.lock() else { return false };
        let at = held.iter().position(|kept| kept.row.account == told.row.account && kept.row.pursuit == told.row.pursuit);
        match at {
            Some(at) if held[at].row.revision > told.row.revision => false,
            Some(at) => {
                held[at] = told;
                true
            }
            None if held.len() < computers::settings().max_told_rows => {
                held.push(told);
                true
            }
            None => false,
        }
    }

    /// Called by the owner of the routes and the connected computers under the computer's turn, which it
    /// holds until the forwarder connection is published. Acknowledgement is one-shot.
    pub fn acknowledge(&self) -> Result<(), crate::refusal_cause::CodedError<()>> {
        let mut guard = self.stream.lock().map_err(|_| crate::refusal_cause::CodedError::new(()))?;
        if self.acknowledged.load(Ordering::Acquire) {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        let now = self.now_ms.now_ms();
        if now < self.admitted_at_ms || now >= self.grant.expires_at_ms {
            self.give_up(&mut guard);
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        match self.authority.registration(&self.grant, now) {
            Registration::Current => {}
            Registration::Withdrawn(cause) | Registration::Unknown(cause) => {
                self.give_up(&mut guard);
                return Err(crate::refusal_cause::CodedError::with_cause((), cause));
            }
        }
        let ack = serde_json::to_vec(&ConnectionAck {
            version: ACK_VERSION.into(),
            route: self.grant.route.clone(),
            expires_at_ms: self.grant.expires_at_ms,
        })
        .map_err(|_| crate::refusal_cause::CodedError::new(()))?;
        if ack.len() > MAX_ACK_BYTES {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        if let Err(error) = write_message(guard.as_mut().ok_or_else(|| crate::refusal_cause::CodedError::new(()))?, &ack) {
            self.give_up(&mut guard);
            return Err(crate::refusal_cause::CodedError::with_cause((), crate::refusal_cause::Caused::cause(&error)));
        }
        self.acknowledged.store(true, Ordering::Release);
        Ok(())
    }

    fn admit(
        stream: S,
        credential: &[u8],
        authority: Arc<dyn ConnectionAdmission>,
        now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
        told: Vec<KeptAccount>,
    ) -> Option<Self> {
        if credential.is_empty() || credential.len() > MAX_CREDENTIAL_BYTES {
            crate::quiet_eprintln!("session-admission event=refused reason=credential-size cause={}", crate::cause!(condition: credential_empty_or_exceeds_limit));
            return None;
        }
        let now = now_ms.now_ms();
        let Some(grant) = authority.admit(credential, now) else {
            crate::quiet_eprintln!("session-admission event=refused reason=registration cause={}", crate::cause!(condition: admission_owner_refused));
            return None;
        };
        let invalid = |cause: crate::refusal_cause::Cause| {
            crate::quiet_eprintln!("session-admission event=refused reason=registration-invalid cause={cause}");
            None
        };
        if now <= 0 { return invalid(crate::cause!(condition: admission_clock_not_positive)); }
        if !valid_route(&grant.route) { return invalid(crate::cause!(condition: admission_route_invalid)); }
        if !valid_admission_identity(&grant) { return invalid(crate::cause!(condition: admission_identity_invalid)); }
        if grant.expires_at_ms <= now { return invalid(crate::cause!(condition: admission_grant_expired)); }
        let Some(lifetime) = grant.expires_at_ms.checked_sub(now) else { return invalid(crate::cause!(condition: admission_lifetime_overflow)); };
        if lifetime > MAX_SESSION_LIFE_MS { return invalid(crate::cause!(condition: admission_lifetime_exceeds_limit)); }
        match authority.registration(&grant, now) {
            Registration::Current => {}
            Registration::Withdrawn(cause) | Registration::Unknown(cause) => return invalid(cause),
        }
        Some(Self {
            grant,
            stream: Mutex::new(Some(stream)),
            acknowledged: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            now_ms,
            admitted_at_ms: now,
            authority,
            told: Mutex::new(told),
            catching_up: Mutex::new(std::collections::HashSet::new()),
            peer: Mutex::new(String::new()),
        })
    }

    pub fn route(&self) -> &Route {
        &self.grant.route
    }

    fn is_past_lifetime_at(&self, now: i64) -> bool {
        now < self.admitted_at_ms || now >= self.grant.expires_at_ms
    }

    pub(crate) fn is_past_lifetime(&self) -> bool {
        self.is_past_lifetime_at(self.now_ms.now_ms())
    }

    /// Connected computers is only advertised while the connection is acknowledged, not
    /// retired and within its lifetime. These are local facts read without the
    /// stream lock: a route lookup never waits on a message in flight or on the
    /// registration owner. The registration itself is re-read once per message,
    /// before its bytes leave (`invoke`); a withdrawal there retires the session.
    /// When this connection was admitted (`acknowledge`): its generation within one device.
    pub(crate) fn admitted_at_ms(&self) -> i64 {
        self.admitted_at_ms
    }

    pub(crate) fn is_ready(&self) -> bool {
        if self.retired.load(Ordering::Acquire) || !self.acknowledged.load(Ordering::Acquire) {
            return false;
        }
        if self.is_past_lifetime_at(self.now_ms.now_ms()) {
            self.retired.store(true, Ordering::Release);
            return false;
        }
        true
    }

    /// Give the connection up. Waits for a message in flight to finish, so a
    /// replacement becomes ready only after it (`ConnectedComputers::install`).
    pub(crate) fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        if let Ok(mut guard) = self.stream.lock() {
            *guard = None;
        }
    }

    /// Drop the stream held under `guard` and mark the session retired.
    fn give_up(&self, guard: &mut Option<S>) {
        self.retired.store(true, Ordering::Release);
        *guard = None;
    }
}

impl<S: Read + Write + Send> ComputerConnections for ForwarderConnection<S> {
    /// A message that never leaves (the session is retired or unacknowledged,
    /// its registration or lifetime no longer stands, or the message's deadline
    /// passed while it waited for its turn) is answered here with a correlated
    /// refusal, as the device would: the operation never started, so its
    /// outcome is known. `Err` means only that the outcome is unknown or the
    /// message is not this route's.
    fn invoke(&self, route: &Route, bytes: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
        if route != &self.grant.route {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        let mut message = decode_message(bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
        message.client_authorization.zeroize();
        // A computer's own session (`computer_wide`) carries every account it told: a message names one of them. A message
        // from another computer of an account may also name an account the computer does not keep yet: it is sent there
        // only when the account's newest believed row names the computer (`computer_route`), and the computer then joins
        // the account by itself (src/native_entry/computer/join_itself.rs).
        let between_computers = message.operation == crate::account::computers::settings().message_operation;
        let wide_account = computer_wide(route)
            && (between_computers || self.told().iter().any(|told| told.row.account == message.account_id));
        if (message.account_id != route.account_id && !wide_account)
            || message.device_id != route.device_id
            || message.resource_address != route.resource_address
            || message.generation != route.generation
        {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        let mut log = SendLog::new();
        let not_sent = |code: &str, cause: crate::refusal_cause::Cause| {
            crate::quiet_eprintln!("session-send-refused code={code} cause={cause}");
            refusal(&message.request_id, code, cause).map_err(|error| crate::refusal_cause::CodedError::with_cause((), crate::refusal_cause::Caused::cause(&error)))
        };
        let mut guard = self.stream.lock().map_err(|_| crate::refusal_cause::CodedError::with_cause((), log.refused("stream-lock-unavailable", crate::cause!(condition: session_stream_lock_poisoned))))?;
        log.turn_ms = log.started.elapsed().as_millis();
        if !self.acknowledged.load(Ordering::Acquire) || self.retired.load(Ordering::Acquire) {
            return not_sent(super::ROUTE_UNAVAILABLE, log.refused("not-ready", crate::cause!()));
        }
        // A message that waited here behind another one is not sent once its
        // deadline has passed; the session stays usable for the next message.
        let now = self.now_ms.now_ms();
        if now >= message.deadline_at_ms {
            return not_sent(super::DEADLINE_ELAPSED, log.refused("deadline-elapsed", crate::cause!()));
        }
        if now < self.admitted_at_ms || now >= self.grant.expires_at_ms {
            self.give_up(&mut guard);
            return not_sent(super::ROUTE_UNAVAILABLE, log.refused("lifetime-ended", crate::cause!()));
        }
        let reading = Instant::now();
        let registration = self.authority.registration(&self.grant, now);
        log.registration_ms = Some(reading.elapsed().as_millis());
        match registration {
            Registration::Current => {}
            // The owner could not be read: this message is not sent, and the
            // session stays for the next one.
            Registration::Unknown(cause) => {
                return not_sent(super::ROUTE_UNAVAILABLE, log.refused("registration-unknown", cause));
            }
            Registration::Withdrawn(cause) => {
                self.give_up(&mut guard);
                return not_sent(super::ROUTE_UNAVAILABLE, log.refused("registration-withdrawn", cause));
            }
        }
        // The registration read may take a round trip: the deadline is checked
        // again at the physical write.
        if self.now_ms.now_ms() >= message.deadline_at_ms {
            return not_sent(super::DEADLINE_ELAPSED, log.refused("deadline-elapsed", crate::cause!()));
        }
        let Some(stream) = guard.as_mut() else {
            return not_sent(super::ROUTE_UNAVAILABLE, log.refused("not-ready", crate::cause!()));
        };
        let sending = Instant::now();
        let answer = write_message(stream, bytes)
            .and_then(|_| read_message(stream, max_message_bytes()))
            .and_then(|reply| {
                reply.ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, crate::refusal_cause::CodedError::new("session closed")))
            });
        let now = self.now_ms.now_ms();
        match answer {
            Ok(reply) if now >= self.admitted_at_ms && now < message.deadline_at_ms => {
                log.round_trip_ms = Some(sending.elapsed().as_millis());
                log.outcome = "answered";
                Ok(reply)
            }
            Err(error) => {
                log.round_trip_ms = Some(sending.elapsed().as_millis());
                self.give_up(&mut guard);
                Err(crate::refusal_cause::CodedError::with_cause((), log.refused("lost", crate::refusal_cause::Caused::cause(&error))))
            }
            // The computer's answer came after this message's deadline (or the grant's end). It is logged as late with its
            // round trip; the computer kept it by request key, so a retry with the same key gets it.
            Ok(_) => {
                log.round_trip_ms = Some(sending.elapsed().as_millis());
                self.give_up(&mut guard);
                Err(crate::refusal_cause::CodedError::with_cause((), log.refused("answered-late", crate::cause!(condition: reply_arrived_after_session_or_message_deadline))))
            }
        }
    }
}

/// One stderr line per message the forwarder's forwarder connection handles, written when it is done:
/// where its time went (`turn_ms` waiting for the computer's stream, `registration_ms` reading the registration owner,
/// `round_trip_ms` from the write to the Mac's answer, `total_ms`), its outcome word and safe refusal cause:
/// never an operation value, device identity, request key, credential, input or reply.
struct SendLog {
    started: Instant,
    turn_ms: u128,
    registration_ms: Option<u128>,
    round_trip_ms: Option<u128>,
    outcome: &'static str,
    cause: Option<crate::refusal_cause::Cause>,
}

impl SendLog {
    fn new() -> Self {
        Self { started: Instant::now(), turn_ms: 0, registration_ms: None, round_trip_ms: None, outcome: "pending", cause: None }
    }
    fn refused(&mut self, outcome: &'static str, cause: crate::refusal_cause::Cause) -> crate::refusal_cause::Cause {
        self.outcome = outcome;
        self.cause = Some(cause.clone());
        cause
    }
}

impl Drop for SendLog {
    fn drop(&mut self) {
        let ms = |value: Option<u128>| value.map_or_else(|| "-".to_owned(), |value| value.to_string());
        let cause = self.cause.as_ref().map(|cause| format!(" cause={cause}")).unwrap_or_default();
        crate::quiet_eprintln!(
            "session-send turn_ms={} registration_ms={} round_trip_ms={} total_ms={} outcome={}{cause}",
            self.turn_ms, ms(self.registration_ms), ms(self.round_trip_ms),
            self.started.elapsed().as_millis(), self.outcome,
        );
    }
}

/// Serve a Mac-initiated connection. The caller must bound stream I/O and the
/// handler must perform independent route, proof, rights and commit checks.
/// `now_ms` is the clock each message's deadline is read against.
pub fn serve_mac_session<S: Read + Write>(
    stream: S,
    route: &Route,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    dispatch: impl FnMut(&[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>>,
) -> io::Result<()> {
    crate::io_operation!(serve_mac_session_while(stream, route, now_ms, || true, |_| false, dispatch))
}

/// The answer for a message that never started: correlated, value-free, and not
/// an uncertain outcome. The Mac gives it for a message whose deadline passed
/// before its dispatch began; the forwarder's forwarder connection for a message it never sent.
pub(super) fn refusal(request_id: &str, code: &str, cause: crate::refusal_cause::Cause) -> io::Result<Vec<u8>> {
    crate::io_operation!(serde_json::to_vec(&super::DeviceReply::Refused { cause: cause.into(),
        request_id: request_id.to_owned(),
        code: code.to_owned(),
    })
    .map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::new(io::ErrorKind::InvalidData, crate::refusal_cause::CodedError::new("invalid refusal")), _refusal_io_cause) }))
}

/// One line per message on stderr: when it was read
/// (`received_at_ms`, Unix milliseconds) and where its time went (`queued_ms`
/// from read to dispatch, `ran_ms` in dispatch, `left_ms` of its deadline at
/// read), its outcome and safe refusal cause. Never an operation value, request key,
/// credential, input or reply.
fn log_message(received_at_ms: i64, received: Instant, started: Instant, left_ms: i64, outcome: &str, cause: Option<&crate::refusal_cause::Cause>) {
    let cause = cause.map(|cause| format!(" cause={cause}")).unwrap_or_default();
    crate::quiet_eprintln!(
        "session-message received_at_ms={received_at_ms} queued_ms={} ran_ms={} left_ms={left_ms} outcome={outcome}{cause}",
        started.saturating_duration_since(received).as_millis(),
        started.elapsed().as_millis(),
    );
}

/// How long after a message's deadline an answer stays kept by its request key, so a retry with the same key gets it
/// and nothing runs again. A retry comes after the forwarder gave up on the first message (504), so this is the window a
/// caller may retry in.
const KEPT_ANSWER_GRACE_MS: i64 = 120_000;
/// The most answers kept at once; a full book keeps no more (the answer is then only in the reply that was written).
const KEPT_ANSWERS_MAX: usize = 4_096;

/// One answer the computer produced, kept by its request key on this computer (`kept_answers`).
struct KeptAnswer {
    identity: String,
    expires_at_ms: i64,
    reply: Vec<u8>,
}

fn kept_answers() -> &'static Mutex<std::collections::HashMap<String, KeptAnswer>> {
    static KEPT: std::sync::OnceLock<Mutex<std::collections::HashMap<String, KeptAnswer>>> = std::sync::OnceLock::new();
    KEPT.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// The book key: the message's account, its computer, the asking client and the caller's request key. A computer's own
/// session carries many accounts (`computer_wide`), so the account is part of the key: one account's request key is never
/// another's answer. The asking client (`asker`, the digest of the proof the message carried) is part of it too: one
/// client's request key is never another client's answer. Ids hold no control character, so a newline separates them.
fn answer_key(message: &crate::resource_authority::InvokeMessage, asker: &str) -> String {
    format!("{}\n{}\n{}\n{}", message.account_id, message.device_id, asker, message.request_key)
}

/// Who asked: the digest of the client proof a message carries, taken before the proof is wiped from the message.
fn asker_of(message: &crate::resource_authority::InvokeMessage) -> String {
    content_crypto::advanced::blake3::hash(message.client_authorization.as_bytes()).to_hex().to_string()
}

/// What the message asks: its resource, operation, input and generation. Its request id and deadline are not part of it,
/// since a retry carries a new id and deadline.
fn answer_identity(message: &crate::resource_authority::InvokeMessage) -> String {
    let asked = serde_json::to_vec(&(
        &message.resource_address,
        &message.operation_resource,
        &message.operation,
        &message.input,
        &message.generation,
    ))
    .unwrap_or_default();
    content_crypto::advanced::blake3::hash(&asked).to_hex().to_string()
}

/// The kept answer for this request key and asked identity, restamped with the retry's request id (`DeviceReply`).
fn kept_answer(message: &crate::resource_authority::InvokeMessage, asker: &str, identity: &str, now: i64) -> Option<Vec<u8>> {
    let book = kept_answers().lock().ok()?;
    let kept = book.get(&answer_key(message, asker))?;
    if kept.expires_at_ms <= now || kept.identity != identity {
        return None;
    }
    let mut reply: crate::forwarder::DeviceReply = serde_json::from_slice(&kept.reply).ok()?;
    match &mut reply {
        crate::forwarder::DeviceReply::Completed { request_id, .. }
        | crate::forwarder::DeviceReply::Refused { request_id, .. }
        | crate::forwarder::DeviceReply::OutcomeUnknown { request_id, .. } => *request_id = message.request_id.clone(),
    }
    serde_json::to_vec(&reply).ok()
}

/// Keep an answer the dispatch produced, whether or not its write reaches the forwarder in time.
fn keep_answer(message: &crate::resource_authority::InvokeMessage, asker: &str, identity: String, reply: &[u8], now: i64) {
    let Ok(mut book) = kept_answers().lock() else { return };
    book.retain(|_, kept| kept.expires_at_ms > now);
    if book.len() >= KEPT_ANSWERS_MAX {
        crate::quiet_eprintln!("session-answer-not-kept cause=book-full");
        return;
    }
    book.insert(answer_key(message, asker), KeptAnswer {
        identity,
        expires_at_ms: message.deadline_at_ms.saturating_add(KEPT_ANSWER_GRACE_MS),
        reply: reply.to_vec(),
    });
}

fn serve_mac_session_while<S: Read + Write, R: AsRef<[u8]>>(
    mut stream: S,
    route: &Route,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    mut session_current: impl FnMut() -> bool,
    mut readmit: impl FnMut(&[u8]) -> bool,
    mut dispatch: impl FnMut(&[u8]) -> Result<R, crate::refusal_cause::CodedError<()>>,
) -> io::Result<()> {
    if !valid_route(route) {
        return crate::io_operation!(Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            crate::refusal_cause::CodedError::new("invalid device route"),
        )));
    }
    loop {
        if !session_current() {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                crate::refusal_cause::CodedError::new("session expired"),
            )));
        }
        let Some(bytes) = crate::io_operation!((read_message(&mut stream, max_message_bytes())).map_err(std::io::Error::from))? else {
            return Ok(());
        };
        let (received, received_at_ms) = (Instant::now(), now_ms.now_ms());
        let bytes = Zeroizing::new(bytes);
        if !session_current() {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                crate::refusal_cause::CodedError::new("session expired"),
            )));
        }
        let mut message = crate::io_operation!((decode_message(&bytes)
            .map_err(|error| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::new(io::ErrorKind::InvalidData, crate::refusal_cause::CodedError::with_cause("invalid invoke message", error.cause())), _refusal_io_cause) })).map_err(std::io::Error::from))?;
        let asker = asker_of(&message);
        message.client_authorization.zeroize();
        // On a computer's own session (`computer_wide`) a message names the account it is for; the computer's dispatch checks it
        // is one it holds.
        if (message.account_id != route.account_id && !computer_wide(route))
            || message.device_id != route.device_id
            || message.resource_address != route.resource_address
            || message.generation != route.generation
        {
            return crate::io_operation!(Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                crate::refusal_cause::CodedError::new("route changed"),
            )));
        }
        // A request key this computer already answered for this client is answered again with that answer, not run a
        // second time: the answer may have been produced after its first caller gave up (504), and the retry asks for it.
        // Only when the dispatch admits the client now (`readmit`): a client revoked since gets the refusal a new
        // message would get, never its earlier answer.
        let identity = answer_identity(&message);
        if let Some(kept) = kept_answer(&message, &asker, &identity, received_at_ms).filter(|_| readmit(&bytes)) {
            crate::quiet_eprintln!("session-message-kept received_at_ms={received_at_ms} outcome=answered-kept");
            crate::io_operation!((write_message(&mut stream, &kept)).map_err(std::io::Error::from))?;
            continue;
        }
        let left_ms = message.deadline_at_ms.saturating_sub(received_at_ms);
        // One line as soon as a message is read, before its dispatch: `session-message` is written only when the
        // dispatch ends, so a session that reads a message and then waits in its dispatch said nothing at all (lead-66
        // install proof, 2026-11-05: admitted sessions and no line while the public calls got no answer for 90 s).
        // With this line, no `session-message-read` means the forwarder sent this session nothing. Names and times only.
        crate::quiet_eprintln!("session-message-read received_at_ms={received_at_ms} left_ms={left_ms}");
        if left_ms <= 0 {
            let cause = crate::cause!(condition: message_deadline_elapsed_before_dispatch);
            log_message(received_at_ms, received, Instant::now(), left_ms, "expired", Some(&cause));
            crate::io_operation!((write_message(&mut stream, &crate::io_operation!((refusal(&message.request_id, super::DEADLINE_ELAPSED, cause)).map_err(std::io::Error::from))?)).map_err(std::io::Error::from))?;
            continue;
        }
        let started = Instant::now();
        let reply = dispatch(&bytes);
        let answered_at_ms = now_ms.now_ms();
        let cause = reply.as_ref().err().map(|failure| failure.cause());
        // An answer produced after the message's deadline is logged as late, with its round trip, and is kept (below).
        let outcome = match &reply {
            Err(_) => "failed",
            Ok(_) if answered_at_ms >= message.deadline_at_ms => "answered-late",
            Ok(_) => "answered",
        };
        log_message(received_at_ms, received, started, left_ms, outcome, cause.as_ref());
        if let Ok(answer) = &reply {
            keep_answer(&message, &asker, identity, answer.as_ref(), answered_at_ms);
        }
        let reply = crate::io_operation!((reply.map_err(|failure| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&failure).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io({
            let cause = failure.cause();
            crate::quiet_eprintln!("door-refusal code=device_outcome_unknown cause={cause}");
            io::Error::other(crate::refusal_cause::CodedError::with_cause("device outcome unknown", cause))
        }, _refusal_io_cause) })).map_err(std::io::Error::from))?;
        // The reply is written even when the session's lifetime ended during the dispatch: the dispatch ran while the
        // session was current, so its side effect happened and the forwarder must learn its outcome. Dropping it here
        // turned a completed write into an "outcome unknown" 504.
        // Keep the result owner (including a Mac commit permit when supplied)
        // alive until the actual socket write has finished.
        crate::io_operation!((write_message(&mut stream, reply.as_ref())).map_err(std::io::Error::from))?;
    }
}

/// Send the computer's connection credential over its outbound confidential stream
/// and require an exact route-bound admission acknowledgement before accepting
/// invokes. Server identity and confidentiality belong to the TLS owner. The
/// computer tells no placement rows here.
pub fn connect_mac_session<S: Read + Write>(
    stream: S,
    credential: &[u8],
    route: &Route,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    dispatch: impl FnMut(&[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>>,
) -> io::Result<()> {
    crate::io_operation!(connect_mac_session_with_admission(stream, credential, &[], route, now_ms, || Ok(()), dispatch))
}

/// The account owner installs a current signed Mac policy snapshot only after
/// the route-bound registration ACK. Its returned guard stays alive through
/// all dispatches and drops on EOF, timeout, refusal or socket failure.
/// A reply owner implementing AsRef may retain a commit permit through the
/// physical write without changing this forwarder connection's framing.
pub fn connect_mac_session_with_admission<S, R, G>(
    stream: S,
    credential: &[u8],
    told: &[KeptAccount],
    route: &Route,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    on_admitted: impl FnOnce() -> io::Result<G>,
    dispatch: impl FnMut(&[u8]) -> Result<R, crate::refusal_cause::CodedError<()>>,
) -> io::Result<()>
where
    S: Read + Write,
    R: AsRef<[u8]>,
{
    crate::io_operation!(connect_mac_session_telling_kept_accounts(stream, credential, told, &[], route, now_ms, on_admitted, |_| false, dispatch))
}

/// `connect_mac_session_with_admission`, naming in `catching_up` the told accounts (by address) this computer holds
/// but does not answer yet (`computers::kept_accounts_bytes_catching_up`): the forwarder sends their calls to another computer.
/// `readmit` says whether the client of a message is admitted now; an answer kept for a retry is given only to a client it
/// admits, and `connect_mac_session_with_admission` keeps none (`|_| false`).
#[allow(clippy::too_many_arguments)]
pub fn connect_mac_session_telling_kept_accounts<S, R, G>(
    mut stream: S,
    credential: &[u8],
    told: &[KeptAccount],
    catching_up: &[String],
    route: &Route,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    on_admitted: impl FnOnce() -> io::Result<G>,
    readmit: impl FnMut(&[u8]) -> bool,
    dispatch: impl FnMut(&[u8]) -> Result<R, crate::refusal_cause::CodedError<()>>,
) -> io::Result<()>
where
    S: Read + Write,
    R: AsRef<[u8]>,
{
    if credential.is_empty() || credential.len() > MAX_CREDENTIAL_BYTES {
        return crate::io_operation!(Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            crate::refusal_cause::CodedError::new("invalid device credential"),
        )));
    }
    let kept_accounts = crate::io_operation!((computers::kept_accounts_bytes_catching_up(told, catching_up).ok_or_else(|| io::Error::new(
        io::ErrorKind::InvalidInput,
        crate::refusal_cause::CodedError::new("too many placement rows to tell"),
    ))).map_err(std::io::Error::from))?;
    crate::io_operation!((write_message(&mut stream, credential)).map_err(std::io::Error::from))?;
    crate::io_operation!((write_message_within(&mut stream, &kept_accounts, computers::settings().kept_accounts_max_bytes)).map_err(std::io::Error::from))?;
    let bytes = crate::io_operation!((crate::io_operation!((read_message(&mut stream, MAX_ACK_BYTES)).map_err(std::io::Error::from))?
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, crate::refusal_cause::CodedError::new("registration refused")))).map_err(std::io::Error::from))?;
    let ack: ConnectionAck = crate::io_operation!((serde_json::from_slice(&bytes)
        .map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::new(io::ErrorKind::InvalidData, crate::refusal_cause::CodedError::new("invalid registration ack")), _refusal_io_cause) })).map_err(std::io::Error::from))?;
    let now = now_ms.now_ms();
    if ack.version != ACK_VERSION
        || ack.route != *route
        || now <= 0
        || ack.expires_at_ms <= now
        || ack
            .expires_at_ms
            .checked_sub(now)
            .is_none_or(|life| life > MAX_SESSION_LIFE_MS)
    {
        return crate::io_operation!(Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            crate::refusal_cause::CodedError::new("registration ack refused"),
        )));
    }
    let _admitted_guard = crate::io_operation!((on_admitted()).map_err(std::io::Error::from))?;
    crate::io_operation!(serve_mac_session_while(
        stream,
        route,
        now_ms.clone(),
        move || {
            let current = now_ms.now_ms();
            current >= now && current < ack.expires_at_ms
        },
        readmit,
        dispatch,
    ))
}

#[cfg(test)]
mod framing_tests {
    //! Framing at the edges of a stream: a clean end, an end inside a message, a signal between reads, and the bounds.
    use super::*;

    /// A reader whose connection was withdrawn: every read answers `Interrupted`, as src/forwarder/tls.rs
    /// `current_connection` does once the connection's cancel flag is set. Counts its reads.
    struct Cancelled(usize);

    impl Read for Cancelled {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            self.0 += 1;
            assert!(self.0 < 1_000, "a cancelled connection is read again and again");
            crate::io_operation!(Err(io::Error::new(io::ErrorKind::Interrupted, crate::refusal_cause::CodedError::new("resource connection cancelled"))))
        }
    }

    fn framed(message: &[u8]) -> Vec<u8> {
        let mut bytes = (message.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(message);
        bytes
    }

    #[test]
    fn a_cancelled_connection_ends_the_read_and_is_not_read_again() {
        let mut stream = Cancelled(0);
        assert_eq!(read_message(&mut stream, 64).unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(stream.0, 1, "one read, then the session ends");
    }

    #[test]
    fn an_end_inside_a_message_is_unexpected_never_a_clean_end() {
        let whole = framed(b"hello");
        for cut in 1..whole.len() {
            let error = read_message(&mut io::Cursor::new(whole[..cut].to_vec()), 64).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof, "cut after {cut} bytes");
        }
        assert!(read_message(&mut io::Cursor::new(Vec::new()), 64).unwrap().is_none());
    }

    #[test]
    fn an_empty_or_oversized_length_is_refused_before_its_body_is_read() {
        for size in [0_u32, 65, u32::MAX] {
            let error = read_message(&mut io::Cursor::new(size.to_be_bytes().to_vec()), 64).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "length {size}");
        }
        let mut sink = Vec::new();
        assert!(write_message_within(&mut sink, b"", 64).is_err());
        assert!(write_message_within(&mut sink, &[0; 65], 64).is_err());
        assert!(sink.is_empty(), "nothing is written for a message out of bounds");
    }
}

#[cfg(test)]
mod reply_after_expiry_tests {
    //! A reply to a message dispatched while its session was current is written, even when the session's lifetime ends
    //! during the dispatch: the side effect ran, so the caller must learn the outcome (not a lost reply, 504).
    use super::*;
    use crate::resource_authority::InvokeMessage;

    /// One message to read, and every byte written back.
    struct Duplex {
        input: io::Cursor<Vec<u8>>,
        output: Vec<u8>,
    }

    impl Read for Duplex {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.input.read(buffer)
        }
    }

    impl Write for Duplex {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.output.extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn clock() -> i64 {
        1_000
    }

    #[test]
    fn a_reply_produced_before_the_session_ends_is_written_even_when_it_ends_during_the_dispatch() {
        let route = Route {
            account_id: "account".into(),
            device_id: "device".into(),
            resource_address: "@own-records".into(),
            generation: "generation".into(),
        };
        let message = InvokeMessage {
            request_id: "request-1".into(),
            account_id: "account".into(),
            device_id: "device".into(),
            resource_address: "@own-records".into(),
            operation_resource: None,
            generation: "generation".into(),
            operation: "records:write".into(),
            input: serde_json::json!({}),
            request_key: "key-1".into(),
            person_present: None,
            client_authorization: "authorization".into(),
            deadline_at_ms: 5_000,
        };
        let mut framed = (u32::try_from(serde_json::to_vec(&message).unwrap().len()).unwrap()).to_be_bytes().to_vec();
        framed.extend(serde_json::to_vec(&message).unwrap());
        let mut stream = Duplex { input: io::Cursor::new(framed), output: Vec::new() };
        // Current before the message is read and before it is dispatched; expired once the dispatch has run.
        let mut checks = 0;
        let session_current = || {
            checks += 1;
            checks <= 2
        };
        let reply = br#"{"request_id":"request-1","status":"done"}"#.to_vec();
        let result = serve_mac_session_while(&mut stream, &route, crate::storage::time_source::fixed(clock()), session_current, |_| false, |_| Ok::<_, crate::refusal_cause::CodedError<()>>(reply.clone()));
        assert!(result.is_err(), "the session ends after its reply");
        let written = &stream.output;
        assert_eq!(written.len(), 4 + reply.len(), "the reply the dispatch produced is written, not dropped");
        assert_eq!(&written[4..], reply.as_slice());
    }

    /// The clock the answer test moves: a dispatch that takes longer than its message's deadline.
    static MOVING_CLOCK: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1_000);

    struct MovingClock;
    impl crate::storage::time_source::Clock for MovingClock {
        fn now_ms(&self) -> i64 {
            MOVING_CLOCK.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    fn invoke_frame(account_id: &str, request_id: &str, request_key: &str, deadline_at_ms: i64) -> Vec<u8> {
        invoke_frame_from(account_id, request_id, request_key, deadline_at_ms, "authorization")
    }

    fn invoke_frame_from(account_id: &str, request_id: &str, request_key: &str, deadline_at_ms: i64, client: &str) -> Vec<u8> {
        let message = InvokeMessage {
            request_id: request_id.into(),
            account_id: account_id.into(),
            device_id: "device".into(),
            resource_address: "@own-records".into(),
            operation_resource: None,
            generation: "generation".into(),
            operation: "records:write".into(),
            input: serde_json::json!({"id": "note-1"}),
            request_key: request_key.into(),
            person_present: None,
            client_authorization: client.into(),
            deadline_at_ms,
        };
        let body = serde_json::to_vec(&message).unwrap();
        let mut framed = (u32::try_from(body.len()).unwrap()).to_be_bytes().to_vec();
        framed.extend(body);
        framed
    }

    /// The frames written back, each one's body.
    fn frames(mut written: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        while written.len() >= 4 {
            let length = u32::from_be_bytes([written[0], written[1], written[2], written[3]]) as usize;
            out.push(written[4..4 + length].to_vec());
            written = &written[4 + length..];
        }
        out
    }

    #[test]
    fn an_answer_late_for_its_deadline_is_kept_by_request_key_and_a_retry_gets_it_without_a_second_run() {
        let route = Route {
            account_id: "account".into(),
            device_id: "device".into(),
            resource_address: "@own-records".into(),
            generation: "generation".into(),
        };
        MOVING_CLOCK.store(1_000, std::sync::atomic::Ordering::SeqCst);
        let mut framed = invoke_frame("account", "request-first", "answer-once-key", 5_000);
        framed.extend(invoke_frame("account", "request-retry", "answer-once-key", 9_000));
        let mut stream = Duplex { input: io::Cursor::new(framed), output: Vec::new() };
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let dispatch = |bytes: &[u8]| {
            runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // The side effect runs and takes past the first message's deadline.
            MOVING_CLOCK.store(6_000, std::sync::atomic::Ordering::SeqCst);
            let asked = decode_message(bytes).unwrap();
            let answer = serde_json::json!({"state": "completed", "request_id": asked.request_id, "value": {"stored": true}});
            Ok::<_, crate::refusal_cause::CodedError<()>>(serde_json::to_vec(&answer).unwrap())
        };
        serve_mac_session_while(&mut stream, &route, std::sync::Arc::new(MovingClock), || true, |_| true, dispatch).unwrap();
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1, "the side effect ran once, for the first message");
        let answers = frames(&stream.output);
        assert_eq!(answers.len(), 2, "the late answer is written, then the retry's answer");
        let first: serde_json::Value = serde_json::from_slice(&answers[0]).unwrap();
        let retry: serde_json::Value = serde_json::from_slice(&answers[1]).unwrap();
        assert_eq!(first["request_id"], "request-first");
        assert_eq!(retry["request_id"], "request-retry", "the kept answer names the retry's request");
        assert_eq!(first["value"], retry["value"], "the retry gets the original answer");
    }

    #[test]
    fn one_request_key_from_two_accounts_on_a_computer_wide_session_is_two_requests() {
        // A computer's own session carries many accounts (`computer_wide`): the same request key from another account is not its answer.
        let route = Route {
            account_id: "device".into(),
            device_id: "device".into(),
            resource_address: "@own-records".into(),
            generation: "generation".into(),
        };
        MOVING_CLOCK.store(1_000, std::sync::atomic::Ordering::SeqCst);
        let mut framed = invoke_frame("first-account", "request-first", "read-computers-1", 9_000);
        framed.extend(invoke_frame("second-account", "request-second", "read-computers-1", 9_000));
        let mut stream = Duplex { input: io::Cursor::new(framed), output: Vec::new() };
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let dispatch = |bytes: &[u8]| {
            runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let asked = decode_message(bytes).unwrap();
            let answer = serde_json::json!({"state": "completed", "request_id": asked.request_id, "value": {"account": asked.account_id}});
            Ok::<_, crate::refusal_cause::CodedError<()>>(serde_json::to_vec(&answer).unwrap())
        };
        serve_mac_session_while(&mut stream, &route, std::sync::Arc::new(MovingClock), || true, |_| true, dispatch).unwrap();
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 2, "each account's request runs");
        let answers = frames(&stream.output);
        let second: serde_json::Value = serde_json::from_slice(&answers[1]).unwrap();
        assert_eq!(second["value"]["account"], "second-account", "the second account gets its own answer");
    }

    #[test]
    fn a_kept_answer_is_given_only_to_the_client_it_was_kept_for_and_only_while_that_client_is_admitted() {
        let route = Route {
            account_id: "account".into(),
            device_id: "device".into(),
            resource_address: "@own-records".into(),
            generation: "generation".into(),
        };
        let run = |frames_in: Vec<Vec<u8>>, admitted: bool| {
            MOVING_CLOCK.store(1_000, std::sync::atomic::Ordering::SeqCst);
            let mut stream = Duplex { input: io::Cursor::new(frames_in.concat()), output: Vec::new() };
            let runs = std::sync::atomic::AtomicUsize::new(0);
            let dispatch = |bytes: &[u8]| {
                let n = runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let asked = decode_message(bytes).unwrap();
                let answer = serde_json::json!({"state": "completed", "request_id": asked.request_id, "value": {"run": n}});
                Ok::<_, crate::refusal_cause::CodedError<()>>(serde_json::to_vec(&answer).unwrap())
            };
            serve_mac_session_while(&mut stream, &route, std::sync::Arc::new(MovingClock), || true, |_| admitted, dispatch).unwrap();
            (runs.load(std::sync::atomic::Ordering::SeqCst), frames(&stream.output))
        };
        // Client B asks A's request key with A's input: B's message runs and B gets its own answer, never A's.
        let (runs, answers) = run(vec![
            invoke_frame_from("account", "request-a", "shared-key", 9_000, "proof-of-a"),
            invoke_frame_from("account", "request-b", "shared-key", 9_000, "proof-of-b"),
        ], true);
        let second: serde_json::Value = serde_json::from_slice(&answers[1]).unwrap();
        assert_eq!(runs, 2, "each client's message runs");
        assert_eq!(second["value"]["run"], 1, "the second client gets its own answer");
        // The same client's retry is answered from the book while it is admitted, and runs again once it is not.
        let retry = |admitted| run(vec![
            invoke_frame_from("account", "request-a", "again-key", 9_000, "proof-of-a"),
            invoke_frame_from("account", "request-retry", "again-key", 9_000, "proof-of-a"),
        ], admitted).0;
        assert_eq!(retry(true), 1, "an admitted client's retry is its kept answer");
        assert_eq!(retry(false), 2, "a client the dispatch no longer admits reaches the dispatch, never its kept answer");
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod scenario_tests;
