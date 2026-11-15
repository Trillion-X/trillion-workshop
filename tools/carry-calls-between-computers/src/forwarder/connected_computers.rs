// src/forwarder/connected_computers.rs
//
// Purpose: Own bounded per-process route connected computers for admitted Mac sessions and serialize route replacement with dispatch.
//
// Non-Negotiable Invariants:
// - Expose only ready current sessions for the exact account/resource route.
// - Hold the resource entry's turn through replacement acknowledgement and in-flight dispatch.
// - A route lookup never waits on a message in flight: the published entry is read under its own short lock.
// - Keep registration and client rights in their separately supplied owners.
//
// Key Concepts:
// - Bounded route entries, admitted session lifetime and exact route generations.
// - Acknowledged replacement, retirement and stale-session removal.
//
// Security Considerations:
// - Connected computers is local process state, not durable account authority or proof a sleeping device is available.
// - A production ingress must consistently pin each account/resource to this connection owner.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Per-process connected computers for computer sessions, and the choice of the computer that
//! answers an account now. Registration and client rights remain with their
//! separately supplied owners. A production public ingress must pin one
//! account/resource to this connection owner.
//!
//! Each admitted session is one computer's connection for one account, or a computer's own session that carries every
//! account it holds (`session::computer_wide`: one session per computer, not per account). A computer
//! tells its computers rows when its session opens; the forwarder keeps them
//! with the session, in memory only. A credential names its account by its
//! address (derived from the account's signing key), never by the internal
//! owner id a session's route may carry. `current_route` takes the rows for
//! that address from every live session that told it, believes only a row
//! the address's key names and verifies (`KeptAccount::believed`: the told
//! public key is the one the address is derived from, and it signed the row;
//! see `account/computers.rs`, nothing stored is asked), takes the highest signed
//! revision, and answers the first live computer that row names as may-answer,
//! as a route named by the address. Two different verified rows at the same
//! top revision are a mismatch, so no computer answers. No live may-answer computer
//! gives `None`. A message sent on such a route reaches the session with the
//! session's own account name in computer of the address (`invoke`), so an
//! account whose internal owner id is not its address (one made before
//! addresses) is answered the same way as a new one.
//!
//! Route generation of the writer: for an account whose computers hold copies, the forwarder also remembers, in memory
//! only and like the sessions themselves, the newest writer term it has carried a writer's message for and the computer
//! that sent it, or a page the writer answered another copy keeper's pull of its feed with and the computer that answered it
//! (`note_writer`; with one voter, the pull is the only writer's message that passes). `current_route` then prefers that computer among the may-answer ones, so writes reach the
//! writer, and `term_check` refuses a writer's message (a push or a renewal, a message between computers) below that term, and at a term
//! that ran out with no message carried at it for `term_ms` (`TermCheck::Lapsed`): a stale or lapsed writer's
//! late messages stop here, and every copy refuses them again on its own (its term floor).
use super::{session::ForwarderConnection, ComputerConnections, RouteDirectory};
use crate::account::computers::{verify_use, KeptAccount, ComputersRow, messages::TermAnnouncement};
use crate::resource_authority::Route;
use zeroize::Zeroize as _;
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex, OnceLock},
};

const MAX_ROUTE_SLOTS: usize = 4_096;
/// (account, resource, computer): the computer is the session's device id.
type Key = (String, String, String);

/// The settings DATA beside this code (`connected_computers.json`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    /// The most accounts whose writer the forwarder remembers (`note_writer`); the least recently used one is forgotten past it.
    most_writer_accounts: usize,
}

/// The one settings value, read from `connected_computers.json` at first use.
fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| serde_json::from_slice(include_bytes!("connected_computers.json")).expect("connected_computers.json is valid"))
}

trait RegisteredSession: ComputerConnections {
    fn is_ready(&self) -> bool;
    fn is_past_lifetime(&self) -> bool;
    fn retire(&self);
    fn told(&self) -> Vec<KeptAccount>;
    /// The socket address the session was admitted from (`ForwarderConnection::peer`), empty when not known.
    fn peer(&self) -> String {
        String::new()
    }
    /// When the forwarder admitted this session: its generation within one device (`refused_second_session`). A session
    /// that is not an admitted connection (a test fake) reports 0.
    fn admitted_at_ms(&self) -> i64 {
        0
    }
    /// Take the told row as what this session's computer tells now for its account (`ForwarderConnection::tell_again`).
    fn tell_again(&self, _told: KeptAccount) -> bool {
        false
    }
    /// Whether this session's computer said it does not answer the account at `address` yet (`ForwarderConnection::
    /// catching_up`): it holds the account but has not caught up with its writer.
    fn catching_up(&self, _address: &str) -> bool {
        false
    }
    /// The computer says again whether it answers the account at `address`.
    fn set_catching_up(&self, _address: &str, _catching_up: bool) {}
}

impl<S: Read + Write + Send> RegisteredSession for ForwarderConnection<S> {
    fn is_ready(&self) -> bool {
        ForwarderConnection::is_ready(self)
    }

    fn admitted_at_ms(&self) -> i64 {
        ForwarderConnection::admitted_at_ms(self)
    }

    fn is_past_lifetime(&self) -> bool {
        ForwarderConnection::is_past_lifetime(self)
    }

    fn retire(&self) {
        ForwarderConnection::retire(self)
    }

    fn told(&self) -> Vec<KeptAccount> {
        ForwarderConnection::told(self)
    }

    fn peer(&self) -> String {
        ForwarderConnection::peer(self)
    }

    fn tell_again(&self, told: KeptAccount) -> bool {
        ForwarderConnection::tell_again(self, told)
    }

    fn catching_up(&self, address: &str) -> bool {
        ForwarderConnection::catching_up(self, address)
    }

    fn set_catching_up(&self, address: &str, catching_up: bool) {
        ForwarderConnection::set_catching_up(self, address, catching_up)
    }
}

#[derive(Clone)]
struct Entry {
    route: Route,
    session: Arc<dyn RegisteredSession>,
}

/// One computer's entry. `active` is the published session, read and written only
/// for a moment, so a route lookup (`live`, `entry_for`) never waits on a message
/// in flight. `turn` is held through a replacement's acknowledgement and
/// through each message's whole round trip: messages of one computer go one at a time,
/// and a replacement becomes ready only after the message in flight ends.
#[derive(Default)]
struct Slot {
    active: Mutex<Option<Entry>>,
    turn: Mutex<()>,
    /// Held only across registration acknowledgement and publication, never across invocation I/O.
    publication: Mutex<()>,
}

impl Slot {
    /// Clear the published entry when it is still `session`.
    fn clear_if(&self, session: &Arc<dyn RegisteredSession>) {
        if let Ok(mut active) = self.active.lock() {
            if active.as_ref().is_some_and(|entry| Arc::ptr_eq(&entry.session, session)) {
                if let Some(entry) = active.take() {
                    log_connected("removed", &entry, " reason=not-ready");
                }
            }
        }
    }
}

/// Whether `candidate` is a second session of one device while `held` is live: admitted no later than it. A session
/// admitted later is the computer's own rotation (`computer.rs` opens the next session beside the old one), and it
/// replaces the old one. An equal or older admission is not a rotation: two sessions claim one device, and the second is
/// refused rather than swapped in.
fn refused_second_session(held: Option<&Entry>, candidate: &dyn RegisteredSession) -> bool {
    held.is_some_and(|held| held.session.is_ready() && candidate.admitted_at_ms() <= held.session.admitted_at_ms())
}

/// One stderr line per connected computers event of a computer's session: the account, device and resource of its route, and the
/// computers row each told account carries (its revision, the computers it names as may-answer, and whether this
/// device is one of them, which is what `current_route` routes by). Ids, revisions and reason words only: never a
/// credential, bearer, key or content.
fn log_connected(event: &str, entry: &Entry, detail: &str) {
    crate::quiet_eprintln!("{}", connected_line(event, entry, &entry.session.peer(), detail));
}

/// The text of one connected-computers line: the event, the account, device and resource of the route, the socket address
/// the session was admitted from (`peer`, so a device can be tied to a host), the reason words, and each told row.
fn connected_line(event: &str, entry: &Entry, peer: &str, detail: &str) -> String {
    let device = &entry.route.device_id;
    let rows: String = entry.session.told().iter().map(|told| told.log_words(device)).collect();
    format!("connected-computers event={event} account={} device={device} resource={:?} peer={peer}{detail}{rows}",
        entry.route.account_id, entry.route.resource_address)
}

