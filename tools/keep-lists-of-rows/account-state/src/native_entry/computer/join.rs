// src/native_entry/computer/join.rs
//
// Purpose: add a computer to an account with no hand edits. Three command lines, two on the side of a computer that holds the
// account, one on the new computer:
//   trillion-local computer id        COMPUTER_CONFIG
//   trillion-local computer send-secrets-key COMPUTER_CONFIG ACCOUNT COMPUTER_ID OUT_FILE
//   trillion-local computer take-copy    COMPUTER_CONFIG ACCOUNT OUT_FOLDER [COMPUTER_ID]
//   trillion-local computer join      COMPUTER_CONFIG COPY_FOLDER
// `send-secrets-key` seals the secrets key to the new computer by its id (`secrets::secrets_key::write_sent`): X25519 to the
// computer's own public key, so no secret of the receiver is needed; the new computer takes it at its start
// (`secrets_key::take_sent`). `take_copy` makes a taken copy of the account folder: every store file one consistent snapshot
// (`storage::sqlite::first_copy::take_copy`, made while the computer keeps serving), every other file as it is, and a manifest that
// describes each (rows and identity per table, bytes and BLAKE3 per file), written last. With COMPUTER_ID it also leaves
// the root sent to that computer in the copy folder. `join` makes the account's folder at the new computer from a taken
// copy: each store Filled in keyset pages and read back against the manifest (`first_copy::fill`), each file checked, and
// the account's own rows the new computer needs (its key row and its computers row) written; then, once it starts, the computer follows the writer's feed from the stamp the copy was taken at
// as a computer that is joining (`Copies::joining`).
//
// Non-Negotiable Invariants:
// - Nothing here writes to a computer's live account folder: `take_copy` only reads it (and writes its own new folder), and
//   `join` makes a new folder beside the others (`.new-`), named by the owner id only once it is whole (the receipt is
//   written last inside it), and refuses when the account is already there.
// - a taken copy never carries what belongs to the computer it came from: its lock file, its door note, its root sealed
//   to its own key, a root sent to it, its rows database (its writer row, its copy log), or the WAL files of a store. The
//   rows it carries are the account's key row and its own computers row; every other row reaches a computer that may
//   answer through the feed of the account's writer, never through a file. Sign-in keeps no row here: it is the Better
//   Auth Workshop tool, verified by JWT (src/account/signed_in.rs).
// - A computer that only holds a copy (the row names it a copy keeper or voter, not one that may answer) gets no plain record, no vault
//   file, no settings row and no root from a taken copy: only the account's receipt and object index (ids and file
//   names), its key row and its computers row. Its records and the vault's secrets reach it sealed, through the feed
//   (src/account/computers/copies.rs `for_peer`).
// - `join` refuses a taken copy whose computers row the account's key did not sign, or that does not name this computer as
//   a copy keeper: the owner names the computer first, by one row edit.
// - No root, key or value is printed or put in an error.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{account_folders, read_config, settings, ComputerConfig};
use crate::{
    account::{
        computers::{self, KeptAccount, ComputersRow},
        rows::{self, store::{Family, Row, Store}},
    },
    secrets::secrets_key::{self, ComputerKey},
    storage::sqlite::first_copy::{self, TakenCopy, Filled},
};
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

pub(super) type Outcome<T> = Result<T, Box<dyn std::error::Error>>;

const USAGE: &str = "usage: trillion-local computer owner-operation STATE_FOLDER JSON\n       trillion-local computer set-copies STATE_FOLDER JSON\n       trillion-local computer set-host-kind STATE_FOLDER JSON\n       trillion-local computer repair-placement COMPUTER_ID STATE_FOLDER\n       trillion-local computer add-copy COMPUTER_ID STATE_FOLDER PLACE_ID_FILE\n       trillion-local computer id COMPUTER_CONFIG\n       trillion-local computer send-secrets-key COMPUTER_CONFIG ACCOUNT COMPUTER_ID OUT_FILE\n       trillion-local computer take-copy COMPUTER_CONFIG ACCOUNT OUT_FOLDER [COMPUTER_ID]\n       trillion-local computer join COMPUTER_CONFIG COPY_FOLDER\n       trillion-local computer adopt-hosting-app-account COMPUTER_CONFIG STATE_FOLDER\n       trillion-local computer adopt-hosting-app-account-for COMPUTER_ID STATE_FOLDER OUT_FOLDER";

/// One file of a taken copy, as it was read.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
struct FileEntry {
    path: String,
    bytes: u64,
    blake3: String,
}

/// One store of a taken copy and its description.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
struct StoreEntry {
    path: String,
    #[serde(rename = "frozen")] taken: TakenCopy,
}

/// One of the account's own rows a taken copy carries.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub(super) struct CarriedRow {
    pub(super) family: String,
    pub(super) id: String,
    pub(super) account: String,
    pub(super) expires_at: u64,
    pub(super) value: serde_json::Value,
}

