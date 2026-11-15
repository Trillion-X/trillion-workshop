//! Selected workspace store preparation/delivery: the record store resource `workspace`
//! of the account's own record store, read under the current browser check.
//! A read answers from its own consistent read transaction, which is its delivery (`Delivery::Snapshot`): a commit
//! that lands after it began does not withdraw it. A caller whose answer must also be current with the file at the
//! chunk (`Delivery::Fresh`: a description built from saved points beside the records) has the RECORD_BOOK check
//! (`BookCheck`) prove no commit to that file between the read and the delivery. Either way the check proves the file
//! is still the one the read began on; it claims nothing about other files or key stores.
pub(crate) mod personal;

use super::{check_sqlite_sidecars, CurrentSqlite, Inode, LocalAccount};
use crate::{
    account::{self, AccountError, AccountResult, BrowserAdmission},
    sqlite_work::SuppliedConnection,
    workspace::{WorkspacePermit, WorkspaceSession},
    workspace_store::{Failure, Kind, Limits, Page, Reader, Selection, Snapshot, Source},
};
use std::{
    cell::RefCell,
    fmt,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use zeroize::Zeroizing;

/// The read's live check: not cancelled, inside its deadline, and the account
/// still owned. The browser check is made by each caller before and after the read.
struct Live<'a> {
    owner: RefCell<&'a mut LocalAccount>,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl Source for Live<'_> {
    fn assert_current(&self) -> Result<(), Kind> {
        if self.cancel.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            return Err(crate::cause!(Kind::Cancelled));
        }
        let owner = self.owner.try_borrow().map_err(|error| crate::carry_cause!(Kind::SourceUnavailable, error))?;
        owner.assert_owned().map_err(|error| Kind::SourceChanged(error.cause()))
    }
}

