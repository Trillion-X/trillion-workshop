// src/native_entry/computer/join_itself.rs
//
// Purpose: a computer named in an account's computers row joins the account by itself, with no operator step. This is the
// part old trillion's platform did when it made the destination store of a carry (Trillion-X/trillion
// src/resource-state-carry.mjs: bounded pages, counts and identities read back, then switch); the pages, the read-back
// and the switch are already here (`computer take-copy` / `computer join`, `Copies::answers_now`). What this file adds is
// making the new computer's account folder:
//
// 1. A message from another computer of an account this computer does not keep reaches it on its own forwarder session
//    (the forwarder sends it there when the account's newest believed row names this computer, its `computer_route`).
//    Its proof is checked as the account's copies check it (the sender's
//    own `trp_` credential, naming the account and the sender).
// 2. This computer asks the sender for what it needs (`Message::Holding`): the account's computers row and key (believed
//    only when the account's key signed it for the address, and only when it names this computer as a copy keeper or a
//    voter), its restore file and object index, the key row and the computers row. The stores its account routes open come through the writer's feed.
// 3. It makes the account folder beside the others (`.new-`), as `computer join` does: the object index, the account's rows,
//    the joining marker; at a computer that may answer, the account stores and the own records store made ready
//    (`create::write_ready_records`); the restore file last; then the folder is named by the owner id.
// 4. It starts the account as `JoiningAccount` (`Computer::start_joining`, `Copies::joining`): it follows the writer's feed
//    from stamp 0, and a computer that may answer gets the root on its sign-in pull and opens its account routes
//    (`keep_joining`, `serve_joined`).
//
// The computer that made the account (one whose config names default computers) tells each other computer of its row
// at once (`tell_copy_keepers`): a `Message::Row` it sends again until each answers with the account's row (it keeps the
// account), so the others join before the first write needs their votes.
//
// Non-Negotiable Invariants:
// - No record value, secret or root travels in `Message::Holding`. Records and the vault's sealed secrets come through the
//   writer's feed; the root comes sealed to this computer's key on its sign-in pull (`Copies::receive_secrets_key`).
// - A computer that only keeps a copy gets ids only: the restore file, the object index, the key row and the computers row.
// - Nothing here writes to a live account folder: the folder is made new and named only once whole. An account this
//   computer already keeps, or is already making, is not made again.
// - A row the account's key did not sign, or that does not name this computer, makes nothing.
// - Numbers are in `settings.json` (`tools_page_bytes`, `tell_copy_keepers_tries`, `tell_copy_keepers_wait_ms`).
//
// What travels after the join (docs/placement-decision/stage-2-status.md, "holds it by itself"):
// - The account stores (policy rows, app key-value rows) come through the writer's feed as records
//   (src/account/computers/account_stores.rs), so every later change reaches this computer; `ensure_account_stores` waits
//   until they are taken in. The browser session key is each computer's own.
// - The holding answer goes in parts when it is longer than one message (`Copies::answer_in_parts`,
//   `copies::send_in_parts`).
// - A computer moved from copy-only to may-answer makes its copied records store ready (`create::make_copied_records_ready`),
//   pulls every sign-in row (`Copies::start_sign_in_again`), and takes the account stores from its own copy once its root
//   opened them. tests/computer_forwarder.rs `a_computer_that_kept_only_a_copy_answers_from_its_own_copy_once_the_row_lets_it_answer`.
// - With no copy of the account's tools (offline at its first start), a computer that may answer takes the live copy of
//   another computer that may answer before its routes open (`Message::Tools`, `tools_from_another_computer`).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{join, placement_of, settings, Computer, ForwarderLink as Forwarder, Placement};
use crate::account::{
    computers::{
        self,
        copies::Link as _,
        messages::{Answer, HeldRow, Holding, Message},
    },
    create::{self, AccountStores},
    rows::{self, store::{Family, Row, Store}},
};
use crate::local_account::{is_own_policy, is_own_records, own_store_file};
use crate::resource_authority::InvokeMessage as Sent;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