/// The directory and forwarder connection for sessions admitted on this public instance.
/// A restart loses connected computers, so it fails closed until the computers reconnect.
pub struct ConnectedComputers {
    slots: Mutex<HashMap<Key, Arc<Slot>>>,
    writers: Mutex<WriterNotes>,
}

/// The writer a writer's message carried for one account: its newest term, the computer that sent it, and when that was
/// carried (`now` as the forwarder's clock reads it).
struct Carried {
    term: u64,
    computer: String,
    carried_ms: i64,
}

/// What this forwarder remembers of one account's writer. `carried` is the writer proven by accepted writer traffic: the
/// fence (`term_check`) reads only it. `announced` is the newest term a writer announced (`take_term_announcement`), which
/// only routes: a claim nobody voted for can misroute a call, never refuse the real writer. `used` is the use that last
/// touched the entry (`WriterNotes::uses`).
struct WriterNote {
    carried: Option<Carried>,
    announced: Option<(u64, String)>,
    used: u64,
}

/// Per account address: the writer this forwarder knows, bounded by `most_writer_accounts`.
#[derive(Default)]
struct WriterNotes {
    by_account: HashMap<String, WriterNote>,
    /// Counts every note and read, so the least recently used account has the smallest `used`.
    uses: u64,
}

impl WriterNotes {
    /// The entry of `address`, made when absent (the least recently used account is forgotten first when the memory is
    /// full), marked as used now.
    fn entry(&mut self, address: &str) -> &mut WriterNote {
        self.uses += 1;
        let used = self.uses;
        if !self.by_account.contains_key(address) && self.by_account.len() >= settings().most_writer_accounts {
            let least_recent = self.by_account.iter().min_by_key(|(_, note)| note.used).map(|(account, _)| account.clone());
            if let Some(least_recent) = least_recent {
                self.by_account.remove(&least_recent);
            }
        }
        let note = self.by_account.entry(address.to_owned()).or_insert(WriterNote { carried: None, announced: None, used });
        note.used = used;
        note
    }
}

/// Whether a writer's message at a term may pass (`ConnectedComputers::term_check`).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TermCheck {
    /// Not below the newest term carried, and that term still runs (or the term is new).
    Pass,
    /// Below the newest term carried: a stale writer's late message.
    Stale,
    /// The newest term carried ran out: no message at it was carried for `term_ms`, so its writer stopped renewing it.
    Lapsed,
}

impl ConnectedComputers {
    /// An empty directory. It keeps nothing but the live sessions and what each told.
    pub fn new() -> Self {
        Self { slots: Mutex::new(HashMap::new()), writers: Mutex::new(WriterNotes::default()) }
    }

    /// Whether a writer's message at `term` for the account at `address` may pass at `now`: it is not below the newest
    /// writer term this forwarder has carried for that account, and when it is that term, the term has not run out since
    /// the last message carried at it. A higher term is a new claim and passes.
    pub(crate) fn term_check(&self, address: &str, term: u64, now: i64) -> TermCheck {
        let Ok(writers) = self.writers.lock() else { return TermCheck::Stale };
        let Some(Carried { term: newest, carried_ms, .. }) = writers.by_account.get(address).and_then(|note| note.carried.as_ref()) else {
            return TermCheck::Pass;
        };
        if term < *newest {
            return TermCheck::Stale;
        }
        if term == *newest && now >= carried_ms.saturating_add(crate::account::computers::settings().term_ms) {
            return TermCheck::Lapsed;
        }
        TermCheck::Pass
    }

    /// A copy accepted a writer's message from `computer` at `term` for the account at `address`, or `computer` answered a
    /// other copy keeper's pull of the writer's feed with a page at `term`. Carried at `now`. A message at a lower term
    /// than the one held is not carried.
    pub(crate) fn note_writer(&self, address: &str, computer: &str, term: u64, now: i64) {
        let Ok(mut writers) = self.writers.lock() else { return };
        let note = writers.entry(address);
        if note.carried.as_ref().is_none_or(|carried| term >= carried.term) {
            note.carried = Some(Carried { term, computer: computer.to_owned(), carried_ms: now });
        }
    }

    /// A writer announced `term` for the account at `address` (`take_term_announcement`, a verified one). It is kept for
    /// routing only: `term_check` never reads it, so an announcement nobody voted for cannot refuse the writer that was carried.
    pub(crate) fn note_announced(&self, address: &str, computer: &str, term: u64) {
        let Ok(mut writers) = self.writers.lock() else { return };
        let note = writers.entry(address);
        if note.announced.as_ref().is_none_or(|(newest, _)| term >= *newest) {
            note.announced = Some((term, computer.to_owned()));
        }
    }

    /// The writer this forwarder carried a writer's message from, for the account at `address`. A read is a use.
    pub(crate) fn writer(&self, address: &str) -> Option<(u64, String)> {
        let mut writers = self.writers.lock().ok()?;
        writers.uses += 1;
        let used = writers.uses;
        let note = writers.by_account.get_mut(address)?;
        note.used = used;
        note.carried.as_ref().map(|carried| (carried.term, carried.computer.clone()))
    }

    /// The writer routing prefers for the account at `address`: the one carried from accepted writer traffic, else the one
    /// a verified announcement named (until traffic proves it). A read is a use.
    pub(crate) fn routing_writer(&self, address: &str) -> Option<(u64, String)> {
        let carried = self.writer(address);
        if carried.is_some() {
            return carried;
        }
        let writers = self.writers.lock().ok()?;
        writers.by_account.get(address)?.announced.clone()
    }

    /// The live session of `computer` for the account at `address`, as a route named by the address, when the account's
    /// newest believed row names both `from` and `computer` as computers that keep a copy or voters. A message between computers goes only
    /// between computers of the same account.
    pub(crate) fn computer_route(&self, address: &str, from: &str, computer: &str) -> Option<Route> {
        let live = self.live(address, COMPUTER_RESOURCE);
        let top = top_row(&live, address)?;
        let named = |id: &str| top.copy_keepers.iter().chain(top.voters.iter()).any(|named| named == id);
        if !named(from) || !named(computer) {
            return None;
        }
        // A computer the row names with no session that told the account (it does not keep the account yet: a new
        // account's default computers, a computer just added by a row edit) is reached on its own session
        // (`session::computer_wide`): the message makes it join the account by itself
        // (src/native_entry/computer/join_itself.rs). Only messages between computers go this way; the account's calls
        // never do (`current_route` reads only sessions that told the account).
        live.into_iter()
            .find(|entry| entry.route.device_id == computer)
            .or_else(|| self.computer_session(computer))
            .map(|entry| Route { account_id: address.to_owned(), ..entry.route })
    }

    /// The live answering computer a caller-authorized command settle may reach. The gateway calls this only for
    /// `Message::SettleCommand` after verifying the sender's short-lived computer proof for this account. The sender
    /// need not remain a member: it is submitting the person's sealed command, not reading or changing copied rows.
    /// The destination must still be named may-answer by the newest signed row and have caught up; no computer-wide
    /// join fallback is allowed. The writer checks the command's original bearer and fenced writer turn itself.
    pub(crate) fn command_settle_route(&self, address: &str, computer: &str) -> Option<Route> {
        // A removed computer cannot pull later placement rows. Its durable
        // command still follows the current signed route, on this same
        // command-only transport. Ordinary peer messages never use this path.
        if computer == crate::account::computers::settings().pending_writes.current_writer_path {
            return self.current_route(address, COMPUTER_RESOURCE);
        }
        self.answering_route(address, computer)
    }

    /// The live session of `computer` for the account at `address`, when the newest signed row names it may-answer and it
    /// has caught up. The one computer a copy's `not_writer` refusal names gets the refused message once more through
    /// this (`gateway.rs`), and a command settle reaches only this.
    pub(crate) fn answering_route(&self, address: &str, computer: &str) -> Option<Route> {
        let live = self.live(address, COMPUTER_RESOURCE);
        let top = top_row(&live, address)?;
        if !top.may_answer.iter().any(|named| named == computer) {
            return None;
        }
        live.into_iter()
            .find(|entry| entry.route.device_id == computer && !entry.session.catching_up(address))
            .map(|entry| Route { account_id: address.to_owned(), ..entry.route })
    }