/// The manifest of a taken copy (`copy_manifest` in the computer settings), written last.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    user_id: String,
    owner_id: String,
    address: String,
    #[serde(rename = "frozen_at_ms")] taken_at_ms: i64,
    receipt: FileEntry,
    index: String,
    files: Vec<FileEntry>,
    stores: Vec<StoreEntry>,
    /// Kept under its stored name `sign_in`, so a copy taken before Nov 13 2026 still reads.
    #[serde(rename = "sign_in")]
    rows: Vec<CarriedRow>,
}

/// The computer-config command lines of adding a computer (the module doc).
pub fn command(args: &[String], out: &mut dyn Write) -> Outcome<()> {
    match args {
        [verb, config] if verb == "id" => {
            // This computer's id in computers rows (its own public key): what the owner names it by in a row edit.
            let config = read_config(Path::new(config))?;
            let computer_key = ComputerKey::read(&config.computer_key_file)?;
            crate::io_operation!(writeln!(out, "{}", computers::ComputerSigner::of(&computer_key)?.computer_id()))?;
            Ok(())
        }
        [verb, config, account, computer_id, out_file] if verb == "send-secrets-key" => {
            let config = read_config(Path::new(config))?;
            let folder = held_folder(&config, account)?;
            send_secrets_key(&config, &folder, computer_id, Path::new(out_file))?;
            crate::io_operation!(writeln!(out, "{}", serde_json::json!({"sent_root": true, "to_computer": computer_id})))?;
            Ok(())
        }
        [verb, config, account, out_folder, rest @ ..] if verb == "take-copy" && rest.len() <= 1 => {
            let config = read_config(Path::new(config))?;
            let folder = held_folder(&config, account)?;
            let manifest = take_copy(&config, &folder, Path::new(out_folder), rest.first().map(String::as_str))?;
            let rows: u64 = manifest.stores.iter().flat_map(|store| store.taken.tables.iter()).map(|table| table.rows).sum();
            crate::io_operation!(writeln!(out, "{}", serde_json::json!({
                "taken_copy": manifest.address, "stores": manifest.stores.len(), "rows": rows, "files": manifest.files.len(),
                "sent_root": rest.first().is_some(),
            })))?;
            Ok(())
        }
        [verb, config, taken] if verb == "join" => {
            let config = read_config(Path::new(config))?;
            let joined = join(&config, Path::new(taken))?;
            crate::io_operation!(writeln!(out, "{}", joined))?;
            Ok(())
        }
        [verb, config, state] if verb == "adopt-hosting-app-account" => {
            // Take over an account folder the hosting app keeps (computer/hosted.rs); the hosting app's Keychain item is
            // read only.
            let config = read_config(Path::new(config))?;
            let taken = super::hosted::take_over_folder(&config, Path::new(state), &|| crate::secrets::read_secrets_key_only(Path::new(state)))?;
            crate::io_operation!(writeln!(out, "{taken}"))?;
            Ok(())
        }
        [verb, computer_id, state, out_folder] if verb == "adopt-hosting-app-account-for" => {
            // The same take for a computer that is not this machine (computer/hosted.rs `take_for_computer`): the root is
            // sealed to COMPUTER_ID and the folder is written into OUT_FOLDER, for the operator to move to that computer.
            let taken = super::hosted::take_for_computer(computer_id, Path::new(state), Path::new(out_folder),
                &|| crate::secrets::read_secrets_key_only(Path::new(state)))?;
            crate::io_operation!(writeln!(out, "{taken}"))?;
            Ok(())
        }
        [verb, computer_id, state] if verb == "repair-placement" => {
            // The operator's local repair (computer/hosted.rs `repair_placement`): it names COMPUTER_ID alone, after this
            // engine's own log proves it hosts that computer. The log is the engine's own (Library/Logs/Trillion/engine.log).
            let log = std::path::PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?).join("Library/Logs/Trillion/engine.log");
            let repaired = super::hosted::repair_placement(Path::new(state), computer_id,
                &|| crate::secrets::read_secrets_key_only(Path::new(state)), &log)?;
            writeln!(out, "{repaired}")?;
            Ok(())
        }
        [verb, computer_id, state, place_file] if verb == "add-copy" => {
            // The operator's local add of a copy (computer/hosted.rs `add_copy`): the place's own id is checked first.
            let added = super::hosted::add_copy(computer_id, Path::new(state), Path::new(place_file),
                &|| crate::secrets::read_secrets_key_only(Path::new(state)))?;
            writeln!(out, "{added}")?;
            Ok(())
        }
        [verb, state, json] if verb == "owner-operation" => {
            // One owner computers operation as JSON (computer/hosted.rs `owner_operation`): no computer id is in this command.
            let done = super::hosted::owner_operation(Path::new(state), json, &|| crate::secrets::read_secrets_key_only(Path::new(state)))?;
            writeln!(out, "{done}")?;
            Ok(())
        }
        [verb, state, json] if verb == "set-host-kind" => {
            // One computer's host kind for the account (`computer set-host-kind`, hosted.rs `set_host_kind`).
            let done = super::hosted::set_host_kind(Path::new(state), json, &|| crate::secrets::read_secrets_key_only(Path::new(state)))?;
            writeln!(out, "{done}")?;
            Ok(())
        }
        [verb, state, json] if verb == "set-copies" => {
            // The account's copy counts as JSON (computer/hosted.rs `set_copies`): the copy rule keeps the counts by itself.
            let done = super::hosted::set_copies(Path::new(state), json, &|| crate::secrets::read_secrets_key_only(Path::new(state)))?;
            writeln!(out, "{done}")?;
            Ok(())
        }
        _ => Err(USAGE.into()),
    }
}