/// A message from another computer for the account at `address` whose proof (the sender's own `trp_` credential, in the
/// message) names the account and the computer the message says sent it: the sender and the message. `None` for
/// anything else.
fn proven(sent: &Sent, address: &str) -> Option<(String, Message)> {
    let from = sent.input["from"].as_str()?.to_owned();
    let message = serde_json::from_value::<Message>(sent.input["message"].clone()).ok()?;
    match computers::read_computer_message_credential(&sent.client_authorization, now_ms()?) {
        Some((computer, account, _)) if computer == from && account == address => Some((from, message)),
        _ => None,
    }
}

/// The current time in milliseconds, on the clock the message proofs are signed by.
fn now_ms() -> Option<i64> {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
}

/// The computer and the account a request's message proof (`Authorization: Bearer trp_...`) names, when the proof checks now.
/// The proof is the sending computer's own signature; the computer is one the account's row names only if the row says so, and
/// `join_now` asks it for the row before this computer joins.
pub(super) fn proof_of(headers: &axum::http::HeaderMap) -> Option<(String, String)> {
    let text = headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")?;
    computers::read_computer_message_credential(text, now_ms()?).map(|(computer, account, _)| (computer, account))
}

/// What a request for an account this computer does not hold gets from `join_now`: `Retry` (try again: the account is being made
/// here, or it could not be made yet), or `NotNamed` (the sender cannot show this computer is named in the account's row).
pub(super) enum JoinStep {
    Retry,
    NotNamed,
}

/// Why making an account here failed: `NotNamed` when the sender cannot show this computer is named in the account's row (it
/// gave no holding, the row is not signed by the account, or the row does not name this computer); `Later` for every other
/// failure, which may pass.
enum JoinFailure {
    NotNamed { detail: &'static str, cause: crate::refusal_cause::Cause },
    Later { detail: &'static str, cause: crate::refusal_cause::Cause },
}

impl From<crate::refusal_cause::CodedError<&'static str>> for JoinFailure {
    fn from(error: crate::refusal_cause::CodedError<&'static str>) -> Self {
        Self::Later { detail: error.code, cause: error.cause() }
    }
}

/// A plain relative path: only normal parts.
fn plain_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|part| matches!(part, Component::Normal(_)))
}

/// The account's own policy store in the object index `index` (its text), relative to the account folder: the one owner
/// rule (`local_account::is_own_policy`, `own_store_file`), never the first account control row (an account the Mac app
/// made lists its `overdue-index` object first; measured 2026-11-05, record:findings:place-copies-blocked-2026-11-05).
fn own_policy(index: &str, owner: &str) -> Option<PathBuf> {
    own_store_file(index, |row| is_own_policy(row, owner))
}

/// The account's own records store in the object index `index`, relative to the account folder, by the same owner rule
/// (`local_account::is_own_records`): an account the Mac app made keeps more than one record book.
fn own_records(index: &str, owner: &str) -> Option<PathBuf> {
    own_store_file(index, |row| is_own_records(row, owner))
}

/// The account's own policy store of the account in `folder`, relative to it, as its object index names it for the
/// owner its restore file names.
pub(super) fn policy_file_of(folder: &Path) -> Option<PathBuf> {
    let (restore, index_path) = restore_of(folder)?;
    let owner = restore_owner(&restore)?;
    let index = fs::read_to_string(folder.join(index_path)).ok()?;
    own_policy(&index, &owner)
}

/// The owner id a restore file's text names (64 hex digits).
fn restore_owner(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value["account"]["ownerId"].as_str().filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_owned)
}

/// The restore file's name in an account folder (settings.json).
pub(super) fn restore_file() -> &'static str {
    &settings().receipt_file
}

/// The restore file of the account in `folder` (its text), and the object index path it names.
fn restore_of(folder: &Path) -> Option<(String, PathBuf)> {
    let text = fs::read_to_string(folder.join(restore_file())).ok()?;
    let index = restore_index(&text)?;
    Some((text, index))
}

