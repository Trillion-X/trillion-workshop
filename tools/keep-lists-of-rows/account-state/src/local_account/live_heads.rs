//! Current local workspace heads on one retained selected resource handle.
//!
//! The parent stores exactly one SelectedLiveHeads per LocalAccount. No caller
//! selects a path, generation, revision or told value. The current browser gate
//! supplies actual private-read entitlement; WorkspacePermit retains this local
//! request's resource/cancellation lifetime. Hosted credit reservations are not
//! manufactured for local SQLite work. Only the screen-revision record of the
//! account's record store is written (`workspace_heads`). Logical values/keys
//! still use their canonical bounded readers.
//!
//! The heads transaction (`workspace_heads::LiveHeads::read`) is a read
//! snapshot, taking the write lock only when it reserves the next revision
//! ceiling. The records head (the own-records scope stamp) is read inside that
//! snapshot, so it always describes the records the snapshot holds; the retained
//! writable handle supplies the live revision state. Output
//! stays provisional until current selection/browser/source rechecks, and the
//! same guard checks each physical write and flush. Unknown COMMIT stays poisoned
//! in LiveHeads; this adapter never drops/reopens it to disguise recovery.

use super::{check_sqlite_sidecars, open_regular, Inode, LocalAccount, MAX_JSON};
use crate::{
    account::{self, BrowserAdmission},
    ecma_json::JsString,
    storage::sqlite::{no_follow_path, Access},
    sqlite_work::{ObservedConnection, SuppliedConnection},
    workspace::{WorkspacePermit, WorkspaceSession},
    workspace_heads::{self as heads, Binding, Heads, HeadsRead, LiveHeads, ResourceOwner},
};
use rusqlite::{Connection, OpenFlags};
use std::{
    cell::RefCell,
    fmt,
    fs::File,
    io::{self, Write},
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const RESOURCE: &str = "@own-records";
const DEADLINE: Duration = Duration::from_secs(5);

/// Internal retained identity of a prepared head chunk, not an authorization
/// token. HTTP must recheck it against this SAME selected owner at body poll.
pub(crate) struct DeliveryWitness {
    binding: Binding,
    path: PathBuf,
    inode: Inode,
    handle: usize,
    receipt: String,
    session_id: String,
    account_id: String,
    admitted: BrowserAdmission,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}

/// Private parent-owned state, never constructed afresh for each request.
pub(super) struct SelectedLiveHeads {
    db: SuppliedConnection,
    live: LiveHeads,
    binding: Binding,
    path: PathBuf,
    inode: Inode,
    handle: usize,
    receipt: String,
    data_version: i64,
}
impl fmt::Debug for SelectedLiveHeads {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SelectedLiveHeads([redacted])")
    }
}

fn watch(db: &Connection, permit: &WorkspacePermit, deadline: Instant) {
    let stop = permit.cancellation_flag();
    let steps = Arc::new(AtomicU64::new(0));
    db.progress_handler(
        1000,
        Some(move || {
            stop.load(Ordering::Acquire)
                || Instant::now() >= deadline
                || steps.fetch_add(1000, Ordering::Relaxed) >= 2_000_000
        }),
    );
}
fn physical(db: &Connection, handle: usize, path: &Path, inode: &Inode) -> heads::Result<()> {
    inode.check(path).map_err(|error| crate::carry_cause!(heads::Error::SourceChanged, error))?;
    check_sqlite_sidecars(path).map_err(|error| crate::carry_cause!(heads::Error::SourceChanged, error))?;
    let mut moved = 1_i32;
    // SAFETY: this private retained owner is the sole user of this handle. The
    // static main name and output integer remain valid throughout the call.
    let (actual, readonly, rc) = unsafe {
        (
            db.handle() as usize,
            rusqlite::ffi::sqlite3_db_readonly(db.handle(), b"main\0".as_ptr().cast()),
            rusqlite::ffi::sqlite3_file_control(
                db.handle(),
                c"main".as_ptr(),
                rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
                (&mut moved as *mut i32).cast(),
            ),
        )
    };
    if actual != handle || readonly != 0 || rc != rusqlite::ffi::SQLITE_OK || moved != 0 {
        return Err(crate::cause!(heads::Error::SourceChanged));
    }
    Ok(())
}

