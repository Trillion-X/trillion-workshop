//! The writer row: which computer may write an account's or a pursuit's records right
//! now, and how that writer role moves to another computer.
//!
//! One writer row per subject (an account, or one pursuit of it). Every computer that
//! votes, and every computer that keeps a copy, holds the row in its own account rows
//! (family `computers`, id `writer_row_prefix` + the subject's row id). It is a
//! `WriterRow`: the writer computer, the term number (the epoch) and when the term
//! ends. No store outside the computers holds it, and the forwarder keeps nothing.
//!
//! The rules, in short:
//! - The term number only goes up. Term N moves to N+1 only when a majority of the
//!   voters the owner names accept it. Each voter moves from N to N+1 once, by one
//!   compare-and-set on its own copy (`WriterRowCopy::replace`), so each voter accepts at
//!   most one writer per term number. Two majorities always share a voter, so two
//!   computers can never both win the same number.
//! - A writer renews by asking the voters to extend its own number. A renewal counts
//!   with a majority. A writer whose renewal fails stops writing at once.
//! - A takeover (a higher number) is accepted by a voter only after the term on that
//!   voter has run out, plus `clock_margin_ms`. A computer claims only when its copy is
//!   caught up (`CaughtUp`, `copies.rs`).
//! - A claim that did not win can still have moved some voters' copies to its number.
//!   Such a voter takes a later claim once that number's own term has run out, and a
//!   voter's answer names the number it holds, so the next claim asks a higher one. A
//!   failed claim therefore never stops the writer role from moving again. A higher claim from
//!   the computer the voter's row already names is taken at once: its term protects only
//!   that computer.
//! - A writer writes only while its term number is the current one in its own copy
//!   and before its own term ends (`WriterRole::commit`). A write counts as done only when
//!   a second copy holds it (`Ack`, answered by `copies.rs` from the copies' caught-up stamps).
//! - With no voters the account has one computer: there is no writer row, and a write
//!   is made as it was made before this module.
//!
//! Voting messages are `Ask`s carried by the `Wire`. In production the wire is the
//! forwarder session the computers already keep (`forwarder/session.rs`); the forwarder
//! only carries the message and stores nothing. The sender of an `Ask` is the computer
//! the session proves, so `accept` takes `from` from the transport, never from the
//! message.
//!
//! Clocks: every computer reads its own clock, and this code assumes the clocks of two
//! computers differ by less than `clock_margin_ms`. The writer ends its own term
//! `clock_margin_ms` before the term ends on the voters, and a voter waits the same
//! margin past the end before it accepts a takeover.
//!
//! Every number is data in `computers/settings.json`.

use super::{settings, Subject};
use crate::account::computers::ScopeClass;
use crate::account::rows::store::{Family, Row, Store};
use serde::{Deserialize, Serialize};

/// The writer row of one subject, as one copy holds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WriterRow {
    /// The computer that holds the writer role (its computer id).
    #[serde(rename = "holder")] pub writer: String,
    /// The term number (the epoch). Starts at 1; 0 means no term yet.
    #[serde(rename = "lease")] pub term: u64,
    /// When the term ends on the clock of the computer that wrote it (ms).
    pub expires_at_ms: i64,
}

/// Why a term step did not go through.
#[derive(Clone, Debug, Eq)]
pub(crate) enum WriterError {
    /// The copy of the writer row could not be read or changed.
    Storage(crate::refusal_cause::Cause),
    /// This computer does not hold the writer role now: no term, its term ended, or its copy
    /// shows another term number or writer.
    NotWriter(crate::refusal_cause::Cause),
    /// This computer's copy has not caught up, so it may not claim the writer role.
    Behind(crate::refusal_cause::Cause),
    /// No second copy holds the write yet, so the write is not acknowledged.
    NotAcknowledged(crate::refusal_cause::Cause),
}

impl WriterError {
    /// The content-free source condition; retained separately from public class equality.
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Storage(cause) => cause.clone(),
            Self::NotWriter(cause) => cause.clone(),
            Self::Behind(cause) => cause.clone(),
            Self::NotAcknowledged(cause) => cause.clone(),
        }
    }
}
impl PartialEq for WriterError {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Storage(_), Self::Storage(_)) => true,
            (Self::NotWriter(_), Self::NotWriter(_)) => true,
            (Self::Behind(_), Self::Behind(_)) => true,
            (Self::NotAcknowledged(_), Self::NotAcknowledged(_)) => true,
            _ => false,
        }
    }
}


pub(crate) type WriterResult<T> = std::result::Result<T, WriterError>;

/// The computer's own copy of writer rows. `replace` is the compare-and-set a voter uses
/// to accept a change: it writes `after` only while the stored row still equals
/// `before` (`None` means no row yet).
pub(crate) trait WriterRowCopy {
    fn read(&self, id: &str) -> WriterResult<Option<WriterRow>>;
    /// Whether the row was replaced. `Ok(false)` means another change got there first.
    fn replace(&self, id: &str, before: Option<&WriterRow>, after: &WriterRow) -> WriterResult<bool>;
}

/// `copies.rs` implements this: the caught-up stamp a second copy reported to the writer for
/// `id` at term `term` (the newest stamp it holds, as `follow::FeedSource::caught_up` reports it), or
/// `None` when no second copy reported. A write at stamp S is acknowledged once a second copy's
/// caught-up stamp is at least S. This computer's own copy never counts.
pub(crate) trait Ack {
    fn second_copy_stamp(&self, id: &str, term: u64) -> Option<i64>;
}

/// `copies.rs` implements this. True when this computer's copy has applied the
/// writer's change feed up to the last change the writer made, so the writer row in
/// it is current and the computer may claim the writer role.
pub(crate) trait CaughtUp {
    fn caught_up(&self, id: &str) -> bool;
}

/// A voter's answer: whether it accepted, and the term number its copy holds after the answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vote {
    pub accepted: bool,
    #[serde(rename = "lease")] pub term: u64,
}

/// Sends a voting message from computer `from` to voter `to`, through the forwarder sessions.
/// `Some(vote)` when the voter answered; `None` when it could not be reached.
pub(crate) trait Wire {
    fn ask(&self, from: &str, to: &str, ask: &Ask) -> Option<Vote>;