/// The account folder named `account` (its owner id) that this computer holds.
fn held_folder(config: &ComputerConfig, account: &str) -> Outcome<PathBuf> {
    account_folders(config)?
        .into_iter()
        .find(|folder| folder.file_name().is_some_and(|name| name == account))
        .ok_or_else(|| crate::refusal_cause::CodedError::new("ACCOUNT is not an account folder of this computer").into())
}

/// The secrets key of the account in `folder`, opened with this computer's key, sealed to the computer `computer_id` as the
/// sent secrets key file `out`.
fn send_secrets_key(config: &ComputerConfig, folder: &Path, computer_id: &str, out: &Path) -> Outcome<()> {
    let receipt_bytes = crate::io_operation!(fs::read(folder.join(&settings().receipt_file)))?;
    let (user_id, _, _) = receipt_ids(&receipt_bytes)?;
    let raw = rows::open(folder).map_err(|error| crate::refusal_cause::CodedError::with_cause("the account's rows did not open", crate::refusal_cause::Caused::cause(&error)))?;
    let store = Store::new(&*raw);
    let named = computers::kept_row(&*raw, &user_id).is_some_and(|told| computers::names_computer(&told.row, computer_id));
    computers::answer_allowed(&store, &user_id, computer_id, named)
        .map_err(|error| crate::refusal_cause::CodedError::with_cause("computer_host_kind_cannot_answer", error.cause()))?;
    let secrets_key = secrets_key::open_sealed(folder, &config.computer_key_file)?;
    secrets_key::write_sent(out, &secrets_key, computer_id)?;
    Ok(())
}

/// The ids the receipt of the account in `folder` names: its user id and owner id, and its object index file.
pub(super) fn receipt_ids(receipt: &[u8]) -> Outcome<(String, String, String)> {
    let value: serde_json::Value = serde_json::from_slice(receipt).map_err(|error| crate::refusal_cause::CodedError::with_cause("the account receipt is unreadable", crate::refusal_cause::Caused::cause(&error)))?;
    let text = |at: &serde_json::Value| at.as_str().filter(|text| !text.is_empty()).map(str::to_owned);
    let user = text(&value["account"]["userId"]).ok_or(crate::refusal_cause::CodedError::new("the account receipt names no user"))?;
    let owner = text(&value["account"]["ownerId"]).ok_or(crate::refusal_cause::CodedError::new("the account receipt names no owner"))?;
    let index = text(&value["objects"]["path"]).ok_or(crate::refusal_cause::CodedError::new("the account receipt names no object index"))?;
    if !plain_relative(Path::new(&index)) {
        return Err(crate::refusal_cause::CodedError::new("the account receipt names an object index outside its folder").into());
    }
    Ok((user, owner, index))
}

/// A relative path with only plain parts: no `..`, no `.`, no root.
pub(super) fn plain_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|part| matches!(part, Component::Normal(_)))
}

/// Whether the file at `path` starts as an SQLite database does.
pub(super) fn is_store(path: &Path) -> bool {
    let mut head = [0u8; 16];
    fs::File::open(path).and_then(|mut file| std::io::Read::read_exact(&mut file, &mut head)).is_ok() && &head == b"SQLite format 3\0"
}

/// The files of the account folder that stay at their computer, by their path in the folder.
fn computer_local(folder: &Path) -> Outcome<Vec<PathBuf>> {
    let settings = settings();
    let mut local = vec![
        folder.join(&settings.lock_file),
        folder.join(&settings.joining_marker),
        folder.join(&rows::contract().door_note_file),
        folder.join(&rows::contract().database_file),
        secrets_key::sealed_file(folder)?,
        secrets_key::sent_file(folder)?,
    ];
    local.sort();
    Ok(local)
}