struct CurrentRead<'a> {
    owner: &'a mut LocalAccount,
    selection: &'a mut dyn FnMut() -> heads::Result<()>,
    session: &'a WorkspaceSession,
    admitted: BrowserAdmission,
    permit: WorkspacePermit,
    deadline: Instant,
    binding: Binding,
    path: PathBuf,
    inode: Inode,
    handle: usize,
    receipt: String,
    /// The told tail read before the heads transaction (see `sample`).
    sampled: Option<Sampled>,
    initializing: bool,
    initialization_checked: bool,
}
/// The told tail, read through the account's own records before the heads
/// transaction (its logical record is read through the own-records store's own
/// handle on the same file). The records head is never sampled here: it is the
/// own-records stamp read inside the heads transaction's own snapshot.
#[derive(Clone, Copy)]
struct Sampled {
    told: Option<u64>,
}
/// A refused heads read's cause as one closed log word.
fn refusal_word(error: &heads::Error) -> &'static str {
    match error {
        heads::Error::Invalid(_) => "invalid",
        heads::Error::Bounds(_) => "bounds",
        heads::Error::SourceChanged(_) => "source-changed",
        heads::Error::NotAuthorized(_) => "not-authorized",
        heads::Error::Unavailable(_) => "unavailable",
        heads::Error::Unresolved(_) => "unresolved",
        heads::Error::Sql(_, _) => "sql",
    }
}
/// The section of the account's installed record model that names the records the live heads read, and its key for
/// the told list's head record (tools/tell-the-person declares it). No record is named here.
const HEADS_SECTION: &str = "live_heads";
const TOLD_HEAD: &str = "told";