    /// Ask each of `voters` (never `from` itself), giving back each voter's vote (`None`: not reached) as it came. It may
    /// stop once `enough` of them accepted, leaving the rest unheard: a voter that is out of reach or stalled then costs
    /// the asker nothing once a majority said yes. This one asks one after another and hears every voter.
    fn ask_all(&self, from: &str, voters: &[String], ask: &Ask, enough: usize) -> Vec<(String, Option<Vote>)> {
        let _ = enough;
        voters.iter().map(|voter| (voter.clone(), self.ask(from, voter, ask))).collect()
    }
}

/// One voting message: a renewal (`term == prior`) or a takeover (`term > prior`).
/// `prior` is the term number the sender read from its own copy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ask {
    pub id: String,
    pub prior: u64,
    #[serde(rename = "lease")] pub term: u64,
    pub expires_at_ms: i64,
}

/// The voter's side, as a pure decision on the copy's row (`before`). `from` is the computer the transport
/// proves sent the message; it is never read from the message. The voter accepts:
/// - a renewal (`term == prior`): when its row shows that same term and writer and the new end is not earlier
///   than the old one, even when that term already ran out on this copy: a voter still at that number gave no
///   higher number to anyone, and any takeover needs a majority holding a higher number, which shares a voter with
///   this renewal's majority (that voter refuses it). A voter added after the writer renewed alone holds an old end
///   (measured 2026-11-08: 2.5 s past it), and refusing then took the writer's majority with no takeover anywhere. A renewal of a
///   number above the one its row shows is taken as a takeover is (below): this is how a voter that was cut off
///   while the writer role moved learns the new writer, and only the computer that won that number renews it;
/// - a takeover (`term > prior`): only when the asked number is above the one its row shows and the term
///   in its row has run out on this copy, plus the clock margin (a copy with no term takes it at once).
///   The asker's `prior` may be below the voter's number: a claim that never won can have moved this
///   voter's copy, and once that claim's own term has run out a later, higher claim is taken.
///
/// Each number moves up only, so a voter accepts each term number for one writer only.
/// Answers the row the voter would write, or `None` when it refuses.
fn decide(before: Option<&WriterRow>, from: &str, ask: &Ask, now: i64) -> Option<WriterRow> {
    decide_or_refuse(before, from, ask, now).ok()
}

/// Why a voter refused a vote: a typed reason the voter logs (`computers-voter event=vote-refused`), so a stall names
/// the condition that held it.
#[derive(Clone, Debug)]
pub(crate) enum VoteRefusal {
    /// The ask carries no term number or its own lease already ran out.
    AskExpired(crate::refusal_cause::Cause),
    /// Same term, the row names another writer: the term is that writer's.
    SameTermOtherWriter(crate::refusal_cause::Cause),
    /// Same term, the ask ends before the row's term does.
    SameTermShorter(crate::refusal_cause::Cause),
    /// A higher term while the row's writer still holds a live term (plus the clock margin).
    LiveTermProtectsWriter(crate::refusal_cause::Cause),
    /// The ask is not a higher term nor the same one (a stale or lower claim).
    StaleAsk(crate::refusal_cause::Cause),
}

impl VoteRefusal {
    /// The word the log names the refusal by.
    pub(crate) fn word(&self) -> &'static str {
        match self {
            Self::AskExpired(_) => "ask_expired",
            Self::SameTermOtherWriter(_) => "same_term_other_writer",
            Self::SameTermShorter(_) => "same_term_shorter",
            Self::LiveTermProtectsWriter(_) => "live_term_protects_writer",
            Self::StaleAsk(_) => "stale_ask",
        }
    }
}

/// `decide`, answering the refusal's typed reason instead of `None`.
fn decide_or_refuse(before: Option<&WriterRow>, from: &str, ask: &Ask, now: i64) -> Result<WriterRow, VoteRefusal> {
    let margin = settings().clock_margin_ms;
    if ask.term == 0 || ask.expires_at_ms <= now {
        return Err(VoteRefusal::AskExpired(crate::cause!(voter ask_expired)));
    }
    let (current, writer, ends) = match before {
        Some(row) => (row.term, row.writer.as_str(), row.expires_at_ms),
        None => (0, "", 0),
    };
    if ask.term == ask.prior && ask.term == current {
        if writer != from {
            return Err(VoteRefusal::SameTermOtherWriter(crate::cause!(voter same_term_other_writer)));
        }
        if ask.expires_at_ms < ends {
            return Err(VoteRefusal::SameTermShorter(crate::cause!(voter same_term_shorter)));
        }
        Ok(WriterRow { writer: from.to_string(), term: current, expires_at_ms: ask.expires_at_ms })
    } else if ask.term >= ask.prior && ask.term > current {
        // The term in this row protects its writer. When the asker is that writer (its own earlier claim, which it did
        // not win, or a term it gave up), there is nobody else to protect: the higher number is taken at once. Else a
        // claimer whose failed claims keep moving the voters it reached would stall itself when it needs every voter
        // still up (three of four).
        if current > 0 && now <= ends + margin && writer != from {
            return Err(VoteRefusal::LiveTermProtectsWriter(crate::cause!(voter live_term_protects_writer)));
        }
        Ok(WriterRow { writer: from.to_string(), term: ask.term, expires_at_ms: ask.expires_at_ms })
    } else {
        Err(VoteRefusal::StaleAsk(crate::cause!(voter stale_ask)))
    }
}

/// A voter, as the transport runs it at the voter's computer: decide on its own copy, and write the
/// change with one compare-and-set, so the voter moves from N to N+1 only once. `Ok(false)` refuses.
#[cfg(test)]
pub(crate) fn accept(copy: &dyn WriterRowCopy, from: &str, ask: &Ask, now: i64) -> WriterResult<bool> {
    accept_vote(copy, from, ask, now).map(|vote| vote.accepted)
}

/// `accept`, also returning the term number the voter's copy holds afterwards, so a refused claimer can ask a
/// higher number next time.
pub(crate) fn accept_vote(copy: &dyn WriterRowCopy, from: &str, ask: &Ask, now: i64) -> WriterResult<Vote> {
    accept_vote_or_refuse(copy, from, ask, now).map(|(vote, _)| vote)
}

