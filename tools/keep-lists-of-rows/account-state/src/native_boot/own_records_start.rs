//! Startup preparation: the selected account is served from what its record store holds.
//!
//! There is no migration (the person, 2026-11-14): `prepare` copies nothing from the old
//! trillion app and carries no old vault. It reports ready at once, installs the first
//! Workshop when the account has none, prepares the tool screens and prints the terminal
//! line the Mac app reads. The step functions below (`step_phase`, `carry_secrets`) are
//! no longer called.
//!
//! Non-Negotiable Invariants:
//! - Each step holds the selected-account owner for one bounded step only and
//!   releases it before the next.
//! - Until the records are ready the host answers every request busy
//!   (`native_entry::preparation_gate`): before the workspace phase the store answers empty,
//!   and a write made then would win over the label the migration carries.
//! - Each step runs inside the adopted selection and the owner's own browser
//!   access check and snapshot witness (`SelectedAccount::own_records_step`).
//! - The stderr lines keep the native protocol the Mac app reads
//!   (`native-startup-preparation status=...`, decoded by the app's
//!   `StartupPreparationDiagnostics.swift`): `preparing`, progress lines, and
//!   one terminal line (`ScopedComplete { .. }`, `Cancelled` or `Failed`).
//!
//! Key Concepts:
//! - Every current step error is terminal. `records::Error` carries no proof
//!   of a current-operation deadline with confirmed rollback, so none of its
//!   variants authorizes an automatic retry. The saved position remains
//!   resumable on a later start; cancellation retains terminal precedence.
//!
//! Security Considerations:
//! - Diagnostics carry counts and phase words only.
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.
use super::SelectedAccount;
use crate::{account_rights::run_capability::Route, local_account::own_records::Step, native_host::OwnedConnectionTask};
use std::{
    io,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// The store is ready: `records` checkpoint records, `keys` field keys and `journal_rows` journal rows were written
    /// this run.
    Ready { records: usize, keys: usize, journal_rows: usize },
    Cancelled,
    Failed,
}

/// Compose the preparation as a supervised sibling of the native host's outbound connection task: both start
/// together, and the preparation is joined before the host task finishes on parent shutdown. `ready` is set once
/// the account's own records are ready on record store; until then the host answers every request busy
/// (`native_entry::preparation_gate`), so nothing reads a half-filled store or writes ahead of the migration.
pub(crate) fn with_connection(
    connection: OwnedConnectionTask,
    owner: Arc<Mutex<SelectedAccount>>,
    session: zeroize::Zeroizing<String>,
    ready: Arc<AtomicBool>,
    route: Option<Route>,
    events: Arc<crate::wake::host_events::HostEvents>,
) -> OwnedConnectionTask {
    supervise(connection, move |cancel| {
        let status = prepare(&owner, &session, cancel.clone(), &ready);
        // The account's causes are woken on this same thread, from the moment its records are ready until the host
        // stops (the cancel flag the connection task shares). A run a cause starts calls back to `route` with the
        // capability its live cause issues: the party that wrote the rule row causing it (`account_rights::run_cause`).
        if let Status::Ready { .. } = status {
            install_first_workshop(&owner, &cancel);
            keep_waking(&owner, &session, &cancel, route.clone(), &events);
        }
        status
    })
}

fn supervise(
    connection: OwnedConnectionTask,
    prepare: impl FnOnce(Arc<AtomicBool>) -> Status + Send + 'static,
) -> OwnedConnectionTask {
    Box::new(move |runtime, cancel, slot| {
        std::thread::scope(|scope| {
            let preparation_cancel = cancel.clone();
            let preparation = std::thread::Builder::new()
                .name("native-own-records-preparation".into())
                .spawn_scoped(scope, move || prepare(preparation_cancel))?;
            let stop_preparation = cancel.clone();
            let connected = connection(runtime, cancel, slot);
            stop_preparation.store(true, Ordering::Release);
            let prepared = preparation.join().map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::other("native preparation worker failed"), _refusal_io_cause) })?;
            connected?;
            match prepared {
                Status::Ready { .. } | Status::Cancelled => Ok(()),
                Status::Failed => Err(io::Error::other("native own-records preparation failed")),
            }
        })
    })
}

/// The phase word each migration step reports, in the order the migration runs them; `Ready` has none.
const STEP_PHASES: [&str; 6] = [
    "own-records-checkpoint",
    "own-records-erasable-keys",
    "own-records-journal",
    "own-records-workspace",
    COPY_PHASE,
    "own-records-orders",
];
/// The phase word of the generic copy, which moves each `copy` table of src/storage/record_store_resources.json into its
/// resource row by row; the `startup` of every such row names it.
pub(crate) const COPY_PHASE: &str = "own-records-copy";
fn step_phase(step: &Step) -> Option<&'static str> {
    let at = match step {
        Step::Checkpoint { .. } => 0,
        Step::Erasable { .. } => 1,
        Step::Journal { .. } => 2,
        Step::Workspace { .. } => 3,
        Step::Copy { .. } => 4,
        Step::Orders { .. } => 5,
        Step::Ready => return None,
    };
    Some(STEP_PHASES[at])
}

/// Every phase this preparation reports: each migration step's, then the secrets carry. The `startup` phases of
/// src/storage/record_store_resources.json are checked against this list (`every_old_source_is_copied_at_startup`).
#[cfg(test)]
pub(crate) fn phases() -> Vec<&'static str> {
    STEP_PHASES.iter().copied().chain([SECRETS_PHASE]).collect()
}
/// The phases that copy nothing from the old trillion app: they derive what record store itself holds (the declared orders).
#[cfg(test)]
pub(crate) const DERIVED_PHASES: [&str; 1] = ["own-records-orders"];