/// Every regular file under `folder`, by its path relative to it, in name order; links are left out.
pub(super) fn walk(folder: &Path, under: &Path, found: &mut Vec<PathBuf>) -> Outcome<()> {
    let mut entries: Vec<_> = crate::io_operation!(crate::io_operation!(fs::read_dir(folder.join(under)))?.collect::<Result<_, _>>())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let relative = under.join(entry.file_name());
        let kind = crate::io_operation!(fs::symlink_metadata(entry.path()))?.file_type();
        if kind.is_dir() {
            walk(folder, &relative, found)?;
        } else if kind.is_file() {
            found.push(relative);
        }
    }
    Ok(())
}

fn file_entry(path: &Path, relative: &Path) -> Outcome<(FileEntry, Vec<u8>)> {
    let bytes = crate::io_operation!(fs::read(path))?;
    let entry = FileEntry {
        path: relative.to_str().ok_or(crate::refusal_cause::CodedError::new("a file name is not text"))?.to_owned(),
        bytes: bytes.len() as u64,
        blake3: blake3::hash(&bytes).to_hex().to_string(),
    };
    Ok((entry, bytes))
}

/// Write `bytes` as a new file `path` (mode 0600), its folders made first.
pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Outcome<()> {
    use crate::tool_runs::os::{Open, OwnerFiles, This};
    if let Some(parent) = path.parent() {
        crate::io_operation!(fs::create_dir_all(parent))?;
    }
    let mut file = crate::io_operation!(This::open(fs::OpenOptions::new().write(true).create_new(true), &path, Open::owner_only(0o600)))?;
    crate::io_operation!(file.write_all(bytes))?;
    crate::io_operation!(file.sync_all())?;
    Ok(())
}

/// The rows a taken copy of the account (user id `user`) carries: its key row and its own computers row (family
/// `computers`).
pub(super) fn carried_rows(folder: &Path, user: &str) -> Outcome<(KeptAccount, Vec<CarriedRow>)> {
    let raw = rows::open(folder).map_err(|error| crate::refusal_cause::CodedError::with_cause("the account's rows did not open", crate::refusal_cause::Caused::cause(&error)))?;
    let told = computers::kept_row(&*raw, user).ok_or(crate::refusal_cause::CodedError::new("the account has no computers row its own key signed"))?;
    let store = Store::new(&*raw);
    let wanted = [
        (Family::Computers, format!("{}{user}", computers::settings().key_prefix)),
        (Family::Computers, computers::Subject::Account(told.row.account.clone()).row_id()),
    ];
    let mut rows = Vec::new();
    for (family, id) in wanted {
        if let Some(row) = store.get::<serde_json::Value>(family, &id).map_err(|error| crate::refusal_cause::CodedError::with_cause("an account row could not be read", crate::refusal_cause::Caused::cause(&error)))? {
            rows.push(CarriedRow { family: family.name().to_owned(), id: row.id, account: row.account, expires_at: row.expires_at, value: row.value });
        }
    }
    Ok((told, rows))
}

/// Make the taken copy of the account in `folder` in `out` (a folder that must not exist yet). With `to_computer`, the
/// secrets key sent to that computer is left in it too.
fn take_copy(config: &ComputerConfig, folder: &Path, out: &Path, to_computer: Option<&str>) -> Outcome<Manifest> {
    let settings = settings();
    if out.exists() {
        return Err(crate::refusal_cause::CodedError::new("OUT_FOLDER is already there; a taken copy is made in a new folder").into());
    }
    let receipt_bytes = crate::io_operation!(fs::read(folder.join(&settings.receipt_file)))?;
    let (user_id, owner_id, index) = receipt_ids(&receipt_bytes)?;
    let (told, carried) = carried_rows(folder, &user_id)?;
    crate::io_operation!(fs::create_dir_all(out))?;
    let made = (|| {
        let local = computer_local(folder)?;
        let mut found = Vec::new();
        walk(folder, Path::new(""), &mut found)?;
        let (mut files, mut stores) = (Vec::new(), Vec::new());
        let mut receipt = None;
        for relative in found {
            let path = folder.join(&relative);
            let name = relative.to_string_lossy();
            let beside = ["-wal", "-shm", "-journal", ".next", ".new"].iter().any(|suffix| name.ends_with(suffix));
            if beside || local.binary_search(&path).is_ok() {
                continue;
            }
            if relative == Path::new(&settings.receipt_file) {
                receipt = Some(file_entry(&path, &relative)?.0);
                continue;
            }
            if is_store(&path) {
                let target = out.join(&relative);
                if let Some(parent) = target.parent() {
                    crate::io_operation!(fs::create_dir_all(parent))?;
                }
                let taken = first_copy::take_copy(&path, &target)?;
                stores.push(StoreEntry { path: name.into_owned(), taken });
            } else {
                let (entry, bytes) = file_entry(&path, &relative)?;
                write_new(&out.join(&relative), &bytes)?;
                files.push(entry);
            }
        }
        let receipt = receipt.ok_or(crate::refusal_cause::CodedError::new("the account folder holds no receipt"))?;
        // The receipt goes as it was read when taking the copy began: the ids above are its ids.
        if receipt.blake3 != blake3::hash(&receipt_bytes).to_hex().as_str() {
            return Err::<Manifest, Box<dyn std::error::Error>>(crate::refusal_cause::CodedError::new("the account receipt changed while it was taken").into());
        }
        write_new(&out.join(&settings.receipt_file), &receipt_bytes)?;
        if let Some(computer_id) = to_computer {
            send_secrets_key(config, folder, computer_id, &secrets_key::sent_file(out)?)?;
        }
        let manifest = Manifest {
            version: settings.copy_version,
            user_id,
            owner_id,
            address: told.row.account.clone(),
            taken_at_ms: super::now_ms(),
            receipt,
            index,
            files,
            stores,
            rows: carried,
        };
        write_new(&out.join(&settings.copy_manifest), &serde_json::to_vec_pretty(&manifest).map_err(|error| { let cause = crate::refusal_cause::Caused::cause(&error); crate::refusal_cause::CodedError::with_cause(error, cause) })?)?;
        Ok(manifest)
    })();
    if made.is_err() {
        let _ = fs::remove_dir_all(out);
    }
    made
}