fn sample(owner: &mut LocalAccount, session_id: &str, cancel: Arc<AtomicBool>) -> heads::Result<Sampled> {
    // The told head is the record the installed tools name; with none installed (or none naming it) there is no told
    // list yet, and the told head is absent, as an empty told list's is. A model that refuses refuses the read.
    let model = crate::record_model_policy::installed(owner.state_root()).map_err(|error| crate::carry_cause!(heads::Error::Unavailable, error))?;
    let Some(told_id) = model.named(HEADS_SECTION, TOLD_HEAD).map(str::to_owned) else {
        return Ok(Sampled { told: None });
    };
    let told = owner
        .current_logical_record(session_id, &told_id, Default::default(), cancel)
        .map_err(|error| heads::Error::Unavailable(error.cause()))?;
    let told = heads::told_tail(told.as_ref().map(|record| record.value()))?;
    Ok(Sampled { told })
}
impl CurrentRead<'_> {
    /// The account's own records (record store) open for this source: the store every
    /// head is read from.
    fn check_initial_store(&mut self) -> heads::Result<()> {
        let held = self.owner.take_own_records().map_err(|error| heads::Error::Unavailable(error.cause()))?;
        self.owner.put_own_records(held);
        Ok(())
    }
    fn witness(&self) -> DeliveryWitness {
        DeliveryWitness {
            binding: self.binding.clone(),
            path: self.path.clone(),
            inode: self.inode.clone(),
            handle: self.handle,
            receipt: self.receipt.clone(),
            session_id: self.session.session_id.clone(),
            account_id: self.session.account_id.clone(),
            admitted: self.admitted.clone(),
            cancel: self.permit.cancellation_flag(),
            deadline: self.deadline,
        }
    }
    fn current(&mut self) -> heads::Result<()> {
        if self.permit.cancelled() || Instant::now() >= self.deadline {
            return Err(crate::cause!(heads::Error::NotAuthorized));
        }
        (self.selection)()?;
        self.owner
            .assert_owned()
            .map_err(|error| crate::carry_cause!(heads::Error::SourceChanged, error))?;
        if self.owner.state_identity() != self.receipt
            || self.owner.source.record_book_path.as_ref().map(|book| no_follow_path(book)).as_ref() != Some(&self.path)
            || self.owner.source.account != self.admitted.account
        {
            return Err(crate::cause!(heads::Error::SourceChanged));
        }
        self.inode
            .check(&self.path)
            .map_err(|error| crate::carry_cause!(heads::Error::SourceChanged, error))?;
        check_sqlite_sidecars(&self.path).map_err(|error| crate::carry_cause!(heads::Error::SourceChanged, error))?;
        let current = account::current_browser_read_only(self.owner, &self.session.session_id)
            .map_err(|error| crate::carry_cause!(heads::Error::NotAuthorized, error))?;
        if current.account != self.admitted.account
            || !self.admitted.still()
            || current.account.user_id != self.session.account_id
        {
            return Err(crate::cause!(heads::Error::NotAuthorized));
        }
        (self.selection)()?;
        if self.permit.cancelled() || Instant::now() >= self.deadline {
            return Err(crate::cause!(heads::Error::NotAuthorized));
        }
        Ok(())
    }
}
struct Read<'a>(Rc<RefCell<CurrentRead<'a>>>);
impl ResourceOwner for Read<'_> {
    fn assert_current(&mut self, binding: &Binding, db: &Connection) -> heads::Result<()> {
        let mut read = self.0.try_borrow_mut().map_err(|error| crate::carry_cause!(heads::Error::Unavailable, error))?;
        if binding != &read.binding {
            return Err(crate::cause!(heads::Error::SourceChanged));
        }
        physical(db, read.handle, &read.path, &read.inode)?;
        read.current()?;
        // initialize() first calls this before BEGIN/DDL, so an unsupported
        // source is refused without even attempting setup. It calls again
        // inside its IMMEDIATE transaction before COMMIT; recheck there so a
        // change between preflight and the write lock cannot commit setup for
        // another engine. Only construction probes metadata, never values.
        if read.initializing && !read.initialization_checked {
            read.check_initial_store()?;
            if !db.is_autocommit() {
                read.initialization_checked = true;
            }
        }
        Ok(())
    }
    fn heads(&mut self, binding: &Binding, db: &Connection) -> heads::Result<Heads> {
        self.assert_current(binding, db)?;
        let mut read = self.0.try_borrow_mut().map_err(|error| crate::carry_cause!(heads::Error::Unavailable, error))?;
        // The records head is the own-records stamp read INSIDE the heads
        // transaction, on its own snapshot: it is the stamp of exactly the
        // records that snapshot holds, so no write landing before or during the
        // read can make it disagree with them, and nothing is refused for one.
        // A write that commits after the snapshot began is published on the
        // account's change notifier, so its own chunk and revision follow.
        // The told tail was read just before: a newer told tail is told by
        // that same notifier's next chunk.
        let sampled = read.sampled.ok_or(crate::cause!(heads::Error::Unavailable))?;
        let stamp = crate::workspace_store::lend_store(db, Access::Read)
            .map_err(|error| heads::Error::Unavailable(error.cause()))?
            .stamp(&read.binding.account, super::own_records::RESOURCE)
            .map_err(|error| heads::Error::Unavailable(error.cause()))?;
        let records = (stamp > 0).then(|| JsString::from(stamp.to_string().as_str()));
        let answer = Heads::new(sampled.told, records);
        read.current()?;
        answer
    }
}
impl HeadsRead for Read<'_> {
    fn assert_read(&mut self, binding: &Binding, db: &Connection) -> heads::Result<()> {
        self.assert_current(binding, db)
    }
    fn assert_delivery(&mut self, binding: &Binding) -> heads::Result<()> {
        let mut read = self.0.try_borrow_mut().map_err(|error| crate::carry_cause!(heads::Error::Unavailable, error))?;
        if binding != &read.binding {
            return Err(crate::cause!(heads::Error::SourceChanged));
        }
        read.current()
    }
}

struct CurrentOutput<'a, 'b, W> {
    output: &'b mut W,
    read: Rc<RefCell<CurrentRead<'a>>>,
}
impl<W: Write> Write for CurrentOutput<'_, '_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        crate::io_operation!((self.check()).map_err(std::io::Error::from))?;
        crate::io_operation!(self.output.write(bytes))
    }
    fn flush(&mut self) -> io::Result<()> {
        crate::io_operation!((self.check()).map_err(std::io::Error::from))?;
        crate::io_operation!(self.output.flush())
    }
}
impl<W> CurrentOutput<'_, '_, W> {
    fn check(&self) -> io::Result<()> {
        crate::io_operation!(crate::io_operation!((self.read
            .try_borrow_mut()
            .map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::WouldBlock), _refusal_io_cause) })).map_err(std::io::Error::from))?
            .current()
            .map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::PermissionDenied), _refusal_io_cause) }))
    }
}