/// Run migration steps until the store is ready, a step refuses, or the native parent cancels; then carry the old
/// secrets vault (`carry_secrets`).
pub fn run(owner: &Arc<Mutex<SelectedAccount>>, session: &str, cancel: Arc<AtomicBool>) -> Status {
    prepare(owner, session, cancel, &AtomicBool::new(false))
}

/// `run`, setting `ready` the moment the records are ready, before the secrets carry.
fn prepare(owner: &Arc<Mutex<SelectedAccount>>, session: &str, cancel: Arc<AtomicBool>, ready: &AtomicBool) -> Status {
    crate::quiet_eprintln!("native-startup-preparation status=preparing");
    let started = Instant::now();
    let steps = 0u64;
    // No migration (the person, 2026-11-14): the account is served from what its record store holds at start. No step
    // copies the old trillion app's records in first, so nothing holds a request busy (account_preparing).
    let status = if cancel.load(Ordering::Acquire) { Status::Cancelled } else { Status::Ready { records: 0, keys: 0, journal_rows: 0 } };
    if let Status::Ready { records, keys, journal_rows } = status {
        crate::quiet_eprintln!(
            "native-startup-preparation status=own-records-ready records={records} keys={keys} journal_rows={journal_rows} steps={steps} elapsed_ms={}",
            started.elapsed().as_millis()
        );
        // An account with no tools installed yet installs the pinned commit before its first request is answered,
        // so its record model (and every nested sealed field a tool declares) is the tools' from the first read.
        first_workshop(owner, &cancel);
        ready.store(true, Ordering::Release);
        prepare_tool_screens(owner, session, &cancel);
    }
    // The terminal line in the protocol the Mac app decodes. The record store has no decision pages or heads to prepare.
    crate::quiet_eprintln!("native-startup-preparation status={}", match status {
        Status::Ready { .. } => "ScopedComplete { decision_pages: 0, heads: 0 }",
        Status::Cancelled => "Cancelled",
        Status::Failed => "Failed",
    });
    status
}

/// Make the tool screens' kept catalog and projection (src/native_boot/tool_screens.rs `prepare_tool_screens`) before
/// the terminal line, so the page, which opens on that line, never waits on the first assembly (~1.2 s on a real
/// account, inside the account owner, where the page's own first reads timed out waiting for it). It never fails the
/// startup: a refusal is reported on its own line and the first tool-screens read assembles as before.
fn prepare_tool_screens(owner: &Arc<Mutex<SelectedAccount>>, session: &str, cancel: &AtomicBool) {
    let started = Instant::now();
    let Ok(mut held) = crate::workspace_session::owner_wait::acquire_background(owner, || cancel.load(Ordering::Acquire)) else {
        return;
    };
    let outcome = held.prepare_tool_screens(session, cancel);
    drop(held);
    match outcome {
        Ok(_) => crate::quiet_eprintln!("native-tool-screens-prepared outcome=kept elapsed_ms={}", started.elapsed().as_millis()),
        Err(error) => crate::quiet_eprintln!("native-tool-screens-prepared outcome=refused cause={}", error.cause()),
    }
}

/// The phase word this preparation reports, and the `startup` phase the `@held-values` row of
/// src/storage/record_store_resources.json names.
const SECRETS_PHASE: &str = "held-values-import";

/// Carry the old Worker's per-person vault into the selected account's own vault, once (`secrets::carry_home`):
/// the vault the account's RecordBook keeps is read in one bounded step under the owner
/// (`SelectedAccount::old_secrets`), then opened with the old root the restore receipt names and sealed here with
/// the owner released. A vault that cannot be opened yet is recorded in the account's vault store as `needs-key`
/// with the key's name and reported the same way; the next start tries again. It never fails the startup: the
/// account's records do not depend on it. The line carries phase words, counts and static source causes only.
fn carry_secrets(owner: &Arc<Mutex<SelectedAccount>>, session: &str, cancel: Arc<AtomicBool>) {
    let report = |what: String| crate::quiet_eprintln!("native-startup-preparation status=phase-start phase={SECRETS_PHASE} {what}");
    // Only a launcher whose product settings declare the old layout (`carried_from`) asks for the carry.
    let from = match crate::secrets::CarriedFrom::shipped() {
        Ok(Some(from)) => from,
        Ok(None) => return report("carry=none".into()),
        Err(error) => return report(format!("refused cause={}", error.cause())),
    };
    let held = crate::workspace_session::owner_wait::acquire_background(owner, || cancel.load(Ordering::Acquire));
    let mut held = match held { Ok(held) => held, Err(error) => return report(format!("refused reason=owner cause={}", error.cause())) };
    let read = held.old_secrets(session, cancel, &from);
    drop(held);
    let (old, account, state_root) = match read {
        Ok(read) => read,
        Err(error) => return report(format!("refused cause={}", error.cause())),
    };
    let Some(vault) = old.vault else { return report("old_vault=none".into()) };
    match crate::secrets::carry_home(&state_root, &account, &vault, &from, old.root_file.as_deref()) {
        Ok(crate::secrets::Carry::Carried(carried)) => report(format!(
            "carried sealed={} sealed_beside={} kept={}",
            carried.sealed.len(),
            carried.sealed_beside.len(),
            carried.kept_equal.len() + carried.kept_different.len() + carried.kept_not_compared.len()
        )),
        Ok(crate::secrets::Carry::Already) => report("already-carried".into()),
        Ok(crate::secrets::Carry::NeedsKey(_)) => report(format!("needs_key=true cause={}", crate::cause!())),
        Err(error) => report(format!("refused cause={}", error.cause())),
    }
}

