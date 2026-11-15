// src/native_entry/computer/placement_check.rs
//
// Purpose: a computer releases an account it holds once the account's newest placement row no longer names it. The check is
// a pull, never a push: a computer that was dropped from the row may be offline when a notice would go out, so a notice can
// be lost, but a pull cannot be missed. Each interval (`placement_check_every_ms`, settings.json), and once at start, every
// account this computer holds reads the placement row of each computer the account's own row names (`Message::Row` with no
// row of its own: the answer is the replying computer's row, which is signed account data, so any holder can serve it), and
// keeps the newest. A newest row that names voters and not this computer releases the account here:
// - the writer turn this computer holds is handed over (`Copies::hand_over_held`), so the others claim it at once;
// - the account stops being served here (it leaves `accounts`, so its timer steps no more and its routes refuse it);
// - its folder moves to `not-placed/` beside `accounts/`, with a note saying why. Nothing is deleted.
// No row is read as proof of a release when no peer answers: silence keeps the account (a pull that fails is retried at the
// next interval). The row itself is the only thing read; no new message is sent.
//
// Non-Negotiable Invariants:
// - A release never deletes account data: the folder is moved, its files stay as they were.
// - An account is released only by its newest row (highest revision among the rows answered and the local row), and only
//   when that row names voters and does not name this computer.
// - A released account never claims again on this computer (it is out of `accounts`, so no timer or write reaches it).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{releases, settings, Computer, ComputerAccount, ForwarderLink};
use crate::account::computers::{
    copies::Link as _,
    messages::{Answer, Message},
    KeptAccount,
};
use crate::refusal_cause::CodedError;
use std::{
    collections::BTreeSet,
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

impl Computer {
    /// Keep the placement check running: every `placement_check_every_ms`, and at once when it starts. Runs on its own
    /// thread until `stop` is set, and ends with the computer's sessions (`join_sessions`).
    pub(super) fn keep_placement_checks(self: &Arc<Self>, stop: &'static AtomicBool) {
        let every = Duration::from_millis(settings().placement_check_every_ms.max(1));
        let computer = self.clone();
        let handle = crate::forwarder::lease_time::spawn(computer.clock.clone(), move || {
            while !stop.load(Ordering::Acquire) {
                computer.check_placements();
                computer.clock.wait(every);
            }
        });
        self.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(handle);
    }

    /// One pass: every account this computer holds, checked against its newest placement row (`newest_placement`).
    fn check_placements(self: &Arc<Self>) {
        for account in self.accounts() {
            let Some(newest) = self.newest_placement(&account.address) else { continue };
            if !releases(&newest.row, &self.computer_id()) {
                continue;
            }
            self.release_account(&account, &newest);
        }
    }

    /// The newest placement row of the account at `address`: this computer's own, or the highest-revision row a computer
    /// the own row names answers with (`Message::Row`, no row of its own). A peer that does not answer counts as nothing.
    fn newest_placement(self: &Arc<Self>, address: &str) -> Option<KeptAccount> {
        let local = self.current_row(address)?;
        let me = self.computer_id();
        let peers: BTreeSet<String> = local.row.copy_keepers.iter()
            .chain(local.row.voters.iter())
            .chain(local.row.may_answer.iter())
            .filter(|computer| **computer != me)
            .cloned()
            .collect();
        let Some(forwarder) = self.config.forwarder.clone() else { return Some(local) };
        let link = ForwarderLink { forwarder: Some(forwarder), address: address.to_owned(), signer: self.signer.clone() };
        let mut newest = local;
        for peer in peers {
            if let Some(Answer::Row { told: Some(told), .. }) = link.send(&peer, &Message::Row { told: None, term: 0, made: false }) {
                if told.believed(address) && told.row.revision > newest.row.revision {
                    newest = told;
                }
            }
        }
        Some(newest)
    }

    /// Release the account `account` here, because its newest row `newest` does not name this computer: hand over the writer
    /// turn this computer holds, stop serving the account, and move its folder to `not-placed/` with a note (never deleted).
    fn release_account(self: &Arc<Self>, account: &Arc<ComputerAccount>, newest: &KeptAccount) {
        if let Some(term) = account.copies().and_then(|copies| copies.hand_over_held()) {
            crate::quiet_eprintln!("computer-placement event=writer-handed-over account={} term={term}", account.address);
        }
        self.accounts.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).retain(|held| !Arc::ptr_eq(held, account));
        let label = account.state_root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let parked = park_folder(&account.state_root, &self.config.accounts, &label, self.clock.now_ms() / 1000, &format!(
            "This account was released from this computer on {}.\nThe account's newest placement row (revision {}) does not name this computer.\nNothing was deleted. The files are as they were when the account was released.\n",
            label, newest.row.revision,
        ));
        match parked {
            Ok(to) => crate::quiet_eprintln!("computer-placement event=released account={} revision={} parked={}", account.address, newest.row.revision, to.display()),
            Err(error) => crate::quiet_eprintln!("computer-placement event=released-not-parked account={} revision={} cause={}", account.address, newest.row.revision, error.code),
        }
    }
}

/// Move `folder` into `not-placed/` beside the accounts folder, named with its label and `unix_secs`, and write `note` into it.
/// Returns the new path. The move is within one folder tree, so it is a rename.
fn park_folder(folder: &Path, accounts: &Path, label: &str, unix_secs: i64, note: &str) -> Result<std::path::PathBuf, CodedError<&'static str>> {
    let parent = accounts.parent().ok_or_else(|| CodedError::new("the accounts folder has no parent"))?;
    let dir = parent.join("not-placed");
    fs::create_dir_all(&dir).map_err(|_| CodedError::new("the not-placed folder could not be made"))?;
    let to = dir.join(format!("{label}-not-placed-{unix_secs}"));
    fs::rename(folder, &to).map_err(|_| CodedError::new("the account folder could not be moved"))?;
    fs::write(to.join("NOT-PLACED.txt"), note).map_err(|_| CodedError::new("the note could not be written"))?;
    Ok(to)
}