impl LocalAccount {
    /// Write a heads reply while retaining current local request rights. The
    /// method returns work only. Private HTTP buffering additionally retains
    /// DeliveryWitness for body-poll checks; an in-memory Write is not delivery.
    pub fn workspace_heads_to(
        &mut self,
        session: &WorkspaceSession,
        permit: WorkspacePermit,
        output: &mut impl Write,
    ) -> heads::Result<heads::Work> {
        self.workspace_heads_to_checked(session, permit, output, &mut || Ok(()))
            .map(|(work, _)| work)
    }
    pub(crate) fn workspace_heads_to_checked(
        &mut self,
        session: &WorkspaceSession,
        permit: WorkspacePermit,
        output: &mut impl Write,
        selection: &mut dyn FnMut() -> heads::Result<()>,
    ) -> heads::Result<(heads::Work, DeliveryWitness)> {
        selection()?;
        if permit.cancelled() {
            return Err(crate::cause!(heads::Error::NotAuthorized));
        }
        let admitted = account::current_browser(self, &session.session_id).map_err(|error| match error {
            crate::account::AccountError::SourceChanged(_) => crate::carry_cause!(heads::Error::SourceChanged, error),
            error => crate::carry_cause!(heads::Error::NotAuthorized, error),
        })?;
        let deadline = Instant::now() + DEADLINE;
        let path = self
            .source
            .record_book_path
            .clone()
            .ok_or(crate::cause!(heads::Error::Unavailable))?;
        self.assert_owned()
            .map_err(|error| crate::carry_cause!(heads::Error::SourceChanged, error))?;
        let mut held = match self.workspace_heads.take() {
            Some(held) => held,
            None => SelectedLiveHeads::open(
                self,
                &path,
                session,
                permit.clone(),
                &admitted,
                selection,
                deadline,
            )?,
        };
        let sampled = match sample(self, &session.session_id, permit.cancellation_flag()) {
            Ok(sampled) => sampled,
            Err(error) => {
                self.workspace_heads = Some(held);
                return Err(error);
            }
        };
        let answer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            watch(&held.db, &permit, deadline);
            let version: i64 = held
                .db
                .query_row("PRAGMA data_version", [], |row| row.get(0))?;
            if version != held.data_version {
                held.live.changed_elsewhere();
                held.data_version = version;
            }
            let context = Rc::new(RefCell::new(CurrentRead {
                owner: self,
                selection,
                session,
                admitted,
                permit,
                deadline,
                binding: held.binding.clone(),
                path: held.path.clone(),
                inode: held.inode.clone(),
                handle: held.handle,
                receipt: held.receipt.clone(),
                sampled: Some(sampled),
                initializing: false,
                initialization_checked: true,
            }));
            let reply = held.live.read(&held.db, Read(context.clone()))?;
            let work = reply.work();
            let delivery = context.clone();
            reply.write_to(&mut CurrentOutput {
                output,
                read: context,
            })?;
            let witness = delivery.try_borrow().map_err(|error| crate::carry_cause!(heads::Error::Unavailable, error))?.witness();
            Ok((work, witness))
        }));
        held.db.progress_handler(0, None::<fn() -> bool>);
        if let Ok(Err(error)) = &answer {
            // One named line per refused heads read (the Mac app copies it into its log). Nothing of the account is
            // written.
            crate::quiet_eprintln!("native-heads-read-refused code={} cause={}", refusal_word(error), error.cause());
        }
        // Preserve LiveHeads' unresolved-COMMIT state even when this read fails.
        self.workspace_heads = Some(held);
        match answer {
            Ok(answer) => answer,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    pub(crate) fn workspace_heads_delivery_current_checked(
        &mut self,
        session: &WorkspaceSession,
        permit: &WorkspacePermit,
        witness: &DeliveryWitness,
        selection: &mut dyn FnMut() -> heads::Result<()>,
    ) -> heads::Result<()> {
        if session.session_id != witness.session_id
            || session.account_id != witness.account_id
            || !Arc::ptr_eq(&permit.cancellation_flag(), &witness.cancel)
        {
            return Err(crate::cause!(heads::Error::NotAuthorized));
        }
        let held = self
            .workspace_heads
            .as_ref()
            .ok_or(crate::cause!(heads::Error::SourceChanged))?;
        if held.binding != witness.binding
            || held.handle != witness.handle
            || held.path != witness.path
            || held.inode != witness.inode
            || held.receipt != witness.receipt
        {
            return Err(crate::cause!(heads::Error::SourceChanged));
        }
        physical(&held.db, held.handle, &held.path, &held.inode)?;
        CurrentRead {
            owner: self,
            selection,
            session,
            admitted: witness.admitted.clone(),
            permit: permit.clone(),
            deadline: witness.deadline,
            binding: witness.binding.clone(),
            path: witness.path.clone(),
            inode: witness.inode.clone(),
            handle: witness.handle,
            receipt: witness.receipt.clone(),
            sampled: None,
            initializing: false,
            initialization_checked: true,
        }
        .current()
    }
}