/// The first-start install alone (`Workshop::install_first`), while the account's requests still wait
/// (preparation_gate): only an account with no installed copy downloads anything. The owner is held only to read where
/// the account's tools run.
fn first_workshop(owner: &Arc<Mutex<SelectedAccount>>, cancel: &Arc<AtomicBool>) {
    let Ok(workshop) = crate::tool_runs::tools::shipped() else { return };
    let held = crate::workspace_session::owner_wait::acquire_background(owner, || cancel.load(Ordering::Acquire));
    let Ok(held) = held else { return };
    let (account, state_root) = held.tool_place();
    drop(held);
    workshop.install_first(&account, &state_root, cancel);
}

/// An account with no installed copy of its tools yet installs the one the DATA pins, and an installed copy is kept
/// current once (`at_start`; a computer does the same, src/native_entry/computer.rs `install_tools`), before its causes are woken, so the first tick already reads its rows. The owner is held only to read where the
/// account's tools run; the download runs without it.
fn install_first_workshop(owner: &Arc<Mutex<SelectedAccount>>, cancel: &Arc<AtomicBool>) {
    let Ok(workshop) = crate::tool_runs::tools::shipped() else { return };
    let held = crate::workspace_session::owner_wait::acquire_background(owner, || cancel.load(Ordering::Acquire));
    let Ok(held) = held else { return };
    let (account, state_root) = held.tool_place();
    drop(held);
    workshop.at_start(&account, &state_root, cancel);
    match crate::native_entry::app_follower() {
        Some(follower) => follower.add(workshop.watch(&account, &state_root)),
        None => crate::quiet_eprintln!("workshop-not-followed reason=no-follower"),
    }
}

/// Wake the account's causes (`crate::wake`) until the host stops: one tick every `tick_ms`, each cause run as a
/// tool run of this account (`wake::tool_runner`). The owner is taken for each record read or write of the
/// wake book and the watched resources only (`WakeStore`), never while a tool runs, so no request waits behind a run.
/// Each change of state logs one line: `waking` (ticks finish), `idle reason=no-tool-rows` (no tools folder found for the
/// account yet), `idle reason=nothing-declared` (no row declares a wake and the book is empty: no owner hold at all
/// until one does), or `tick-unfinished reason=<failure>` (the next tick resumes it).
fn keep_waking(owner: &Arc<Mutex<SelectedAccount>>, session: &str, cancel: &Arc<AtomicBool>, route: Option<Route>,
    events: &crate::wake::host_events::HostEvents) {
    let report = |what: String| crate::quiet_eprintln!("native-wake status={what}");
    let (waker, workshop) = match (crate::wake::Waker::shipped(), crate::tool_runs::tools::shipped()) {
        (Ok(waker), Ok(workshop)) => (waker, workshop),
        (waker, workshop) => {
            if let Err(error) = waker { report(format!("refused reason=wake-data cause={}", error.cause())); }
            if let Err(error) = workshop { report(format!("refused reason=workshop-data cause={}", error.cause())); }
            return;
        }
    };
    let held = crate::workspace_session::owner_wait::acquire_background(owner, || cancel.load(Ordering::Acquire));
    let Ok(held) = held else { return };
    let (account, state_root) = held.tool_place();
    let mut held = held;
    // The wake book is kept under the account the own-records store keeps its records under, which is the account
    // its tools run for; a store kept under another account would split them, so it is refused.
    let kept = held.with_own_store(session, cancel.clone(), |_, kept| Ok(kept.to_owned()));
    drop(held);
    if !matches!(kept.as_deref(), Ok(kept) if kept == account) {
        return report(format!("refused reason=store-account cause={}", kept.as_ref().err().map(|error| error.cause()).unwrap_or_else(|| crate::cause!())));
    }
    let runner = crate::wake::tool_runner::WorkshopRunner { workshop, account: &account, state_root: &state_root, cancelled: cancel,
        route: route.as_ref() };
    let budget = owner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).store_budget;
    let mut store = WakeStore { owner, session, cancel: cancel.clone(), inventory:Default::default(), budget };
    // The account's vault file, when it is already there, joins the idle upkeep from the boot (`secrets::register_held_values`).
    if let Err(error) = crate::secrets::register_held_values(&state_root, &account) {
        report(format!("refused reason=held-values-register cause={}", error.cause()));
    }
    let mut reclaim = Reclaim::default();
    // The account's one change notifier: a change a wake listens for, or an event the computer sends, ends the wait
    // between passes early.
    let changes = crate::records::changes::AccountChanges::of(&account);
    if let Some(changes) = &changes {
        events.attach(changes.clone());
    }
    waker.keep_waking(&account, &mut store, &crate::storage::record_store::RealClock, &runner, || runner.rows(), events,
        changes.as_deref(), cancel,
        |pass| report(match pass {
            crate::wake::Pass::Ticked => "waking".into(),
            crate::wake::Pass::Idle => "idle reason=no-tool-rows".into(),
            crate::wake::Pass::Quiet => "idle reason=nothing-declared".into(),
            crate::wake::Pass::Unfinished(failure) => format!("tick-unfinished cause={}", failure.cause()),
        }),
        |longest| reclaim.step(owner, session, cancel, longest));
}

