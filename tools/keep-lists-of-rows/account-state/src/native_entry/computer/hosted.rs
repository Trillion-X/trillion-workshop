// src/native_entry/computer/hosted.rs
//
// Purpose: take an account folder the hosting app holds into this computer, with one command line:
//   trillion-local computer adopt-hosting-app-account COMPUTER_CONFIG STATE_FOLDER
// The hosting app keeps the account's secrets key in its own Keychain item (`secrets_key_keychain_item`,
// src/secrets/secrets_key.json), not sealed to a computer key. This command reads that item once,
// READ ONLY (`secrets::secrets_key_from_item_only`: no split, no write, no replace), makes the account's folder in this
// computer's accounts folder from STATE_FOLDER, leaves the secrets key in it sealed to this computer's own id
// (`secrets_key::seal_to_computer`, the sent file this computer takes at its start, `take_sent`), and writes the restore file
// last. The computer then serves the account at its next start like any account it holds.
//
// Non-Negotiable Invariants:
// - The hosting app's Keychain item is never written or replaced; the hosting app's folder is only read. Each store is
//   one consistent snapshot (`first_copy::take_copy`, SQLite `VACUUM INTO`); WAL and journal files are not copied.
// - It refuses while another process holds the folder's lock (`lock_file`, held under `flock` by a running hosting app),
//   and holds that lock itself while it reads, so the hosting app cannot start in the middle.
// - The new folder is made beside the others (`.new-`) and named by the account's owner id only once whole; an account
//   this computer already holds is refused.
// - What stays at the hosting app's side does not travel: its lock, the sign-in note (the computer writes its own), WAL
//   files. The account's sign-in rows travel whole: this is the same account moving, not a second copy.
// - No secret value is printed, logged or put in an error.
//
// Known gaps: the hosting app keeps serving its own folder after this (nothing stops it); the owner moves the computers
// row (a computers edit at the account's routes) so the account's calls go to this computer. Run on a Mac with the real Keychain: not done
// here (no Mac in the cloud session); the tests use an in-memory Keychain reader.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{join, settings, ComputerConfig};
use crate::{
    account::{computers, create},
    secrets::{secrets_key::{self, ComputerKey}, SecretsKey},
    storage::sqlite::first_copy,
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use crate::tool_runs::os::{Lock, OwnerFiles, This};

/// The computer's own key file the config names.
fn key_file(config: &ComputerConfig) -> &Path {
    &config.computer_key_file
}

/// The folder's lock, held by this command (`flock`, exclusive) while it reads the folder; released when dropped.
struct HeldLock(Option<fs::File>);

impl HeldLock {
    /// Take the folder's lock when the folder has one: refused while another process holds it.
    fn take(folder: &Path) -> join::Outcome<Self> {
        let path = folder.join(&settings().lock_file);
        if !path.exists() {
            return Ok(Self(None));
        }
        let file = crate::io_operation!(fs::File::open(&path))?;
        if !This::lock(&file, Lock::Try).unwrap_or(false) {
            return Err(crate::refusal_cause::CodedError::new("another process holds the folder's lock: quit the hosting app first").into());
        }
        Ok(Self(Some(file)))
    }
}

impl Drop for HeldLock {
    fn drop(&mut self) {
        if let Some(file) = &self.0 {
            let _ = This::lock(file, Lock::Release);
        }
    }
}

/// Take the account folder `state` the hosting app holds into the computer `config` (the module doc). `secrets_key` reads
/// the hosting app's secrets key item (read only). Answers what was done, as one JSON line.
pub(super) fn take_over_folder(config: &ComputerConfig, state: &Path, secrets_key: &dyn Fn() -> crate::secrets::Result<SecretsKey>)
    -> join::Outcome<serde_json::Value> {
    let computer_key = ComputerKey::read(key_file(config))?;
    let me = computers::ComputerSigner::of(&computer_key)?.computer_id();
    let room = || config.takes_one_more(super::account_folders(config).map(|folders| folders.len()).unwrap_or(0));
    take_into(&config.accounts, state, &me, &room, secrets_key)
}

/// Take the account folder `state` the hosting app holds for another computer, `computer_id`, that is not this machine
/// (`computer adopt-hosting-app-account-for COMPUTER_ID STATE_FOLDER OUT_FOLDER`): the same folder `take_over_folder` makes,
/// written into `out` (a folder of this machine) instead of a computer's accounts folder, its secrets key sealed to
/// `computer_id` (its public key only: no secret of the receiving computer is on this machine). The operator moves the
/// folder `<out>/<owner id>` into that computer's accounts folder whole; at its next start the computer takes the sealed
/// root (`take_sent`) and serves the account.
///
/// Why a second form: the hosting app's folder and its Keychain item are only on the hosting app's machine, and the first
/// form seals to the key of a computer config on the same machine. A computer on a server could only be reached by first
/// running a throwaway computer on the Mac, starting it once, and sending its root again (`send-secrets-key`); this form is
/// that path in one step, with no computer key made on the Mac. Old trillion: none to port (the hosted PersonStore was
/// one Durable Object and never moved between machines; old trillion was not reachable from this session, so no
/// file:line is cited). New.
///
/// The computer that serves the folder moves the account's computers row to itself at its first tell, with no other
/// step, when the row names no voters and only the hosting app's devices: the restore file travels as it is, so the
/// folder's state identity is the hosting app's, the hosting app's enrolled devices read as this computer's earlier ids
/// (`LocalAccount::enrolled_devices`), and `computers::told` signs the row again at the next revision naming the computer
/// alone. A row the owner set to name other computers or voters is told as it is.
pub(super) fn take_for_computer(computer_id: &str, state: &Path, out: &Path, secrets_key: &dyn Fn() -> crate::secrets::Result<SecretsKey>)
    -> join::Outcome<serde_json::Value> {
    if !out.is_absolute() || !out.is_dir() {
        return Err(crate::refusal_cause::CodedError::new("OUT_FOLDER is not an absolute folder").into());
    }
    if !secrets_key::names_computer_key(computer_id) {
        return Err(crate::refusal_cause::CodedError::new("COMPUTER_ID names no computer key").into());
    }
    take_into(out, state, computer_id, &|| true, secrets_key)
}

/// The one taking both forms share: the folder `state` the hosting app holds becomes `<accounts>/<owner id>`, its root sealed
/// to `to` (a computer id). `room` says whether one more account folder may be made there.
fn take_into(accounts: &Path, state: &Path, to: &str, room: &dyn Fn() -> bool,
    secrets_key: &dyn Fn() -> crate::secrets::Result<SecretsKey>) -> join::Outcome<serde_json::Value> {
    let settings = settings();
    if !state.is_absolute() || !state.is_dir() {
        return Err(crate::refusal_cause::CodedError::new("STATE_FOLDER is not an absolute folder").into());
    }
    let _lock = HeldLock::take(state)?;
    let restore = state.join(super::join_itself::restore_file());
    let restore_bytes = fs::read(&restore).map_err(|error| crate::refusal_cause::CodedError::with_cause("STATE_FOLDER has no account restore file", crate::refusal_cause::Caused::cause(&error)))?;
    let restored: serde_json::Value = serde_json::from_slice(&restore_bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause("the restore file is unreadable", crate::refusal_cause::Caused::cause(&error)))?;
    let owner = restored["account"]["ownerId"].as_str().unwrap_or_default().to_owned();
    if owner.len() != 64 || !owner.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(crate::refusal_cause::CodedError::new("the restore file's owner id is not a folder name").into());
    }
    let target = accounts.join(&owner);
    if target.exists() {
        return Err(crate::refusal_cause::CodedError::new("this computer already holds the account").into());
    }
    if !room() {
        return Err(crate::refusal_cause::CodedError::new("this computer holds as many accounts as it may").into());
    }
    let root = secrets_key().map_err(|error| crate::refusal_cause::CodedError::with_cause("the hosting app's secrets key item could not be read", crate::refusal_cause::Caused::cause(&error)))?;
    let making = accounts.join(format!("{}{}", create::UNFINISHED_PREFIX, &owner[..16]));
    if making.exists() {
        return Err(crate::refusal_cause::CodedError::new("this account is already being taken here").into());
    }
    crate::io_operation!(fs::create_dir_all(&making))?;
    let made = (|| -> join::Outcome<(usize, usize)> {
        let mut found = Vec::new();
        join::walk(state, Path::new(""), &mut found)?;
        let stay: Vec<PathBuf> = vec![
            PathBuf::from(&settings.lock_file),
            restore.strip_prefix(state).map(Path::to_path_buf).map_err(|error| { let cause = crate::refusal_cause::Caused::cause(&error); crate::refusal_cause::CodedError::with_cause(error, cause) })?,
            PathBuf::from(&crate::account::rows::contract().door_note_file),
            secrets_key::sealed_file(Path::new(""))?,
            secrets_key::sent_file(Path::new(""))?,
        ];
        let (mut stores, mut files) = (0, 0);
        for relative in found {
            let name = relative.to_string_lossy();
            let beside = ["-wal", "-shm", "-journal", ".next", ".new"].iter().any(|suffix| name.ends_with(suffix));
            if beside || stay.contains(&relative) {
                continue;
            }
            let path = state.join(&relative);
            let to = making.join(&relative);
            if let Some(parent) = to.parent() {
                crate::io_operation!(fs::create_dir_all(parent))?;
            }
            if join::is_store(&path) {
                first_copy::take_copy(&path, &to)?;
                stores += 1;
            } else {
                join::write_new(&to, &crate::io_operation!(fs::read(&path))?)?;
                files += 1;
            }
        }
        secrets_key::write_sent(&secrets_key::sent_file(&making)?, &root, to)?;
        // The restore file goes last, as it was read when taking began.
        if crate::io_operation!(fs::read(&restore))? != restore_bytes {
            return Err(crate::refusal_cause::CodedError::new("the account's restore file changed while it was taken").into());
        }
        join::write_new(&making.join(restore.strip_prefix(state).map_err(|error| { let cause = crate::refusal_cause::Caused::cause(&error); crate::refusal_cause::CodedError::with_cause(error, cause) })?), &restore_bytes)?;
        Ok((stores, files))
    })();
    let (stores, files) = match made {
        Ok(counts) => counts,
        Err(error) => {
            let _ = fs::remove_dir_all(&making);
            return Err(error);
        }
    };
    crate::io_operation!(fs::rename(&making, &target))?;
    Ok(serde_json::json!({"taken_over": owner, "computer": to, "folder": target, "stores": stores, "files": files, "sent_root": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd as _;
    use std::{cell::RefCell, collections::HashMap};
    use zeroize::Zeroizing;

    /// A computer folder with its config and key (the same one `computer join`'s tests make).
    fn computer(dir: &Path) -> ComputerConfig {
        join::tests::computer(dir, 9).0
    }

    /// The in-memory Keychain the tests use: every read is counted, and it has no way to be written.
    struct Keychain {
        items: HashMap<String, String>,
        reads: RefCell<Vec<String>>,
    }

    impl Keychain {
        fn read(&self) -> crate::secrets::Result<SecretsKey> {
            crate::secrets::secrets_key_from_item_only(&|item: &str| {
                self.reads.borrow_mut().push(item.to_owned());
                Ok(self.items.get(item).map(|value| Zeroizing::new(value.clone())))
            })
        }
    }

    /// A folder as the hosting app holds an account: an account made with no computer key sealed (the hosting app keeps
    /// the secrets key in its Keychain), its sealed root removed, and a lock file.
    fn hosting_app_folder(dir: &Path) -> (PathBuf, String) {
        let state = dir.join("hosting-app-state");
        let maker = ComputerKey::from_bytes(vec![1u8; 32]).unwrap();
        let rows = crate::account::rows::StartingRows::for_tests();
        let created = create::create_account(&state, &maker, &rows).unwrap();
        let root = secrets_key::open_sealed_with(&state, &maker).unwrap();
        fs::remove_file(secrets_key::sealed_file(&state).unwrap()).unwrap();
        fs::write(state.join(&settings().lock_file), b"{}").unwrap();
        (state, root_text(&root, &created.owner_id))
    }

    /// The text of the root, as the Keychain item holds it. Only the test sees it.
    fn root_text(root: &SecretsKey, _owner: &str) -> String {
        root.text_for_test().to_owned()
    }

    #[test]
    fn an_account_the_hosting_app_holds_is_taken_with_its_keychain_item_read_only_and_its_root_sealed_to_this_computer() {
        let dir = tempfile::tempdir().unwrap();
        let config = computer(&dir.path().join("computer"));
        let (state, root) = hosting_app_folder(dir.path());
        let item = secrets_key::secrets_key_item().unwrap();
        let keychain = Keychain { items: HashMap::from([(item.clone(), root.clone())]), reads: RefCell::new(Vec::new()) };
        let before: HashMap<String, String> = keychain.items.clone();

        // Refused while another process holds the folder's lock.
        let lock = fs::File::open(state.join(&settings().lock_file)).unwrap();
        assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0);
        let held = std::thread::spawn({
            let (config, state) = (computer(&dir.path().join("computer")), state.clone());
            move || take_over_folder(&config, &state, &|| Err(crate::secrets::Error::Keychain("not reached", crate::cause!()))).map_err(|error| error.to_string())
        }).join().unwrap();
        assert!(held.unwrap_err().contains("lock"), "refused while the lock is held");
        drop(lock);

        let taken = take_over_folder(&config, &state, &|| keychain.read()).unwrap();
        let owner = taken["taken_over"].as_str().unwrap().to_owned();
        let folder = config.accounts.join(&owner);
        assert!(folder.join(super::super::join_itself::restore_file()).exists(), "{taken}");
        assert!(!folder.join(&settings().lock_file).exists(), "the hosting app's lock stays with it");
        // The Keychain was only read: one read of the secrets key's own item, and the items are as they were.
        assert_eq!(*keychain.reads.borrow(), vec![item.clone()]);
        assert_eq!(keychain.items, before);
        // The root is in the folder sealed to this computer's id; at the computer's start it is taken and sealed to its key.
        let computer_key = ComputerKey::read(key_file(&config)).unwrap();
        assert!(secrets_key::sent_file(&folder).unwrap().exists());
        assert!(secrets_key::take_sent(&folder, &computer_key, &computers::settings().computer_id_context).unwrap());
        let opened = secrets_key::open_sealed_with(&folder, &computer_key).unwrap();
        assert_eq!(opened.text_for_test(), root);
        // The hosting app's folder is as it was: no sealed root, no sent file appeared there.
        assert!(!secrets_key::sealed_file(&state).unwrap().exists() && !secrets_key::sent_file(&state).unwrap().exists());

        // A second take of the same account is refused; a missing Keychain item is refused and makes nothing.
        assert!(take_over_folder(&config, &state, &|| keychain.read()).is_err());
        let empty = Keychain { items: HashMap::new(), reads: RefCell::new(Vec::new()) };
        fs::remove_dir_all(&folder).unwrap();
        assert!(take_over_folder(&config, &state, &|| empty.read()).is_err());
        assert!(fs::read_dir(&config.accounts).unwrap().next().is_none(), "nothing is left behind");
    }

    /// The hosting app's machine holds no key of the receiving computer: the take for another computer names it by its
    /// id only, writes the folder into a folder of this machine, and only that computer's key takes the root.
    #[test]
    fn an_account_the_hosting_app_holds_is_taken_for_another_computer_by_its_id_and_only_its_key_takes_the_root() {
        let dir = tempfile::tempdir().unwrap();
        // The receiving computer, as on a server: only its id travels to the hosting app's machine.
        let server = computer(&dir.path().join("server"));
        let server_key = ComputerKey::read(key_file(&server)).unwrap();
        let server_id = computers::ComputerSigner::of(&server_key).unwrap().computer_id();
        let (state, root) = hosting_app_folder(dir.path());
        let item = secrets_key::secrets_key_item().unwrap();
        let keychain = Keychain { items: HashMap::from([(item.clone(), root.clone())]), reads: RefCell::new(Vec::new()) };
        let out = dir.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let state_before: Vec<PathBuf> = { let mut found = Vec::new(); join::walk(&state, Path::new(""), &mut found).unwrap(); found.sort(); found };

        // A mistyped id and a relative out folder are refused before anything is read or copied.
        assert!(take_for_computer("not-an-id", &state, &out, &|| keychain.read()).is_err());
        assert!(take_for_computer(&server_id, &state, Path::new("out"), &|| keychain.read()).is_err());
        assert!(keychain.reads.borrow().is_empty(), "nothing was read for a refused take");
        assert!(fs::read_dir(&out).unwrap().next().is_none());

        let taken = take_for_computer(&server_id, &state, &out, &|| keychain.read()).unwrap();
        assert_eq!(taken["computer"], server_id.as_str(), "{taken}");
        let owner = taken["taken_over"].as_str().unwrap().to_owned();
        let folder = out.join(&owner);
        assert_eq!(taken["folder"], folder.to_string_lossy().as_ref());
        // The restore file travels byte for byte: the folder's state identity is the hosting app's, so the hosting
        // app's enrolled devices read as the serving computer's earlier ids (`computers::told`).
        let restore = super::super::join_itself::restore_file();
        assert_eq!(fs::read(folder.join(&restore)).unwrap(), fs::read(state.join(&restore)).unwrap());
        assert!(!folder.join(&settings().lock_file).exists(), "the hosting app's lock stays with it");
        assert_eq!(*keychain.reads.borrow(), vec![item.clone()], "the Keychain item was read once, only read");

        // Another computer's key does not take the root: refused and left where it is.
        let other = join::tests::computer(&dir.path().join("other"), 7).0;
        let other_key = ComputerKey::read(key_file(&other)).unwrap();
        assert!(secrets_key::take_sent(&folder, &other_key, &computers::settings().computer_id_context).is_err());
        assert!(secrets_key::sent_file(&folder).unwrap().exists());

        // Moved into the server's accounts folder whole, the server's key takes it at its start and seals it to itself.
        let at_server = server.accounts.join(&owner);
        fs::rename(&folder, &at_server).unwrap();
        assert!(secrets_key::take_sent(&at_server, &server_key, &computers::settings().computer_id_context).unwrap());
        assert_eq!(secrets_key::open_sealed_with(&at_server, &server_key).unwrap().text_for_test(), root);
        assert!(!secrets_key::sent_file(&at_server).unwrap().exists(), "the sent file is removed once taken");

        // The hosting app's folder is as it was, and a second take into the same out folder is refused only when the
        // folder is still there.
        let state_after: Vec<PathBuf> = { let mut found = Vec::new(); join::walk(&state, Path::new(""), &mut found).unwrap(); found.sort(); found };
        assert_eq!(state_before, state_after);
        assert!(!secrets_key::sealed_file(&state).unwrap().exists() && !secrets_key::sent_file(&state).unwrap().exists());
        fs::create_dir_all(out.join(&owner)).unwrap();
        assert!(take_for_computer(&server_id, &state, &out, &|| keychain.read()).is_err(), "an out folder that holds it is refused");
    }
}

/// The operator's local repair of an account's computers row (`computer repair-placement STATE_FOLDER COMPUTER_ID`, run on
/// the computer that holds the account key): it names `computer_id` alone, after the engine's own log proves this engine
/// hosts that computer for the account (`computer-start event=hosting`). The account key is read from the folder's vault
/// with the hosting app's root (read only), and each step is an owner edit (`computers/placement_repair.rs`). Nothing on
/// the relay or the public door reaches this.
pub(super) fn repair_placement(state: &Path, computer_id: &str, secrets_key: &dyn Fn() -> crate::secrets::Result<SecretsKey>,
    log: &Path) -> join::Outcome<serde_json::Value> {
    if !state.is_absolute() || !state.is_dir() {
        return Err("STATE_FOLDER is not an absolute folder".into());
    }
    if computer_id.len() != 64 || !computer_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("COMPUTER_ID is not a computer id".into());
    }
    let door: serde_json::Value = serde_json::from_slice(&fs::read(state.join("sign-in-door.json"))?)?;
    let account = door["account"].as_str().ok_or("the sign-in door note names no account")?.to_owned();
    let address = door["address"].as_str().ok_or("the sign-in door note names no address")?.to_owned();
    let engine_log = fs::read_to_string(log)?;
    let proven = engine_log.lines().any(|line| line.contains("computer-start event=hosting")
        && line.contains(&format!("account={address} ")) && line.contains(&format!("computer={computer_id} ")));
    if !proven {
        return Err("the engine log does not show this engine hosting that computer for this account".into());
    }
    let restored: serde_json::Value = serde_json::from_slice(&fs::read(state.join(super::join_itself::restore_file()))?)?;
    let owner = restored["account"]["ownerId"].as_str().ok_or("the restore file names no owner")?.to_owned();
    let root = secrets_key().map_err(|_| "the hosting app's secrets key item could not be read")?;
    let vault = crate::secrets::open_with_secrets_key(state, &owner, &root).map_err(|_| "the account's vault did not open")?;
    let key = crate::account::computers::kept_account_key(&vault)?;
    if key.address() != address {
        return Err("the vault's account key is not the account's".into());
    }
    let storage = crate::account::rows::open(state).map_err(|_| "the sign-in database did not open")?;
    let store = crate::account::rows::store::Store::new(&*storage);
    let written = crate::account::computers::placement_repair::apply(&store, &account,
        &crate::account::computers::Subject::Account(address.clone()), &key, computer_id)
        .map_err(|error| format!("the placement repair refused: {error:?}"))?;
    Ok(serde_json::json!({"repaired": written.len(), "address": address, "computer": computer_id,
        "revision": written.last().map(|row| row.value.revision)}))
}

/// The operator's local add of a copy (`computer add-copy COMPUTER_ID STATE_FOLDER PLACE_ID_FILE`, run on the computer that
/// holds the account key): COMPUTER_ID becomes a computer that keeps a copy and may answer, and this computer stays in every
/// set. It changes no voter. Two checks come first: PLACE_ID_FILE holds the public id that the place's own engine prints
/// (`trillion-local computer id`, run on the place), and it must equal COMPUTER_ID; the account then offers it (the
/// offered-computers list, when it is not there yet). Then one owner edit (`computers::apply`, `add-computer`), checked by the same rules as every
/// other computers change.
pub(super) fn add_copy(computer_id: &str, state: &Path, place_id_file: &Path,
    secrets_key: &dyn Fn() -> crate::secrets::Result<SecretsKey>) -> join::Outcome<serde_json::Value> {
    if !state.is_absolute() || !state.is_dir() {
        return Err("STATE_FOLDER is not an absolute folder".into());
    }
    if computer_id.len() != 64 || !computer_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("COMPUTER_ID is not a computer id".into());
    }
    let place_says = fs::read_to_string(place_id_file)?;
    if place_says.trim() != computer_id {
        return Err(crate::refusal_cause::CodedError::new("the place's own computer id is not COMPUTER_ID").into());
    }
    let door: serde_json::Value = serde_json::from_slice(&fs::read(state.join("sign-in-door.json"))?)?;
    let account = door["account"].as_str().ok_or("the sign-in door note names no account")?.to_owned();
    let address = door["address"].as_str().ok_or("the sign-in door note names no address")?.to_owned();
    let restored: serde_json::Value = serde_json::from_slice(&fs::read(state.join(super::join_itself::restore_file()))?)?;
    let owner = restored["account"]["ownerId"].as_str().ok_or("the restore file names no owner")?.to_owned();
    let root = secrets_key().map_err(|_| "the hosting app's secrets key item could not be read")?;
    let vault = crate::secrets::open_with_secrets_key(state, &owner, &root).map_err(|_| "the account's vault did not open")?;
    let key = crate::account::computers::kept_account_key(&vault)?;
    if key.address() != address {
        return Err("the vault's account key is not the account's".into());
    }
    let storage = crate::account::rows::open(state).map_err(|_| "the sign-in database did not open")?;
    let store = crate::account::rows::store::Store::new(&*storage);
    // The place's identity is proven above, so the account offers it (or keeps what it already offers) before the add.
    let offered = crate::account::computers::copy_rule::offered(&store, &account)
        .map_err(|_| "the offered-computers list did not read")?;
    let (revision, mut list) = offered.map_or((0, Vec::new()), |row| (row.revision, row.settings));
    if !list.iter().any(|offer| offer.computer == computer_id) {
        list.push(crate::account::computers::copy_rule::Offered { kind: None, computer: computer_id.to_owned(), has_room: true, always_on: false });
        crate::account::computers::copy_rule::set_offered(&store, &account, revision, list)
            .map_err(|_| "the offered-computers list did not change")?;
    }
    let row = crate::account::computers::apply(&store, &account, &crate::account::computers::Operation::AddComputer {
        pursuit: None, computer: computer_id.to_owned(), may_answer: true, voter: false }, &key, &serde_json::Value::Null, &crate::storage::time_source::RealClock)
        .map_err(|error| format!("the copy add refused: {error:?}"))?;
    crate::quiet_eprintln!("placement-repair event=applied cause=add_copy_by_local_key revision={}", row.value.revision);
    Ok(serde_json::json!({"added": computer_id, "address": address, "revision": row.value.revision,
        "keepers": row.value.copy_keepers.len(), "answering": row.value.may_answer.len(), "voters": row.value.voters.len()}))
}