/// Whether a carried row of family `name` is one a joining computer writes: the computers family alone (the key row and
/// the computers row). A copy taken before sign-in left the engine (Nov 13 2026) also carries the account's sign-in
/// settings rows (family `lists`); they are not written, since nothing reads them now.
pub(super) fn written_family(name: &str) -> bool {
    name == Family::Computers.name()
}

/// The account's computers row and key a manifest carries, believed for its address.
fn manifest_row(manifest: &Manifest) -> Outcome<KeptAccount> {
    let key_id = format!("{}{}", computers::settings().key_prefix, manifest.user_id);
    let row_id = computers::Subject::Account(manifest.address.clone()).row_id();
    let find = |id: &str| manifest.rows.iter().find(|row| row.family == Family::Computers.name() && row.id == id);
    let key = find(&key_id).and_then(|row| row.value["public_key"].as_str().map(str::to_owned)).ok_or(crate::refusal_cause::CodedError::new("the taken copy carries no account key"))?;
    let row: ComputersRow = serde_json::from_value(find(&row_id).ok_or(crate::refusal_cause::CodedError::new("the taken copy carries no computers row"))?.value.clone())
        .map_err(|error| crate::refusal_cause::CodedError::with_cause("the taken copy's computers row is unreadable", crate::refusal_cause::Caused::cause(&error)))?;
    let told = KeptAccount { row, account_key: key };
    if !told.believed(&manifest.address) {
        return Err(crate::refusal_cause::CodedError::new("the taken copy's computers row is not signed by the account's own key").into());
    }
    Ok(told)
}