/// The account's idle upkeep between wake passes: one step of the holders walk while it has records left
/// (`RecordStore::walk_referrers`); then, while the own store's search walk is not done (rows written before its word
/// index, or before its current terms rule, existed: `RecordStore::search_walk`, ported from old trillion
/// record-log-store.mjs `buildIndexes` run by its idle maintainer), after the word index's owed merges
/// (`RecordStore::search_merge`, steps of about `merge_bytes` each committed alone, while the pass is within `longest`), one page of that walk, sized like a reclaim step
/// (halved past `longest`, doubled well within it, up to the store's `walk_rows`); the walk keeps its own cursor, so a
/// step that is refused, cut short or lost to a restart is taken up by the next. Once both are done, one step of giving the own store's freed space back to the volume
/// (`RecordStore::reclaim_pages`; an erasure leaves its space to these steps, never to a rewrite on a write path). It takes
/// the account only when the account is free and no request waits for it (`owner_wait::try_idle`), and is bounded
/// by time as well as by pages: a step that ran past `longest` halves the next step's pages, one well within it
/// doubles them, up to the store's `reclaim_step_pages`. Busy or unavailable, the next pass tries again.
///
/// Once no free page is left, the log beside the account's file (which can still hold earlier images of removed
/// rows, and gigabytes of messages after a large write) is cleared beside the account, never under its hold: SQLite
/// copies a log in one pass it cannot pause (3 to 20 s on a clone, every account-route call meanwhile refused), so the copy
/// runs on a thread of its own on the log's own connection (`sqlite::LogKeeper::copy`), taking no lock a request
/// waits on, and the wake's stop interrupts it. Only the reset that empties the log runs under the account, at the
/// next idle step, and only after a copy no commit came after, so it writes nothing but the truncation.
#[derive(Default)]
struct Reclaim {
    /// The pages the next step asks for; None until the first step, which asks for an eighth of the most.
    pages: Option<u64>,
    /// The log of the account's file, opened at the first step that leaves no free page; out while it copies.
    log: Option<crate::storage::sqlite::LogKeeper>,
    /// The running copy of the log, and the handle that interrupts it.
    copying: Option<(std::thread::JoinHandle<crate::storage::sqlite::LogKeeper>, crate::storage::sqlite::InterruptHandle)>,
    /// The records the next search walk step asks for; None until the first step, which asks for an eighth of the most.
    walk_rows: Option<usize>,
    /// Whether the own store's search walk is done (it is not asked again in this run of the account).
    walked: bool,
}
impl Reclaim {
    fn step(&mut self, owner: &Arc<Mutex<SelectedAccount>>, session: &str, cancel: &Arc<AtomicBool>, longest: Duration) {
        // Every other store the account keeps open (`record_store::maintenance`: the held-values vault, and any store its
        // owner registers) takes its turn first, one store a pass in path order, before the account is held: its vacuum
        // waits for that store to be quiet (`vacuum_if_due`), not for the whole account, and the own store's steps below
        // never hold it back. Its free pages and one-time vacuum run within `longest`; every turn logs its typed outcome.
        if let Some((one, outcome)) = crate::storage::record_store::maintenance::run_next(longest) {
            crate::quiet_eprintln!("{}", crate::storage::record_store::maintenance::turn_line(&one, &outcome));
        }
        if let Some((thread, _)) = self.copying.take_if(|(thread, _)| thread.is_finished()) {
            self.log = thread.join().ok();
        }
        if self.copying.is_some() {
            return;
        }
        let Some(mut held) = crate::workspace_session::owner_wait::try_idle(owner) else { return };
        // The referrers index walks records kept before their kind named its parts first, one bounded page per idle step
        // (`RecordStore::walk_referrers`, old record-log-store.mjs `buildModel` run by its idle maintainer); free pages
        // wait until nothing is left to walk.
        let walked: Result<bool, crate::records::Error> = (|| {
            held.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
            let walked = held.owner.with_own_records(session, cancel.clone(), |records| {
                records.walk_referrers_step(cancel.clone(), longest)
            })?;
            held.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
            Ok(walked)
        })();
        if walked != Ok(true) {
            return;
        }
        // A list whose move into a store of its own is under way copies its next pages (src/storage/record_store_resources/
        // lists.rs `step`, old placed-lists.mjs `continueMoves`, the resource's alarm), one page a list a round while the
        // pass is within `longest`; the move keeps its cursor in the list record, so a pass cut short is taken up by the
        // next. The other upkeep waits until no list moves.
        let moved: Result<bool, crate::records::Error> = (|| {
            held.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
            let moved = held.owner.with_own_records(session, cancel.clone(), |records| records.continue_list_moves(longest))?;
            held.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
            Ok(moved)
        })();
        if moved != Ok(true) {
            if let Err(error) = &moved {
                crate::quiet_eprintln!("list-move event=refused cause={}", error.cause());
            }
            return;
        }
        // A declared order whose declaration changed under its name (`RecordStore::fill_order`: its old rows leave,
        // then it fills again), one bounded step per idle pass; free pages wait until every order is filled.
        // Steps go on while the pass is within `longest`, so an order declared over a large kind (the Checks list's
        // orders over about 40,700 rows, 2026-11-05) fills in minutes, not one 256-row step per wake tick; the
        // account is held for at most `longest` plus one step, and a request waiting for it is not let in sooner
        // than that.
        let filled = held.with_own_store(session, cancel.clone(), |store, account| {
            let rows = store.referrers_walk_rows();
            let names: Vec<String> = store.settings().orders.iter().map(|declared| declared.order.clone()).collect();
            let started = Instant::now();
            for name in names {
                while !store.fill_order(account, crate::local_account::own_records::RESOURCE, &name, rows)? {
                    if started.elapsed() >= longest {
                        return Ok(false);
                    }
                }
            }
            // A declared total whose records were written before it was declared, or under another declaration of it,
            // is filled the same way (`RecordStore::fill_total`; adopted as it is when it was counted from the start).
            let totals: Vec<String> = store.settings().totals.iter().map(|declared| declared.total.clone()).collect();
            for total in totals {
                if !store.fill_total(account, crate::local_account::own_records::RESOURCE, &total, rows)? {
                    return Ok(false);
                }
            }
            Ok(true)
        });
        if filled != Ok(true) {
            return;
        }
        // The same fill for each placed list's own store (`OwnRead::fill_list_store_orders`).
        let filled = held.owner.with_own_records(session, cancel.clone(), |records| records.fill_list_store_orders(longest));
        if filled != Ok(true) {
            return;
        }
        // The word index's merges (`RecordStore::search_merge`): a write only appends segments, so the merges its
        // flushes leave owed are worked down here, each step reading about `merge_bytes` of parts and committed alone
        // (old trillion record-log-store.mjs:112-119, the index merge in resumable turns of at most 4 MiB). Steps go on
        // while the pass is within `longest`, like the order fill; a merge cut short is taken up by the next pass where
        // its last committed step left it. The search walk and free pages wait until no merge is owed.
        let merged = held.with_own_store(session, cancel.clone(), |store, account| {
            let bytes = store.settings().search.merge_bytes();
            let started = Instant::now();
            loop {
                if store.search_merge(account, crate::local_account::own_records::RESOURCE, bytes)?.done {
                    return Ok(true);
                }
                if started.elapsed() >= longest {
                    return Ok(false);
                }
            }
        });
        if merged != Ok(true) {
            return;
        }
        if !self.walked {
            let rows = &mut self.walk_rows;
            let walked = held.with_own_store(session, cancel.clone(), |store, account| {
                let most = store.settings().search.walk_rows();
                let asked = rows.unwrap_or(most / 8).clamp(1, most);
                let started = Instant::now();
                let walked = store.search_walk(account, crate::local_account::own_records::RESOURCE, asked);
                *rows = Some(next_pages(asked as u64, started.elapsed(), longest, most as u64) as usize);
                walked
            });
            match walked {
                Ok(walked) if walked.done => self.walked = true,
                // One page a step: the free pages wait until the walk is done.
                _ => return,
            }
        }
        let pages = &mut self.pages;
        let left = held.with_own_store(session, cancel.clone(), |store, _| {
            let most = store.reclaim_step_pages();
            let asked = pages.unwrap_or(most / 8).clamp(1, most);
            let started = Instant::now();
            let left = store.reclaim_pages(asked).map(|step| step.left());
            *pages = Some(next_pages(asked, started.elapsed(), longest, most));
            left.map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))
        });
        if left != Ok(0) {
            return;
        }
        // The one-time vacuum of the own store's file (`RecordStore::vacuum_if_due`, DATA `vacuum`): due once its free pages
        // are the DATA share and the store has been idle, and from then on its free pages come back in the steps above. A
        // refused or busy step is tried again by the next pass.
        let _ = held.own_records_file().map(|path| {
            let free = crate::storage::record_store::settings::volume_free_bytes(&path).unwrap_or(0);
            held.with_own_store(session, cancel.clone(), |store, account| {
                store.vacuum_if_due(account, crate::local_account::own_records::RESOURCE, free)
            })
        });
        if self.log.is_none() {
            self.log = held.own_records_file().ok().and_then(|path| crate::storage::sqlite::LogKeeper::open(&path).ok());
        }
        let Some(log) = self.log.take() else { return };
        if log.empty() || log.reset() == Ok(true) {
            self.log = Some(log);
            return;
        }
        drop(held);
        let interrupt = log.interrupter();
        let copy = std::thread::Builder::new().name("own-records-log-copy".into()).spawn(move || {
            let _ = log.copy();
            log
        });
        if let Ok(thread) = copy {
            self.copying = Some((thread, interrupt));
        }
    }
}
impl Drop for Reclaim {
    /// The wake stopped: a copy still running is interrupted, and never waited for, so it delays no shutdown; an
    /// interrupted copy records nothing, and one the process exit cuts short leaves the file as SQLite keeps it.
    fn drop(&mut self) {
        if let Some((_, interrupt)) = self.copying.take() {
            interrupt.interrupt();
        }
    }
}
/// The pages the next reclaim step asks for, after one of `asked` pages took `took` against its bound `longest`.
fn next_pages(asked: u64, took: Duration, longest: Duration, most: u64) -> u64 {
    if took > longest {
        (asked / 2).max(1)
    } else if took < longest / 2 {
        asked.saturating_mul(2).min(most)
    } else {
        asked
    }
}

