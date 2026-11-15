// tests/native_boot.rs
//
// Purpose: Check the actual private selection reader without adopting an account.
// Invariants: no self-authenticating Launch, new account/session or fallback;
// byte, pathname, owner and source changes refuse before state can be mounted.
// Key Concepts: synthetic existing descriptor and independently pinned DATA.
// Security Considerations: synthetic metadata only, no real token or original opens.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#![cfg(unix)]
#[path = "native_boot/mcp_capture.rs"]
mod mcp_capture;
#[path = "support/carried_selection.rs"]
mod carried_selection;
use serde_json::{json, Value};
use content_crypto::advanced::blake3;
use std::{
    fs,
    net::SocketAddr,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
};
use trillion_local::native_boot::{Error, Selection};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    state: PathBuf,
    descriptor: PathBuf,
    carried: PathBuf,
    source: Value,
}
fn data(path: &Path, value: Value) -> Value {
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, &bytes).unwrap();
    json!({"path":path,"pin":{"bytes":bytes.len(),"blake3":blake3::hash(&bytes).to_hex().as_str()}})
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let state = root.join("state");
        fs::create_dir(&state).unwrap();
        // Each carried file sits at its carried path inside the frontend folder, as an app holds it.
        let dom = data(
            &root.join("data/inputs.json"),
            json!({"element_id":"first","item_reads":{"element_id":"items"}}),
        );
        let first_answers = data(
            &root.join("data/first_answers.json"),
            json!({"kept":{"store_prefix":"trillion-kept-"}}),
        );
        let source = json!({"version":"trillion.local-runtime-adoption/v1","state":state,
            "receipt_identity":"a".repeat(64),"port":28788,"native":{
            "version":"trillion.native-selection/v1","receipt_bytes":1024,
            "app_kv":{"sqlite":"storage/kv/current.sqlite","namespace":"trillion-local-app"},
            "prior_processes":[],"root_source":null,"frontend":{"root":root,
            "manifest_identity":"b".repeat(64),"tree_identity":"c".repeat(64),
            "module_manifest_identity":"d".repeat(64),
            "files":{"data/inputs.json":dom,"data/first_answers.json":first_answers}}}});
        let descriptor = root.join("adoption.json");
        let carried = root.join("frontend-selection.json");
        let f = Self {
            _temp: temp,
            root,
            state,
            descriptor,
            carried,
            source,
        };
        f.save();
        f
    }
    fn save(&self) {
        carried_selection::write_selection(&self.descriptor, &self.source);
    }
    fn address(&self) -> SocketAddr {
        "127.0.0.1:28788".parse().unwrap()
    }
    fn read(&self) -> Result<Selection, Error> {
        Selection::from_descriptor(&self.descriptor, &self.carried, &self.state, self.address())
    }
}

#[test]
fn exact_private_selection_retains_supplied_identity_without_creating_account_state() {
    let f = Fixture::new();
    let selection = f.read().unwrap();
    assert_eq!(selection.selected.receipt.blake3, "a".repeat(64));
    assert_eq!(selection.selected.root, f.state);
    assert!(selection.selected.prior_processes.is_empty());
    assert_eq!(selection.address(), f.address());
    selection.assert_current().unwrap();
    assert_eq!(
        fs::read_dir(&f.state).unwrap().count(),
        0,
        "selection must not initialize or adopt this synthetic empty directory"
    );
    assert!(
        selection.frontend.open(None).is_err(),
        "metadata selection cannot invent a frontend"
    );
}
#[test]
fn selected_state_address_and_account_files_must_match() {
    let mut f = Fixture::new();
    let other = f.root.join("other");
    fs::create_dir(&other).unwrap();
    assert!(Selection::from_descriptor(&f.descriptor, &f.carried, &other, f.address()).is_err());
    for address in [
        "127.0.0.1:28789",
        "0.0.0.0:28788",
        "[::1]:28788",
        "127.0.0.1:80",
    ] {
        assert!(
            Selection::from_descriptor(&f.descriptor, &f.carried, &f.state, address.parse().unwrap()).is_err()
        );
    }
    for account_files in ["", "../other", "a/b"] {
        f.source["native"]["app_kv"]["namespace"] = json!(account_files);
        f.save();
        assert!(f.read().is_err());
    }
}
#[test]
fn a_selection_naming_a_second_route_table_is_refused() {
    // The route table has one copy, the engine's own product DATA (OwnerRoutes::from_product).
    let mut f = Fixture::new();
    f.read().unwrap();
    f.source["native"]["frontend"]["owner_routes"] = data(
        &f.root.join("owner-routes.json"),
        json!({"families":[{"family":"test","exact":["/test"],"prefix":[]}]}),
    );
    f.save();
    assert!(f.read().is_err());
}