    /// Every live session the newest signed row names may-answer and that has caught up, as routes named by the address. A
    /// computer that answers `not_held` for the account is passed the request on to the next of these (`gateway.rs`
    /// `forward_http`).
    pub(crate) fn may_answer_routes(&self, address: &str) -> Vec<Route> {
        let live = self.live(address, COMPUTER_RESOURCE);
        let Some(top) = top_row(&live, address) else { return Vec::new() };
        live.into_iter()
            .filter(|entry| top.may_answer.binary_search(&entry.route.device_id).is_ok() && !entry.session.catching_up(address))
            .map(|entry| Route { account_id: address.to_owned(), ..entry.route })
            .collect()
    }

    /// A writer's term announcement (`messages::TermAnnouncement`) from `computer` for the account at `address`, taken at `now`
    /// (D10). It is kept as the routing hint of that account (`note_announced`, highest term kept) only when its signature checks
    /// against `computer`'s own key, the term has not run out, and the newest signed row held from live sessions names `computer` as a
    /// copy keeper or voter. It never feeds the fence: only accepted writer traffic does (`note_writer`). Answers whether it was taken.
    pub(crate) fn take_term_announcement(&self, address: &str, computer: &str, announcement: &TermAnnouncement, now: i64) -> bool {
        let parts = TermAnnouncement::signed_parts(address, announcement.term, announcement.expires_at_ms);
        let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
        if !verify_use("term", computer, &parts, announcement.at, now, &announcement.signature) {
            crate::quiet_eprintln!("term-announcement event=refused reason=signature");
            return false;
        }
        if announcement.expires_at_ms <= now {
            crate::quiet_eprintln!("term-announcement event=refused reason=expired");
            return false;
        }
        let live = self.live(address, COMPUTER_RESOURCE);
        let holder = top_row(&live, address).is_some_and(|top| top.copy_keepers.iter().chain(top.voters.iter()).any(|named| named == computer));
        if !holder {
            crate::quiet_eprintln!("term-announcement event=refused reason=not-holder");
            return false;
        }
        self.note_announced(address, computer, announcement.term);
        true
    }

    /// The computer `computer` tells the row again for the account at `address` while its session stays open (its
    /// row was edited): taken for that computer's live session that told the account, when the row is believed for
    /// the address (`KeptAccount::believed`) and is not older than what the session holds. From then on the forwarder routes
    /// by it (`current_route`, `computer_route`) as by a row told at the open. `catching_up`: whether the computer still
    /// does not answer the account (it has not caught up with the writer); `current_route` passes over it until it
    /// says it does. Answers whether it was taken.
    pub(crate) fn tell_again(
        &self,
        address: &str,
        computer: &str,
        told: KeptAccount,
        catching_up: bool,
    ) -> bool {
        if !told.believed(address) {
            return false;
        }
        // The computer can read its valid ACK before `install` publishes `active`. This mutation waits only
        // for that publication boundary, never for invocation I/O on the general turn: a request in flight
        // may itself cause a synchronous placement announcement. Route lookups keep their short active lock.
        // Preserve address-to-owner aliases: an account-specific session can carry its internal owner id, not
        // the public signed address. Lock the genuine selected slot, not a slot invented from the public name.
        let selected = self.live(address, COMPUTER_RESOURCE).into_iter()
            .find(|entry| entry.route.device_id == computer).and_then(|entry| self.slot(&key_of(&entry.route)));
        let wide = self.slot(&(computer.to_owned(), COMPUTER_RESOURCE.to_owned(), computer.to_owned()));
        for slot in selected.into_iter().chain(wide) {
            let Ok(_publication) = slot.publication.lock() else { return false };
            let Ok(active) = slot.active.lock() else { return false };
            let Some(entry) = active.as_ref().cloned() else { continue };
            if entry.route.device_id != computer || !entry.session.is_ready() {
                continue;
            }
            // Registration or a replacement may have completed while this mutation waited. Revalidate the
            // published session and signed account binding under the publication guard; a wide session can add a new row.
            if !super::session::computer_wide(&entry.route)
                && !entry.session.told().iter().any(|kept| kept.believed(address))
            {
                continue;
            }
            let taken = entry.session.tell_again(told);
            if taken { entry.session.set_catching_up(address, catching_up); }
            let taken = taken && entry.session.is_ready();
            // Clear/replace cannot race the short placement mutation; neither operation waits on invocation I/O here.
            drop(active);
            if taken {
                log_connected(
                    "told-again",
                    &entry,
                    if catching_up { " catching_up=yes" } else { " catching_up=no" },
                );
            }
            return taken;
        }
        false
    }

    /// Whether `computer`'s own session (`session::computer_wide`) is live now.
    pub(crate) fn computer_live(&self, computer: &str) -> bool {
        self.computer_session(computer).is_some()
    }

    /// The live session `computer` opened for itself rather than for one account (`session::computer_wide`).
    fn computer_session(&self, computer: &str) -> Option<Entry> {
        let slot = self.slot(&(computer.to_owned(), COMPUTER_RESOURCE.to_owned(), computer.to_owned()))?;
        let entry = slot.active.lock().ok()?.as_ref().cloned()?;
        entry.session.is_ready().then_some(entry)
    }

    fn slot(&self, key: &Key) -> Option<Arc<Slot>> {
        self.slots.lock().ok()?.get(key).cloned()
    }

    fn install_slot(&self, key: &Key) -> Option<Arc<Slot>> {
        let mut slots = self.slots.lock().ok()?;
        if let Some(slot) = slots.get(key) {
            return Some(slot.clone());
        }
        if slots.len() >= MAX_ROUTE_SLOTS {
            slots.retain(|_, slot| {
                // A caller may hold a newly created empty entry while it is
                // installing and acknowledging its session. Keep that entry
                // reachable until its admission completes.
                Arc::strong_count(slot) > 1
                    || slot.active.lock().is_ok_and(|entry| {
                        entry
                            .as_ref()
                            .is_some_and(|entry| !entry.session.is_past_lifetime())
                    })
            });
        }
        if slots.len() >= MAX_ROUTE_SLOTS {
            return None;
        }
        let slot = Arc::new(Slot::default());
        slots.insert(key.clone(), slot.clone());
        Some(slot)
    }