/// The account's own record store as wake's record source: each operation takes the selected-account owner for itself
/// alone (`SelectedAccount::with_own_store`) and releases it. The account `Records` names is the store's own.
struct WakeStore<'a> {
    owner: &'a Arc<Mutex<SelectedAccount>>,
    session: &'a str,
    cancel: Arc<AtomicBool>,
    inventory: std::cell::RefCell<InboxInventory>,
    /// The store budget the owner was given (`SelectedAccount::set_store_budget`); none in production.
    budget: Option<crate::storage::record_store_resources::StoreBudget>,
}
#[derive(Default)]
struct InboxInventory {
    active: Option<crate::storage::record_store_resources::domains::Inventory>,
    complete: bool,
    repeat: bool,
}
impl WakeStore<'_> {
    fn with<T>(&self, operation: impl FnOnce(&mut crate::local_account::own_records::OwnStore) -> Result<T, crate::records::Error>)
        -> Result<T, crate::records::Error> {
        let mut held = crate::workspace_session::owner_wait::acquire_background(self.owner, || self.cancel.load(Ordering::Acquire))
            .map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        held.with_own_store(self.session, self.cancel.clone(), |store, _| operation(store))
    }

    /// A declaration carries the complete history; the account contributes
    /// only its current authority/generation, never a placement lookup. The
    /// selected adapter owns the snapshot and the physical custody witness.
    fn with_history<T>(&self, scope: &serde_json::Value, operation: impl FnOnce(&dyn crate::wake::HistoryRead, &str)
        -> Result<T, crate::records::Error>) -> Result<T, crate::records::Error> {
        read_history(self.owner,self.session,self.cancel.clone(),Instant::now() + crate::legacy_records::Bounds::default().elapsed,scope,operation)
    }
}

