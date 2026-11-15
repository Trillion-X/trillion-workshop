// Purpose: The selected state's startup lock: `local-runtime.lock`, held under `flock` for the owner's whole life.
// Invariants: the kernel releases the lock when the process holding it exits in any way (clean exit, crash,
// kill), so a held lock is a live owner and a free one has none, whatever record the file still carries. The
// record (pid, token, birth, receipt) names the process that held it, for a message only; a free lock with any
// record (a dead process, a reused pid, a record cut short by a crash) is taken over where it is, with one log
// line. Two checks stay beside the lock: a prior incarnation the opened account names that is still alive, and a
// record whose exact incarnation is alive (a trillion-local
// from before the held lock, which never took it), both refuse. No account authority is created here; the
// ordinary account constructor still checks the selected sources after the claim. Every cooperating Rust
// claimant holds the directory transition lock through the claim. Advisory locks do not confine a malicious or
// noncooperating same-UID filesystem writer.

use super::{pinned_bytes, AccountError, AccountResult, FilePin, Inode, ProcessIdentity, MAX_JSON};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    ops::{Deref, DerefMut},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use zeroize::{Zeroize, Zeroizing};
use crate::tool_runs::os::{Lock, Open, OwnerFiles, This};

const MAX_LOCK: usize = 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    pid: u32,
    token: String,
    #[serde(default)]
    started_seconds: Option<u64>,
    #[serde(default)]
    started_fraction: Option<u64>,
    #[serde(default)]
    receipt_identity: Option<String>,
}
impl Drop for Record {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
impl Record {
    fn parse(bytes: &[u8]) -> AccountResult<Self> {
        let row: Self = serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if !crate::records::process_identity::observable(row.pid)
            || row.token.is_empty()
            || row.token.len() > 128
            || row.token.chars().any(char::is_control)
        {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        Ok(row)
    }
    fn birth(&self, receipt: &FilePin) -> AccountResult<Option<ProcessIdentity>> {
        match (
            self.started_seconds,
            self.started_fraction,
            self.receipt_identity.as_deref(),
        ) {
            (None, None, None) => Ok(None),
            (Some(seconds), Some(fraction), Some(identity))
                if seconds > 0 && fraction < 1_000_000 && identity == receipt.blake3 =>
            {
                Ok(Some(ProcessIdentity {
                    pid: self.pid,
                    started_seconds: seconds,
                    started_fraction: fraction,
                }))
            }
            _ => Err(crate::cause!(AccountError::SourceChanged)),
        }
    }
    /// The process incarnation the record names, whatever state it was bound to.
    fn incarnation(&self) -> Option<ProcessIdentity> {
        Some(ProcessIdentity {
            pid: self.pid,
            started_seconds: self.started_seconds?,
            started_fraction: self.started_fraction?,
        })
    }
}
/// The pid a lock file's record names, for the one log line; never its token.
fn lock_owner_pid(row: Option<&Record>) -> String {
    row.map_or_else(|| "unreadable".into(), |row| row.pid.to_string())
}

/// Non-secret incarnation/state binding added to the SAME pid/token record.
/// The existing state lock owner remains responsible for generating its token.
pub(super) struct OwnerBinding {
    pid: u32,
    birth: ProcessIdentity,
    receipt: String,
}
impl OwnerBinding {
    pub(super) fn bind(&self, record: &mut Value) -> AccountResult<()> {
        let row = record.as_object_mut().ok_or(crate::cause!(AccountError::InvalidInput))?;
        if row.len() != 2
            || row.get("pid").and_then(Value::as_u64) != Some(u64::from(self.pid))
            || !row
                .get("token")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty() && v.len() <= 128)
        {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        row.insert("started_seconds".into(), self.birth.started_seconds.into());
        row.insert(
            "started_fraction".into(),
            self.birth.started_fraction.into(),
        );
        row.insert("receipt_identity".into(), self.receipt.clone().into());
        Ok(())
    }
}

// Closing this open file number alone does not release flock while a fork/dup still
// references the same open-file description. Explicitly unlock when OUR guard
// ends; inherited open file numbers never inherit custody of this transition.
// The flag is atomic so the state lock is Sync: the account owner that keeps it is shared across threads.
struct AdvisoryFile {
    file: File,
    locked: AtomicBool,
}
impl AdvisoryFile {
    fn new(file: File) -> Self {
        Self {
            file,
            locked: AtomicBool::new(false),
        }
    }
    /// Takes the exclusive lock without waiting: false when another open file holds it.
    fn try_lock(&self) -> AccountResult<bool> {
        let taken = This::lock(&self.file, Lock::Try).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if taken {
            self.locked.store(true, Ordering::Release);
        }
        Ok(taken)
    }
    fn lock(&self) -> AccountResult<()> {
        if self.try_lock()? {
            Ok(())
        } else {
            Err(crate::cause!(AccountError::SourceUnavailable))
        }
    }
}
impl Deref for AdvisoryFile {
    type Target = File;
    fn deref(&self) -> &File {
        &self.file
    }
}
impl DerefMut for AdvisoryFile {
    fn deref_mut(&mut self) -> &mut File {
        &mut self.file
    }
}
impl Drop for AdvisoryFile {
    fn drop(&mut self) {
        if self.locked.load(Ordering::Acquire) {
            let _ = This::lock(&self.file, Lock::Release);
        }
    }
}

struct Directory {
    path: PathBuf,
    file: AdvisoryFile,
    inode: Inode,
    mode: u32,
}
impl Directory {
    fn open(path: &Path) -> AccountResult<Self> {
        let file = This::open(OpenOptions::new().read(true), path,
            Open { folder: true, no_follow: true, ..Open::default() })
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let m = file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let facts = This::facts(&m).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if !m.is_dir() || facts.owner != This::this_owner().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))? || facts.mode & 0o022 != 0 {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        let this = Self {
            path: path.into(),
            file: AdvisoryFile::new(file),
            inode: Inode::of(&m)?,
            mode: facts.mode,
        };
        this.check()?;
        Ok(this)
    }
    fn check(&self) -> AccountResult<()> {
        let named = std::fs::symlink_metadata(&self.path).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let held = self.file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if !named.is_dir()
            || named.file_type().is_symlink()
            || Inode::of(&named)? != self.inode
            || Inode::of(&held)? != self.inode
            || This::facts(&named).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?.mode != self.mode
            || This::facts(&held).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?.mode != self.mode
        {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        Ok(())
    }
    fn lock(&self) -> AccountResult<()> {
        self.file.lock()
    }
}

// The state lock is kept by an account owner that threads share; it must stay Send and Sync without a lock.
const _: () = {
    const fn shared<T: Send + Sync>() {}
    shared::<StateLockFile>();
    shared::<super::ExistingStateLock>();
};

/// The open startup lock file. Its owner keeps it, and with it the `flock`, until the owner ends.
pub(super) struct StateLockFile {
    file: AdvisoryFile,
    path: PathBuf,
    inode: Inode,
}
impl StateLockFile {
    /// Opens the lock file, making it when absent: a private regular file of this user with one name.
    pub(super) fn open(path: &Path) -> AccountResult<Self> {
        let file = This::open(OpenOptions::new().read(true).write(true).create(true), path,
            Open { mode: Some(0o600), ..Open::NO_FOLLOW })
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let m = file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let facts = This::facts(&m).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if !m.is_file()
            || facts.owner != This::this_owner().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?
            || facts.mode & 0o7777 != 0o600
            || facts.links != 1
        {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        Ok(Self {
            file: AdvisoryFile::new(file),
            path: path.into(),
            inode: Inode::of(&m)?,
        })
    }
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
    pub(super) fn inode(&self) -> &Inode {
        &self.inode
    }
    /// The name still names this file: an owner that ended between this open and the lock unlinked it.
    fn check(&self) -> AccountResult<()> {
        self.inode.check(&self.path)
    }
    /// The record the file holds now, read through this open file.
    fn record(&mut self) -> AccountResult<Zeroizing<Vec<u8>>> {
        self.file.seek(SeekFrom::Start(0)).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let mut bytes = Zeroizing::new(Vec::new());
        (&mut *self.file)
            .take(MAX_LOCK as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        Ok(bytes)
    }
    /// Replaces the record where it is. A refusal before the whole record is written removes the name while it is
    /// still this file (a partial record would only name no one); a name another owner replaced is kept.
    pub(super) fn write(
        &mut self,
        bytes: &[u8],
        write: impl FnOnce(&mut File, &[u8]) -> std::io::Result<()>,
    ) -> AccountResult<()> {
        let written = self
            .file
            .set_len(0)
            .and_then(|_| self.file.seek(SeekFrom::Start(0)).map(drop))
            .and_then(|_| write(&mut self.file, bytes));
        if written.is_err() {
            if self.check().is_ok() {
                let _ = std::fs::remove_file(&self.path);
            }
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        self.check()
    }
}
fn no_selected_owner(prior: &[ProcessIdentity]) -> AccountResult<()> {
    if prior.len() > 16 {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    let mut pids = HashSet::new();
    for old in prior {
        if !crate::records::process_identity::observable(old.pid)
            || old.started_seconds == 0
            || old.started_fraction >= 1_000_000
            || !pids.insert(old.pid)
        {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        if ProcessIdentity::observe(old.pid)? == Some(*old) {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
    }
    Ok(())
}

/// Takes the startup lock for this process and hands it to `claim`, which writes this owner's record into it.
/// A held lock refuses, naming the pid of the process holding it in one log line; a free lock with a stale record is taken over
/// with one log line. Account rights are still checked by LocalAccount's normal source constructor after the claim.
pub(super) fn with_selected_claim<T>(
    root: &Path,
    receipt: &FilePin,
    prior: &[ProcessIdentity],
    claim: impl FnOnce(&OwnerBinding, StateLockFile) -> AccountResult<T>,
) -> AccountResult<T> {
    let directory = Directory::open(root)?;
    directory.lock()?;
    let (receipt_bytes, witness) =
        pinned_bytes(&root.join("restore-receipt.json"), receipt, MAX_JSON)?;
    let value: Value = serde_json::from_slice(&receipt_bytes).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    if value["complete"] != true
        || value["account"]["userId"].as_str().is_none_or(str::is_empty)
        || !value["account"]["ownerId"]
            .as_str()
            .is_some_and(|v| super::hex(v, 64))
    {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    no_selected_owner(prior)?;
    let pid = std::process::id();
    let birth = ProcessIdentity::observe(pid)?.ok_or(crate::cause!(AccountError::SourceUnavailable))?;
    let binding = OwnerBinding {
        pid,
        birth,
        receipt: receipt.blake3.clone(),
    };
    let path = root.join("local-runtime.lock");
    let mut lock = StateLockFile::open(&path)?;
    let free = lock.file.try_lock()?;
    let previous = lock.record()?;
    let lock_owner = Record::parse(&previous).ok();
    if !free {
        let error = crate::cause!(AccountError::SourceChanged);
        crate::quiet_eprintln!("native-startup-lock outcome=refused reason=held holder_pid={} cause={}", lock_owner_pid(lock_owner.as_ref()), error.cause());
        return Err(error);
    }
    lock.check()?;
    if let Some(old) = lock_owner.as_ref().and_then(Record::incarnation) {
        // This process's own record is a state lock of its own that ended without removing the file.
        if old != birth && ProcessIdentity::observe(old.pid)? == Some(old) {
            let error = crate::cause!(AccountError::SourceChanged);
            crate::quiet_eprintln!("native-startup-lock outcome=refused reason=live-unlocked-holder holder_pid={} cause={}", old.pid, error.cause());
            return Err(error);
        }
    }
    if !previous.is_empty() {
        crate::quiet_eprintln!("native-startup-lock outcome=taken-over previous_pid={}", lock_owner_pid(lock_owner.as_ref()));
    }
    witness.check()?;
    directory.check()?;
    let result = claim(&binding, lock)?;
    witness.check()?;
    directory.check()?;
    let row = Record::parse(&super::bounded_file(&path, MAX_LOCK)?)?;
    if row.pid != pid || row.birth(receipt)? != Some(birth) {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    Ok(result)
}

#[cfg(all(test, any(process_table = "procfs", process_table = "proc-pidinfo")))]
mod tests {
    use super::*;
    use std::{
        fs,
        io::Write,
        os::{
            fd::AsRawFd,
            unix::{
                fs::{symlink, MetadataExt, OpenOptionsExt, PermissionsExt},
                process::CommandExt,
            },
        },
        process::{Child, Command},
        sync::{Arc, Barrier},
        thread,
    };

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        receipt: FilePin,
    }
    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let bytes=serde_json::to_vec(&serde_json::json!({"complete":true,"account":{"userId":"fixture-user","ownerId":"a".repeat(64)}})).unwrap();
        fs::write(root.join("restore-receipt.json"), &bytes).unwrap();
        let receipt = FilePin {
            bytes: bytes.len() as u64,
            blake3: super::super::blake3::hash(&bytes).to_hex().to_string(),
        };
        Fixture {
            _temp: temp,
            root,
            receipt,
        }
    }
    impl Fixture {
        fn lock(&self) -> PathBuf {
            self.root.join("local-runtime.lock")
        }
        /// A private lock file holding `bytes`, held by no one.
        fn record(&self, bytes: &[u8]) {
            fs::write(self.lock(), bytes).unwrap();
            fs::set_permissions(self.lock(), fs::Permissions::from_mode(0o600)).unwrap();
        }
        fn bound(&self, owner: ProcessIdentity) -> Vec<u8> {
            serde_json::to_vec(&serde_json::json!({"pid":owner.pid,"token":"fixture-old-owner",
                "started_seconds":owner.started_seconds,"started_fraction":owner.started_fraction,
                "receipt_identity":self.receipt.blake3}))
            .unwrap()
        }
        fn claim(&self) -> AccountResult<StateLockFile> {
            with_selected_claim(&self.root, &self.receipt, &[], claim)
        }
        /// The claim took the lock: the file is the one it held before, and its record is this process's.
        fn assert_claimed(&self, before: u64) {
            assert_eq!(fs::metadata(self.lock()).unwrap().ino(), before);
            let current = Record::parse(&fs::read(self.lock()).unwrap()).unwrap();
            assert_eq!(current.pid, std::process::id());
            assert_eq!(
                current.birth(&self.receipt).unwrap(),
                ProcessIdentity::observe(std::process::id()).unwrap()
            );
        }
    }
    fn claim(binding: &OwnerBinding, mut lock: StateLockFile) -> AccountResult<StateLockFile> {
        let mut row = serde_json::json!({"pid":std::process::id(),"token":"fixture-new-owner"});
        binding.bind(&mut row)?;
        let bytes = serde_json::to_vec(&row).unwrap();
        lock.write(&bytes, |file, bytes| file.write_all(bytes).and_then(|_| file.sync_all()))?;
        Ok(lock)
    }
    /// Another test thread's child holds a copy of every open file description between its fork and its exec, so a
    /// lock this test let go can still be held for that moment: an answer expected free is tried for up to 2 s.
    fn once_forks_settle<T>(mut attempt: impl FnMut() -> AccountResult<T>) -> AccountResult<T> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match attempt() {
                Err(_) if std::time::Instant::now() < deadline => {
                    thread::sleep(std::time::Duration::from_millis(10))
                }
                answer => return answer,
            }
        }
    }
    fn free(lock: &AdvisoryFile) -> bool {
        once_forks_settle(|| if lock.try_lock()? { Ok(()) } else { Err(crate::cause!(AccountError::SourceChanged)) }).is_ok()
    }
    fn dead() -> ProcessIdentity {
        let mut child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let identity = ProcessIdentity::observe(child.id()).unwrap().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ProcessIdentity::observe(identity.pid).unwrap().is_none());
        identity
    }
    /// A real lock-holding process: a separate process that holds the lock file's flock (an inherited open file number of the open
    /// file that took it) and is named by the file's bound record, as trillion-local is. Returns it and the record.
    fn lock_owner(f: &Fixture) -> (Child, Vec<u8>) {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(f.lock())
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let fd = file.as_raw_fd();
        let mut command = Command::new("/bin/sleep");
        command.arg("60");
        // SAFETY: fcntl is async-signal-safe; it clears close-on-exec on the child's own copy of the open file number.
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
        let child = command.spawn().unwrap();
        let bytes = f.bound(ProcessIdentity::observe(child.id()).unwrap().unwrap());
        (&file).write_all(&bytes).unwrap();
        file.sync_all().unwrap();
        drop(file);
        (child, bytes)
    }

    #[test]
    fn a_live_lock_owner_refuses_and_a_killed_lock_owner_is_taken_over() {
        let f = fixture();
        let (mut child, before) = lock_owner(&f);
        let inode = fs::metadata(f.lock()).unwrap().ino();
        let mut called = false;
        assert!(with_selected_claim(&f.root, &f.receipt, &[], |_, _| {
            called = true;
            Ok(())
        })
        .is_err());
        assert!(!called, "a live holder refuses before the claim");
        assert_eq!(fs::read(f.lock()).unwrap(), before);

        child.kill().unwrap();
        child.wait().unwrap();
        let state_lock = once_forks_settle(|| f.claim()).unwrap();
        f.assert_claimed(inode);
        assert!(f.claim().is_err(), "the new owner holds the lock for its life");
        drop(state_lock);
        once_forks_settle(|| f.claim()).unwrap();
    }
    #[test]
    fn a_record_whose_lock_owner_is_gone_or_never_finished_is_taken_over() {
        let now = ProcessIdentity::observe(std::process::id()).unwrap().unwrap();
        let reused = ProcessIdentity {
            started_seconds: now.started_seconds - 1,
            ..now
        };
        for kind in ["dead", "reused-pid", "legacy-dead", "cut-short", "empty", "foreign-receipt"] {
            let f = fixture();
            let bytes = match kind {
                "dead" => f.bound(dead()),
                "reused-pid" => f.bound(reused),
                "legacy-dead" => {
                    serde_json::to_vec(&serde_json::json!({"pid":dead().pid,"token":"fixture-old"})).unwrap()
                }
                "cut-short" => f.bound(dead())[..40].to_vec(),
                "empty" => Vec::new(),
                "foreign-receipt" => {
                    let old = dead();
                    serde_json::to_vec(&serde_json::json!({"pid":old.pid,"token":"fixture-old",
                        "started_seconds":old.started_seconds,"started_fraction":old.started_fraction,
                        "receipt_identity":"f".repeat(64)}))
                    .unwrap()
                }
                _ => unreachable!(),
            };
            f.record(&bytes);
            let inode = fs::metadata(f.lock()).unwrap().ino();
            let state_lock = once_forks_settle(|| f.claim()).unwrap_or_else(|e| panic!("{kind}: {e}"));
            f.assert_claimed(inode);
            drop(state_lock);
        }
    }
    #[test]
    fn a_live_lock_owner_from_before_the_held_lock_and_a_live_prior_owner_refuse() {
        // A trillion-local from before the held lock never took the flock; its exact incarnation alive still refuses.
        let f = fixture();
        let mut child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let unlocked = ProcessIdentity::observe(child.id()).unwrap().unwrap();
        let before = f.bound(unlocked);
        f.record(&before);
        assert!(f.claim().is_err());
        assert_eq!(fs::read(f.lock()).unwrap(), before);
        child.kill().unwrap();
        child.wait().unwrap();
        drop(once_forks_settle(|| f.claim()).unwrap());

        let f = fixture();
        let me = ProcessIdentity::observe(std::process::id()).unwrap().unwrap();
        let mut called = false;
        assert!(with_selected_claim(&f.root, &f.receipt, &[me], |_, _| {
            called = true;
            Ok(())
        })
        .is_err());
        assert!(!called);
        assert!(!f.lock().exists());
    }
    /// A container's first process is PID 1 in its own PID account files, so the lock record and the prior owners name
    /// PID 1. A record left by a PID 1 that is gone (the container restarted: PID 1 is a new incarnation) is taken
    /// over, and a prior PID 1 incarnation that is gone does not refuse the claim. Before, every PID 1 was refused as
    /// invalid input ("native account input refused"), so `trillion-local serve` as PID 1 could not open an account.
    #[cfg(process_table = "procfs")]
    #[test]
    fn a_pid_one_owner_that_is_gone_is_taken_over() {
        let live = ProcessIdentity::observe(1).unwrap().unwrap();
        let earlier = ProcessIdentity { started_seconds: live.started_seconds.max(2) - 1, ..live };
        assert_ne!(earlier, live, "the earlier PID 1 is another incarnation");
        let f = fixture();
        f.record(&f.bound(earlier));
        assert_eq!(Record::parse(&f.bound(earlier)).unwrap().pid, 1, "a record naming PID 1 reads");
        let inode = fs::metadata(f.lock()).unwrap().ino();
        let state_lock = once_forks_settle(|| with_selected_claim(&f.root, &f.receipt, &[earlier], claim))
            .unwrap_or_else(|e| panic!("a PID 1 that is gone is taken over: {e}"));
        f.assert_claimed(inode);
        drop(state_lock);
        // The PID 1 that runs now still refuses, as any live prior owner does.
        let f = fixture();
        assert!(with_selected_claim(&f.root, &f.receipt, &[live], claim).is_err());
    }
    #[test]
    fn concurrent_claimant_cannot_replace_the_first_new_owner() {
        let f = Arc::new(fixture());
        f.record(&f.bound(dead()));
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let (thread_f, thread_entered, thread_release) =
            (f.clone(), entered.clone(), release.clone());
        let first = thread::spawn(move || {
            with_selected_claim(&thread_f.root, &thread_f.receipt, &[], |binding, lock| {
                thread_entered.wait();
                thread_release.wait();
                claim(binding, lock)
            })
        });
        entered.wait();
        assert!(f.claim().is_err());
        release.wait();
        let state_lock = first.join().unwrap().unwrap();
        let claimed = fs::read(f.lock()).unwrap();
        assert!(f.claim().is_err());
        assert_eq!(fs::read(f.lock()).unwrap(), claimed);
        drop(state_lock);
    }
    #[test]
    fn wrong_receipt_and_unsafe_lock_files_do_not_change_the_lock() {
        for kind in ["receipt", "mode", "symlink", "hardlink"] {
            let mut f = fixture();
            let before = f.bound(dead());
            f.record(&before);
            match kind {
                "receipt" => f.receipt.blake3 = "f".repeat(64),
                "mode" => {
                    fs::set_permissions(f.lock(), fs::Permissions::from_mode(0o644)).unwrap()
                }
                "symlink" => {
                    fs::rename(f.lock(), f.root.join("held-marker")).unwrap();
                    symlink("held-marker", f.lock()).unwrap();
                }
                "hardlink" => fs::hard_link(f.lock(), f.root.join("second-name")).unwrap(),
                _ => unreachable!(),
            }
            assert!(f.claim().is_err(), "{kind}");
            assert_eq!(fs::read(f.lock()).unwrap(), before, "{kind}");
        }
    }
    #[test]
    fn guard_drop_unlocks_even_while_a_duplicated_description_survives() {
        let f = fixture();
        // Actual OS control for the old close-only assumption: dup/fork shares
        // the open-file description, so closing one fd leaves flock held.
        let raw_path = f.root.join("close-only-control");
        let raw = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&raw_path)
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(raw.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let inherited = raw.try_clone().unwrap();
        drop(raw);
        let retry = AdvisoryFile::new(OpenOptions::new().read(true).open(&raw_path).unwrap());
        assert!(!retry.try_lock().unwrap());
        drop(inherited);
        assert!(free(&retry));
        drop(retry);
        let directory = Directory::open(&f.root).unwrap();
        directory.lock().unwrap();
        let inherited = directory.file.try_clone().unwrap();
        drop(directory);
        let next = Directory::open(&f.root).unwrap();
        assert!(free(&next.file));
        drop(next);
        drop(inherited);
        let held = StateLockFile::open(&f.lock()).unwrap();
        assert!(free(&held.file));
        let inherited = held.file.try_clone().unwrap();
        drop(held);
        let next = StateLockFile::open(&f.lock()).unwrap();
        assert!(free(&next.file));
        drop(next);
        drop(inherited);
    }
}
