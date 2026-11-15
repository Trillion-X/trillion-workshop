// tests/support/carried_selection.rs
//
// Purpose: write one synthetic opened account as an installed app has it: the private account descriptor (which account)
// and the app's carried frontend file (the client tree's identities, the source commit and the opaque carried file
// map, path -> pin), the two files `native_boot::Selection::from_descriptor` reads.
//
// Key Concepts: fixtures build one whole value, the account fields with `native.frontend` beside them, and change any
// part of it; `write_selection` splits it into the two files and `read_selection` joins them back. Many fixtures still
// name their files in the older per-field shape (`inputs`, `first_answers`, `client_program`, `shell_capture`,
// `mcp_capture`, `tool_screens`); `write_selection` lays each out at the carried path its engine reader opens
// (`native_boot::FIRST_ANSWERS` and the others), copying the file there, exactly as a release's carried map holds it.
// A fixture may instead give `native.frontend.files` (carried path -> {path, pin}) directly, for any path at all.
// `native.sign_in_rules` and `native.reveal_policy` are dropped: the app carries no policy file, and the account's
// sign-in lifetimes are its own sign-in settings row (`Selection::sign_in_rules`).
//
// Included with `#[path]` by integration tests and with `include!` by the library's own test modules, so it holds only
// items and plain comments.