/// Shared native admission for background changes and a live socket's bounded
/// read-only ID view. Scope never changes which account or authority admits it.
pub(crate) fn read_history<T>(owner: &Arc<Mutex<SelectedAccount>>, session: &str, cancel: Arc<AtomicBool>, until: Instant,
    scope: &serde_json::Value, operation: impl FnOnce(&dyn crate::wake::HistoryRead, &str)
        -> Result<T, crate::records::Error>) -> Result<T, crate::records::Error> {
    read_history_retained(owner,session,cancel,until,scope,operation).map(|(answer,_permit)|answer)
}

/// The source's actual browser admission and physical-history holder travel
/// together until the final bytes leave. Neither is replaced by a sampled bool.
pub(crate) struct HistoryPermit {
    _native: crate::local_account::NativeAuthorityPermit,
    browser: crate::account::BrowserAdmission,
    selection: Arc<super::Chosen>,
    cancel: Arc<AtomicBool>,
}
impl HistoryPermit {
    pub(crate) fn still(&self) -> bool {
        !self.cancel.load(Ordering::Acquire) && self.browser.still() && self.selection.assert_current().is_ok()
    }
}

/// Keep the real physical-history permit with an externally disclosed answer.
/// The socket owns this exact permit until its frame has been flushed or dropped.
pub(crate) fn read_history_retained<T>(owner: &Arc<Mutex<SelectedAccount>>, session: &str, cancel: Arc<AtomicBool>, until: Instant,
    scope: &serde_json::Value, operation: impl FnOnce(&dyn crate::wake::HistoryRead, &str)
        -> Result<T, crate::records::Error>) -> Result<(T,HistoryPermit), crate::records::Error> {
        use crate::{account::{NativeAccountOwner, current_browser, current_browser_read_only},
            storage::record_store_resources::domains::Selection};
        use crate::records::Error;
        let input = serde_json::json!({"scope":scope});
        let selected = Selection::from_input(&input)?.ok_or(crate::cause!(Error::Unavailable))?;
        if selected.create { return Err(crate::cause!(Error::Unavailable)); }
        let mut held = crate::workspace_session::owner_wait::acquire_background(owner, || cancel.load(Ordering::Acquire) || Instant::now() >= until)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        held.selection.assert_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let browser=current_browser(&mut held.owner,session).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let account = held.owner.account().owner_id;
        let generation = held.owner.original_records_read_generation().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let bound = held.owner.selected_command_domain(&input,&account,generation).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Unavailable))?;
        let readers = bound.readers()?;
        let physical = held.owner.record_file_check(readers.path().to_owned()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let identity = selected.identity();
        let admitted_selection = held.selection.clone();
        let authority = held.owner.native_domain_authority(&identity,cancel.clone(),until,&mut |owner| {
            admitted_selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
            if !browser.same_as(&current_browser_read_only(owner,session)?) { return Err(crate::cause!(crate::account::AccountError::BrowserInactive)); }
            if owner.account().owner_id != account || owner.original_records_read_generation().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceUnavailable, error))? != generation {
                return Err(crate::cause!(crate::account::AccountError::SourceChanged));
            }
            admitted_selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))
        }).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        drop(held);
        let expected_head=crate::account::computers::copies::current_domain_head(&account,&identity).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let (answer,physical_token,permit) = readers.read_bounded(cancel.clone(),until,|store| {
            if let Some(head)=&expected_head {crate::local_account::own_records::assert_domain_snapshot_head(store.storage(),&account,&identity,head)?;}
            let token=crate::local_account::own_records::domain_authority(&store,&account,&identity)?;
            let permit=authority.hold_native(&token).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            Ok((operation(&store,&account)?,token,permit))
        })?;
        if !readers.read_bounded(cancel.clone(),until,|store| crate::local_account::own_records::domain_authority(&store,&account,&identity).map(|token|token==physical_token))? { return Err(crate::cause!(Error::Conflict)); }
        admitted_selection.assert_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let mut held = crate::workspace_session::owner_wait::acquire_background(owner,||cancel.load(Ordering::Acquire) || Instant::now() >= until)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !Arc::ptr_eq(&admitted_selection,&held.selection) || held.owner.account().owner_id != account { return Err(crate::cause!(Error::Conflict)); }
        if !browser.same_as(&current_browser_read_only(&mut held.owner,session).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?) { return Err(crate::cause!(Error::Unavailable)); }
        held.selection.assert_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if held.owner.original_records_read_generation().map_err(|error| crate::carry_cause!(Error::Unavailable, error))? != generation { return Err(crate::cause!(Error::Conflict)); }
        physical.assert_same_file().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if cancel.load(Ordering::Acquire) || Instant::now() >= until { return Err(crate::cause!(Error::Unavailable)); }
        Ok((answer,HistoryPermit { _native:permit,browser,selection:admitted_selection,cancel }))
}
impl crate::records::Records for WakeStore<'_> {
    fn get(&self, account: &str, resource: &str, id: &str) -> Result<crate::records::Read, crate::records::Error> {
        self.with(|store| store.get(account, resource, id))
    }
    fn mutate(&mut self, account: &str, resource: &str, input: crate::records::Mutation)
        -> Result<crate::records::Change, crate::records::Error> {
        self.with(|store| store.mutate(account, resource, input))
    }
    fn list_page(&self, account: &str, resource: &str, after: &str, limit: usize)
        -> Result<crate::records::Page<crate::records::Record, String>, crate::records::Error> {
        self.with(|store| store.list_page(account, resource, after, limit))
    }
    fn changes_page(&self, account: &str, resource: &str, after: i64, limit: usize)
        -> Result<crate::records::Page<crate::records::Change, i64>, crate::records::Error> {
        self.with(|store| store.changes_page(account, resource, after, limit))
    }
    fn mutate_admitted(&mut self, call: &crate::resource_authority::AdmittedCall, context: &dyn crate::records::CommitContext)
        -> Result<crate::records::Change, crate::records::Error> {
        self.with(|store| store.mutate_admitted(call, context))
    }
}
impl crate::wake::Source for WakeStore<'_> {
    /// One firing of a keep rule of the own store, each step told in the log (the rule's refusal too, with its column).
    fn keep_rule(&mut self, account: &str, resource: &str, rule: &str, now_ms: i64, conditions: &dyn crate::storage::record_store::keep::Conditions)
        -> Result<crate::storage::record_store::keep::Applied, crate::records::Error> {
        use crate::storage::record_store::keep::Applied;
        if resource != crate::local_account::own_records::RESOURCE { return Err(crate::cause!(crate::records::Error::Unavailable)); }
        let applied = self.with(|store| store.keep_rule(account, resource, rule, now_ms, conditions))?;
        match &applied {
            Applied::Stepped(kept) => crate::quiet_eprintln!("{}", kept.line()),
            Applied::Refused(row) => if let Some(line) = row.line() { crate::quiet_eprintln!("{line}") },
            Applied::Idle => {}
        }
        Ok(applied)
    }
    fn scoped_mutate(&mut self, account: &str, resource: &str, scope: Option<&serde_json::Value>, input: crate::records::Mutation)
        -> Result<crate::records::Change,crate::records::Error> {
        use crate::account::{NativeAccountOwner,current_browser,current_browser_read_only};
        use crate::records::Error;
        let Some(scope) = scope else { return self.with(|store| crate::records::Records::mutate(store,account,resource,input)); };
        let until = Instant::now() + crate::legacy_records::Bounds::default().elapsed;
        let selected_input = serde_json::json!({"scope":scope});
        let selected = crate::storage::record_store_resources::domains::Selection::from_input(&selected_input)?.ok_or(crate::cause!(Error::Unavailable))?;
        if selected.create { return Err(crate::cause!(Error::Unavailable)); }
        let mut held = crate::workspace_session::owner_wait::acquire_background(self.owner,||self.cancel.load(Ordering::Acquire) || Instant::now() >= until)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        held.selection.assert_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        current_browser(&mut held.owner,self.session).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if held.owner.account().owner_id != account { return Err(crate::cause!(Error::Conflict)); }
        let generation = held.owner.original_records_read_generation().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let bound = held.owner.selected_command_domain(&selected_input,account,generation).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Unavailable))?;
        let physical = held.owner.record_file_check(bound.readers()?.path().to_owned()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let capture_required = crate::account::computers::copies::running_for(account).is_some();
        let history = serde_json::to_value(selected.identity()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let admitted_selection = held.selection.clone();
        let authority = held.owner.native_domain_authority(&selected.identity(),self.cancel.clone(),until,&mut |owner| {
            admitted_selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
            current_browser_read_only(owner,self.session)?;
            if owner.account().owner_id != account || owner.original_records_read_generation().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceUnavailable, error))? != generation {
                return Err(crate::cause!(crate::account::AccountError::SourceChanged));
            }
            admitted_selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))
        }).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        // Waiting for this resource's writer or for acknowledgement must not
        // retain the account owner and block another domain's admission.
        drop(held);
        crate::local_account::own_records::mutate_internal_checked(&bound,&authority,account,resource,input,self.cancel.clone(),until,capture_required,
            || {
                admitted_selection.assert_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                let mut held = crate::workspace_session::owner_wait::acquire_background(self.owner,||self.cancel.load(Ordering::Acquire) || Instant::now() >= until)
                    .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                if !Arc::ptr_eq(&admitted_selection,&held.selection) { return Err(crate::cause!(Error::Conflict)); }
                current_browser_read_only(&mut held.owner,self.session).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                held.selection.assert_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                if held.owner.account().owner_id != account || held.owner.original_records_read_generation().map_err(|error| crate::carry_cause!(Error::Unavailable, error))? != generation { return Err(crate::cause!(Error::Conflict)); }
                physical.assert_same_file().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                if self.cancel.load(Ordering::Acquire) || Instant::now() >= until { return Err(crate::cause!(Error::Unavailable)); }
                Ok(())
            },
            |storage,frame| crate::account::computers::copies::before_domain_storage_commit(account,storage,&bound,frame).map_err(|error| crate::carry_cause!(Error::Unavailable, error)),
            || crate::records::changes::HeldChanges::begin_in_scope(Some(history)),
            self.budget)
    }
    fn pending_scopes(&self, account: &str, limit: usize) -> Result<Vec<serde_json::Value>,crate::records::Error> {
        use crate::account::{NativeAccountOwner,current_browser,current_browser_read_only};
        use crate::records::Error;
        let until = Instant::now() + crate::legacy_records::Bounds::default().elapsed;
        let mut held = crate::workspace_session::owner_wait::acquire_background(self.owner,||self.cancel.load(Ordering::Acquire) || Instant::now() >= until)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        held.selection.assert_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        current_browser(&mut held.owner,self.session).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if held.owner.account().owner_id != account { return Err(crate::cause!(Error::Conflict)); }
        let generation = held.owner.original_records_read_generation().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let mut inventory = self.inventory.borrow_mut();
        if inventory.active.as_ref().is_none_or(|active|active.generation()!=generation) {
            inventory.active = Some(held.owner.domain_inventory().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?);
            inventory.complete = false;
            inventory.repeat = false;
        }
        let admitted_selection = held.selection.clone();
        drop(held);
        let (histories,done) = match inventory.active.as_mut().ok_or(crate::cause!(Error::Unavailable))?.page(limit,self.cancel.clone(),until) {
            Ok(page) => page,
            Err(error) => { inventory.active=None; inventory.complete=false; return Err(error); }
        };
        inventory.complete = done && !inventory.repeat;
        if done {
            inventory.repeat = false;
            // A completed iterator starts a new bounded sweep on the next
            // request. Quiet optimization decides whether that request is owed.
            inventory.active = None;
        }
        drop(inventory);
        let delivered = (|| {
            admitted_selection.assert_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let mut held = crate::workspace_session::owner_wait::acquire_background(self.owner,||self.cancel.load(Ordering::Acquire) || Instant::now() >= until)
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if !Arc::ptr_eq(&admitted_selection,&held.selection) || held.owner.account().owner_id != account { return Err(crate::cause!(Error::Conflict)); }
            current_browser_read_only(&mut held.owner,self.session).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            held.selection.assert_current().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if held.owner.original_records_read_generation().map_err(|error| crate::carry_cause!(Error::Unavailable, error))? != generation { return Err(crate::cause!(Error::Conflict)); }
            histories.into_iter().map(|history|serde_json::to_value(history).map_err(|error| crate::carry_cause!(Error::Unavailable, error))).collect()
        })();
        if delivered.is_err() {
            // A page whose authority check failed was never delivered. Replay
            // from the start so its durable outboxes cannot fall behind a cursor.
            let mut inventory=self.inventory.borrow_mut();
            inventory.active=None; inventory.complete=false;
        }
        delivered
    }
    fn inventory_current(&self) -> bool { self.inventory.borrow().complete }
    fn invalidate_inventory(&self) {
        let mut inventory = self.inventory.borrow_mut();
        if inventory.complete { inventory.complete = false; }
        else { inventory.repeat = true; }
    }
    fn scoped_record(&self, account: &str, resource: &str, scope: Option<&serde_json::Value>, id: &str)
        -> Result<Option<crate::records::Record>,crate::records::Error> {
        match scope {
            None => self.with(|store|store.current_record(account,resource,id)),
            Some(scope) => self.with_history(scope,|store,owner| {
                if account != owner { return Err(crate::cause!(crate::records::Error::Conflict)); }
                store.record(owner,resource,id)
            }),
        }
    }
    fn scoped_ids(&self, account: &str, resource: &str, scope: Option<&serde_json::Value>, kind: &str, limit: usize)
        -> Result<Vec<String>,crate::records::Error> {
        match scope {
            None => self.with(|store|store.ids_of_kind(account,resource,kind,None,limit).map(|(ids,_)|ids)),
            Some(scope) => self.with_history(scope,|store,owner| {
                if account != owner { return Err(crate::cause!(crate::records::Error::Conflict)); }
                store.ids(owner,resource,kind,limit)
            }),
        }
    }
    fn stamp(&self, account: &str, resource: &str) -> Result<i64, crate::records::Error> {
        self.with(|store| store.stamp(account, resource))
    }
    fn scoped_stamp(&self, account: &str, resource: &str, scope: Option<&serde_json::Value>) -> Result<i64, crate::records::Error> {
        match scope {
            None => self.with(|store| store.stamp(account,resource)),
            Some(scope) => self.with_history(scope,|store,owner| {
                if owner != account { return Err(crate::cause!(crate::records::Error::Conflict)); }
                store.newest(owner,resource)
            }),
        }
    }
    fn scoped_changes_page(&self, account: &str, resource: &str, scope: Option<&serde_json::Value>, after: i64, limit: usize)
        -> Result<crate::records::Page<crate::records::Change,i64>,crate::records::Error> {
        match scope {
            None => self.with(|store| store.changes_page_readonly(account,resource,after,limit)),
            Some(scope) => self.with_history(scope,|store,owner| {
                if owner != account { return Err(crate::cause!(crate::records::Error::Conflict)); }
                store.after(owner,resource,after,limit)
            }),
        }
    }
    fn ids_of_kind(&self, account: &str, resource: &str, kind: &str, before: Option<&str>, limit: usize)
        -> Result<(Vec<String>, Option<String>), crate::records::Error> {
        self.with(|store| store.ids_of_kind(account, resource, kind, before, limit))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_reclaim_step_past_its_bound_halves_the_next_and_one_well_within_doubles_it_up_to_the_most() {
        let (bound, most) = (std::time::Duration::from_millis(10), 1024);
        let at = |ms| std::time::Duration::from_millis(ms);
        assert_eq!(super::next_pages(128, at(25), bound, most), 64);
        assert_eq!(super::next_pages(1, at(25), bound, most), 1, "never below one page");
        assert_eq!(super::next_pages(128, at(2), bound, most), 256);
        assert_eq!(super::next_pages(1000, at(2), bound, most), 1024, "never above the most");
        assert_eq!(super::next_pages(128, at(7), bound, most), 128, "within the bound and not well within it: kept");
    }
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn ended_connection_cancels_preparation_without_relying_on_its_callback() {
        let (started, observe_started) = mpsc::channel();
        let task = supervise(Box::new(move |_, _, _| {
            observe_started.recv_timeout(Duration::from_secs(1)).unwrap();
            Ok(())
        }), move |cancel| {
            started.send(()).unwrap();
            let end = Instant::now() + Duration::from_secs(1);
            while !cancel.load(Ordering::Acquire) && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(1));
            }
            if cancel.load(Ordering::Acquire) { Status::Cancelled } else { Status::Failed }
        });
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(task(runtime.handle().clone(), Arc::new(AtomicBool::new(false)),
            crate::native_host::ResourceConnectionSlot::new()).is_ok());
    }

    #[test]
    fn a_failed_preparation_never_becomes_a_successful_supervised_stop() {
        let task = supervise(Box::new(|_, _, _| Ok(())), |_| Status::Failed);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(task(runtime.handle().clone(), Arc::new(AtomicBool::new(false)),
            crate::native_host::ResourceConnectionSlot::new()).is_err());
    }
}