/// The record book's open file and identity, held by its canonical path (`no_follow_path`: the folder above the name is
/// resolved). The identity checks compare that same path on both sides, so a folder swapped for a link is refused.
fn open_record_book(path: &Path) -> heads::Result<(PathBuf, File, Inode)> {
    let path = no_follow_path(path);
    let (file, inode) = open_regular(&path).map_err(|error| crate::carry_cause!(heads::Error::Unavailable, error))?;
    check_sqlite_sidecars(&path).map_err(|error| crate::carry_cause!(heads::Error::Unavailable, error))?;
    Ok((path, file, inode))
}

impl SelectedLiveHeads {
    fn open(
        owner: &mut LocalAccount,
        path: &PathBuf,
        session: &WorkspaceSession,
        permit: WorkspacePermit,
        admitted: &BrowserAdmission,
        selection: &mut dyn FnMut() -> heads::Result<()>,
        deadline: Instant,
    ) -> heads::Result<Self> {
        let (path, _file, inode) = open_record_book(path)?;
        // READ_WRITE without CREATE: never bootstrap a replacement resource.
        let db = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        let handle = unsafe { db.handle() as usize };
        physical(&db, handle, &path, &inode)?;
        // SAFETY: this freshly opened, privately retained connection has no
        // trace callback or prepared statements. The wrapper owns its meter.
        let db = SuppliedConnection::from(
            unsafe { ObservedConnection::attach_untraced(db, owner.source.sql_work.clone()) }
                .map_err(|error| crate::carry_cause!(heads::Error::Unavailable, error))?,
        );
        watch(&db, &permit, deadline);
        db.busy_timeout(Duration::ZERO)?;
        db.pragma_update(None, "trusted_schema", false)?;
        db.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            MAX_JSON as i32,
        );
        let receipt = owner.state_identity().to_owned();
        // A local physical incarnation, derived by this actual owner. It is
        // not a substitute for a signed network resource generation/grant.
        let generation = content_crypto::advanced::blake3::hash(
            &serde_json::to_vec(&(&receipt, inode.dev, inode.ino)).map_err(|error| crate::carry_cause!(heads::Error::Unavailable, error))?,
        )
        .to_hex()
        .to_string();
        let binding = Binding::new(&owner.source.account.owner_id, RESOURCE, &generation)?;
        let sampled = sample(owner, &session.session_id, permit.cancellation_flag())?;
        let context = Rc::new(RefCell::new(CurrentRead {
            owner,
            selection,
            session,
            admitted: admitted.clone(),
            permit,
            deadline,
            binding: binding.clone(),
            path: path.clone(),
            inode: inode.clone(),
            handle,
            receipt: receipt.clone(),
            sampled: Some(sampled),
            initializing: true,
            initialization_checked: false,
        }));
        let live = LiveHeads::attach(binding.clone(), &db, &mut Read(context))?;
        let data_version = db.query_row("PRAGMA data_version", [], |row| row.get(0))?;
        Ok(Self {
            db,
            live,
            binding,
            path: path.clone(),
            inode,
            handle,
            receipt,
            data_version,
        })
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;
    use std::fs;

    #[test]
    fn a_record_book_behind_a_linked_folder_is_held_by_its_canonical_path_and_a_swapped_file_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let real = fs::canonicalize(temp.path()).unwrap().join("real");
        fs::create_dir(&real).unwrap();
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let book = real.join("records.sqlite");
        Connection::open(&book).unwrap().close().unwrap();

        let (held, _file, inode) = open_record_book(&link.join("records.sqlite")).unwrap();
        assert_eq!(held, book, "the open holds the canonical path, the one the identity checks compare on both sides");
        inode.check(&held).unwrap();

        let other = real.join("other.sqlite");
        Connection::open(&other).unwrap().close().unwrap();
        fs::rename(&other, &book).unwrap();
        assert!(inode.check(&held).is_err(), "a file swapped behind the held name is refused");
    }
}