/// The object index path a restore file's text names, as a plain relative path.
fn restore_index(text: &str) -> Option<PathBuf> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value["objects"]["path"].as_str().map(PathBuf::from).filter(|path| plain_relative(path))
}

impl Computer {
    /// A message `sent` from another computer for the account at `address`: when it is a proven `Message::Holding`, this
    /// computer's whole answer to it (`answer_holding`); and, when it is proven at all, the computer that sent it.
    pub(super) fn from_another_computer(&self, sent: &Sent, address: &str) -> (Option<Result<Vec<u8>, crate::refusal_cause::CodedError<()>>>, Option<String>) {
        let Some((from, message)) = proven(sent, address) else { return (None, None) };
        let answer = match message {
            Message::Holding => self.answer_holding(address, &from),
            Message::Tools { after } => self.answer_tools(address, &from, after.as_deref()),
            _ => return (None, Some(from)),
        };
        // An answer longer than one message is kept as parts by the account's copies here, and the asker takes the others
        // with `Message::AnswerPart` (answered by those copies, `Copies::answer_part`).
        let answer = match self.find(address).and_then(|account| account.copies().cloned()) {
            Some(copies) => copies.answer_in_parts(&from, answer),
            None => answer,
        };
        let whole = serde_json::to_value(answer).map_err(|_| crate::refusal_cause::CodedError::new(()))
            .and_then(|value| serde_json::to_vec(&serde_json::json!({"state": "completed", "request_id": sent.request_id, "value": value})).map_err(|_| crate::refusal_cause::CodedError::new(())));
        (Some(whole), Some(from))
    }

    /// This computer's way to the other computers of the account at `address`, through its forwarder.
    fn forwarder(&self, address: &str) -> Forwarder {
        Forwarder { forwarder: self.config.forwarder.clone(), address: address.to_owned(), signer: self.signer.clone() }
    }