use content_crypto::advanced::blake3;
use serde_json::{json, Map, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

/// The older per-field names and the carried path each one's engine reader opens.
const CARRIED_AT: [(&str, &str); 5] = [
    ("inputs", "data/inputs.json"),
    ("first_answers", "data/first_answers.json"),
    ("client_program", "data/client_program.json"),
    ("shell_capture", "data/shell_capture/capture.json"),
    ("mcp_capture", "data/mcp_capture/capture.json"),
];
/// The tool-screen declaration's carried path and the carried paths of the two files it names.
const TOOL_SCREENS: &str = "data/tool_screens.json";
const TOOL_SURFACES: &str = "data/tool_screens/surfaces.json";
const TOOL_LOOKS: &str = "data/tool_screens/looks.json";

/// Copy the `{path, pin}` file `source` to `carried` inside `root` (unless it is already there) and answer its pin.
fn carry(root: &Path, carried: &str, source: &Value) -> Value {
    let from = PathBuf::from(source["path"].as_str().expect("a carried file names its path"));
    let to = root.join(carried);
    if from != to {
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        // A capture's sibling artifacts sit beside its receipt: they are carried with it, each as its own entry.
        fs::copy(&from, &to).expect("a fixture's carried file exists");
    }
    source["pin"].clone()
}

fn pin_of(bytes: &[u8]) -> Value {
    json!({"bytes":bytes.len(),"blake3":blake3::hash(bytes).to_hex().as_str()})
}

/// Write `whole`'s account fields to `descriptor` (mode 0600) and its frontend to the carried frontend file in its frontend
/// root (the descriptor's folder when `whole` names no frontend root). A part a test removed is absent. Returns the
/// carried frontend file's path.
pub fn write_selection(descriptor: &Path, whole: &Value) -> PathBuf {
    let mut account = whole.clone();
    let mut frontend = Map::new();
    if let Some(native) = account.get_mut("native").and_then(Value::as_object_mut) {
        native.remove("sign_in_rules");
        native.remove("reveal_policy");
        if let Some(Value::Object(part)) = native.remove("frontend") {
            frontend = part;
        }
    }
    let root = match frontend.get("root").and_then(Value::as_str) {
        Some(root) => PathBuf::from(root),
        None => descriptor.parent().unwrap().to_path_buf(),
    };
    let mut files = Map::new();
    if let Some(Value::Object(given)) = frontend.remove("files") {
        for (carried, source) in given {
            let pin = carry(&root, &carried, &source);
            files.insert(carried, pin);
        }
    }
    for (key, carried) in CARRIED_AT {
        match frontend.remove(key) {
            Some(Value::Null) | None => {}
            Some(source) => {
                let pin = carry(&root, carried, &source);
                if key.ends_with("_capture") {
                    // The capture owner opens capture.json's declared siblings from the same folder.
                    let from = PathBuf::from(source["path"].as_str().unwrap());
                    let capture: Value = serde_json::from_slice(&fs::read(&from).unwrap()).unwrap_or(Value::Null);
                    let parent = Path::new(carried).parent().unwrap();
                    for (name, _) in capture["artifacts"].as_object().into_iter().flatten() {
                        let sibling = from.parent().unwrap().join(name);
                        let bytes = fs::read(&sibling).unwrap();
                        let entry = parent.join(name).to_str().unwrap().to_owned();
                        let pin = carry(&root, &entry, &json!({"path":sibling,"pin":pin_of(&bytes)}));
                        files.insert(entry, pin);
                    }
                }
                files.insert(carried.into(), pin);
            }
        }
    }
    if let Some(screens) = frontend.remove("tool_screens").filter(|value| !value.is_null()) {
        files.insert(TOOL_SURFACES.into(), carry(&root, TOOL_SURFACES, &screens["surfaces"]));
        files.insert(TOOL_LOOKS.into(), carry(&root, TOOL_LOOKS, &screens["looks"]));
        let declared = serde_json::to_vec(&json!({"surfaces":TOOL_SURFACES,"looks":TOOL_LOOKS,"host":screens["host"]})).unwrap();
        fs::write(root.join(TOOL_SCREENS), &declared).unwrap();
        files.insert(TOOL_SCREENS.into(), pin_of(&declared));
    }
    // The engine reads no retired locale key and no other field: what is left is the client tree.
    frontend.remove("tool_label_locale");
    frontend.insert("root".into(), json!("."));
    let source = frontend.remove("source").unwrap_or_else(|| json!({"repo":"fixture","commit":"0".repeat(40)}));
    let carried = json!({"source":source,"frontend":frontend,"files":files});
    fs::write(descriptor, serde_json::to_vec(&account).unwrap()).unwrap();
    fs::set_permissions(descriptor, fs::Permissions::from_mode(0o600)).unwrap();
    let carried_path = root.join("frontend-selection.json");
    fs::write(&carried_path, serde_json::to_vec(&carried).unwrap()).unwrap();
    carried_path
}

/// The whole value `write_selection` was given, read back from the two files it wrote: the frontend in the older
/// per-field shape for every file a reader opens by name (now at its carried path), and `files` for any other.
#[allow(dead_code)] // Only some including tests read an opened account back.
pub fn read_selection(descriptor: &Path, carried_path: &Path) -> Value {
    let mut whole: Value = serde_json::from_slice(&fs::read(descriptor).unwrap()).unwrap();
    let carried: Value = serde_json::from_slice(&fs::read(carried_path).unwrap()).unwrap();
    let root = carried_path.parent().unwrap().to_path_buf();
    let mut frontend = carried["frontend"].as_object().unwrap().clone();
    frontend.insert("root".into(), json!(root));
    frontend.insert("source".into(), carried["source"].clone());
    let mut files = carried["files"].as_object().unwrap().clone();
    let at = |pin: Value, carried: &str| json!({"path":root.join(carried),"pin":pin});
    for (key, carried) in CARRIED_AT {
        if let Some(pin) = files.remove(carried) {
            frontend.insert(key.into(), at(pin, carried));
        }
    }
    if let Some(_) = files.remove(TOOL_SCREENS) {
        let declared: Value = serde_json::from_slice(&fs::read(root.join(TOOL_SCREENS)).unwrap()).unwrap();
        let surfaces = files.remove(TOOL_SURFACES).unwrap();
        let looks = files.remove(TOOL_LOOKS).unwrap();
        frontend.insert(
            "tool_screens".into(),
            json!({"surfaces":at(surfaces, TOOL_SURFACES),"looks":at(looks, TOOL_LOOKS),"host":declared["host"]}),
        );
    }
    // Capture siblings are written again with their capture.
    files.retain(|name, _| !name.starts_with("data/shell_capture/") && !name.starts_with("data/mcp_capture/"));
    if !files.is_empty() {
        let given: Map<String, Value> =
            files.into_iter().map(|(name, pin)| (name.clone(), at(pin, &name))).collect();
        frontend.insert("files".into(), Value::Object(given));
    }
    whole["native"].as_object_mut().unwrap().insert("frontend".into(), Value::Object(frontend));
    whole
}