/// Shared by the generic owner commands below: the account's folder, its own key and its sign-in store, read as the local
/// owner (the same reads as `repair_placement`). No computer id is read here.
fn owner_of(state: &Path, secrets_key: &dyn Fn() -> crate::secrets::Result<SecretsKey>)
    -> join::Outcome<(String, crate::account::computers::AccountKey, crate::account::rows::Shared)> {
    if !state.is_absolute() || !state.is_dir() {
        return Err("STATE_FOLDER is not an absolute folder".into());
    }
    let door: serde_json::Value = serde_json::from_slice(&fs::read(state.join("sign-in-door.json"))?)?;
    let account = door["account"].as_str().ok_or("the sign-in door note names no account")?.to_owned();
    let address = door["address"].as_str().ok_or("the sign-in door note names no address")?.to_owned();
    let restored: serde_json::Value = serde_json::from_slice(&fs::read(state.join(super::join_itself::restore_file()))?)?;
    let owner = restored["account"]["ownerId"].as_str().ok_or("the restore file names no owner")?.to_owned();
    let root = secrets_key().map_err(|_| "the hosting app's secrets key item could not be read")?;
    let vault = crate::secrets::open_with_secrets_key(state, &owner, &root).map_err(|_| "the account's vault did not open")?;
    let key = crate::account::computers::kept_account_key(&vault)?;
    if key.address() != address {
        return Err("the vault's account key is not the account's".into());
    }
    let storage = crate::account::rows::open(state).map_err(|_| "the sign-in database did not open")?;
    Ok((account, key, storage))
}