/// `accept_vote`, also naming why the voter refused when it did (`None` when it decided, even if the compare-and-set lost).
pub(crate) fn accept_vote_or_refuse(copy: &dyn WriterRowCopy, from: &str, ask: &Ask, now: i64) -> WriterResult<(Vote, Option<VoteRefusal>)> {
    let before = copy.read(&ask.id)?;
    let held = before.as_ref().map_or(0, |row| row.term);
    match decide_or_refuse(before.as_ref(), from, ask, now) {
        Ok(after) => {
            let accepted = copy.replace(&ask.id, before.as_ref(), &after)?;
            Ok((Vote { accepted, term: if accepted { after.term } else { copy.read(&ask.id)?.map_or(held, |row| row.term) } }, None))
        }
        Err(refusal) => Ok((Vote { accepted: false, term: held }, Some(refusal))),
    }
}

/// This computer's writer role for one subject: its own view of its term. The rows are in the
/// copy; the writer role holds only what this computer has won or renewed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WriterRole {
    id: String,
    me: String,
    voters: Vec<String>,
    held: Option<Held>,
    /// The highest term number a voter named in an answer to this computer. The next claim asks above it.
    seen: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Held {
    term: u64,
    /// When this computer stops writing (its term end less the clock margin).
    valid_until_ms: i64,
}

/// The writer row id of `subject` for the default scope class (`lease-writer`): the row id it always had.
pub(crate) fn writer_row_id(subject: &Subject) -> String {
    writer_row_id_in(subject, &ScopeClass::default_class())
}

/// The writer row id of `subject` for scope class `class` (plan 4a, B-2). `lease-writer` keeps the row id `writer_row_id`
/// has always named; every other class adds `#` and its name, so one subject can hold a writer row per class and a
/// class's terms never move another's.
pub(crate) fn writer_row_id_in(subject: &Subject, class: &ScopeClass) -> String {
    let base = format!("{}{}", settings().writer_row_prefix, subject.row_id());
    if *class == ScopeClass::default_class() { base } else { format!("{base}#{}", class.name()) }
}

impl WriterRole {
    /// The writer role of computer `me` for `subject`, with the voters its computers row names.
    pub(crate) fn new(subject: &Subject, me: &str, voters: &[String]) -> WriterRole {
        WriterRole { id: writer_row_id(subject), me: me.to_string(), voters: voters.to_vec(), held: None, seen: 0 }
    }

    /// The writer row id this writer role is for.
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    /// The voters this writer role asks.
    pub(crate) fn voters(&self) -> &[String] {
        &self.voters
    }

    /// Ask `voters` from now on: the account's computers row changed (`copies.rs`). A held term stays held; its next
    /// renewal needs a majority of the new voters. The change is made only under the rule `copies.rs` states (one voter
    /// at a time, held by majorities of the old and the new voters first), so any majority of the new voters shares a
    /// computer with any majority of the old ones.
    pub(crate) fn set_voters(&mut self, voters: &[String]) {
        self.voters = voters.to_vec();
    }

    /// Stop writing at once and keep no term: the computer gives the writer role up (a write it could not get acknowledged,
    /// so another copy may hold more than this one). The voters keep the term until it runs out, then any caught-up
    /// computer may claim.
    pub(crate) fn give_up(&mut self) {
        self.held = None;
    }

    /// The term number this computer may write under at `now`, if any.
    pub(crate) fn holding(&self, now: i64) -> Option<u64> {
        self.held.as_ref().filter(|held| now < held.valid_until_ms).map(|held| held.term)
    }

    /// When this computer stops writing under its term, if it holds one at `now` (its term end less the clock margin).
    pub(crate) fn valid_until(&self, now: i64) -> Option<i64> {
        self.held.as_ref().filter(|held| now < held.valid_until_ms).map(|held| held.valid_until_ms)
    }

    /// Renew the held term. Returns whether a majority of voters extended it. A failed
    /// renewal ends the writer role at once: this computer stops writing.
    pub(crate) fn renew(&mut self, now: i64, copy: &dyn WriterRowCopy, wire: &dyn Wire) -> WriterResult<bool> {
        let Some(held) = self.held.clone() else { return Ok(false) };
        let before = copy.read(&self.id)?;
        let ask = Ask { id: self.id.clone(), prior: held.term, term: held.term, expires_at_ms: now + settings().term_ms };
        if !self.win(now, before.as_ref(), copy, wire, &ask)? {
            self.held = None;
            return Ok(false);
        }
        self.held = Some(Held { term: held.term, valid_until_ms: now + settings().term_ms - settings().clock_margin_ms });
        Ok(true)
    }

    /// Try to take the writer role: move the term from the copy's number to the next one.
    /// `Ok(true)` when a majority accepted and this computer now holds it. `Behind` when
    /// the copy has not caught up. A computer with no voters never claims.
    pub(crate) fn claim(&mut self, now: i64, copy: &dyn WriterRowCopy, wire: &dyn Wire, caught: &dyn CaughtUp) -> WriterResult<bool> {
        if self.voters.is_empty() || self.holding(now).is_some() {
            return Ok(false);
        }
        if !caught.caught_up(&self.id) {
            return Err(crate::cause!(WriterError::Behind));
        }
        let before = copy.read(&self.id)?;
        let prior = before.as_ref().map_or(0, |row| row.term);
        let term = prior.max(self.seen) + 1;
        let ask = Ask { id: self.id.clone(), prior, term, expires_at_ms: now + settings().term_ms };
        if !self.win(now, before.as_ref(), copy, wire, &ask)? {
            return Ok(false);
        }
        self.held = Some(Held { term, valid_until_ms: now + settings().term_ms - settings().clock_margin_ms });
        Ok(true)
    }