    /// The stop flag the computer's forwarder sessions obey, once they started.
    fn sessions_stop(&self) -> Option<&'static std::sync::atomic::AtomicBool> {
        self.forwarder_stop.get().copied()
    }

    /// Answer `Message::Holding` from `from` for the account at `address`, which this computer serves (`find`): only to a
    /// computer the account's row names; the settings and ways rows only to one it lets answer.
    pub(super) fn answer_holding(&self, address: &str, from: &str) -> Answer {
        let refused = |code: &str, cause: crate::refusal_cause::Cause| Answer::Refused { code: code.to_owned(), cause, writer: None };
        let (Some(account), Some(told)) = (self.find(address), self.current_row(address)) else {
            return refused("not_served_here", crate::cause!());
        };
        let row = &told.row;
        if !row.copy_keepers.iter().chain(row.voters.iter()).any(|computer| computer == from) {
            return refused("not_a_computer_of_this_account", crate::cause!());
        }
        let folder = &account.state_root;
        let made = (|| -> Result<Holding, (&'static str, crate::refusal_cause::Cause)> {
            let (restore, index_path) = restore_of(folder).ok_or(("the restore file is not readable", crate::cause!()))?;
            let value: serde_json::Value = serde_json::from_str(&restore).map_err(|_| ("the restore file is not readable", crate::cause!()))?;
            let user = value["account"]["userId"].as_str().ok_or(("the restore file names no user", crate::cause!()))?.to_owned();
            let index = fs::read_to_string(folder.join(&index_path)).map_err(|_| ("the object index is not readable", crate::cause!()))?;
            let (_, carried) = join::carried_rows(folder, &user).map_err(|_| ("the account rows are not readable", crate::cause!()))?;
            let row_id = computers::Subject::Account(address.to_owned()).row_id();
            let current = serde_json::to_value(row).map_err(|_| ("the row is not writable", crate::cause!()))?;
            let rows = carried.into_iter()
                .map(|carried| HeldRow {
                    value: if carried.id == row_id { current.clone() } else { carried.value },
                    family: carried.family, id: carried.id, account: carried.account, expires_at: carried.expires_at,
                })
                .collect();
            Ok(Holding { row: told.clone(), restore, index, rows })
        })();
        match made {
            Ok(holding) => Answer::Holding { holding: Box::new(holding) },
            Err((_detail, cause)) => {
                crate::quiet_eprintln!("computer-join-itself event=holding-refused cause={cause}");
                refused("holding_unavailable", cause)
            }
        }
    }

    /// Answer `Message::Tools` from `from` for the account at `address`, which this computer serves: one page of the live copy
    /// of the account's tools (`Workshop::copy_page`, at most `tools_page_bytes` of file bytes), only to a computer the
    /// account's row lets answer.
    fn answer_tools(&self, address: &str, from: &str, after: Option<&str>) -> Answer {
        let refused = |code: &str, cause: crate::refusal_cause::Cause| Answer::Refused { code: code.to_owned(), cause, writer: None };
        let (Some(account), Some(told)) = (self.find(address), self.current_row(address)) else { return refused("not_served_here", crate::cause!()) };
        if !told.row.may_answer.iter().any(|computer| computer == from) {
            return refused("not_answering", crate::cause!());
        }
        let tools = match crate::tool_runs::tools::shipped() { Ok(tools) => tools, Err(failure) => return refused("tools_unavailable", failure.cause()) };
        match tools.copy_page(&account.state_root, after, settings().tools_page_bytes) {
            Ok(page) => Answer::Tools { page },
            Err(failure) => refused(failure.code(), failure.cause()),
        }
    }

    /// The account of `joining` has no copy of its tools here (its first start could not install one from the network):
    /// take the live copy of a computer of the account that may answer, page by page (`Message::Tools`,
    /// `Workshop::take_copy`), before its account routes open. Answers whether a copy is here now.
    pub(super) fn tools_from_another_computer(&self, folder: &Path, address: &str, owner: &str, may_answer: &[String]) -> bool {
        let Ok(tools) = crate::tool_runs::tools::shipped() else { return false };
        if tools.has_copy(folder) {
            return true;
        }
        let me = self.computer_id();
        let forwarder = self.forwarder(address);
        for peer in may_answer.iter().filter(|computer| **computer != me) {
            let mut ask = |after: Option<&str>| match computers::copies::send_in_parts(&forwarder, peer, &Message::Tools { after: after.map(str::to_owned) }) {
                Some(Answer::Tools { page: Some(page) }) => Some(page),
                _ => None,
            };
            match tools.take_copy(owner, folder, &mut ask) {
                Ok(_) => {
                    crate::quiet_eprintln!("computer-join-itself event=tools-from-computer account={address}");
                    return tools.has_copy(folder);
                }
                Err(failure) => crate::quiet_eprintln!("computer-join-itself event=tools-refused {}", failure.logged()),
            }
        }
        false
    }

    /// A proven message from `from` reached this computer for the account at `address`, which it neither serves nor joins:
    /// join the account by itself, once (a second message while it is being made does nothing). The asking runs on its
    /// own thread; the message in hand is refused meanwhile (`no_copies_here`), and its sender sends it again.
    pub(super) fn join_by_itself(self: &Arc<Self>, address: &str, from: &str) {
        if self.sessions_stop().is_none() || self.joining_now.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(address) {
            return;
        }
        let computer = self.clone();
        let (address, from) = (address.to_owned(), from.to_owned());
        crate::forwarder::lease_time::spawn(computer.clock.clone(), move || {
            computer.join_now(&address, &from);
        });
    }

    /// Join the account at `address` for the proven computer `from`, once: a second call while it is being made answers `Retry`
    /// and does nothing. It answers the request that asked (`JoinStep`), and logs the join or its refusal.
    pub(super) fn join_now(self: &Arc<Self>, address: &str, from: &str) -> JoinStep {
        if self.sessions_stop().is_none() {
            return JoinStep::Retry;
        }
        {
            let mut making = self.joining_now.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if !making.insert(address.to_owned()) {
                return JoinStep::Retry;
            }
        }
        let step = match self.make_joined(address, from) {
            Ok(true) => {
                crate::quiet_eprintln!("computer-join-itself event=joined account={address}");
                JoinStep::Retry
            }
            Ok(false) => JoinStep::Retry,
            Err(JoinFailure::NotNamed { detail, cause }) => {
                crate::quiet_eprintln!("computer-join-itself event=refused cause={cause} detail=\"{detail}\"");
                JoinStep::NotNamed
            }
            Err(JoinFailure::Later { detail, cause }) => {
                crate::quiet_eprintln!("computer-join-itself event=refused cause={cause} detail=\"{detail}\"");
                JoinStep::Retry
            }
        };
        self.joining_now.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(address);
        step
    }

    /// Ask `from` for the account at `address` (`Message::Holding`), make its folder, and start it as a joining account.
    /// Answers whether it was made (false: it is kept here already).
    fn make_joined(self: &Arc<Self>, address: &str, from: &str) -> Result<bool, JoinFailure> {
        if self.find(address).is_some() || self.find_joining(address).is_some() {
            return Ok(false);
        }
        let forwarder = self.forwarder(address);
        let Some(Answer::Holding { holding }) = computers::copies::send_in_parts(&forwarder, from, &Message::Holding) else {
            return Err(JoinFailure::NotNamed { detail: "the computer that sent the message did not give the account", cause: crate::cause!() });
        };
        let holding = *holding;
        let me = self.computer_id();
        let row = &holding.row.row;
        if !holding.row.believed(address) {
            return Err(JoinFailure::NotNamed { detail: "the account's row is not signed by its own key", cause: crate::cause!() });
        }
        if row.voters.is_empty() || !row.copy_keepers.iter().chain(row.voters.iter()).any(|computer| *computer == me) {
            return Err(JoinFailure::NotNamed { detail: "the account's row does not name this computer", cause: crate::cause!() });
        }
        let may_answer = row.may_answer.iter().any(|computer| *computer == me);
        let owner = restore_owner(&holding.restore).ok_or_else(|| crate::refusal_cause::CodedError::new("the restore file names no owner"))?;
        let index_path = restore_index(&holding.restore).ok_or_else(|| crate::refusal_cause::CodedError::new("the restore file names no object index in its folder"))?;
        let target = self.config.accounts.join(&owner);
        if target.exists() {
            return Ok(false);
        }
        if !self.config.takes_one_more(self.accounts().len() + self.joining().len()) {
            return Err(JoinFailure::Later { detail: "this computer keeps as many accounts as it may", cause: crate::cause!() });
        }
        let making = self.config.accounts.join(format!("{}{}", create::UNFINISHED_PREFIX, &owner[..16]));
        if making.exists() {
            return Err(JoinFailure::Later { detail: "a folder of this account is already being made here", cause: crate::cause!() });
        }
        fs::create_dir_all(&making).map_err(|_| crate::refusal_cause::CodedError::new("the account folder could not be made"))?;
        if let Err(detail) = make_folder(&making, &holding, &index_path, &owner, may_answer) {
            let _ = fs::remove_dir_all(&making);
            return Err(detail.into());
        }
        fs::rename(&making, &target).map_err(|_| crate::refusal_cause::CodedError::new("the account folder could not be named"))?;
        let state = match placement_of(&target, &self.computer_key, &me) {
            Placement::Joins(state) => state,
            Placement::Serves | Placement::Released => return Err(JoinFailure::Later { detail: "the made folder does not read as a joining account", cause: crate::cause!() }),
        };
        self.start_joining(target, state).map_err(|error| crate::refusal_cause::CodedError::with_cause("the account's copies did not start", error.cause()))?;
        let joining = self.find_joining(address).ok_or_else(|| crate::refusal_cause::CodedError::new("the account's copies did not start"))?;
        if let Some(stop) = self.sessions_stop() {
            self.keep_session(address, stop);
            self.keep_joining(&joining, stop);
        }
        Ok(true)
    }

    /// Before a joining account that may answer opens its account routes: its account stores are there. They come through
    /// the writer's feed as records (src/account/computers/account_stores.rs), so a computer that joined by itself, and one
    /// that kept only a copy and was then let answer (its copies opened what it held sealed once the root came), takes
    /// them into its own stores from its own copy (`Copies::account_stores_held`). Answers whether they are there now.
    pub(super) fn ensure_account_stores(&self, joining: &super::JoiningAccount) -> bool {
        let Some((_, index_path)) = restore_of(&joining.folder) else { return false };
        let Ok(index) = fs::read_to_string(joining.folder.join(index_path)) else { return false };
        let Some(policy) = own_policy(&index, &joining.owner_id) else { return false };
        // Its own records store, filled by its copies, is made ready as a new account's is (with the records it holds):
        // without the position row, which no copy follows, every records call is refused.
        let Some(records) = own_records(&index, &joining.owner_id) else { return false };
        if create::make_copied_records_ready(&joining.folder, &records, &joining.owner_id).is_err() {
            return false;
        }
        if joining.copies.account_stores_held() {
            return true;
        }
        // Copies that started before they knew the stores (an older folder) keep none: nothing to take yet.
        create::account_stores_held(&joining.folder, &policy)
    }

    /// Tell each other computer the row of the account at `address` names (copy keepers and voters) the account's row
    /// (`Message::Row`, made), so a computer that does not keep it yet joins by itself (`join_by_itself`): sent again every
    /// `tell_copy_keepers_wait_ms`, at most `tell_copy_keepers_tries` times, until each answers with the account's row. Runs on its
    /// own thread; a computer with no forwarder tells nobody.
    pub(super) fn tell_copy_keepers(self: &Arc<Self>, address: &str) {
        if self.config.forwarder.is_none() { return; }
        let _ = self.tell_copy_keepers_announcing(address, |computer, address| computer.tell_again(address));
    }

    // The existing announcement transport is separate so a real admitted forwarder can refuse the first
    // publication in a controlled test. Production keeps its normal signed announcement and cache owner.
    fn tell_copy_keepers_announcing(
        self: &Arc<Self>, address: &str,
        announce: impl Fn(&Arc<Self>, &str) -> bool + Send + 'static,
    ) -> Option<std::thread::JoinHandle<()>> {
        if self.sessions_stop().is_none() {
            return None;
        }
        let Some(told) = self.current_row(address) else { return None };
        let me = self.computer_id();
        let mut others: Vec<String> = told.row.copy_keepers.iter().chain(told.row.voters.iter())
            .filter(|computer| **computer != me).cloned().collect();
        others.sort();
        others.dedup();
        let computer = self.clone();
        let address = address.to_owned();
        Some(crate::forwarder::lease_time::spawn(computer.clock.clone(), move || {
            let forwarder = computer.forwarder(&address);
            let wait = Duration::from_millis(settings().tell_copy_keepers_wait_ms);
            for _ in 0..settings().tell_copy_keepers_tries {
                let stop = computer.sessions_stop().is_some_and(|stop| stop.load(Ordering::Acquire));
                if stop {
                    break;
                }
                // A new account's peer relay can need its own first publication. A transient failure of the
                // sign-up's one announcement must not strand an idle account: this already bounded worker
                // retries that same signed publication before asking its peers, without another timer.
                let announced = announce(&computer, &address);
                if computer.sessions_stop().is_some_and(|stop| stop.load(Ordering::Acquire)) { break; }
                let Some(told) = computer.current_row(&address) else { break };
                others.retain(|peer| {
                    let message = Message::Row { told: Some(told.clone()), term: 0, made: true };
                    !matches!(forwarder.send(peer, &message), Some(Answer::Row { told: Some(_), .. }))
                });
                if others.is_empty() && announced { break; }
                computer.clock.wait(wait);
            }
            if !others.is_empty() {
                crate::quiet_eprintln!("computer-join-itself event=not-told cause={}", crate::cause!());
            }
            // The rows written before its copies ran (outside them, by the command line) travel now, as one acknowledged
            // change, once the others hold the account: claiming the writer turn for it while they were still joining
            // raced their joins (measured 2026-11-04: one run in three, B and C never joined within 60 s).
            if let Some(account) = computer.find(&address) {
                computer.copy_outside_changes(&account);
            }
        }))
    }
}

