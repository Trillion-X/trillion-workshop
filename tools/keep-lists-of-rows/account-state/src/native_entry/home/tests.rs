// Tests of the one home and its layout (src/native_entry/home.rs, home.json).

use super::*;
use std::collections::BTreeMap;

const NO_ENV: &dyn Fn(&str) -> Option<String> = &|_| None;

/// Every trillion-local DATA file in this repository's sources (src and crates), by path.
fn engine_data_files() -> BTreeMap<String, String> {
    fn walk(folder: &Path, root: &Path, out: &mut BTreeMap<String, String>) {
        for entry in fs::read_dir(folder).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                if let Ok(text) = fs::read_to_string(&path) {
                    out.insert(path.strip_prefix(root).unwrap().to_string_lossy().into_owned(), text);
                }
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = BTreeMap::new();
    for folder in ["src", "crates"] {
        walk(&root.join(folder), root, &mut files);
    }
    files
}

#[test]
fn the_layout_is_well_formed_and_lists_todays_entries() {
    let layout = layout();
    assert!(layout.valid());
    assert_eq!(layout.default_name(), ".trillion");
    assert_eq!(layout.entries.len(), 44, "the 29 entries of today's home, `hooks`, nine more live tool writers, and five job folders not moved yet");
    assert_eq!(layout.entries.iter().filter(|row| row.moved_from.is_none()).count(), 39);
    for (name, writer) in [("accounts", Writer::Engine), ("hooks", Writer::Engine), ("cli", Writer::Workshop),
        ("listening", Writer::Workshop), ("kept", Writer::Person), ("installed-programs.json", Writer::Workshop),
        ("session-message-cursors", Writer::AiCliHook), ("runtime.json", Writer::App), ("speaking", Writer::App),
        ("hands-free", Writer::Nobody), ("managed-settings.json", Writer::Person)] {
        assert_eq!(layout.row(name).map(|row| row.writer), Some(writer), "{name}");
    }
    assert_eq!(layout.row("installed-programs.json").unwrap().kind, Kind::File);
    assert_eq!(layout.row("host.sealed.log").unwrap().kind, Kind::File);
    let engine: Vec<&str> = layout.entries.iter().filter(|row| row.writer == Writer::Engine).map(|row| row.name.as_str()).collect();
    assert_eq!(engine, ["accounts", "hooks"]);
}

/// (a) No trillion-local DATA names a path in the person's Trillion home by itself: every such path is a layout entry
/// and a path inside it. Every trillion-local row's reader names its entry, so a row with no reader cannot stay.
#[test]
fn every_engine_path_is_a_layout_entry_and_each_engine_row_is_read() {
    let layout = layout();
    let files = engine_data_files();
    let mark = format!("{}/", layout.default);
    for (path, text) in &files {
        if path.ends_with("native_entry/home.json") {
            continue;
        }
        assert!(!text.contains(&mark), "{path} names `{mark}` itself: name an entry of src/native_entry/home.json instead");
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for row in layout.entries.iter().filter(|row| row.writer == Writer::Engine) {
        let reader = row.reader.as_deref().unwrap();
        let text = fs::read_to_string(root.join(reader)).unwrap_or_else(|_| panic!("{}: its reader {reader} is not in the repository", row.name));
        assert!(text.contains(&format!("\"{}", row.name)) || text.contains(&format!("`{}`", row.name)) || text.contains(&format!("\"{}/", row.name)),
            "{reader} does not name the engine entry `{}`", row.name);
    }
}

/// The one home: the default under the person's home, or the folder the one setting names; nothing else.
#[test]
fn the_home_is_the_default_unless_the_one_setting_names_another() {
    let layout = layout();
    assert_eq!(Home::of(NO_ENV, Some(Path::new("/p"))).unwrap().root(), Path::new("/p/.trillion"));
    let set = |name: &str| (name == layout.setting).then(|| "/elsewhere/home".to_owned());
    assert_eq!(Home::of(&set, Some(Path::new("/p"))).unwrap().root(), Path::new("/elsewhere/home"));
    let relative = |name: &str| (name == layout.setting).then(|| "relative".to_owned());
    assert_eq!(Home::of(&relative, Some(Path::new("/p"))), None, "a relative setting names no home");
    assert_eq!(Home::of(NO_ENV, None), None);
    assert_eq!(Home::of(NO_ENV, Some(Path::new("p"))), None);
}

/// trillion-local refuses an entry with no trillion-local row before it makes anything, naming the entry.
#[test]
fn an_engine_path_under_an_unlisted_entry_is_refused_and_named() {
    let home = Home::of(NO_ENV, Some(Path::new("/h"))).unwrap();
    assert_eq!(home.engine_path("hooks/record-every-message").unwrap(), Path::new("/h/.trillion/hooks/record-every-message"));
    assert_eq!(home.engine_path("accounts").unwrap(), Path::new("/h/.trillion/accounts"));
    for (inside, entry) in [("listen-test-abc/on.json", "listen-test-abc"), ("rollback", "rollback"),
        ("kept/x", "kept"), ("drive/x", "drive"), ("hooks/../kept", "hooks/../kept"), ("/abs", "/abs"), ("", "")] {
        assert_eq!(home.engine_path(inside), Err(Unlisted(entry.to_owned(), crate::cause!())), "{inside}");
    }
    assert_eq!(home.admits(Path::new("/h/.trillion/accounts")), Ok(()));
    assert_eq!(home.admits(Path::new("/h/.trillion/accounts/one")), Ok(()));
    assert_eq!(home.admits(Path::new("/srv/accounts")), Ok(()), "a folder outside the home is the config's own");
    assert_eq!(home.admits(Path::new("/h/.trillion/scratch/accounts")), Err(Unlisted("scratch".into(), crate::cause!())));
    assert_eq!(home.admits(Path::new("/h/.trillion")), Err(Unlisted(String::new(), crate::cause!())));
}

/// (c) A home holding entries with no row reports each, and only those.
#[test]
fn undeclared_entries_lists_each_entry_without_a_row() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join(".trillion");
    assert!(undeclared_entries(&home).is_empty(), "a missing home holds nothing undeclared");
    fs::create_dir_all(home.join("listen-test-abc")).unwrap();
    fs::create_dir_all(home.join("rollback")).unwrap();
    fs::create_dir_all(home.join("accounts")).unwrap();
    fs::write(home.join("installed-programs.json"), b"{}").unwrap();
    assert_eq!(undeclared_entries(&home), ["listen-test-abc", "rollback"]);
}

/// (b) Account creation, trillion-local's writer of the `accounts` entry, run against a temporary person home: the folder
/// trillion-local is given is its home's `accounts` entry, and after it the home holds only layout rows and the person's
/// home holds nothing but the home (trillion-local wrote nothing outside it). The hook command, its other writer,
/// is run the same way in src/account/hooks/tests.rs.
#[test]
fn account_creation_makes_only_listed_entries_and_nothing_outside_the_home() {
    let temp = tempfile::tempdir().unwrap();
    // The account's stores refuse a path through a symbolic link, so the test names the real path.
    let person = fs::canonicalize(temp.path()).unwrap();
    let home = Home::of(NO_ENV, Some(&person)).unwrap();
    let accounts = home.engine_path("accounts").unwrap();
    fs::create_dir_all(&accounts).unwrap();
    let computer = crate::secrets::secrets_key::ComputerKey::from_bytes(vec![7; 32]).unwrap();
    crate::account::create::create_named(&accounts, &computer, &crate::account::rows::StartingRows::for_tests()).unwrap();
    assert_eq!(fs::read_dir(&accounts).unwrap().count(), 1, "one account folder");
    assert!(undeclared_entries(home.root()).is_empty(), "{:?}", undeclared_entries(home.root()));
    let outside: Vec<String> = fs::read_dir(&person).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(outside, [layout().default_name()], "the engine wrote outside its home");
}

/// Every Application Support entry the layout moves goes to a row (or is deleted or ignored), and every row not in the
/// home yet is the target of a move.
#[test]
fn every_second_home_entry_has_its_job_folder() {
    let layout = layout();
    for row in layout.entries.iter().filter(|row| row.moved_from.is_some()) {
        assert!(layout.moves.iter().any(|moved| moved.to.split('/').next() == Some(row.name.as_str())), "{} is no move's target", row.name);
    }
    assert!(layout.moves.iter().any(|moved| moved.from == "local-runtime.json" && moved.to == "runtime.json"));
}

/// The state folder the app chooses (src/native_boot.rs) is refused inside this process's
/// home unless it is under an entry trillion-local writes; outside the home it is not the layout's to judge.
#[test]
fn a_selected_state_folder_in_an_unlisted_entry_of_the_home_is_refused() {
    let Some(home) = Home::of_this_process() else { return };
    assert!(crate::native_boot::state_in_its_entry(&home.root().join("accounts/an-account")));
    assert!(!crate::native_boot::state_in_its_entry(&home.root().join("rollback/an-account")));
    assert!(!crate::native_boot::state_in_its_entry(&home.root().join("kept/an-account")), "kept is the person's");
    assert!(!crate::native_boot::state_in_its_entry(home.root()), "not the home's top itself");
    assert!(crate::native_boot::state_in_its_entry(Path::new("/elsewhere/state")));
}