    /// One vote on `ask`. This computer's own copy counts as a voter when it is one, and must say yes. A
    /// majority of the voters makes the change win. Only then is this computer's copy written (with
    /// `before` as the expected row), so a computer never moves its copy to a number it did not win.
    fn win(&mut self, now: i64, before: Option<&WriterRow>, copy: &dyn WriterRowCopy, wire: &dyn Wire, ask: &Ask) -> WriterResult<bool> {
        if ask.prior != before.map_or(0, |row| row.term) {
            // The copy's term moved away from the one this computer asks from (`term-moved`): named, not silent.
            crate::quiet_eprintln!("computers-voter event=term-moved row={} asked_from={} copy_term={}", self.id, ask.prior, before.map_or(0, |row| row.term));
            return Ok(false);
        }
        let votes_here = self.voters.contains(&self.me);
        // A refused own vote names its reason, so a term that cannot renew says why (`own-vote-refused`).
        let own = votes_here && match decide_or_refuse(before, &self.me, ask, now) {
            Ok(_) => true,
            Err(refusal) => {
                crate::quiet_eprintln!("computers-voter event=own-vote-refused row={} term={} reason={refusal:?}", self.id, ask.term);
                false
            }
        };
        let mut yes = usize::from(own);
        // The other voters are asked at once (`Wire::ask_all`), and the vote ends once a majority accepted: before, they
        // were asked one after another and every renewal waited `message_wait_ms` on a stalled voter first, so the
        // writer's term ran out between renewals and its writes were refused (measured 2026-11-03, 21 of 21; reproduced
        // in tests/answering_computers_hold_acknowledged_writes.rs with a real-time term clock). When this computer's
        // own copy says no, every voter is still heard, for the term numbers they hold (`seen`).
        let others: Vec<String> = self.voters.iter().filter(|voter| **voter != self.me).cloned().collect();
        let majority = self.voters.len() / 2 + 1;
        let enough = if votes_here && !own { usize::MAX } else { majority.saturating_sub(yes) };
        if enough > 0 {
            for (_, vote) in wire.ask_all(&self.me, &others, ask, enough) {
                if let Some(vote) = vote {
                    self.seen = self.seen.max(vote.term);
                    if vote.accepted {
                        yes += 1;
                    }
                }
            }
        }
        if (votes_here && !own) || yes * 2 <= self.voters.len() {
            return Ok(false);
        }
        let after = WriterRow { writer: self.me.clone(), term: ask.term, expires_at_ms: ask.expires_at_ms };
        copy.replace(&self.id, before, &after)
    }

    /// Run one write under the writer role. With no voters the write runs as it always did.
    /// Otherwise the write runs only when this computer holds the writer role at `now` and its
    /// copy shows the same term and writer (`assert_current`), and it counts only
    /// when `ack` says a second copy holds it at this term and stamp. `write` returns
    /// the value and the change stamp.
    pub(crate) fn commit<T>(
        &self,
        now: i64,
        copy: &dyn WriterRowCopy,
        ack: &dyn Ack,
        write: impl FnOnce() -> WriterResult<(T, i64)>,
    ) -> WriterResult<T> {
        if self.voters.is_empty() {
            return write().map(|(value, _)| value);
        }
        let term = self.holding(now).ok_or(crate::cause!(WriterError::NotWriter))?;
        let current = copy.read(&self.id)?;
        if !current.is_some_and(|row| row.writer == self.me && row.term == term) {
            return Err(crate::cause!(WriterError::NotWriter));
        }
        let (value, stamp) = write()?;
        if ack.second_copy_stamp(&self.id, term).is_none_or(|caught_up| caught_up < stamp) {
            return Err(crate::cause!(WriterError::NotAcknowledged));
        }
        Ok(value)
    }
}

/// The computer's copy in the account's account rows (family `computers`). `replace` is a
/// compare-and-set on the stored value (`Store::replace_if`). A failed insert is
/// reported as not replaced, so a write that cannot be made never looks accepted.
pub(crate) struct StoreCopy<'a> {
    pub store: Store<'a>,
    pub account: &'a str,
}