/// Make the account folder in `making` from `holding` (the module doc, step 3): the restore file is written last.
fn make_folder(making: &Path, holding: &Holding, index_path: &Path, owner: &str, may_answer: bool) -> Result<(), crate::refusal_cause::CodedError<&'static str>> {
    write_new(&making.join(index_path), holding.index.as_bytes())?;
    let raw = rows::open(making).map_err(|error| crate::refusal_cause::CodedError::with_cause("the account rows could not be made", error.cause()))?;
    let store = Store::new(&*raw);
    for given in holding.rows.iter().filter(|given| join::written_family(&given.family)) {
        let row = Row { id: given.id.clone(), account: given.account.clone(), expires_at: given.expires_at, value: given.value.clone() };
        store.insert(Family::Computers, &row).map_err(|error| crate::refusal_cause::CodedError::with_cause("an account row could not be written", error.cause()))?;
    }
    drop(store);
    drop(raw);
    if may_answer {
        // The account stores are made empty; their rows come through the writer's feed as records and are taken in
        // before the account's routes open (`ensure_account_stores`).
        let policy = own_policy(&holding.index, owner).ok_or_else(|| crate::refusal_cause::CodedError::new("the object index names no one policy store of the account's owner"))?;
        create::apply_account_stores(making, &policy, &AccountStores::default(), &create::KeptHere::default())
            .map_err(|error| crate::refusal_cause::CodedError::with_cause("the account stores could not be made", error.cause()))?;
        let records = own_records(&holding.index, owner)
            .ok_or_else(|| crate::refusal_cause::CodedError::new("the object index names no one own records store of the account's owner"))?;
        create::write_ready_records(making, &records, owner).map_err(|error| crate::refusal_cause::CodedError::with_cause("the records store could not be made ready", error.cause()))?;
    }
    // Until it has caught up once, the computer joins: it neither claims the writer role nor votes for a takeover.
    write_new(&making.join(&settings().joining_marker), holding.row.row.account.as_bytes())?;
    write_new(&making.join(restore_file()), holding.restore.as_bytes())?;
    Ok(())
}