/// One owner computers operation, as the owner's own vocabulary (`computers::Operation`, JSON with `op`): `computer
/// owner-operation STATE_FOLDER JSON`. The operation names what it changes; the rules are `computers::apply`'s.
pub(super) fn owner_operation(state: &Path, operation: &str, secrets_key: &dyn Fn() -> crate::secrets::Result<SecretsKey>)
    -> join::Outcome<serde_json::Value> {
    let operation: crate::account::computers::Operation = serde_json::from_str(operation)?;
    let (account, key, storage) = owner_of(state, secrets_key)?;
    let store = crate::account::rows::store::Store::new(&*storage);
    let row = crate::account::computers::apply(&store, &account, &operation, &key, &serde_json::Value::Null, &crate::storage::time_source::RealClock)
        .map_err(|error| format!("the owner operation refused: {error:?}"))?;
    crate::quiet_eprintln!("placement-repair event=applied cause=owner_operation_by_local_key revision={}", row.value.revision);
    Ok(serde_json::json!({"revision": row.value.revision, "keepers": row.value.copy_keepers, "answering": row.value.may_answer,
        "voters": row.value.voters}))
}

/// The account's copy counts (`copy_rule::set_copies`): `computer set-copies STATE_FOLDER JSON`, JSON
/// `{"expected_revision": N, "settings": {least_copy_keepers, least_voters, least_may_answer, least_always_on}}`. The
/// copy rule then keeps the account at those counts by itself (the offered list fills from reports, `fill_offered`).
pub(super) fn set_copies(state: &Path, change: &str, secrets_key: &dyn Fn() -> crate::secrets::Result<SecretsKey>)
    -> join::Outcome<serde_json::Value> {
    #[derive(serde::Deserialize)]
    struct Change { expected_revision: u64, settings: crate::account::computers::copy_rule::CopySettings }
    let change: Change = serde_json::from_str(change)?;
    let (account, _key, storage) = owner_of(state, secrets_key)?;
    let store = crate::account::rows::store::Store::new(&*storage);
    let row = crate::account::computers::copy_rule::set_copies(&store, &account, change.expected_revision, change.settings)
        .map_err(|error| format!("the copy counts refused: {error:?}"))?;
    Ok(serde_json::json!({"revision": row.revision, "settings": row.settings}))
}

/// One computer's host kind for the account (`copy_rule::set_host_kind`, the same owner function as the door's
/// `sign-in:set-host-kind`): `computer set-host-kind STATE_FOLDER JSON`, JSON `{"computer": ID, "kind": KIND,
/// "expected_revision": N}` (0 when the computer has no kind row yet).
pub(super) fn set_host_kind(state: &Path, change: &str, secrets_key: &dyn Fn() -> crate::secrets::Result<SecretsKey>)
    -> join::Outcome<serde_json::Value> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Change { computer: String, kind: String, expected_revision: u64 }
    let change: Change = serde_json::from_str(change)?;
    let (account, _key, storage) = owner_of(state, secrets_key)?;
    let store = crate::account::rows::store::Store::new(&*storage);
    let row = crate::account::computers::copy_rule::set_host_kind(&store, &account, &change.computer, change.expected_revision, &change.kind)
        .map_err(|error| format!("the host kind refused: {error:?}"))?;
    Ok(serde_json::json!({"revision": row.revision, "computer": change.computer, "kind": row.settings.kind}))
}