    /// Acknowledge the exact admitted route to the computer, then publish it.
    /// The per-computer turn is held through the acknowledgement, so a
    /// replacement waits for any in-flight dispatch before it becomes ready;
    /// the session it replaces is retired once the new one is published.
    /// Another computer of the same account keeps its own entry.
    pub fn install<S: Read + Write + Send + 'static>(
        &self,
        session: Arc<ForwarderConnection<S>>,
    ) -> Result<(), crate::refusal_cause::CodedError<()>> {
        let route = session.route().clone();
        let key = key_of(&route);
        let slot = self.install_slot(&key).ok_or_else(|| crate::refusal_cause::CodedError::new(()))?;
        let _turn = slot.turn.lock().map_err(|_| crate::refusal_cause::CodedError::new(()))?;
        // Acquire publication only after an in-flight invocation released its turn, so that invocation may
        // still announce placement while a replacement waits for it. ACK and active publication share this guard.
        let _publication = slot.publication.lock().map_err(|_| crate::refusal_cause::CodedError::new(()))?;
        let candidate: Arc<dyn RegisteredSession> = session.clone();
        if slot.active.lock().map_err(|_| crate::refusal_cause::CodedError::new(()))?
            .as_ref()
            .is_some_and(|entry| Arc::ptr_eq(&entry.session, &candidate))
        {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        let entry = Entry { route, session: candidate };
        let second = refused_second_session(slot.active.lock().map_err(|_| crate::refusal_cause::CodedError::new(()))?.as_ref(), entry.session.as_ref());
        if second {
            session.retire();
            log_connected("refused", &entry, " reason=second-session");
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        if let Err(failure) = session.acknowledge() {
            session.retire();
            log_connected("refused", &entry, " reason=acknowledgement");
            crate::quiet_eprintln!("door-refusal code=connection_acknowledgement_refused cause={}", failure.cause());
            return Err(failure);
        }
        log_connected("added", &entry, "");
        let previous = slot.active.lock().map_err(|_| crate::refusal_cause::CodedError::new(()))?.replace(entry);
        if let Some(previous) = previous {
            previous.session.retire();
            log_connected("removed", &previous, " reason=replaced");
        }
        Ok(())
    }

    /// The live sessions on `resource` that told the account at `address`
    /// (a row believed for it), one per computer. A session that is no longer
    /// ready is cleared as it is found. Only published (acknowledged) sessions
    /// are seen, and nothing here waits on a message in flight.
    fn live(&self, address: &str, resource: &str) -> Vec<Entry> {
        let slots: Vec<Arc<Slot>> = match self.slots.lock() {
            Ok(slots) => slots
                .iter()
                .filter(|((_, held_resource, _), _)| held_resource == resource)
                .map(|(_, slot)| slot.clone())
                .collect(),
            Err(_) => return Vec::new(),
        };
        let mut live = Vec::new();
        for slot in slots {
            let Ok(mut active) = slot.active.lock() else { continue };
            let Some(entry) = active.as_ref().cloned() else { continue };
            if !entry.session.is_ready() {
                *active = None;
                log_connected("removed", &entry, " reason=not-ready");
            } else if entry.session.told().iter().any(|told| told.believed(address)) {
                live.push(entry);
            }
        }
        live
    }
}

/// What a test stands behind a live computer session (`ConnectedComputers::live_for_test`): what the computer tells now,
/// whether it says it is catching up on the account, and whether its session is still open.
#[cfg(test)]
pub(crate) trait TestComputer: Send + Sync {
    fn told(&self) -> Vec<KeptAccount>;
    fn catching_up(&self, address: &str) -> bool;
    fn live(&self) -> bool;
    /// The computer's reply to one invoke frame (what the session carries back), when it answers one.
    fn reply(&self, _message: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

#[cfg(test)]
struct TestSession(Arc<dyn TestComputer>);

#[cfg(test)]
impl ComputerConnections for TestSession {
    fn invoke(&self, _route: &Route, message: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
        self.0.reply(message).ok_or_else(|| crate::refusal_cause::CodedError::new(()))
    }
}

#[cfg(test)]
impl RegisteredSession for TestSession {
    fn is_ready(&self) -> bool {
        self.0.live()
    }
    fn is_past_lifetime(&self) -> bool {
        !self.0.live()
    }
    fn retire(&self) {}
    fn told(&self) -> Vec<KeptAccount> {
        self.0.told()
    }
    fn catching_up(&self, address: &str) -> bool {
        self.0.catching_up(address)
    }
}

#[cfg(test)]
impl ConnectedComputers {
    /// A live session of `computer` for the account at `address` on the computer resource, answered by `held` (a test's
    /// computer: its copies' row, whether they answer now, whether it is up), so a test routes by the real
    /// `current_route` over computers it runs in process.
    pub(crate) fn live_for_test(&self, address: &str, computer: &str, held: Arc<dyn TestComputer>) {
        let route = Route { account_id: address.into(), device_id: computer.into(), resource_address: COMPUTER_RESOURCE.into(),
            generation: format!("test-{computer}") };
        let slot = self.install_slot(&key_of(&route)).expect("slot");
        *slot.active.lock().unwrap() = Some(Entry { route, session: Arc::new(TestSession(held)) });
    }

    /// The computer `current_route` answers the account's calls at now, by its id.
    pub(crate) fn chosen_for_test(&self, address: &str) -> Option<String> {
        self.current_route(address, COMPUTER_RESOURCE).map(|route| route.device_id)
    }
}

/// The resource every computer session is opened on (`remote_connection_check::computer_route`).
const COMPUTER_RESOURCE: &str = "@own-records";

/// The highest signed row believed for `address` among what `live` sessions told; `None` when none, or when two
/// different rows share the top revision.
fn top_row(live: &[Entry], address: &str) -> Option<ComputersRow> {
    let mut top: Option<ComputersRow> = None;
    let mut mismatch = false;
    for entry in live {
        for told in entry.session.told() {
            if !told.believed(address) {
                continue;
            }
            let row = told.row;
            match &top {
                Some(current) if row.revision < current.revision => {}
                Some(current) if row.revision == current.revision => {
                    mismatch |= row != *current;
                }
                _ => {
                    mismatch = false;
                    top = Some(row);
                }
            }
        }
    }
    if mismatch { None } else { top }
}

fn key_of(route: &Route) -> Key {
    (route.account_id.clone(), route.resource_address.clone(), route.device_id.clone())
}

impl RouteDirectory for ConnectedComputers {
    /// The live computer that answers the account at the address `account_id` on `resource` now, chosen from the
    /// highest signed computers row (see the module doc), as a route named by the address. `None` when no verified row
    /// names a live computer.
    fn current_route(&self, account_id: &str, resource_address: &str) -> Option<Route> {
        let live = self.live(account_id, resource_address);
        let top = top_row(&live, account_id)?;
        let writer = self.routing_writer(account_id).map(|(_, computer)| computer);
        // A computer the row lets answer that said it has not caught up yet (it joins, holds no root, does not vote yet, or
        // its sign-in rows do not match the writer's) is passed over: the calls go to a computer that has, the writer
        // first. Before, a new computer was chosen as soon as its session opened, and refused the account's own key
        // (401) or answered 503 while the old computer was live (measured 2026-11-03, 94 x 401 and 79 x 503 in a move).
        let may_answer = |entry: &&Entry| top.may_answer.binary_search(&entry.route.device_id).is_ok()
            && !entry.session.catching_up(account_id);
        let chosen = live.iter().filter(may_answer).find(|entry| writer.as_deref() == Some(entry.route.device_id.as_str()))
            .or_else(|| live.iter().find(may_answer))?;
        Some(Route { account_id: account_id.to_owned(), ..chosen.route.clone() })
    }
}

impl ConnectedComputers {
    /// The live entry a route `current_route` answered stands for: the session of the same computer, resource and
    /// generation that told the route's address.
    fn entry_for(&self, route: &Route) -> Option<Entry> {
        if let Some(slot) = self.slot(&key_of(route)) {
            if let Some(entry) = slot.active.lock().ok()?.as_ref().filter(|entry| entry.route == *route) {
                return Some(entry.clone());
            }
        }
        self.live(&route.account_id, &route.resource_address).into_iter().find(|entry| {
            entry.route.device_id == route.device_id && entry.route.generation == route.generation
        })
        // The computer's own session, for a message to a computer that does not keep the account yet (`computer_route`).
        .or_else(|| self.computer_session(&route.device_id).filter(|entry| {
            entry.route.generation == route.generation && entry.route.resource_address == route.resource_address
        }))
    }
}

impl ComputerConnections for ConnectedComputers {
    /// Send the message on `route`. A route named by an address whose session carries another account name (an account
    /// whose internal owner id is not its address) has its message renamed to the session's own account before it
    /// leaves; nothing else in the message changes.
    /// Messages of one computer wait for its turn; a message whose deadline passes
    /// while it waits is not sent (`ForwarderConnection::invoke`).
    ///
    /// A message that never leaves here (no session stands for its route, or the one that stood was replaced or ended
    /// before the message's turn) is answered with a correlated `ROUTE_UNAVAILABLE` refusal, as the session itself
    /// answers a message it never sent: the operation never started, so its outcome is known. Before, each of these
    /// was `Err`, which the caller can only read as an outcome that is unknown.
    fn invoke(&self, route: &Route, message: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
        let not_sent = |cause: crate::refusal_cause::Cause| {
            let mut decoded = crate::resource_authority::decode_message(message).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
            decoded.client_authorization.zeroize();
            super::session::refusal(&decoded.request_id, super::ROUTE_UNAVAILABLE, cause).map_err(|_| crate::refusal_cause::CodedError::new(()))
        };
        let Some(entry) = self.entry_for(route) else { return not_sent(crate::cause!()) };
        let Some(slot) = self.slot(&key_of(&entry.route)) else { return not_sent(crate::cause!()) };
        let Ok(_turn) = slot.turn.lock() else { return not_sent(crate::cause!()) };
        let Some(held) = slot.active.lock().ok().and_then(|active| active.as_ref().cloned()) else { return not_sent(crate::cause!()) };
        if held.route != entry.route {
            return not_sent(crate::cause!());
        }
        if !held.session.is_ready() {
            slot.clear_if(&held.session);
            return not_sent(crate::cause!());
        }
        let renamed;
        // A computer's own session carries the message as it is: it names the account it is for (`session::computer_wide`).
        let bytes = if held.route.account_id == route.account_id || super::session::computer_wide(&held.route) {
            message
        } else {
            let mut decoded = crate::resource_authority::decode_message(message).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
            if decoded.account_id != route.account_id {
                decoded.client_authorization.zeroize();
                return Err(crate::refusal_cause::CodedError::new(()));
            }
            decoded.account_id = held.route.account_id.clone();
            renamed = zeroize::Zeroizing::new(serde_json::to_vec(&decoded).map_err(|_| crate::refusal_cause::CodedError::new(()))?);
            decoded.client_authorization.zeroize();
            renamed.as_slice()
        };
        let result = held.session.invoke(&held.route, bytes);
        if !held.session.is_ready() {
            slot.clear_if(&held.session);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::computers::{AccountKey, ComputerSigner};
    use crate::secrets::secrets_key::ComputerKey;

    const OTHER: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const RESOURCE: &str = "@own-records";
    const COMPUTER_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const COMPUTER_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const COMPUTER_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const NOW: i64 = 1_000_000;

    fn account_key() -> &'static AccountKey {
        static KEY: std::sync::OnceLock<AccountKey> = std::sync::OnceLock::new();
        KEY.get_or_init(|| AccountKey::generate().expect("key"))
    }

    fn impostor_key() -> AccountKey {
        AccountKey::generate().expect("key")
    }

    /// The account whose rows the tests tell: the owner id `account_key` names.
    fn account() -> String {
        account_key().address()
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    /// The account's row signed with `key`, told with `key`'s public key.
    fn row(revision: u64, copy_keepers: &[&str], may_answer: &[&str], key: &AccountKey) -> KeptAccount {
        let row = ComputersRow::sign(&account(), revision, &names(copy_keepers), &names(may_answer), key).expect("signed");
        KeptAccount { row, account_key: key.public_hex() }
    }

    struct FakeSession {
        expired: bool,
        rows: Mutex<Vec<KeptAccount>>,
        catching_up: Mutex<std::collections::HashSet<String>>,
    }

    impl ComputerConnections for FakeSession {
        /// Answers the account the message it was sent names, so a test sees what reached the session.
        fn invoke(&self, route: &Route, message: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
            let message = crate::resource_authority::decode_message(message).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
            if message.account_id != route.account_id { return Err(crate::refusal_cause::CodedError::new(())); }
            Ok(message.account_id.into_bytes())
        }
    }

    impl RegisteredSession for FakeSession {
        fn is_ready(&self) -> bool {
            !self.expired
        }

        fn is_past_lifetime(&self) -> bool {
            self.expired
        }

        fn retire(&self) {}

        fn told(&self) -> Vec<KeptAccount> {
            self.rows.lock().unwrap().clone()
        }

        fn tell_again(&self, told: KeptAccount) -> bool {
            let mut rows = self.rows.lock().unwrap();
            match rows.iter_mut().find(|kept| kept.row.account == told.row.account) {
                Some(kept) if kept.row.revision > told.row.revision => false,
                Some(kept) => {
                    *kept = told;
                    true
                }
                None => {
                    rows.push(told);
                    true
                }
            }
        }

        fn catching_up(&self, address: &str) -> bool {
            self.catching_up.lock().unwrap().contains(address)
        }

        fn set_catching_up(&self, address: &str, catching_up: bool) {
            let mut held = self.catching_up.lock().unwrap();
            if catching_up { held.insert(address.to_owned()); } else { held.remove(address); }
        }
    }

    fn route_at(account: &str, resource: &str, computer: &str) -> Route {
        Route {
            account_id: account.into(),
            device_id: computer.into(),
            resource_address: resource.into(),
            generation: "generation".into(),
        }
    }

    /// A live session of `computer` for `ACCOUNT` that told `rows`.
    fn tell(directory: &ConnectedComputers, computer: &str, rows: Vec<KeptAccount>) {
        let entry = Entry {
            route: route_at(&account(), RESOURCE, computer),
            session: Arc::new(FakeSession { expired: false, rows: Mutex::new(rows), catching_up: Mutex::default() }),
        };
        let slot = directory.install_slot(&key_of(&entry.route)).expect("slot");
        *slot.active.lock().unwrap() = Some(entry);
    }

    #[test]
    fn a_connected_line_names_the_peer_address_it_was_admitted_from() {
        let entry = Entry {
            route: route_at(&account(), RESOURCE, COMPUTER_A),
            session: Arc::new(FakeSession { expired: false, rows: Mutex::new(vec![]), catching_up: Mutex::default() }),
        };
        let line = connected_line("added", &entry, "203.0.113.7:443", "");
        assert!(line.ends_with(" peer=203.0.113.7:443"), "{line}");
        assert!(line.contains(&format!(" device={COMPUTER_A} ")), "{line}");
    }

    fn chosen(directory: &ConnectedComputers) -> Option<String> {
        directory.current_route(&account(), RESOURCE).map(|route| route.device_id)
    }

    #[test]
    fn a_row_told_again_while_the_sessions_stay_open_is_what_the_forwarder_routes_by() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        tell(&directory, COMPUTER_A, vec![row(1, &[COMPUTER_A], &[COMPUTER_A], key)]);
        tell(&directory, COMPUTER_B, vec![row(1, &[COMPUTER_A], &[COMPUTER_A], key)]);
        assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_A));
        assert!(directory.computer_route(&account(), COMPUTER_A, COMPUTER_B).is_none(), "row 1 does not name B");
        // The owner edits the row: A and B hold, B answers. A tells it again; no session is opened or closed.
        assert!(directory.tell_again(&account(), COMPUTER_A, row(2, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_B], key), false));
        assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_B), "the edited row is the one routed by");
        assert!(directory.computer_route(&account(), COMPUTER_A, COMPUTER_B).is_some(), "a message between A and B now passes");
        // An older row, a row the account's key did not sign, and a computer with no live session are not taken.
        assert!(!directory.tell_again(&account(), COMPUTER_A, row(1, &[COMPUTER_A], &[COMPUTER_A], key), false));
        assert!(!directory.tell_again(&account(), COMPUTER_A, row(3, &[COMPUTER_A], &[COMPUTER_A], &impostor_key()), false));
        assert!(!directory.tell_again(&account(), COMPUTER_C, row(3, &[COMPUTER_C], &[COMPUTER_C], key), false));
        assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_B));
    }

    #[test]
    fn the_highest_signed_revision_picks_the_computer() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        tell(&directory, COMPUTER_A, vec![row(1, &[COMPUTER_A], &[COMPUTER_A], key)]);
        tell(&directory, COMPUTER_B, vec![row(2, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_B], key)]);
        assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_B));
    }

    #[test]
    fn the_highest_row_is_not_replaced_by_an_older_one_when_its_computer_is_not_live() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        // Revision 1 allows A and A is live. Revision 2, told by C, allows only B, and B is not live.
        tell(&directory, COMPUTER_A, vec![row(1, &[COMPUTER_A], &[COMPUTER_A], key)]);
        tell(&directory, COMPUTER_C, vec![row(2, &[COMPUTER_A, COMPUTER_B, COMPUTER_C], &[COMPUTER_B], key)]);
        assert_eq!(chosen(&directory), None, "the older row does not stand in for the newer one");
    }

    #[test]
    fn an_unsigned_or_wrongly_signed_row_is_refused() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        let mut unsigned = row(9, &[COMPUTER_A], &[COMPUTER_A], key);
        unsigned.row.signature = String::new();
        tell(&directory, COMPUTER_A, vec![unsigned]);
        tell(&directory, COMPUTER_B, vec![row(9, &[COMPUTER_B], &[COMPUTER_B], &impostor_key())]);
        assert_eq!(chosen(&directory), None, "a computer cannot make its own row true");
        tell(&directory, COMPUTER_C, vec![row(1, &[COMPUTER_C], &[COMPUTER_C], key)]);
        assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_C), "only the verified row counts");
    }

    #[test]
    fn a_row_for_another_account_is_ignored() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        let mut elsewhere = row(4, &[COMPUTER_A], &[COMPUTER_A], key);
        elsewhere.row.account = OTHER.to_string();
        tell(&directory, COMPUTER_A, vec![elsewhere]);
        assert_eq!(chosen(&directory), None);
    }

    #[test]
    fn two_different_rows_at_the_top_revision_refuse_every_computer() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        tell(&directory, COMPUTER_A, vec![row(5, &[COMPUTER_A], &[COMPUTER_A], key)]);
        tell(&directory, COMPUTER_B, vec![row(5, &[COMPUTER_B], &[COMPUTER_B], key)]);
        assert_eq!(chosen(&directory), None, "a mismatch at one revision is shown, never answered");
    }

    #[test]
    fn the_same_row_told_twice_is_not_a_mismatch() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        tell(&directory, COMPUTER_A, vec![row(5, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A], key)]);
        tell(&directory, COMPUTER_B, vec![row(5, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A], key)]);
        assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_A));
    }

    #[test]
    fn only_a_live_computer_that_may_answer_is_forwarded_to() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        let rows = vec![row(3, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A], key)];
        tell(&directory, COMPUTER_B, rows.clone());
        assert_eq!(chosen(&directory), None, "B holds the copy but may not answer");
        tell(&directory, COMPUTER_A, rows);
        assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_A));
    }

    #[test]
    fn no_live_allowed_computer_gives_none() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        assert_eq!(chosen(&directory), None, "no session at all");
        tell(&directory, COMPUTER_B, vec![row(1, &[COMPUTER_A], &[COMPUTER_A], key)]);
        assert_eq!(chosen(&directory), None, "the allowed computer is not live");
    }

    #[test]
    fn a_row_told_with_a_key_its_account_does_not_name_is_refused() {
        let directory = ConnectedComputers::new();
        // The impostor's key signs the row and is told with it, but the owner id is not derived from it.
        let impostor = impostor_key();
        tell(&directory, COMPUTER_A, vec![row(7, &[COMPUTER_A], &[COMPUTER_A], &impostor)]);
        assert_eq!(chosen(&directory), None);
        // The account's real row told with the impostor's key is refused too.
        let mut swapped = row(1, &[COMPUTER_A], &[COMPUTER_A], account_key());
        swapped.account_key = impostor.public_hex();
        tell(&directory, COMPUTER_B, vec![swapped]);
        assert_eq!(chosen(&directory), None);
    }

    #[test]
    fn an_account_whose_owner_id_is_not_its_address_is_routed_by_its_address() {
        let directory = ConnectedComputers::new();
        // The session's route carries the account's internal owner id (an account made before addresses); it
        // told the account's row for the address.
        let owner_id = "5".repeat(64);
        let route = Route { account_id: owner_id.clone(), ..route_at(&account(), RESOURCE, COMPUTER_A) };
        let entry = Entry { route: route.clone(), session: Arc::new(FakeSession { expired: false,
            rows: Mutex::new(vec![row(1, &[COMPUTER_A], &[COMPUTER_A], account_key())]), catching_up: Mutex::default() }) };
        let slot = directory.install_slot(&key_of(&route)).expect("slot");
        *slot.active.lock().unwrap() = Some(entry);
        let public = directory.current_route(&account(), RESOURCE).expect("routed by the address");
        assert_eq!(public.account_id, account());
        assert_eq!((public.device_id.as_str(), public.generation.as_str()), (COMPUTER_A, route.generation.as_str()));
        assert_eq!(directory.current_route(&owner_id, RESOURCE), None, "the owner id routes nothing");
        // A message on the address's route reaches the session named by the session's own account.
        let message = serde_json::to_vec(&crate::resource_authority::InvokeMessage { person_present: None,
            request_id: "req".into(), account_id: account(), device_id: COMPUTER_A.into(), resource_address: RESOURCE.into(),
            operation_resource: None, generation: route.generation.clone(), operation: "records:read".into(),
            input: serde_json::json!({}), request_key: "k".into(), client_authorization: "bearer".into(), deadline_at_ms: 1,
        }).unwrap();
        assert_eq!(directory.invoke(&public, &message).unwrap(), owner_id.as_bytes());
        // A message on a route no session stands for is refused, never sent and never an unknown outcome.
        let other = Route { account_id: OTHER.into(), ..public.clone() };
        let refused: serde_json::Value = serde_json::from_slice(&directory.invoke(&other, &message).unwrap()).unwrap();
        assert_eq!({ let mut source_reply = refused; let source_cause = source_reply.as_object_mut().unwrap().remove("cause").expect("every refusal carries its construction source"); let source_cause = crate::refusal_cause::ReportedCause::from_wire(source_cause.as_str().unwrap()).expect("the source identity is valid and content-free"); assert!(source_cause.id().contains("@src/forwarder/")); source_reply }, serde_json::json!({"state": "refused", "request_id": "req", "code": crate::forwarder::ROUTE_UNAVAILABLE}));
    }

    #[test]
    fn two_computers_of_one_account_coexist_and_a_computer_replaces_only_itself() {
        let directory = ConnectedComputers::new();
        let rows = vec![row(1, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A], account_key())];
        tell(&directory, COMPUTER_A, rows.clone());
        tell(&directory, COMPUTER_B, rows);
        tell(&directory, COMPUTER_C, vec![]);
        let a = directory.slot(&(account(), RESOURCE.into(), COMPUTER_A.into())).expect("A keeps its slot");
        assert!(a.active.lock().unwrap().is_some());
        assert_eq!(directory.live(&account(), RESOURCE).len(), 2, "a session that told nothing for the address is not its");
    }

    #[test]
    fn full_directory_reclaims_expired_sessions_but_keeps_pending_installations() {
        let directory = ConnectedComputers::new();
        let expired: Arc<dyn RegisteredSession> = Arc::new(FakeSession { expired: true, rows: Mutex::new(vec![]), catching_up: Mutex::default() });
        let live_session: Arc<dyn RegisteredSession> = Arc::new(FakeSession { expired: false, rows: Mutex::new(vec![]), catching_up: Mutex::default() });
        let pending_key: Key = ("account".into(), "pending".into(), COMPUTER_A.into());
        let pending = Arc::new(Slot::default());
        {
            let mut slots = directory.slots.lock().unwrap();
            slots.insert(pending_key.clone(), pending.clone());
            for index in 1..MAX_ROUTE_SLOTS {
                let address = format!("resource:{index}");
                let session = if index == 1 {
                    expired.clone()
                } else {
                    live_session.clone()
                };
                slots.insert(
                    ("account".into(), address.clone(), COMPUTER_A.into()),
                    Arc::new(Slot {
                        active: Mutex::new(Some(Entry {
                            route: route_at("account", &address, COMPUTER_A),
                            session,
                        })),
                        turn: Mutex::new(()),
                        publication: Mutex::new(()),
                    }),
                );
            }
        }

        let replacement_key: Key = ("account".into(), "replacement".into(), COMPUTER_A.into());
        let replacement = directory.install_slot(&replacement_key).unwrap();
        let slots = directory.slots.lock().unwrap();
        assert!(!slots.contains_key(&("account".into(), "resource:1".into(), COMPUTER_A.into())));
        assert!(slots.contains_key(&pending_key));
        assert!(Arc::ptr_eq(
            slots.get(&replacement_key).unwrap(),
            &replacement
        ));
        assert_eq!(slots.len(), MAX_ROUTE_SLOTS);
        drop(slots);

        // Once nobody is installing these empty entries, capacity can be reused.
        drop(pending);
        drop(replacement);
        let next_key: Key = ("account".into(), "next".into(), COMPUTER_A.into());
        assert!(directory.install_slot(&next_key).is_some());
        let slots = directory.slots.lock().unwrap();
        assert!(!slots.contains_key(&pending_key));
        assert!(!slots.contains_key(&replacement_key));
        assert!(slots.contains_key(&next_key));
    }

    mod in_flight_tests;
    mod not_sent_tests;
    mod registration_tests;

    /// A move from A to B (2026-11-03): B's session opens and tells the edited row, which lets B answer, while B
    /// has not caught up with the writer A. The forwarder keeps sending the account's calls to A until B says it answers;
    /// before, the calls went to B as soon as it was live, and failed there (401 for the account's own key, 503) while
    /// A was live and may-answer. A computer that is catching up still gets the messages between computers (it must catch up).
    #[test]
    fn a_computer_that_has_not_caught_up_gets_no_calls_and_the_writer_keeps_them() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        let both = [COMPUTER_A, COMPUTER_B];
        let row = ComputersRow::sign_with_voters(&account(), 2, &names(&both), &names(&both), &names(&[COMPUTER_A]), key).unwrap();
        let told = KeptAccount { row, account_key: key.public_hex() };
        tell(&directory, COMPUTER_B, vec![told.clone()]);
        assert!(directory.tell_again(&account(), COMPUTER_B, told.clone(), true));
        tell(&directory, COMPUTER_A, vec![told.clone()]);
        for _ in 0..20 {
            assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_A), "the writer answers while B catches up");
        }
        assert!(directory.computer_route(&account(), COMPUTER_A, COMPUTER_B).is_some(), "messages still reach B");
        // A only computer that is catching up answers nothing: 503 rather than a call it would refuse.
        let lonely = ConnectedComputers::new();
        tell(&lonely, COMPUTER_B, vec![told.clone()]);
        assert!(lonely.tell_again(&account(), COMPUTER_B, told.clone(), true));
        assert_eq!(chosen(&lonely), None);
        // B caught up and says so: it may answer now, and the writer is still preferred while the forwarder knows it.
        assert!(directory.tell_again(&account(), COMPUTER_B, told.clone(), false));
        directory.note_writer(&account(), COMPUTER_A, 1, NOW);
        assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_A));
        directory.note_writer(&account(), COMPUTER_B, 2, NOW);
        assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_B), "the writer role moved to B");
    }

    /// Local commands retained before a computer was removed still reach the current answering writer. This route
    /// grants no access to a record feed: all ordinary peer messages keep the signed sender-membership fence.
    #[test]
    fn a_command_settle_from_an_omitted_computer_reaches_only_a_current_answerer() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        let told = row(1, &[COMPUTER_B, COMPUTER_C], &[COMPUTER_B], key);
        tell(&directory, COMPUTER_B, vec![told.clone()]);
        tell(&directory, COMPUTER_C, vec![told.clone()]);
        assert!(directory.computer_route(&account(), COMPUTER_A, COMPUTER_B).is_none(),
            "an omitted computer gets no ordinary row/feed route");
        assert_eq!(directory.command_settle_route(&account(), COMPUTER_B).map(|route| route.device_id).as_deref(),
            Some(COMPUTER_B), "the command's caller rights are checked at the live writer");
        assert!(directory.command_settle_route(&account(), COMPUTER_A).is_none(), "the omitted computer is no target");
        assert!(directory.command_settle_route(&account(), COMPUTER_C).is_none(), "a sealed copy keeper cannot answer commands");
        assert!(directory.command_settle_route(OTHER, COMPUTER_B).is_none(), "the account is part of the route");
        assert!(directory.tell_again(&account(), COMPUTER_B, told.clone(), true));
        assert!(directory.command_settle_route(&account(), COMPUTER_B).is_none(), "catching up grants no command route");
        assert!(directory.tell_again(&account(), COMPUTER_B, told, false));
        assert!(directory.command_settle_route(&account(), COMPUTER_B).is_some());
        let moved = row(2, &[COMPUTER_C], &[COMPUTER_C], key);
        assert!(directory.tell_again(&account(), COMPUTER_C, moved, false));
        assert!(directory.command_settle_route(&account(), COMPUTER_B).is_none(), "the newest signed row wins");
        assert!(directory.command_settle_route(&account(), COMPUTER_C).is_some());
    }

    /// A retained command can outlive every destination in the sender's local
    /// row. The command-only current route follows the newest signed placement.
    #[test]
    fn a_command_settle_follows_a_new_writer_without_the_senders_current_placement() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        let current = &crate::account::computers::settings().pending_writes.current_writer_path;
        tell(&directory, COMPUTER_B, vec![row(1, &[COMPUTER_B], &[COMPUTER_B], key)]);
        directory.note_writer(&account(), COMPUTER_B, 1, NOW);
        assert_eq!(directory.command_settle_route(&account(), current).unwrap().device_id, COMPUTER_B);
        let moved = row(2, &[COMPUTER_C], &[COMPUTER_C], key);
        tell(&directory, COMPUTER_C, vec![moved.clone()]);
        directory.note_writer(&account(), COMPUTER_C, 2, NOW);
        assert!(directory.command_settle_route(&account(), COMPUTER_B).is_none(), "the old destination is no longer admitted");
        assert_eq!(directory.command_settle_route(&account(), current).unwrap().device_id, COMPUTER_C,
            "the sender need not learn a row it no longer has rights to pull");
        assert!(directory.computer_route(&account(), COMPUTER_A, current).is_none(), "this grants no ordinary copies route");
        assert!(directory.command_settle_route(OTHER, current).is_none(), "the current route remains account-bound");
        assert!(directory.tell_again(&account(), COMPUTER_C, moved, true));
        assert!(directory.command_settle_route(&account(), current).is_none(), "an unready new computer grants no current command route");
    }

    #[test]
    fn the_writer_answers_first_and_a_stale_writer_is_refused() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        let all = [COMPUTER_A, COMPUTER_B, COMPUTER_C];
        let row = ComputersRow::sign_with_voters(&account(), 1, &names(&all), &names(&all), &names(&all), key).unwrap();
        for computer in all {
            tell(&directory, computer, vec![KeptAccount { row: row.clone(), account_key: key.public_hex() }]);
        }
        let first = chosen(&directory).unwrap();
        directory.note_writer(&account(), COMPUTER_C, 2, NOW);
        assert_eq!(chosen(&directory).as_deref(), Some(COMPUTER_C), "the writer answers once the forwarder carried its term");
        assert_eq!(directory.term_check(&account(), 2, NOW), TermCheck::Pass);
        assert_eq!(directory.term_check(&account(), 3, NOW), TermCheck::Pass);
        assert_eq!(directory.term_check(&account(), 1, NOW), TermCheck::Stale, "a writer's message below the newest term is refused");
        directory.note_writer(&account(), COMPUTER_A, 1, NOW);
        assert_eq!(directory.writer(&account()), Some((2, COMPUTER_C.to_string())), "an older term does not move the writer");
        let _ = first;

        // Messages go only between computers the newest row names, to a live session of the named computer.
        assert_eq!(directory.computer_route(&account(), COMPUTER_A, COMPUTER_B).map(|route| route.device_id).as_deref(), Some(COMPUTER_B));
        assert_eq!(directory.computer_route(&account(), OTHER, COMPUTER_B), None, "a sender the row does not name");
        assert_eq!(directory.computer_route(&account(), COMPUTER_A, OTHER), None, "a computer the row does not name");
    }

    /// D08: a writer that stops renewing its term is refused at once when the term ran out, not when a caller gives up.
    /// A renewal at the same number carries the term on from the moment it is carried; a higher number is a new claim.
    #[test]
    fn a_writer_whose_term_lapsed_is_refused_at_once() {
        let directory = ConnectedComputers::new();
        let term_ms = crate::account::computers::settings().term_ms;
        directory.note_writer(&account(), COMPUTER_C, 2, NOW);
        assert_eq!(directory.term_check(&account(), 2, NOW + term_ms - 1), TermCheck::Pass);
        assert_eq!(directory.term_check(&account(), 2, NOW + term_ms), TermCheck::Lapsed, "the term ran out with no renewal");
        directory.note_writer(&account(), COMPUTER_C, 2, NOW + term_ms - 1);
        assert_eq!(directory.term_check(&account(), 2, NOW + term_ms), TermCheck::Pass, "a carried renewal extends the term");
        assert_eq!(directory.term_check(&account(), 2, NOW + 2 * term_ms), TermCheck::Lapsed);
        assert_eq!(directory.term_check(&account(), 3, NOW + 2 * term_ms), TermCheck::Pass, "a new claim takes a higher number");
        assert_eq!(directory.term_check(&OTHER.to_string(), 1, NOW), TermCheck::Pass, "an account with no writer carried passes");
    }

    /// D11: the writers memory keeps at most `most_writer_accounts` accounts and forgets the least recently used one.
    #[test]
    fn the_writer_memory_is_bounded_and_forgets_the_least_recently_used() {
        let directory = ConnectedComputers::new();
        let most = settings().most_writer_accounts;
        let inserted = 5_000;
        assert!(inserted > most, "the test inserts past the bound");
        for index in 0..inserted {
            directory.note_writer(&format!("account-{index}"), COMPUTER_B, 1, NOW);
        }
        assert_eq!(directory.writers.lock().unwrap().by_account.len(), most, "the memory stays at its bound");
        assert_eq!(directory.writer("account-0"), None, "the oldest unused account is forgotten");
        assert!(directory.writer(&format!("account-{}", inserted - 1)).is_some(), "the most recent insert survives");

        // A read counts as a use: the account read is kept, and the next least recently used one is forgotten.
        let directory = ConnectedComputers::new();
        for index in 0..most {
            directory.note_writer(&format!("account-{index}"), COMPUTER_B, 1, NOW);
        }
        assert!(directory.writer("account-0").is_some());
        directory.note_writer("newest", COMPUTER_B, 1, NOW);
        assert!(directory.writer("account-0").is_some(), "the account read survives");
        assert_eq!(directory.writer("account-1"), None, "the least recently used account is forgotten");
    }

    /// D09: a `not_writer` refusal names its writer, and the message goes once more there only when that computer is
    /// live and may answer the account now. Nothing else is a target.
    #[test]
    fn a_refused_message_follows_its_named_writer_only_when_it_answers() {
        let directory = ConnectedComputers::new();
        let key = account_key();
        let told = row(1, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_B], key);
        tell(&directory, COMPUTER_A, vec![told.clone()]);
        assert!(directory.answering_route(&account(), COMPUTER_B).is_none(), "a named writer with no live session is no target");
        tell(&directory, COMPUTER_B, vec![told.clone()]);
        assert_eq!(directory.answering_route(&account(), COMPUTER_B).map(|route| route.device_id).as_deref(), Some(COMPUTER_B));
        assert!(directory.answering_route(&account(), COMPUTER_A).is_none(), "a computer the row does not let answer is no target");
        assert!(directory.answering_route(OTHER, COMPUTER_B).is_none(), "the account is part of the route");
        assert!(directory.tell_again(&account(), COMPUTER_B, told.clone(), true));
        assert!(directory.answering_route(&account(), COMPUTER_B).is_none(), "a writer that has not caught up is no target");
    }

    /// A term announcement signed by `signer` for the account at `address`, as the writer posts it on each renewal.
    fn announce(signer: &ComputerSigner, address: &str, term: u64, expires_at_ms: i64, at: i64) -> TermAnnouncement {
        let parts = TermAnnouncement::signed_parts(address, term, expires_at_ms);
        let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
        TermAnnouncement { term, expires_at_ms, at, signature: signer.sign_use("term", &parts, at).expect("the term use is named") }
    }

    /// D10: a restarted forwarder, with no writer carried, learns the writer from one verified term announcement of the
    /// writer's own computer. A forged one, one from a computer the row does not hold, a tampered or lapsed one are ignored.
    #[test]
    fn a_verified_term_announcement_routes_a_fresh_forwarder_to_the_writer() {
        let writer = ComputerSigner::of(&ComputerKey::from_bytes(vec![41; 32]).unwrap()).unwrap();
        let other = ComputerSigner::of(&ComputerKey::from_bytes(vec![42; 32]).unwrap()).unwrap();
        let outsider = ComputerSigner::of(&ComputerKey::from_bytes(vec![43; 32]).unwrap()).unwrap();
        let (writer_id, other_id) = (writer.computer_id(), other.computer_id());
        let term_ms = crate::account::computers::settings().term_ms;
        let directory = ConnectedComputers::new();
        let told = row(1, &[&writer_id, &other_id], &[&writer_id, &other_id], account_key());
        tell(&directory, &writer_id, vec![told.clone()]);
        tell(&directory, &other_id, vec![told]);
        assert_eq!(directory.writer(&account()), None, "a fresh forwarder knows no writer");

        let address = account();
        let forged = announce(&other, &address, 2, NOW + term_ms, NOW);
        assert!(!directory.take_term_announcement(&address, &writer_id, &forged, NOW), "another key's signature is ignored");
        let outsiders = announce(&outsider, &address, 2, NOW + term_ms, NOW);
        assert!(!directory.take_term_announcement(&address, &outsider.computer_id(), &outsiders, NOW), "a computer the row does not hold is ignored");
        let lapsed = announce(&writer, &address, 2, NOW, NOW);
        assert!(!directory.take_term_announcement(&address, &writer_id, &lapsed, NOW), "a term that already ran out is ignored");
        let good = announce(&writer, &address, 2, NOW + term_ms, NOW);
        let mut tampered = good.clone();
        tampered.term = 9;
        assert!(!directory.take_term_announcement(&address, &writer_id, &tampered, NOW), "a term changed after signing is ignored");
        assert_eq!(directory.writer(&address), None, "none of the refused announcements was carried");

        assert!(directory.take_term_announcement(&address, &writer_id, &good, NOW));
        assert_eq!(directory.writer(&address), None, "an announcement is a hint, not carried");
        assert_eq!(directory.routing_writer(&address), Some((2, writer_id.clone())));
        assert_eq!(chosen(&directory).as_deref(), Some(writer_id.as_str()), "the first write goes to the writer");
        let newer = announce(&other, &address, 1, NOW + term_ms, NOW);
        assert!(directory.take_term_announcement(&address, &other_id, &newer, NOW));
        assert_eq!(directory.routing_writer(&address), Some((2, writer_id.clone())), "an older term does not move the writer");
    }

    /// The fence reads only what accepted writer traffic carried. A holder of the row that announces a higher term nobody voted
    /// for leaves the real writer's messages passing, and calls still go to the real writer.
    #[test]
    fn an_unvoted_higher_announcement_does_not_displace_the_carried_writer() {
        let directory = ConnectedComputers::new();
        let writer = ComputerSigner::of(&ComputerKey::from_bytes(vec![44; 32]).unwrap()).unwrap();
        let other = ComputerSigner::of(&ComputerKey::from_bytes(vec![45; 32]).unwrap()).unwrap();
        let (writer_id, other_id) = (writer.computer_id(), other.computer_id());
        let term_ms = crate::account::computers::settings().term_ms;
        let told = row(1, &[&writer_id, &other_id], &[&writer_id, &other_id], account_key());
        tell(&directory, &writer_id, vec![told.clone()]);
        tell(&directory, &other_id, vec![told]);
        let address = account();
        directory.note_writer(&address, &writer_id, 2, NOW);
        let unvoted = announce(&other, &address, 3, NOW + term_ms, NOW);
        assert!(directory.take_term_announcement(&address, &other_id, &unvoted, NOW), "a holder's signed claim is taken as a hint");
        assert_eq!(directory.term_check(&address, 2, NOW), TermCheck::Pass, "the real writer's term still passes");
        assert_eq!(directory.term_check(&address, 1, NOW), TermCheck::Stale);
        assert_eq!(directory.writer(&address), Some((2, writer_id.clone())), "the carried writer is unchanged");
        assert_eq!(chosen(&directory).as_deref(), Some(writer_id.as_str()), "calls still go to the real writer");
    }

}