/// What a delivery requires of the record book after its read: a `Snapshot` answers from the consistent read it
/// made, whatever committed after it; a `Fresh` delivery is withheld by any commit to the file since it began.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Delivery {
    Snapshot,
    Fresh,
}
/// The account's RECORD_BOOK file as a delivery saw it: a readonly handle, its path, inode and `data_version`. A
/// replacement of the file, even with identical bytes, or a sidecar that should not be there withholds every
/// delivery (`assert_same_file`). A commit to the file by another connection (the workspace store, or the other
/// families a delivery depends on, such as a saved workshop point) withholds a `Fresh` one (`assert_unchanged`). No
/// record is read again.
pub(crate) struct BookCheck {
    db: SuppliedConnection,
    path: PathBuf,
    inode: Inode,
    version: i64,
}
fn data_version(db: &SuppliedConnection) -> AccountResult<i64> {
    // PRAGMA outside a held transaction refreshes this connection's view of
    // other connections' commits; inside one it would not.
    if !db.is_autocommit() {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    crate::storage::sqlite::data_version(db).map_err(|error| AccountError::SourceUnavailable(error.cause()))
}
impl BookCheck {
    pub(crate) fn assert_same_file(&self) -> AccountResult<()> {
        self.inode.check(&self.path)?;
        check_sqlite_sidecars(&self.path)
    }
    pub(crate) fn assert_unchanged(&self) -> AccountResult<()> {
        self.assert_same_file()?;
        if data_version(&self.db)? != self.version {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        Ok(())
    }
    /// The check `delivery` requires.
    pub(crate) fn assert_delivery(&self, delivery: Delivery) -> AccountResult<()> {
        match delivery {
            Delivery::Snapshot => self.assert_same_file(),
            Delivery::Fresh => self.assert_unchanged(),
        }
    }
}

impl LocalAccount {
    /// Open the delivery check on the selected RECORD_BOOK before its read.
    pub(crate) fn record_book_check(&self) -> AccountResult<BookCheck> {
        let path = self.source.record_book_path.clone().ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        self.record_file_check(path)
    }
    /// Retain physical custody for the file selected by an admitted resource
    /// binding. Opening this witness neither creates nor grants a resource.
    pub(crate) fn record_file_check(&self, path: PathBuf) -> AccountResult<BookCheck> {
        let CurrentSqlite { connection, path, inode, .. } =
            CurrentSqlite::open_with_meter(path, self.source.sql_work.clone())?;
        let version = data_version(&connection)?;
        Ok(BookCheck { db: connection, path, inode, version })
    }
    /// One read of the workspace store, bounded by `deadline`.
    pub(super) fn read_workspace_store(
        &mut self,
        selection: Option<&Selection>,
        page: Option<&Page>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<Snapshot, Failure> {
        let held = self.take_own_records().map_err(|error| Failure::new(Kind::SourceUnavailable(error.cause()), Default::default()))?;
        let mut limits = Limits::default();
        limits.elapsed = limits
            .elapsed
            .min(deadline.saturating_duration_since(Instant::now()));
        let read = {
            let (store, account) = held.store();
            let live = Live { owner: RefCell::new(&mut *self), cancel: cancel.clone(), deadline };
            Reader::new(store, account, live, limits).and_then(|reader| reader.read_checked(selection, page, cancel))
        };
        self.put_own_records(held);
        read
    }
    /// Read the workspace store with current browser check held across the
    /// read (checked before and after; a change between refuses the snapshot).
    pub fn workspace_snapshot(
        &mut self,
        session_id: &str,
        selection: Option<&Selection>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Snapshot, Failure> {
        let refused = |kind| Failure::new(kind, Default::default());
        let admitted = account::current_browser(self, session_id)
            .map_err(|error| refused(Kind::SourceUnavailable(error.cause())))?;
        let deadline = Instant::now() + Limits::default().elapsed;
        let snapshot = self.read_workspace_store(selection, None, cancel, deadline)?;
        match account::current_browser_read_only(self, session_id) {
            Ok(now)
                if now.account == admitted.account
                    && now.same_as(&admitted) =>
            {
                Ok(snapshot)
            }
            _ => Err(Failure::new(crate::cause!(Kind::SourceChanged), snapshot.work)),
        }
    }
}

pub(crate) struct RecordDeliveryWitness {
    book: BookCheck,
    delivery: Delivery,
    receipt: String,
    admitted: BrowserAdmission,
    session_id: Zeroizing<String>,
    account_id: String,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl fmt::Debug for RecordDeliveryWitness {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordDeliveryWitness([redacted])")
    }
}
/// What a read of the workspace store was admitted under (`LocalAccount::admit_workspace_store`) and the read-only
/// handles it reads through: it holds no account owner while it reads.
pub(crate) struct WorkspaceStoreAdmission {
    admitted: BrowserAdmission,
    receipt: String,
    book: BookCheck,
    store: StoreRead,
    defaults: Defaults,
}
/// The read-only handles of the account's own records file and the account they read: what a read of the workspace
/// store goes through while it holds no account owner.
pub(crate) struct StoreRead {
    readers: Arc<crate::storage::record_store_resources::Readers>,
    owner_id: String,
}
/// The read's own live check: not cancelled and inside its deadline. The account's check is checked by the
/// caller before and after the read (`finish_workspace_store`).
struct Window {
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl Source for Window {
    fn assert_current(&self) -> Result<(), Kind> {
        if self.cancel.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            return Err(crate::cause!(Kind::Cancelled));
        }
        Ok(())
    }
}
impl WorkspaceStoreAdmission {
    /// The live socket's id reads (src/native_entry/live.rs `LiveIds`: a scope's catch-up and a window's newest ids),
    /// in one read transaction on a read-only handle of the account's file, under this admission. They answer ids
    /// and numbers only, never a value.
    pub(crate) fn with_live_ids<T>(&self, read: impl FnOnce(&dyn crate::native_entry::live::LiveIds) -> T) -> Result<T, Failure> {
        let account = self.store.owner_id.clone();
        self.store
            .readers
            .read(|store| Ok::<_, crate::records::Error>(read(&crate::native_entry::live::StoreIds { store: &store, account: &account })))
            .map_err(|error| Failure::new(Kind::SourceUnavailable(error.cause()), Default::default()))
    }

    /// One read of the workspace store (`StoreRead::read`).
    pub(crate) fn read(
        &self,
        asked: Option<&Selection>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<Snapshot, Failure> {
        let snapshot = self.store.read(asked, None, cancel, deadline)?;
        Ok(self.defaults.laid_under(asked, None, snapshot))
    }
}
impl LocalAccount {
    /// The read-only handles of the selected account's records file and its id, for a read that holds no owner. The
    /// caller admits the read before and checks the browser check again after it.
    pub(crate) fn store_read(&mut self) -> AccountResult<StoreRead> {
        let readers = match &self.store_readers {
            Some(readers) => readers.clone(),
            None => {
                let path = self.source.record_book_path.clone().ok_or(crate::cause!(AccountError::SourceUnavailable))?;
                let opened = Arc::new(crate::storage::record_store_resources::Readers::new(path, self.source.sql_work.clone()));
                self.store_readers = Some(opened.clone());
                opened
            }
        };
        Ok(StoreRead { readers, owner_id: crate::account::NativeAccountOwner::account(self).owner_id })
    }
}
impl StoreRead {
    /// Whether `self` and `other` are handles of the same file.
    pub(crate) fn same_file(&self, other: &StoreRead) -> bool {
        self.readers.path() == other.readers.path()
    }
    /// One read of the workspace store in one read transaction on a read-only handle of the account's file, bounded by
    /// `deadline`: no account owner is held and no writer of the file is waited on.
    pub(crate) fn read(
        &self,
        selection: Option<&Selection>,
        page: Option<&Page>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<Snapshot, Failure> {
        let mut limits = Limits::default();
        limits.elapsed = limits.elapsed.min(deadline.saturating_duration_since(Instant::now()));
        let window = Window { cancel: cancel.clone(), deadline };
        self.readers
            .read(|store| {
                Ok::<_, crate::records::Error>(
                    Reader::new(&store, &self.owner_id, window, limits)
                        .and_then(|reader| reader.read_checked(selection, page, cancel)),
                )
            })
            .map_err(|error| Failure::new(Kind::SourceUnavailable(error.cause()), Default::default()))?
    }
}
impl RecordDeliveryWitness {
    pub(crate) fn expired(&self) -> bool {
        self.cancel.load(Ordering::Acquire) || Instant::now() >= self.deadline
    }
}
fn same_session(admission: &BrowserAdmission, session: &WorkspaceSession) -> AccountResult<()> {
    if admission.account.user_id != session.account_id || !admission.still() {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    Ok(())
}
/// `failure`, after naming on stderr the check that found the change (never a value, label or key).
fn named_change(check: &'static str, failure: Failure) -> Failure {
    crate::quiet_eprintln!("native-records-read-refused stage=finish-check check={check} cause={}", failure.cause());
    failure
}
impl LocalAccount {
    /// Admit one read of the workspace store for `session`: the browser check, the account's state identity and
    /// the delivery check of its record book are taken here, under the owner. The read itself
    /// (`WorkspaceStoreAdmission::read`) holds no owner; `finish_workspace_store` checks every one of them again.
    pub(crate) fn admit_workspace_store(
        &mut self,
        session: &WorkspaceSession,
        permit: &WorkspacePermit,
        deadline: Instant,
    ) -> Result<WorkspaceStoreAdmission, Failure> {
        let failure = |kind| Failure::new(kind, Default::default());
        if permit.cancelled() || Instant::now() >= deadline {
            return Err(failure(crate::cause!(Kind::Cancelled)));
        }
        let admitted = account::current_browser(self, &session.session_id)
            .map_err(|error| failure(Kind::SourceChanged(error.cause())))?;
        same_session(&admitted, session).map_err(|error| failure(Kind::SourceChanged(error.cause())))?;
        let receipt = self.state_identity().to_owned();
        let book = self.record_book_check().map_err(|error| failure(Kind::SourceUnavailable(error.cause())))?;
        let store = self.store_read().map_err(|error| failure(Kind::SourceUnavailable(error.cause())))?;
        let defaults = Defaults::published(self.state_root());
        Ok(WorkspaceStoreAdmission { admitted, receipt, book, store, defaults })
    }
    /// The browser check still holds after the read of `snapshot`: the same browser check, the same owned account,
    /// the same state identity and an unchanged record book. The witness it returns is the delivery's.
    pub(crate) fn finish_workspace_store(
        &mut self,
        session: &WorkspaceSession,
        permit: &WorkspacePermit,
        admission: WorkspaceStoreAdmission,
        snapshot: Snapshot,
        deadline: Instant,
        delivery: Delivery,
    ) -> Result<(Snapshot, RecordDeliveryWitness), Failure> {
        let WorkspaceStoreAdmission { admitted, receipt, book, store, .. } = admission;
        let now = match account::current_browser_read_only(self, &session.session_id) {
            Ok(now) => now,
            Err(error) => return Err(named_change("browser-session",
                Failure::new(Kind::SourceChanged(error.cause()), snapshot.work))),
        };
        let (same_readers, readers_cause) = match self.store_read() {
            Ok(current) => (current.same_file(&store), None),
            Err(error) => (false, Some(error.cause())),
        };
        // Each changed fact keeps its own source condition; tracked owner
        // failures keep the original owner's cause through this reclassification.
        let moved = if now.account != admitted.account {
            Some(("browser-account", crate::cause!()))
        } else if !now.same_as(&admitted) {
            Some(("browser-session", crate::cause!()))
        } else if let Err(error) = self.assert_owned() {
            Some(("account-not-owned", error.cause()))
        } else if self.state_identity() != receipt {
            Some(("state-identity", crate::cause!()))
        } else if !same_readers {
            Some(("record-book-file", readers_cause.unwrap_or_else(|| crate::cause!())))
        } else if let Err(error) = book.assert_delivery(delivery) {
            Some(("record-book-fence", error.cause()))
        } else {
            None
        };
        if let Some((check, cause)) = moved {
            return Err(named_change(check, Failure::new(Kind::SourceChanged(cause), snapshot.work)));
        }
        let witness = RecordDeliveryWitness {
            book,
            delivery,
            receipt,
            admitted,
            session_id: Zeroizing::new(session.session_id.clone()),
            account_id: session.account_id.clone(),
            cancel: permit.cancellation_flag(),
            deadline,
        };
        if witness.expired() {
            return Err(Failure::new(crate::cause!(Kind::Cancelled), snapshot.work));
        }
        Ok((snapshot, witness))
    }
    pub(crate) fn workspace_store_delivery_current(
        &mut self,
        session: &WorkspaceSession,
        permit: &WorkspacePermit,
        witness: &RecordDeliveryWitness,
        selection_check: &dyn Fn() -> AccountResult<()>,
    ) -> AccountResult<()> {
        selection_check()?;
        if witness.expired()
            || permit.cancelled()
            || !Arc::ptr_eq(&permit.cancellation_flag(), &witness.cancel)
            || session.session_id != witness.session_id.as_str()
            || session.account_id != witness.account_id
        {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        self.assert_owned()?;
        if self.state_identity() != witness.receipt {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        let current = account::current_browser_read_only(self, &session.session_id)?;
        same_session(&current, session)?;
        if current.account != witness.admitted.account
            || !witness.admitted.still()
        {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        selection_check()?;
        witness.book.assert_delivery(witness.delivery)?;
        if witness.expired() {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        Ok(())
    }
}

/// Trillion's defaults as a delivery read lays them under the person's own records: the published default of each
/// record (the default publisher's rows in the account's installed tools, src/tool_runs/tools/shipped_defaults.rs), read
/// once when the read is admitted (under the owner) and laid under after it, holding none.
///
/// Only the person's own delivery reads lay them under (the page's workspace store read, the live feed and the
/// personal-key read of AIs and apps). A read whose records feed a write, the operator's publication or another
/// account's share read the store as it is, so a default is never written into a store or published as a person's own.
/// The records a read asks for (labels, then prefixes), as the store's reader takes them.
type Asked = Selection;
#[derive(Default)]
pub(crate) struct Defaults {
    published: std::collections::BTreeMap<String, crate::ecma_json::Value>,
}
/// Where a label stands in a read's order: the asked labels in their asked order, then every id the read walks
/// (each prefix's, or every id) ascending.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    Named(usize),
    Walked(String),
}
fn rank(asked: Option<&Asked>, label: &str) -> Option<Rank> {
    match asked {
        None => Some(Rank::Walked(label.to_owned())),
        Some(asked) => match asked.labels.iter().position(|named| named == label) {
            Some(at) => Some(Rank::Named(at)),
            None => asked
                .prefixes
                .iter()
                .any(|prefix| label.starts_with(prefix.as_str()))
                .then(|| Rank::Walked(label.to_owned())),
        },
    }
}
impl Defaults {
    /// The defaults the account's installed tools publish now; none when it has none installed.
    pub(crate) fn published(state_root: &std::path::Path) -> Self {
        Self { published: crate::tool_runs::tools::shipped_defaults::published(state_root) }
    }
    /// `snapshot` with each published default the read selects laid under the person's record of its label
    /// (src/records/shipped_defaults.rs `lay_under`: what the person keeps wins). A selected default with no record of
    /// the person's is read as its shipped fields, where it falls in the read's order, when it falls inside this page:
    /// after the page's `after` and no later than its `next`. A record of theirs that is not an object is theirs as it
    /// is. Nothing is written, and `next`, the work and the byte counts stay the store's.
    pub(crate) fn laid_under(&self, asked: Option<&Asked>, page: Option<&Page>, mut snapshot: Snapshot) -> Snapshot {
        use crate::ecma_json::Value;
        if self.published.is_empty() {
            return snapshot;
        }
        let after = page.and_then(|page| page.after.as_deref()).and_then(|after| rank(asked, after));
        let next = snapshot.next.as_deref().and_then(|next| rank(asked, next));
        for (label, row) in &self.published {
            let Some(at) = rank(asked, label) else { continue };
            match snapshot.records.iter_mut().find(|(kept, _)| kept == label) {
                Some((_, value)) => {
                    if matches!(value, Value::Object(_)) {
                        if let Some(laid) = crate::records::shipped_defaults::lay_under(row, Some(value)) {
                            *value = laid;
                        }
                    }
                }
                None => {
                    let in_page = after.as_ref().is_none_or(|after| at > *after)
                        && (snapshot.next.is_none() || next.as_ref().is_some_and(|next| at <= *next));
                    if !in_page {
                        continue;
                    }
                    let Some(laid) = crate::records::shipped_defaults::lay_under(row, None) else { continue };
                    let index = snapshot
                        .records
                        .iter()
                        .position(|(kept, _)| rank(asked, kept).is_some_and(|kept| kept > at))
                        .unwrap_or(snapshot.records.len());
                    snapshot.records.insert(index, (label.clone(), laid));
                }
            }
        }
        snapshot
    }
}

#[cfg(test)]
mod defaults_tests {
    use super::*;
    use crate::ecma_json::{self, Value};

    fn json(raw: &str) -> Value {
        ecma_json::parse(raw.as_bytes(), Default::default()).unwrap()
    }
    fn show(value: &Value) -> String {
        ecma_json::stringify(value, Default::default()).unwrap()
    }
    fn defaults() -> Defaults {
        let row = json(r#"{"kind":"shipped-default","record":"show-rules","merge":{"by_id":["types"],"switched":[{"field":"in_use","off_in":"starting"}]},"value":{"types":[{"id":"simple"}],"in_use":["simple"]}}"#);
        Defaults { published: [("show-rules".to_owned(), row)].into_iter().collect() }
    }
    fn snapshot(records: &[(&str, &str)], next: Option<&str>) -> Snapshot {
        Snapshot {
            records: records.iter().map(|(label, value)| (label.to_string(), json(value))).collect(),
            input_bytes: 7,
            expanded_bytes: 9,
            next: next.map(str::to_owned),
            work: Default::default(),
        }
    }
    fn labels(snapshot: &Snapshot) -> Vec<&str> {
        snapshot.records.iter().map(|(label, _)| label.as_str()).collect()
    }
    fn value(snapshot: &Snapshot, label: &str) -> String {
        show(&snapshot.records.iter().find(|(kept, _)| kept == label).unwrap().1)
    }

    #[test]
    fn a_blank_account_reads_the_default_where_it_falls_in_every_read_that_asks_for_it() {
        let every = defaults().laid_under(None, None, snapshot(&[("note:a", "{}"), ("tray", "{}")], None));
        assert_eq!(labels(&every), ["note:a", "show-rules", "tray"]);
        assert_eq!(value(&every, "show-rules"), r#"{"types":[{"id":"simple"}],"in_use":["simple"]}"#);
        assert_eq!((every.input_bytes, every.expanded_bytes, every.next.as_deref()), (7, 9, None));
        let named = Asked { labels: vec!["tray".into(), "show-rules".into(), "wake".into()], prefixes: vec![] };
        let read = defaults().laid_under(Some(&named), None, snapshot(&[("tray", "{}"), ("wake", "{}")], None));
        assert_eq!(labels(&read), ["tray", "show-rules", "wake"]);
        let prefixed = Asked { labels: vec![], prefixes: vec!["show-".into()] };
        assert_eq!(labels(&defaults().laid_under(Some(&prefixed), None, snapshot(&[], None))), ["show-rules"]);
    }

    #[test]
    fn a_read_that_does_not_select_it_or_a_page_it_is_not_in_does_not_get_it() {
        let other = Asked { labels: vec!["tray".into()], prefixes: vec!["note:".into()] };
        assert_eq!(labels(&defaults().laid_under(Some(&other), None, snapshot(&[("tray", "{}")], None))), ["tray"]);
        // A page that ends before it, and the page after the one that held it.
        let first = defaults().laid_under(None, Some(&Page::default()), snapshot(&[("note:a", "{}")], Some("note:a")));
        assert_eq!(labels(&first), ["note:a"]);
        let later = Page { after: Some("tray".into()), bytes: 0 };
        assert_eq!(labels(&defaults().laid_under(None, Some(&later), snapshot(&[("wake", "{}")], None))), ["wake"]);
        // The page whose range holds it.
        let middle = Page { after: Some("note:a".into()), bytes: 0 };
        let read = defaults().laid_under(None, Some(&middle), snapshot(&[("tray", "{}")], Some("tray")));
        assert_eq!(labels(&read), ["show-rules", "tray"]);
        assert_eq!(read.next.as_deref(), Some("tray"));
    }

    #[test]
    fn the_persons_record_wins_and_a_switched_off_default_stays_off() {
        let kept = r#"{"types":[{"id":"mine"}],"in_use":["mine"],"starting":{"simple":{"on":false}},"theme":"dark"}"#;
        let read = defaults().laid_under(None, None, snapshot(&[("show-rules", kept)], None));
        assert_eq!(
            value(&read, "show-rules"),
            r#"{"types":[{"id":"simple"},{"id":"mine"}],"in_use":["mine"],"starting":{"simple":{"on":false}},"theme":"dark"}"#
        );
        // A record of theirs that is not an object is theirs as it is.
        let read = defaults().laid_under(None, None, snapshot(&[("show-rules", "null")], None));
        assert_eq!(value(&read, "show-rules"), "null");
        // No defaults installed: the snapshot as the store read it.
        let none = Defaults::default().laid_under(None, None, snapshot(&[("tray", "{}")], None));
        assert_eq!(labels(&none), ["tray"]);
    }
}