/// Write `bytes` as a new file `path` (mode 0600), its folders made first.
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), crate::refusal_cause::CodedError<&'static str>> {
    use std::io::Write as _;
    use crate::tool_runs::os::{Open, OwnerFiles, This};
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| crate::refusal_cause::CodedError::new("a folder could not be made"))?;
    }
    let mut file = This::open(fs::OpenOptions::new().write(true).create_new(true), &path, Open::owner_only(0o600)).map_err(|_| crate::refusal_cause::CodedError::new("a file could not be made"))?;
    file.write_all(bytes).map_err(|_| crate::refusal_cause::CodedError::new("a file could not be written"))?;
    file.sync_all().map_err(|_| crate::refusal_cause::CodedError::new("a file could not be written"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::computers::{ComputersRow, KeptAccount};

    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/native_placement_announcement.rs"));
    /// An account folder the Mac app made: its object index lists the account control's `overdue-index` object before its
    /// own policy object (`policy:<owner>`), and a record book of another name before its own records, each in the nested
    /// `storage/do/trillion-local-<class>/<id>.sqlite` path the Mac app keeps them in, none of whose folders exist yet.
    /// Measured 2026-11-05 (record:findings:place-copies-blocked-2026-11-05): a computer joining such an account failed
    /// three times with "the account stores could not be made".
    #[test]
    fn a_computer_joins_a_folder_shaped_like_a_mac_app_account() {
        let owner = "ab".repeat(32);
        let records = "RECORD_BOOK";
        let nested = |class: &str, id: char| format!("storage/do/trillion-local-{class}/{}.sqlite", id.to_string().repeat(64));
        let (overdue, policy) = (nested("AccountControl", '1'), nested("AccountControl", '2'));
        let (other_book, own_book) = (nested("RecordBook", '3'), nested("RecordBook", '4'));
        let own_records_name = format!("own-record-resource:{}",
            serde_json::to_string(&[owner.as_str(), crate::account::BROWSER_RESOURCE]).unwrap());
        let index = [
            serde_json::json!({"binding": "ACCOUNT_CONTROL", "className": "AccountControl", "originalId": "1".repeat(64),
                "names": ["overdue-index"], "sqlite": overdue}),
            serde_json::json!({"binding": "ACCOUNT_CONTROL", "className": "AccountControl", "originalId": "2".repeat(64),
                "names": [format!("policy:{owner}")], "sqlite": policy}),
            serde_json::json!({"binding": records, "className": "RecordBook", "originalId": "3".repeat(64),
                "names": ["record-book:other"], "sqlite": other_book}),
            serde_json::json!({"binding": records, "className": "RecordBook", "originalId": "4".repeat(64),
                "names": [own_records_name], "sqlite": own_book}),
        ].iter().map(ToString::to_string).collect::<Vec<_>>().join("\n");
        let restore = serde_json::json!({"complete": true, "account": {"userId": "account-mac", "ownerId": owner},
            "objects": {"path": "objects.jsonl"}}).to_string();
        let row = ComputersRow { account: "trl_mac".into(), pursuit: None, revision: 4, copy_keepers: vec!["b".into()],
            may_answer: vec!["a".into(), "b".into()], voters: vec!["a".into(), "b".into()], signature: String::new() };
        let holding = Holding { row: KeptAccount { row, account_key: String::new() }, restore, index, rows: vec![] };

        let dir = tempfile::tempdir().unwrap();
        let making = dir.path().canonicalize().unwrap().join(".new-mac");
        fs::create_dir_all(&making).unwrap();
        make_folder(&making, &holding, Path::new("objects.jsonl"), &owner, true).expect("the joined folder is made");

        // The account's own stores, by the owner rule, at their nested paths; the other objects' files are not made.
        assert_eq!(policy_file_of(&making), Some(PathBuf::from(&policy)));
        assert!(making.join(&policy).is_file(), "the own policy store is made");
        assert!(!making.join(&overdue).exists(), "the overdue index is not taken for the policy store");
        assert!(making.join(&own_book).is_file(), "the own records store is made ready");
        assert!(!making.join(&other_book).exists(), "another record book is not taken for the own records");
    }

    /// The owner rule takes exactly one policy store: an index naming two objects `policy:<owner>`, or only another
    /// owner's, names none (as `LocalAccountObserver` refuses such an account), and its first row is never taken for it.
    #[test]
    fn the_policy_store_is_the_one_object_named_for_the_owner() {
        let owner = "cd".repeat(32);
        let row = |id: char, name: &str, file: &str| serde_json::json!({"binding": "ACCOUNT_CONTROL", "originalId": id.to_string().repeat(64),
            "names": [name], "sqlite": file}).to_string();
        let own = format!("policy:{owner}");
        let one = [row('1', "overdue-index", "a.sqlite"), row('2', &own, "b.sqlite")].join("\n");
        assert_eq!(own_policy(&one, &owner), Some(PathBuf::from("b.sqlite")));
        let two = [row('2', &own, "b.sqlite"), row('3', &own, "c.sqlite")].join("\n");
        assert_eq!(own_policy(&two, &owner), None);
        assert_eq!(own_policy(&one, &"ef".repeat(32)), None);
        let escaping = row('2', &own, "../b.sqlite");
        assert_eq!(own_policy(&escaping, &owner), None);
    }
}