#[test]
fn traversal_unknown_and_duplicate_descriptor_fields_refuse() {
    let mut f = Fixture::new();
    f.source["native"]["app_kv"]["sqlite"] = json!("../original.sqlite");
    f.save();
    assert!(f.read().is_err());
    let mut f = Fixture::new();
    f.source["native"]["unexpected"] = json!(true);
    f.save();
    assert!(f.read().is_err());
    let f = Fixture::new();
    let mut bytes = fs::read(&f.descriptor).unwrap();
    bytes.pop();
    bytes.extend_from_slice(b",\"port\":28788}");
    fs::write(&f.descriptor, bytes).unwrap();
    assert!(f.read().is_err());
}
#[test]
fn descriptor_modes_aliases_and_absent_selection_refuse() {
    let f = Fixture::new();
    fs::set_permissions(&f.descriptor, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(f.read().is_err());
    f.save();
    let link = f.root.join("alias.json");
    symlink(&f.descriptor, &link).unwrap();
    assert!(Selection::from_descriptor(&link, &f.carried, &f.state, f.address()).is_err());
    fs::remove_file(&f.descriptor).unwrap();
    assert!(f.read().is_err());
    assert_eq!(fs::read_dir(&f.state).unwrap().count(), 0);
}
#[test]
fn descriptor_and_pinned_policy_rotation_refuse_existing_witness() {
    let mut f = Fixture::new();
    let selection = f.read().unwrap();
    f.source["port"] = json!(28789);
    f.save();
    assert_eq!(selection.assert_current().unwrap_err(), trillion_local::cause!(Error::Changed));
    let f = Fixture::new();
    let selection = f.read().unwrap();
    fs::write(f.root.join("data/first_answers.json"), b"{}").unwrap();
    assert!(selection.assert_current().is_err());
    assert!(f.read().is_err());
}
#[test]
fn invalid_or_duplicate_prior_incarnations_do_not_authorize_takeover() {
    let mut f = Fixture::new();
    for prior in [
        json!([{"pid":1,"started_seconds":1,"started_fraction":0}]),
        json!([{"pid":99999,"started_seconds":1,"started_fraction":1000000}]),
        json!([{"pid":99999,"started_seconds":1,"started_fraction":0},{"pid":99999,"started_seconds":2,"started_fraction":0}]),
    ] {
        f.source["native"]["prior_processes"] = prior;
        f.save();
        assert!(f.read().is_err());
    }
}
#[test]
fn old_descriptor_and_a_wrong_carried_pin_have_no_permissive_native_defaults() {
    let mut f = Fixture::new();
    f.source.as_object_mut().unwrap().remove("native");
    f.save();
    assert!(f.read().is_err());
    // Any carried file, whatever it is for, is checked against its pin: one no reader names is refused the same way.
    let mut f = Fixture::new();
    f.source["native"]["frontend"]["files"]["data/no-reader-names-this.json"] =
        data(&f.root.join("data/no-reader-names-this.json"), json!({}));
    f.source["native"]["frontend"]["files"]["data/no-reader-names-this.json"]["pin"]["blake3"] = json!("0".repeat(64));
    f.save();
    assert!(matches!(f.read(), Err(Error::Changed(_))));
}
#[test]
fn an_unchanged_selection_is_checked_without_reading_its_files_again() {
    let f = Fixture::new();
    let selection = f.read().unwrap();
    let first = selection.rereads();
    for _ in 0..5 {
        selection.assert_current().unwrap();
    }
    assert_eq!(selection.rereads(), first, "the same generations: nothing is read again");
    // The same bytes under a new file (rename over it) are read once, still match their pin, and then are not read.
    let sign_in = f.root.join("data/first_answers.json");
    let copy = f.root.join("data/first_answers.copy");
    fs::write(&copy, fs::read(&sign_in).unwrap()).unwrap();
    fs::rename(&copy, &sign_in).unwrap();
    selection.assert_current().unwrap();
    assert_eq!(selection.rereads(), first + 1);
    selection.assert_current().unwrap();
    assert_eq!(selection.rereads(), first + 1);
    // Other bytes renamed over a pinned file refuse.
    fs::write(&copy, b"{\"kept\":{}}").unwrap();
    fs::rename(&copy, &sign_in).unwrap();
    assert_eq!(selection.assert_current().unwrap_err(), trillion_local::cause!(Error::Changed));
}
#[test]
fn an_edit_that_puts_the_modified_time_back_is_still_refused() {
    let f = Fixture::new();
    let selection = f.read().unwrap();
    let sign_in = f.root.join("data/first_answers.json");
    let modified = fs::metadata(&sign_in).unwrap().modified().unwrap();
    // The same length, one byte different (the kept prefix "trillion-" becomes "trillioN-").
    let mut bytes = fs::read(&sign_in).unwrap();
    let at = bytes.windows(8).position(|part| part == b"trillion").unwrap();
    bytes[at + 7] = b'N';
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(&sign_in, &bytes).unwrap();
    fs::File::options().write(true).open(&sign_in).unwrap().set_modified(modified).unwrap();
    assert_eq!(fs::metadata(&sign_in).unwrap().modified().unwrap(), modified, "the modified time is put back");
    assert_eq!(selection.assert_current().unwrap_err(), trillion_local::cause!(Error::Changed), "the changed time still shows the edit");
}
#[test]
fn a_new_build_with_different_pins_is_selected_by_the_same_descriptor() {
    // Installing a new signed build replaces only the app: its carried selection names new client identities and new
    // DATA bytes, and the account descriptor stays byte for byte what it was.
    let mut f = Fixture::new();
    f.read().unwrap();
    let descriptor_before = fs::read(&f.descriptor).unwrap();
    f.source["native"]["frontend"]["manifest_identity"] = json!("e".repeat(64));
    f.source["native"]["frontend"]["tree_identity"] = json!("f".repeat(64));
    let next = data(&f.root.join("data/first_answers.json"), json!({"kept":{"store_prefix":"kept-next-"}}));
    f.source["native"]["frontend"]["files"]["data/first_answers.json"] = next.clone();
    f.source["native"]["frontend"]["source"] = json!({"repo":"fixture","commit":"1".repeat(40)});
    f.save();
    assert_eq!(fs::read(&f.descriptor).unwrap(), descriptor_before, "the account descriptor is not rewritten");
    let selection = f.read().unwrap();
    assert_eq!(selection.frontend.manifest_identity, "e".repeat(64));
    let first = selection.frontend.file(trillion_local::native_boot::FIRST_ANSWERS).unwrap();
    assert_eq!(first.path, f.root.join("data/first_answers.json"));
    assert_eq!(first.pin.blake3, next["pin"]["blake3"].as_str().unwrap());
    assert_eq!(selection.selected.root, f.state);
}
#[test]
fn a_descriptor_naming_bundle_files_is_refused() {
    // The app is the one record of its own client and file pins; a descriptor carrying a second copy is refused.
    let f = Fixture::new();
    let mut account: Value = serde_json::from_slice(&fs::read(&f.descriptor).unwrap()).unwrap();
    for key in ["frontend", "files"] {
        let whole = carried_selection::read_selection(&f.descriptor, &f.carried);
        account["native"][key] = whole["native"]["frontend"][key].clone();
        fs::write(&f.descriptor, serde_json::to_vec(&account).unwrap()).unwrap();
        assert!(f.read().is_err(), "a descriptor naming {key} is refused");
        f.save();
        account = serde_json::from_slice(&fs::read(&f.descriptor).unwrap()).unwrap();
    }
    f.read().unwrap();
}
#[test]
fn carried_paths_outside_the_frontend_folder_and_other_roots_refuse() {
    let f = Fixture::new();
    let carried: Value = serde_json::from_slice(&fs::read(&f.carried).unwrap()).unwrap();
    let outside = f.root.parent().unwrap().join("outside.json");
    // A carried path is a plain relative path inside the folder, never the carried selection itself.
    for name in [outside.to_str().unwrap(), "../dom.json", "./data/inputs.json", "data//inputs.json", "", "frontend-selection.json"] {
        let mut changed = carried.clone();
        let pin = changed["files"]["data/inputs.json"].clone();
        changed["files"][name] = pin;
        fs::write(&f.carried, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(f.read().is_err(), "{name:?} is refused");
    }
    for (pointer, value) in [
        ("/frontend/root", json!(f.root)),
        ("/frontend/root", json!("..")),
        ("/source/commit", json!("main")),
        ("/source/commit", json!("A".repeat(40))),
        ("/source/repo", json!("")),
        ("/files/data~1inputs.json", json!({"bytes":1})),
    ] {
        let mut changed = carried.clone();
        *changed.pointer_mut(pointer).unwrap_or_else(|| panic!("{pointer}")) = value;
        fs::write(&f.carried, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(f.read().is_err(), "{pointer} is refused");
    }
    let mut changed = carried.clone();
    changed["files"]["data/inputs.json"]["unexpected"] = json!(true);
    fs::write(&f.carried, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(f.read().is_err(), "an unknown field in a carried pin is refused");
    let mut changed = carried.clone();
    changed.as_object_mut().unwrap().remove("source");
    fs::write(&f.carried, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(f.read().is_err(), "a carried selection that names no source commit is refused");
    let mut changed = carried.clone();
    changed["unexpected"] = json!(true);
    fs::write(&f.carried, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(f.read().is_err(), "an unknown carried field is refused");
    fs::remove_file(&f.carried).unwrap();
    assert!(f.read().is_err(), "an app with no carried selection is refused");
}
#[test]
fn a_descriptor_the_app_names_is_trusted_only_as_this_users_private_file() {
    let f = Fixture::new();
    // A descriptor others may read or write is refused before anything else is read.
    fs::set_permissions(&f.descriptor, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(Selection::installed_at(&f.descriptor), Err(Error::Invalid(_))));
    // This user's own 0600 file is read wherever it lies; a test binary is no app, so the selection stops there.
    f.save();
    assert!(matches!(Selection::installed_at(&f.descriptor), Err(Error::Unavailable(_))));
    let link = f.root.join("alias.json");
    symlink(&f.descriptor, &link).unwrap();
    assert!(Selection::installed_at(&link).is_err(), "an alias is not the descriptor");
    assert_eq!(fs::read_dir(&f.state).unwrap().count(), 0);
}
/// The Mac app's installed layout as trillion-apps c43efbb6 builds it, which stopped the engine at
/// `native-startup-error stage=selection` on the Mac (11:22 PM MST Nov 4): `Resources/computer-reader.json` and
/// `Resources/device-notices.json` shape with synthetic fixtures (tests/fixtures/mac-app), the web client's `frontend-selection.json`
/// in `Resources/local-workspace` with its source, three identities and the three carried data files (no shell or MCP
/// capture), and an app files list with exactly the keys the Mac's has. The app's notices file names no `origin` since
/// trillion-apps 2f2a2e5 (the shell reads its gateway from App/bundled-origin.json): the product's address is the
/// product settings' `app_host` (PRODUCT_SETTINGS), so the selection takes it from there.
#[test]
fn the_mac_apps_installed_layout_selects_its_account_with_the_products_origin() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let state = root.join("state");
    fs::create_dir(&state).unwrap();
    let contents = root.join("Trillion.app/Contents");
    let resources = contents.join("Resources");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mac-app");
    fs::create_dir_all(&resources).unwrap();
    for name in ["computer-reader.json", "device-notices.json"] {
        fs::copy(fixture.join(name), resources.join(name)).unwrap();
    }
    let notices: Value = serde_json::from_slice(&fs::read(resources.join("device-notices.json")).unwrap()).unwrap();
    assert!(notices.get("origin").is_none(), "the app's notices file names no origin since trillion-apps 2f2a2e5");
    let reader: Value = serde_json::from_slice(&fs::read(resources.join("computer-reader.json")).unwrap()).unwrap();
    let frontend = contents.join(reader["local_runtime"]["frontend_root"].as_str().unwrap());
    let mut files = serde_json::Map::new();
    for (name, value) in [
        ("data/first_answers.json", json!({"kept":{"store_prefix":"trillion-kept-"}})),
        ("data/inputs.json", json!({"element_id":"first","item_reads":{"element_id":"items"}})),
        ("data/client_program.json", json!({"program":"synthetic"})),
    ] {
        let pinned = data(&frontend.join(name), value);
        files.insert(name.into(), pinned["pin"].clone());
    }
    fs::create_dir_all(frontend.join("built")).unwrap();
    fs::write(frontend.join("frontend-selection.json"), serde_json::to_vec(&json!({
        "source":{"repo":"Trillion-X/trillion-apps","commit":"c43efbb6f472a06deb6846cbba122909f64e7bd4"},
        "frontend":{"root":".","manifest_identity":"b".repeat(64),"tree_identity":"c".repeat(64),
            "module_manifest_identity":"d".repeat(64)},
        "files":files})).unwrap()).unwrap();
    let descriptor = root.join("local-runtime.json");
    let list = json!({"version":"trillion.local-runtime-adoption/v1","state":state,"receipt_identity":"a".repeat(64),
        "port":28788,"native":{"version":"trillion.native-selection/v1","receipt_bytes":1024,
        "app_kv":{"sqlite":"storage/kv/current.sqlite","namespace":"trillion-local-app"},"prior_processes":[],
        "root_source":null}});
    let mut keys: Vec<_> = list.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["native", "port", "receipt_identity", "state", "version"], "the Mac's app files list keys");
    fs::write(&descriptor, serde_json::to_vec(&list).unwrap()).unwrap();
    fs::set_permissions(&descriptor, fs::Permissions::from_mode(0o600)).unwrap();

    let selection = Selection::installed_from(&contents, &descriptor).expect("the Mac app's layout selects its account");
    assert_eq!(selection.selected.root, state);
    assert_eq!(selection.frontend.files.len(), 3);
    let product: Value = serde_json::from_slice(&fs::read(std::env::var_os("PRODUCT_SETTINGS").unwrap()).unwrap()).unwrap();
    let origin = format!("https://{}", product["app_host"].as_str().unwrap());
    assert_eq!(selection.selected_service_origin().unwrap(), Some(origin.clone()));
    let endpoints = selection.selected_mcp_service_endpoints().unwrap().unwrap();
    assert_eq!(endpoints.mcp_audience(), format!("{origin}/mcp"));
    // A changed carried file is named by its check, never by its path or bytes.
    fs::write(frontend.join("data/client_program.json"), b"{}").unwrap();
    let refused = Selection::installed_from_checked(&contents, &descriptor).err().unwrap();
    assert_eq!(refused.step(), "frontend-files");
}