/// Make the account's folder at this computer from the taken copy `taken` (the module doc). Answers what was done, as one
/// JSON line: the address, whether this computer may answer, and each store's fill.
fn join(config: &ComputerConfig, taken: &Path) -> Outcome<serde_json::Value> {
    let settings = settings();
    let manifest_bytes = super::bounded_file(&taken.join(&settings.copy_manifest), settings.copy_manifest_max_bytes,
        super::Stage::Accounts, "the taken copy's manifest")?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause("the taken copy's manifest is unreadable", crate::refusal_cause::Caused::cause(&error)))?;
    if manifest.version != settings.copy_version {
        return Err(crate::refusal_cause::CodedError::new("the taken copy has another format version").into());
    }
    let computer_key = ComputerKey::read(&config.computer_key_file)?;
    let me = computers::ComputerSigner::of(&computer_key)?.computer_id();
    let told = manifest_row(&manifest)?;
    if !told.row.copy_keepers.contains(&me) && !told.row.voters.contains(&me) {
        return Err(crate::refusal_cause::CodedError::new("the account's computers row does not name this computer; the owner names it as a copy keeper first").into());
    }
    let may_answer = told.row.may_answer.contains(&me);
    let target = config.accounts.join(&manifest.owner_id);
    if target.exists() || !plain_relative(Path::new(&manifest.owner_id)) {
        return Err(crate::refusal_cause::CodedError::new("this computer already holds the account, or its owner id is not a folder name").into());
    }
    let receipt_bytes = crate::io_operation!(fs::read(taken.join(&settings.receipt_file)))?;
    let (user, owner, index) = receipt_ids(&receipt_bytes)?;
    if (user.as_str(), owner.as_str(), index.as_str()) != (manifest.user_id.as_str(), manifest.owner_id.as_str(), manifest.index.as_str())
        || blake3::hash(&receipt_bytes).to_hex().as_str() != manifest.receipt.blake3
    {
        return Err(crate::refusal_cause::CodedError::new("the taken copy's receipt is not the one its manifest names").into());
    }
    let making = config.accounts.join(format!("{}{}", crate::account::create::UNFINISHED_PREFIX, &manifest.owner_id[..16.min(manifest.owner_id.len())]));
    if making.exists() {
        return Err(crate::refusal_cause::CodedError::new("a join of this account is already being made here").into());
    }
    crate::io_operation!(fs::create_dir_all(&making))?;
    let made = (|| {
        let mut Filled: Vec<serde_json::Value> = Vec::new();
        for file in &manifest.files {
            let relative = Path::new(&file.path);
            if !plain_relative(relative) {
                return Err::<serde_json::Value, Box<dyn std::error::Error>>(crate::refusal_cause::CodedError::new("the taken copy names a file outside its folder").into());
            }
            // A computer that only holds a copy takes the object index alone: ids and file names, no value.
            if !may_answer && file.path != manifest.index {
                continue;
            }
            let bytes = crate::io_operation!(fs::read(taken.join(relative)))?;
            if bytes.len() as u64 != file.bytes || blake3::hash(&bytes).to_hex().as_str() != file.blake3 {
                return Err(crate::refusal_cause::CodedError::new("a file of the taken copy is not the one its manifest names").into());
            }
            write_new(&making.join(relative), &bytes)?;
        }
        if may_answer {
            for store in &manifest.stores {
                let relative = Path::new(&store.path);
                if !plain_relative(relative) {
                    return Err(crate::refusal_cause::CodedError::new("the taken copy names a store outside its folder").into());
                }
                let target = making.join(relative);
                if let Some(parent) = target.parent() {
                    crate::io_operation!(fs::create_dir_all(parent))?;
                }
                let Filled { pages, rows, bytes, largest_page_bytes, ms } = first_copy::fill(&taken.join(relative), &store.taken, &target)?;
                Filled.push(serde_json::json!({"store": store.path, "pages": pages, "rows": rows, "bytes": bytes,
                    "largest_page_bytes": largest_page_bytes, "ms": ms}));
            }
            let sent = secrets_key::sent_file(taken)?;
            if sent.exists() {
                write_new(&secrets_key::sent_file(&making)?, &crate::io_operation!(fs::read(sent))?)?;
            }
        }
        // The account's own rows it carries: its key row and its computers row, at every computer that joins.
        let raw = rows::open(&making).map_err(|error| crate::refusal_cause::CodedError::with_cause("the account rows could not be made", crate::refusal_cause::Caused::cause(&error)))?;
        let store = Store::new(&*raw);
        for carried in &manifest.rows {
            if !written_family(&carried.family) {
                continue;
            }
            let row = Row { id: carried.id.clone(), account: carried.account.clone(), expires_at: carried.expires_at, value: carried.value.clone() };
            store.insert(Family::Computers, &row).map_err(|error| crate::refusal_cause::CodedError::with_cause("an account row could not be written", crate::refusal_cause::Caused::cause(&error)))?;
        }
        drop(raw);
        // Until it has caught up once, the computer joins: it neither claims the writer role nor votes for a takeover.
        write_new(&making.join(&settings.joining_marker), manifest.address.as_bytes())?;
        write_new(&making.join(&settings.receipt_file), &receipt_bytes)?;
        crate::io_operation!(fs::rename(&making, &target))?;
        Ok(serde_json::json!({"joined": manifest.address, "owner": manifest.owner_id, "computer": me, "answering": may_answer,
            "frozen_at_ms": manifest.taken_at_ms, "stores": Filled}))
    })();
    match made {
        Ok(value) => Ok(value),
        Err(error) => {
            let _ = fs::remove_dir_all(&making);
            Err(error)
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::account::computers::{Change, Subject};

    fn key_text(byte: u8) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode([byte; 32])
    }

    /// A computer folder in `dir` with its own key (`byte`) and config; answers the config and the computer's id.
    pub(in crate::native_entry::computer) fn computer(dir: &Path, byte: u8) -> (ComputerConfig, String) {
        fs::create_dir_all(dir.join("accounts")).unwrap();
        fs::write(dir.join("computer.key"), key_text(byte)).unwrap();
        let config = serde_json::json!({
            "listen": "127.0.0.1:7199",
            "accounts": dir.join("accounts"),
            "place_key_file": dir.join("computer.key"),
            "public_origin": "https://computer.test",
            "report": {"storage": {"keep_free_bytes": 0}, "reach": "https://computer.test", "cost_per_month_cents": 0,
                "contained_tools": false, "takes_new_accounts": false},
            "sign_in": {"relying_party_drop_labels": 1, "max_body_bytes": 16384, "expired_rows_per_write": 100},
            "new_accounts": crate::account::rows::StartingRows::for_tests(),
        });
        fs::write(dir.join("computer.json"), config.to_string()).unwrap();
        let config = read_config(&dir.join("computer.json")).unwrap();
        let id = computers::ComputerSigner::of(&ComputerKey::read(&config.computer_key_file).unwrap()).unwrap().computer_id();
        (config, id)
    }

    /// The account in `folder` names `copy_keepers`, `may_answer` and `voters` in its computers row, signed with its own key.
    fn name_computers(folder: &Path, owner: &str, user: &str, key_file: &Path, copy_keepers: &[&str], may_answer: &[&str], voters: &[&str]) {
        let secrets_key = secrets_key::open_sealed(folder, key_file).unwrap();
        let vault = crate::secrets::open_with_secrets_key(folder, owner, &secrets_key).unwrap();
        let key = computers::kept_account_key(&vault).unwrap();
        let raw = rows::open(folder).unwrap();
        let store = Store::new(&*raw);
        computers::keep_public_key(&store, user, &key).unwrap();
        let list = |names: &[&str]| names.iter().map(|name| name.to_string()).collect::<Vec<_>>();
        let change = Change { pursuit: None, expected_revision: 0, copy_keepers: list(copy_keepers), may_answer: list(may_answer), voters: list(voters) };
        computers::edit(&store, user, &Subject::Account(key.address()), &change, &key, &serde_json::Value::Null).unwrap();
    }

    /// The host kind of `computer` for the account in `folder`, set explicitly (copy_rule `set_host_kind`, expected revision 0).
    fn set_kind(folder: &Path, user: &str, computer: &str, kind: &str) {
        let raw = rows::open(folder).unwrap();
        computers::copy_rule::set_host_kind(&Store::new(&*raw), user, computer, 0, kind).unwrap();
    }

    /// A placed account this computer does not hold the signing key of waits as a joining account: its kept row names this
    /// computer, so the composition refusal (`SIGNING_KEY_NOT_KEPT`) takes the waiting path (`waiting_for_key`), and the
    /// same refusal for a computer the row does not name stays skipped.
    #[test]
    fn a_placed_account_without_its_signing_key_waits_as_a_joining_account() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let (a, id_a) = computer(&base.join("a"), 9);
        let (_, id_b) = computer(&base.join("b"), 10);
        let (_, id_d) = computer(&base.join("d"), 12);
        computers::choose_this_computer(a.report.clone()).ok();
        let key_a = ComputerKey::read(&a.computer_key_file).unwrap();
        let created = crate::account::create::create_named(&a.accounts, &key_a, a.new_accounts.as_ref().unwrap()).unwrap();
        let folder = a.accounts.join(&created.owner_id);
        name_computers(&folder, &created.owner_id, &created.user_id, &a.computer_key_file, &[&id_a, &id_b], &[&id_a], &[&id_a, &id_b]);

        let key_missing = crate::native_entry::computer::ComputerError::new(crate::native_entry::computer::Stage::Composition, computers::SIGNING_KEY_NOT_KEPT);
        let waiting = crate::native_entry::computer::waiting_for_key(&folder, &id_b, &key_missing)
            .expect("a placed account without its key joins as a waiting account");
        assert_eq!(waiting.user_id, created.user_id);
        assert_eq!(waiting.owner_id, created.owner_id);
        assert!(crate::native_entry::computer::waiting_for_key(&folder, &id_d, &key_missing).is_none(), "a computer the row does not name stays skipped");
    }

    #[test]
    fn a_taken_copy_joins_a_computer_that_may_answer_whole_and_a_copy_only_computer_with_ids_only() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let (a, id_a) = computer(&base.join("a"), 9);
        let (b, id_b) = computer(&base.join("b"), 10);
        let (c, id_c) = computer(&base.join("c"), 11);
        let (d, _) = computer(&base.join("d"), 12);
        computers::choose_this_computer(a.report.clone()).ok();
        let key_a = ComputerKey::read(&a.computer_key_file).unwrap();
        let created = crate::account::create::create_named(&a.accounts, &key_a, a.new_accounts.as_ref().unwrap()).unwrap();
        let folder = a.accounts.join(&created.owner_id);
        // A record in the account's own store before the copy was taken.
        {
            let path = folder.join("records.sqlite");
            let db = rusqlite::Connection::open(&path).unwrap();
            let tables: i64 = db.query_row("SELECT count(*) FROM sqlite_schema WHERE type='table'", [], |row| row.get(0)).unwrap();
            assert!(tables > 0, "the account's records store is made with it");
        }
        // Before the account's row names the new computer, a taken copy does not join it.
        // B's kind is named, not left to the default for a computer named for the first time (9bdfd0021): a kind that allows answering.
        set_kind(&folder, &created.user_id, &id_b, "hosting-place");
        name_computers(&folder, &created.owner_id, &created.user_id, &a.computer_key_file, &[&id_a, &id_b, &id_c], &[&id_a, &id_b], &[&id_a]);

        let copy_b = base.join("taken-b");
        let manifest = take_copy(&a, &folder, &copy_b, Some(&id_b)).unwrap();
        assert_eq!(manifest.address, created.address);
        assert!(manifest.stores.iter().any(|store| store.path == "records.sqlite"), "{:?}", manifest.stores.iter().map(|s| &s.path).collect::<Vec<_>>());
        assert!(!copy_b.join(rows::contract().database_file.as_str()).exists(), "no rows database travels");
        assert!(!secrets_key::sealed_file(&copy_b).unwrap().exists(), "no root sealed to A's key travels");
        assert!(secrets_key::sent_file(&copy_b).unwrap().exists(), "the root sent to B travels");
        assert!(take_copy(&a, &folder, &copy_b, None).is_err(), "a taken copy is made in a new folder only");
        let ids: Vec<&str> = manifest.rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ids.len(), 2, "the key row and the computers row: {ids:?}");

        // B may answer: it gets every store, Filled and read back, the files, the settings rows and the sent secrets key.
        let joined = join(&b, &copy_b).unwrap();
        assert_eq!(joined["answering"], true, "{joined}");
        let at_b = b.accounts.join(&created.owner_id);
        for store in &manifest.stores {
            assert_eq!(first_copy::describe(&at_b.join(&store.path)).unwrap(), store.taken, "{} Filled whole", store.path);
        }
        assert!(at_b.join(&settings().joining_marker).exists());
        assert!(!at_b.join(&settings().lock_file).exists(), "no lock of A's travels");
        let raw = rows::open(&at_b).unwrap();
        let kept = computers::kept_row(&*raw, &created.user_id).expect("B reads the row with the account's own key");
        assert_eq!(kept.row.account, created.address);
        drop(raw);
        // At start B is a computer that joins: the row names it and voters, and its root is not sealed to its key yet.
        let key_b = ComputerKey::read(&b.computer_key_file).unwrap();
        assert!(matches!(super::super::placement_of(&at_b, &key_b, &id_b), super::super::Placement::Joins(_)));
        assert!(secrets_key::take_sent(&at_b, &key_b, &computers::settings().computer_id_context).unwrap());
        assert!(matches!(super::super::placement_of(&at_b, &key_b, &id_b), super::super::Placement::Serves), "with its root, B opens the account as any");
        assert_eq!(super::super::records_file_of(&at_b), Some(at_b.join("records.sqlite")));
        assert!(join(&b, &copy_b).is_err(), "B already holds the account");

        // C only holds a copy: the receipt and the object index, the key row and the computers row; no value at all.
        let copy_c = base.join("taken-c");
        take_copy(&a, &folder, &copy_c, None).unwrap();
        let joined = join(&c, &copy_c).unwrap();
        assert_eq!(joined["answering"], false, "{joined}");
        let at_c = c.accounts.join(&created.owner_id);
        let mut held = Vec::new();
        walk(&at_c, Path::new(""), &mut held).unwrap();
        let held: Vec<String> = held.iter().map(|path| path.to_string_lossy().into_owned()).filter(|name| !name.ends_with("-wal") && !name.ends_with("-shm")).collect();
        assert_eq!(held, vec!["objects.jsonl", "places-joining", "restore-receipt.json", "sign-in.sqlite"], "{held:?}");
        let raw = rows::open(&at_c).unwrap();
        assert!(computers::kept_row(&*raw, &created.user_id).is_some());
        drop(raw);
        let key_c = ComputerKey::read(&c.computer_key_file).unwrap();
        assert!(matches!(super::super::placement_of(&at_c, &key_c, &id_c), super::super::Placement::Joins(_)), "C joins, and never opens a vault");
        assert_eq!(super::super::records_file_of(&at_c), Some(at_c.join("records.sqlite")));

        // A computer the row does not name is refused, and leaves nothing behind.
        assert!(join(&d, &copy_c).is_err());
        assert_eq!(fs::read_dir(&d.accounts).unwrap().count(), 0);
        // a taken copy whose store was changed after the copy was taken is refused, and leaves nothing behind.
        let copy_e = base.join("taken-e");
        take_copy(&a, &folder, &copy_e, None).unwrap();
        {
            let db = rusqlite::Connection::open(copy_e.join("records.sqlite")).unwrap();
            db.execute_batch("CREATE TABLE IF NOT EXISTS planted(x); INSERT INTO planted VALUES(1);").unwrap();
        }
        fs::remove_dir_all(&at_b).unwrap();
        assert!(join(&b, &copy_e).is_err(), "a store that does not match its description is refused");
        assert_eq!(fs::read_dir(&b.accounts).unwrap().count(), 0);
    }
}