#[cfg(test)]
mod second_session_tests {
    use super::*;
    use crate::resource_authority::Route;

    /// A session one computer holds for one device, admitted at `admitted_at_ms`, ready until `ready` says otherwise.
    struct Admitted {
        admitted_at_ms: i64,
        ready: bool,
    }

    impl ComputerConnections for Admitted {
        fn invoke(&self, _route: &Route, _message: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
            Err(crate::refusal_cause::CodedError::new(()))
        }
    }

    impl RegisteredSession for Admitted {
        fn is_ready(&self) -> bool {
            self.ready
        }

        fn is_past_lifetime(&self) -> bool {
            false
        }

        fn retire(&self) {}

        fn told(&self) -> Vec<KeptAccount> {
            Vec::new()
        }

        fn admitted_at_ms(&self) -> i64 {
            self.admitted_at_ms
        }
    }

    fn live(admitted_at_ms: i64) -> Entry {
        Entry {
            route: Route {
                account_id: "account".into(),
                device_id: "computer".into(),
                resource_address: "@own-records".into(),
                generation: "generation".into(),
            },
            session: Arc::new(Admitted { admitted_at_ms, ready: true }),
        }
    }

    #[test]
    fn a_second_session_for_the_same_device_is_refused_unless_it_was_admitted_later() {
        let held = live(1_000);
        let same = Admitted { admitted_at_ms: 1_000, ready: true };
        let older = Admitted { admitted_at_ms: 900, ready: true };
        let later = Admitted { admitted_at_ms: 1_001, ready: true };
        assert!(refused_second_session(Some(&held), &same), "an equal admission is a second session, not a rotation");
        assert!(refused_second_session(Some(&held), &older), "an older admission is a second session, not a rotation");
        assert!(!refused_second_session(Some(&held), &later), "the computer's own rotation admits a later session");
    }

    #[test]
    fn nothing_is_refused_without_a_live_session_to_compare_with() {
        let candidate = Admitted { admitted_at_ms: 1_000, ready: true };
        assert!(!refused_second_session(None, &candidate));
        let mut retired = live(2_000);
        retired.session = Arc::new(Admitted { admitted_at_ms: 2_000, ready: false });
        assert!(!refused_second_session(Some(&retired), &candidate), "a session that is no longer ready blocks nothing");
    }
}