impl WriterRowCopy for StoreCopy<'_> {
    fn read(&self, id: &str) -> WriterResult<Option<WriterRow>> {
        let row = self.store.get::<WriterRow>(Family::Computers, id).map_err(|error| WriterError::Storage(error.cause()))?;
        Ok(row.map(|row| row.value))
    }

    fn replace(&self, id: &str, before: Option<&WriterRow>, after: &WriterRow) -> WriterResult<bool> {
        let row = |value: &WriterRow| Row { id: id.to_string(), account: self.account.to_string(), expires_at: 0, value: value.clone() };
        match before {
            None => Ok(self.store.insert(Family::Computers, &row(after)).is_ok()),
            Some(prior) => self.store.replace_if(Family::Computers, &row(prior), &row(after)).map_err(|error| WriterError::Storage(error.cause())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::computers::{AccountKey, ComputersRow};
    use crate::storage::memory::Memory;
    use std::{
        cell::{Cell, RefCell},
        collections::{BTreeMap, BTreeSet},
        rc::Rc,
    };
    use zeroize::Zeroizing;

    const ADDRESS: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const P1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const P2: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const P3: &str = "3333333333333333333333333333333333333333333333333333333333333333";
    const P4: &str = "4444444444444444444444444444444444444444444444444444444444444444";
    const TERM: i64 = 9_000;
    const MARGIN: i64 = 1_000;

    fn subject() -> Subject {
        Subject::Account(ADDRESS.to_string())
    }

    #[test]
    fn each_vote_refusal_names_its_condition() {
        let row = |writer: &str, term: u64, expires_at_ms: i64| WriterRow { writer: writer.to_string(), term, expires_at_ms };
        let ask = |prior: u64, term: u64, expires_at_ms: i64| Ask { id: "row".into(), prior, term, expires_at_ms };
        let now = 10_000;
        let refused = |before: Option<&WriterRow>, from: &str, ask: &Ask| decide_or_refuse(before, from, ask, now).err();
        // An ask whose own lease already ran out.
        assert!(matches!(refused(None, P1, &ask(0, 1, now)), Some(VoteRefusal::AskExpired(_))));
        // The row names P2 at term 2 with a lease to 20 s; P1 asks at term 2 to hold it (same term, other writer).
        let held = row(P2, 2, 20_000);
        assert!(matches!(refused(Some(&held), P1, &ask(2, 2, 30_000)), Some(VoteRefusal::SameTermOtherWriter(_))));
        // The writer itself renews, but with a shorter lease than the row holds.
        assert!(matches!(refused(Some(&held), P2, &ask(2, 2, 15_000)), Some(VoteRefusal::SameTermShorter(_))));
        // A takeover at term 3 while P2's term still runs (plus the clock margin): refused as protected.
        assert!(matches!(refused(Some(&held), P1, &ask(2, 3, 30_000)), Some(VoteRefusal::LiveTermProtectsWriter(_))));
        // A stale ask below the row's own term.
        assert!(matches!(refused(Some(&held), P1, &ask(1, 1, 30_000)), Some(VoteRefusal::StaleAsk(_))));
        // The same takeover after the term and the margin ran out is accepted: no refusal.
        let ended = row(P2, 2, 1_000);
        assert!(refused(Some(&ended), P1, &ask(2, 3, 30_000)).is_none());
    }

    #[test]
    fn the_default_class_keeps_the_writer_row_id_it_always_had() {
        let base = format!("{}{}", settings().writer_row_prefix, subject().row_id());
        assert_eq!(writer_row_id(&subject()), base);
        assert_eq!(writer_row_id_in(&subject(), &ScopeClass::default_class()), base);
    }

    #[test]
    fn each_other_scope_class_has_its_own_writer_row_of_the_same_subject() {
        let merge = ScopeClass::parse("crdt-merge").expect("crdt-merge is a named scope class");
        let base = writer_row_id(&subject());
        assert_eq!(writer_row_id_in(&subject(), &merge), format!("{base}#crdt-merge"));
        assert_ne!(writer_row_id_in(&subject(), &merge), writer_row_id_in(&subject(), &ScopeClass::parse("local").unwrap()));
    }

    #[test]
    fn a_class_name_the_settings_do_not_name_is_refused() {
        assert!(ScopeClass::parse("lease-writr").is_none(), "a misspelt class is never a row key");
        assert!(ScopeClass::parse("").is_none());
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    /// Whether each computer's copy and each net link is up, with the simulated clock and a log of every
    /// accepted change (computer, term number) -> writer, which must never name two writers.
    struct Net {
        copies: BTreeMap<String, MemCopy>,
        now: Cell<i64>,
        down: RefCell<BTreeSet<String>>,
        cut: RefCell<BTreeSet<(String, String)>>,
        log: Rc<RefCell<BTreeMap<(String, u64), String>>>,
    }

    impl Net {
        fn new(computers: &[&str]) -> Net {
            let log = Rc::new(RefCell::new(BTreeMap::new()));
            let copies = computers.iter().map(|computer| (computer.to_string(), MemCopy::new(computer, log.clone()))).collect();
            Net { copies, now: Cell::new(0), down: RefCell::new(BTreeSet::new()), cut: RefCell::new(BTreeSet::new()), log }
        }

        fn copy(&self, computer: &str) -> &MemCopy {
            &self.copies[computer]
        }

        fn set_down(&self, computer: &str, down: bool) {
            if down {
                self.down.borrow_mut().insert(computer.to_string());
            } else {
                self.down.borrow_mut().remove(computer);
            }
        }

        fn set_cut(&self, a: &str, b: &str, cut: bool) {
            let (a, b) = (a.to_string(), b.to_string());
            let mut links = self.cut.borrow_mut();
            if cut {
                links.insert((a.clone(), b.clone()));
                links.insert((b, a));
            } else {
                links.remove(&(a.clone(), b.clone()));
                links.remove(&(b, a));
            }
        }

        fn reachable(&self, from: &str, to: &str) -> bool {
            let down = self.down.borrow();
            !down.contains(from) && !down.contains(to) && !self.cut.borrow().contains(&(from.to_string(), to.to_string()))
        }
    }

    impl Wire for Net {
        fn ask(&self, from: &str, to: &str, ask: &Ask) -> Option<Vote> {
            if !self.reachable(from, to) {
                return None;
            }
            self.copies.get(to)?.accept_from(from, ask, self.now.get())
        }
    }

    /// One computer's copy, in memory. Every change of a term number is logged for the one-writer check.
    struct MemCopy {
        owner: String,
        rows: RefCell<BTreeMap<String, WriterRow>>,
        log: Rc<RefCell<BTreeMap<(String, u64), String>>>,
    }

    impl MemCopy {
        fn new(owner: &str, log: Rc<RefCell<BTreeMap<(String, u64), String>>>) -> MemCopy {
            MemCopy { owner: owner.to_string(), rows: RefCell::new(BTreeMap::new()), log }
        }

        /// The voter's answer to a message from `from`, as the transport runs it at this computer.
        fn accept_from(&self, from: &str, ask: &Ask, now: i64) -> Option<Vote> {
            accept_vote(self, from, ask, now).ok()
        }

        fn set(&self, id: &str, row: WriterRow) {
            self.rows.borrow_mut().insert(id.to_string(), row);
        }
    }

    impl WriterRowCopy for MemCopy {
        fn read(&self, id: &str) -> WriterResult<Option<WriterRow>> {
            Ok(self.rows.borrow().get(id).cloned())
        }

        fn replace(&self, id: &str, before: Option<&WriterRow>, after: &WriterRow) -> WriterResult<bool> {
            let mut rows = self.rows.borrow_mut();
            if rows.get(id) != before {
                return Ok(false);
            }
            if before.map_or(0, |row| row.term) != after.term {
                let mut log = self.log.borrow_mut();
                let writer = log.entry((self.owner.clone(), after.term)).or_insert_with(|| after.writer.clone());
                assert_eq!(*writer, after.writer, "{} accepted two writers for term {}", self.owner, after.term);
            }
            rows.insert(id.to_string(), after.clone());
            Ok(true)
        }
    }

    /// A second copy as `copies.rs` would report it: `caught` is its caught-up stamp, or `None`
    /// when no second copy reported. A copy that reported a stamp is caught up enough to claim.
    struct OtherCopies {
        caught: Option<i64>,
    }

    impl Ack for OtherCopies {
        fn second_copy_stamp(&self, _id: &str, _term: u64) -> Option<i64> {
            self.caught
        }
    }

    impl CaughtUp for OtherCopies {
        fn caught_up(&self, _id: &str) -> bool {
            self.caught.is_some()
        }
    }

    fn write_ok() -> WriterResult<((), i64)> {
        Ok(((), 1))
    }

    #[test]
    fn a_renewal_keeps_the_writer_role_and_a_commit_under_it_counts() {
        let net = Net::new(&[P1, P2, P3]);
        let voters = names(&[P1, P2, P3]);
        let mut writer_role = WriterRole::new(&subject(), P1, &voters);
        assert!(writer_role.claim(0, net.copy(P1), &net, &OtherCopies { caught: Some(i64::MAX) }).unwrap());
        assert_eq!(writer_role.holding(0), Some(1));
        for step in 1..=10 {
            let now = step * 3_000;
            net.now.set(now);
            assert!(writer_role.renew(now, net.copy(P1), &net).unwrap(), "renewal {step} with every voter up");
            assert_eq!(writer_role.holding(now), Some(1));
        }
        let at = 30_000;
        writer_role.commit(at, net.copy(P1), &OtherCopies { caught: Some(i64::MAX) }, write_ok).expect("a commit under the held term counts");
    }

    #[test]
    fn a_dead_writer_is_taken_over_by_a_majority_once_its_term_ran_out() {
        let net = Net::new(&[P1, P2, P3]);
        let voters = names(&[P1, P2, P3]);
        let (mut one, mut two) = (WriterRole::new(&subject(), P1, &voters), WriterRole::new(&subject(), P2, &voters));
        net.now.set(0);
        assert!(one.claim(0, net.copy(P1), &net, &OtherCopies { caught: Some(i64::MAX) }).unwrap());
        net.now.set(3_000);
        assert!(one.renew(3_000, net.copy(P1), &net).unwrap());
        net.set_down(P1, true);

        // The last renewal ends at 3000 + TERM. Right at the end, plus margin, a takeover is still refused.
        net.now.set(3_000 + TERM + MARGIN);
        assert_eq!(two.claim(net.now.get(), net.copy(P2), &net, &OtherCopies { caught: Some(i64::MAX) }), Ok(false));
        net.now.set(3_000 + TERM + MARGIN + 1);
        assert!(two.claim(net.now.get(), net.copy(P2), &net, &OtherCopies { caught: Some(i64::MAX) }).unwrap(), "P2 and P3 accept term 2");
        assert_eq!(two.holding(net.now.get()), Some(2));
        two.commit(net.now.get(), net.copy(P2), &OtherCopies { caught: Some(i64::MAX) }, write_ok).expect("the new writer commits");

        // The dead writer comes back: its copy shows term 1, its writer role ended, and its renewal is refused.
        net.set_down(P1, false);
        net.now.set(net.now.get() + 1);
        assert_eq!(one.holding(net.now.get()), None);
        assert_eq!(one.commit(net.now.get(), net.copy(P1), &OtherCopies { caught: Some(i64::MAX) }, write_ok), Err(crate::cause!(WriterError::NotWriter)));
        net.now.set(net.now.get() + 1_000);
        assert_eq!(one.renew(net.now.get(), net.copy(P1), &net), Ok(false));
    }

    #[test]
    fn two_voters_with_a_cut_do_not_take_over_and_writes_pause() {
        let net = Net::new(&[P1, P2]);
        let voters = names(&[P1, P2]);
        let (mut one, mut two) = (WriterRole::new(&subject(), P1, &voters), WriterRole::new(&subject(), P2, &voters));
        net.now.set(0);
        assert!(one.claim(0, net.copy(P1), &net, &OtherCopies { caught: Some(i64::MAX) }).unwrap(), "both voters are up, so 2 of 2 accept");

        // The cut comes between the two voters. P1's renewal reaches only itself: 1 of 2 is not a majority.
        net.set_cut(P1, P2, true);
        net.now.set(3_000);
        assert!(!one.renew(3_000, net.copy(P1), &net).unwrap());
        assert_eq!(one.commit(3_000, net.copy(P1), &OtherCopies { caught: Some(i64::MAX) }, write_ok), Err(crate::cause!(WriterError::NotWriter)), "writes pause at once");

        // After the term ran out, neither side can take over alone.
        net.now.set(3_000 + TERM + MARGIN + 1);
        assert!(!two.claim(net.now.get(), net.copy(P2), &net, &OtherCopies { caught: Some(i64::MAX) }).unwrap(), "P2 alone is 1 of 2");
        assert!(!one.claim(net.now.get(), net.copy(P1), &net, &OtherCopies { caught: Some(i64::MAX) }).unwrap(), "P1 alone is 1 of 2");

        // Once the cut heals, a claim works again: no computer was ever given two numbers.
        net.set_cut(P1, P2, false);
        assert!(one.claim(net.now.get(), net.copy(P1), &net, &OtherCopies { caught: Some(i64::MAX) }).unwrap(), "after the heal P1 takes term 2");
    }

    #[test]
    fn a_stale_writer_is_refused_when_its_copy_shows_a_newer_number() {
        let net = Net::new(&[P1, P2, P3]);
        let voters = names(&[P1, P2, P3]);
        let mut one = WriterRole::new(&subject(), P1, &voters);
        net.now.set(0);
        assert!(one.claim(0, net.copy(P1), &net, &OtherCopies { caught: Some(i64::MAX) }).unwrap());
        // The writer's own writer role still reads as valid, but its copy now shows term 2 held by P2 (the change feed brought it).
        net.copy(P1).set(&writer_row_id(&subject()), WriterRow { writer: P2.to_string(), term: 2, expires_at_ms: TERM });
        assert_eq!(one.holding(1), Some(1));
        assert_eq!(one.commit(1, net.copy(P1), &OtherCopies { caught: Some(i64::MAX) }, write_ok), Err(crate::cause!(WriterError::NotWriter)));
    }

    #[test]
    fn a_commit_without_a_second_copy_is_not_acknowledged() {
        let net = Net::new(&[P1, P2, P3]);
        let voters = names(&[P1, P2, P3]);
        let mut one = WriterRole::new(&subject(), P1, &voters);
        net.now.set(0);
        assert!(one.claim(0, net.copy(P1), &net, &OtherCopies { caught: Some(i64::MAX) }).unwrap());
        assert_eq!(one.commit(1, net.copy(P1), &OtherCopies { caught: None }, write_ok), Err(crate::cause!(WriterError::NotAcknowledged)));
        assert_eq!(one.commit(1, net.copy(P1), &OtherCopies { caught: None }, write_ok), Err(crate::cause!(WriterError::NotAcknowledged)));
        assert_eq!(one.commit(1, net.copy(P1), &OtherCopies { caught: Some(0) }, write_ok), Err(crate::cause!(WriterError::NotAcknowledged)), "a second copy behind the write's stamp");
        assert_eq!(one.commit(1, net.copy(P1), &OtherCopies { caught: Some(1) }, write_ok), Ok(()), "caught up to the write's stamp");
    }

    #[test]
    fn a_computer_with_no_voters_writes_as_it_always_did() {
        let net = Net::new(&[P1]);
        let mut writer_role = WriterRole::new(&subject(), P1, &[]);
        assert_eq!(writer_role.claim(0, net.copy(P1), &net, &OtherCopies { caught: Some(i64::MAX) }), Ok(false));
        assert_eq!(writer_role.renew(0, net.copy(P1), &net), Ok(false));
        assert_eq!(writer_role.commit(0, net.copy(P1), &OtherCopies { caught: None }, || Ok((7u8, 1))), Ok(7), "no term, no ack needed");
        assert!(net.copy(P1).rows.borrow().is_empty(), "no writer row is written");
    }

    #[test]
    fn a_claimer_is_not_stalled_by_its_own_claims_that_did_not_win() {
        let copy = MemCopy::new(P3, Rc::new(RefCell::new(BTreeMap::new())));
        let id = writer_row_id(&subject());
        assert_eq!(accept(&copy, P1, &Ask { id: id.clone(), prior: 0, term: 4, expires_at_ms: TERM }, 0), Ok(true), "P1's claim that did not win");
        assert_eq!(accept(&copy, P1, &Ask { id: id.clone(), prior: 0, term: 5, expires_at_ms: TERM + 10 }, 10), Ok(true),
            "P1 asks a higher number while its own term 4 is in the row: taken at once");
        assert_eq!(accept(&copy, P2, &Ask { id: id.clone(), prior: 0, term: 6, expires_at_ms: TERM + 20 }, 20), Ok(false),
            "another computer still waits for P1's term to run out");
    }

    #[test]
    fn a_voter_accepts_one_writer_per_term_number() {
        let copy = MemCopy::new(P3, Rc::new(RefCell::new(BTreeMap::new())));
        let id = writer_row_id(&subject());
        let first = Ask { id: id.clone(), prior: 0, term: 1, expires_at_ms: TERM };
        assert_eq!(accept(&copy, P1, &first, 0), Ok(true));
        assert_eq!(accept(&copy, P2, &first, 0), Ok(false), "the same number cannot go to a second writer");
        assert_eq!(accept(&copy, P1, &first, 0), Ok(false), "nor be taken again by its writer");
        let renewal = Ask { id: id.clone(), prior: 1, term: 1, expires_at_ms: TERM + 1_000 };
        assert_eq!(accept(&copy, P2, &renewal, 100), Ok(false), "a renewal from another computer is refused");
        assert_eq!(accept(&copy, P1, &renewal, 100), Ok(true));
        let takeover = Ask { id: id.clone(), prior: 1, term: 2, expires_at_ms: 40_000 };
        assert_eq!(accept(&copy, P2, &takeover, TERM as i64 + MARGIN as i64), Ok(false), "the term here has not run out");
        assert_eq!(accept(&copy, P2, &takeover, TERM as i64 + 1_000 + MARGIN + 1), Ok(true));
        assert_eq!(copy.read(&id).unwrap().unwrap().writer, P2);
    }

    #[test]
    fn a_voter_renews_its_writer_term_even_after_its_old_copy_of_the_end_has_passed() {
        let copy = MemCopy::new(P3, Rc::new(RefCell::new(BTreeMap::new())));
        let id = writer_row_id(&subject());
        assert_eq!(accept(&copy, P1, &Ask { id: id.clone(), prior: 0, term: 1, expires_at_ms: TERM }, 0), Ok(true));
        let late = TERM + MARGIN + 2_500;
        let renewal = Ask { id: id.clone(), prior: 1, term: 1, expires_at_ms: late + TERM };
        assert_eq!(accept(&copy, P2, &renewal, late), Ok(false), "another computer still cannot renew P1's number");
        assert_eq!(accept(&copy, P1, &renewal, late), Ok(true), "no higher number was given here, so P1 renews");
        let takeover = Ask { id: id.clone(), prior: 1, term: 2, expires_at_ms: late + 2 * TERM };
        assert_eq!(accept(&copy, P2, &takeover, late + 1), Ok(false), "the renewed term protects P1 again");
        let moved = Ask { id: id.clone(), prior: 1, term: 2, expires_at_ms: 3 * late };
        assert_eq!(accept(&copy, P2, &moved, late + TERM + MARGIN + 1), Ok(true));
        let after = Ask { id: id.clone(), prior: 1, term: 1, expires_at_ms: 4 * late };
        assert_eq!(accept(&copy, P1, &after, late + TERM + MARGIN + 2), Ok(false), "once a higher number is here, the old one is never renewed");
    }

    #[test]
    fn the_store_copy_moves_the_row_by_compare_and_set() {
        let memory = Memory::open("sign_in").expect("the sign_in schema opens");
        let storage: &dyn crate::storage::Storage = &memory;
        let copy = StoreCopy { store: Store::new(storage), account: "account-one" };
        let id = writer_row_id(&subject());
        let first = WriterRow { writer: P1.to_string(), term: 1, expires_at_ms: TERM };
        assert_eq!(copy.replace(&id, None, &first), Ok(true));
        assert_eq!(copy.replace(&id, None, &first), Ok(false), "a row that exists is not inserted again");
        assert_eq!(copy.read(&id), Ok(Some(first.clone())));
        let second = WriterRow { writer: P2.to_string(), term: 2, expires_at_ms: 2 * TERM };
        let stale = WriterRow { writer: P3.to_string(), term: 2, expires_at_ms: 2 * TERM };
        assert_eq!(copy.replace(&id, Some(&stale), &stale), Ok(false), "a stale before row changes nothing");
        assert_eq!(copy.replace(&id, Some(&first), &second), Ok(true));
        assert_eq!(copy.read(&id), Ok(Some(second)));
    }

    #[test]
    fn a_writer_row_and_a_computers_row_name_their_own_computers_and_voters() {
        let key = AccountKey::from_secret(Zeroizing::new([9u8; 32])).expect("secret");
        let row = ComputersRow::sign_for(&key.address(), None, 1, &names(&[P1]), &names(&[P1]), &names(&[P2, P3]), &key).unwrap();
        assert!(row.verify(key.public_key()));
        let mut moved = row.clone();
        moved.voters = names(&[P2, P4]);
        assert!(!moved.verify(key.public_key()), "a changed voter list is not the signed row");
        assert!(ComputersRow::sign_for(&key.address(), None, 1, &names(&[P1]), &[], &names(&[P2, P2]), &key).is_err());
    }

    #[test]
    fn a_claim_that_never_won_does_not_stop_a_later_claim() {
        let net = Net::new(&[P1, P2, P3, P4]);
        let voters = names(&[P1, P3, P4]);
        let caught = OtherCopies { caught: Some(i64::MAX) };
        let mut one = WriterRole::new(&subject(), P1, &voters);
        assert!(one.claim(0, net.copy(P1), &net, &caught).unwrap());
        net.set_down(P1, true);

        // P2 (not a voter, so its own copy holds no term) claims once P1's term ran out. Its first ask is term 1,
        // which every voter already gave: P3 refuses and says it holds term 1. Its next ask is term 2: P3 accepts and
        // moves its copy to term 2, but P4 is cut off from P2, so 1 of 3 is not a majority and the claim fails. Then
        // P2 dies.
        let mut two = WriterRole::new(&subject(), P2, &voters);
        net.set_cut(P2, P4, true);
        let after_one = TERM + MARGIN + 1;
        net.now.set(after_one);
        assert!(!two.claim(after_one, net.copy(P2), &net, &caught).unwrap());
        assert_eq!(net.copy(P3).read(&writer_row_id(&subject())).unwrap().unwrap().term, 1);
        assert!(!two.claim(after_one, net.copy(P2), &net, &caught).unwrap());
        assert_eq!(net.copy(P3).read(&writer_row_id(&subject())).unwrap().unwrap().term, 2, "the failed claim moved P3");
        net.set_down(P2, true);

        // P4 claims: P3 still keeps the failed claim's term 2 until it runs out, and says so.
        let mut four = WriterRole::new(&subject(), P4, &voters);
        net.now.set(after_one + 1);
        assert!(!four.claim(after_one + 1, net.copy(P4), &net, &caught).unwrap());
        // Once term 2 has run out on P3, P4 asks term 3 and P3 takes it: the writer role moves again.
        let later = after_one + TERM + MARGIN + 1;
        net.now.set(later);
        assert!(four.claim(later, net.copy(P4), &net, &caught).unwrap(), "P3 and P4 accept term 3");
        assert_eq!(four.holding(later), Some(3));
    }

    /// A small deterministic random number source (xorshift), so every run replays the same interleavings.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    #[test]
    fn random_interleavings_never_give_one_term_number_to_two_writers() {
        let computers = [P1, P2, P3, P4];
        let voters = names(&[P1, P2, P3]);
        let mut takeovers = 0;
        let mut commits = 0;
        for random_start in 1..=200u64 {
            let net = Net::new(&computers);
            let subject = subject();
            let mut writer_roles: BTreeMap<&str, WriterRole> = computers.iter().map(|computer| (*computer, WriterRole::new(&subject, computer, &voters))).collect();
            let mut winners: BTreeMap<u64, String> = BTreeMap::new();
            let mut rng = Rng(random_start.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            let mut now = 0i64;
            for step in 0..400u64 {
                now += rng.below(2_500) as i64;
                net.now.set(now);
                let computer = computers[rng.below(computers.len() as u64) as usize];
                let other = computers[rng.below(computers.len() as u64) as usize];
                match rng.below(10) {
                    0 => net.set_down(computer, rng.below(2) == 0),
                    1 => net.set_cut(computer, other, rng.below(2) == 0),
                    2 | 3 => {
                        let caught = OtherCopies { caught: if rng.below(4) != 0 { Some(i64::MAX) } else { None } };
                        let writer_role = writer_roles.get_mut(computer).unwrap();
                        if net.down.borrow().contains(computer) {
                            continue;
                        }
                        if writer_role.claim(now, net.copy(computer), &net, &caught) == Ok(true) {
                            let term = writer_role.holding(now).expect("a won writer role holds");
                            if term > 1 {
                                takeovers += 1;
                            }
                            let previous = winners.entry(term).or_insert_with(|| computer.to_string());
                            assert_eq!(previous, computer, "random start {random_start} step {step}: term {term} won by two computers");
                        }
                    }
                    4 | 5 => {
                        let writer_role = writer_roles.get_mut(computer).unwrap();
                        if net.down.borrow().contains(computer) {
                            continue;
                        }
                        let _ = writer_role.renew(now, net.copy(computer), &net);
                    }
                    _ => {
                        let writer_role = writer_roles.get(computer).unwrap();
                        if net.down.borrow().contains(computer) {
                            continue;
                        }
                        let ack = OtherCopies { caught: if rng.below(3) != 0 { Some(i64::MAX) } else { None } };
                        let stamp = step as i64;
                        if let Ok(()) = writer_role.commit(now, net.copy(computer), &ack, || Ok(((), stamp))) {
                            commits += 1;
                            let term = writer_role.holding(now).expect("a commit needs a held writer role");
                            assert_eq!(winners.get(&term).map(String::as_str), Some(computer), "random start {random_start} step {step}: a write under a writer role nobody won");
                        }
                    }
                }
                // At any moment at most one computer holds the writer role, and it is the one that won the newest number.
                let holding: Vec<(&str, u64)> = writer_roles.iter().filter_map(|(computer, writer_role)| writer_role.holding(now).map(|term| (*computer, term))).collect();
                assert!(holding.len() <= 1, "random start {random_start} step {step}: two computers hold the writer role at {now}: {holding:?}");
            }
        }
        assert!(takeovers > 0, "the random runs exercised at least one takeover");
        assert!(commits > 0, "the random runs made at least one acknowledged write");
    }
}

crate::impl_caused!(WriterError);
