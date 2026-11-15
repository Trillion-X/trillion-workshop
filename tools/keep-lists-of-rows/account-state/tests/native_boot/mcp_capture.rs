// Actual Frontend descriptor/capture consumer, synthetic descriptor only.
// Current C renderer bytes are copied fixtures from the canonical frontend.
// No account, native program, installed app files list, origin or grant is opened.
use super::*;
use content_crypto::advanced::blake3;
use trillion_local::native_boot::MCP_CAPTURE;

const DOCUMENT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/mcp-app-resource-current-c/screen.html"
));
const RESOURCE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/mcp-app-resource-current-c/resource.json"
));
const CAPTURE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/mcp-app-resource-current-c/capture.json"
));
const CAPTURE_PIN: &str = "3350a34fd3d4d51c78ffbe7585c91ba4babfd7ebd7264da6acd8e31ae47bf17c";

fn pinned(path: &Path) -> Value {
    let bytes = fs::read(path).unwrap();
    json!({"path":path,"pin":{"bytes":bytes.len(),"blake3":blake3::hash(&bytes).to_hex().as_str()}})
}
/// The capture's files, as carried: the receipt at `MCP_CAPTURE` and its siblings beside it, each its own entry of
/// the carried file map.
fn with_capture() -> (Fixture, PathBuf) {
    let mut fixture = Fixture::new();
    let root = fixture.root.join("data/mcp_capture");
    fs::create_dir_all(&root).unwrap();
    for (name, bytes) in [
        ("screen.html", DOCUMENT),
        ("resource.json", RESOURCE),
        ("capture.json", CAPTURE),
    ] {
        fs::write(root.join(name), bytes).unwrap();
        fixture.source["native"]["frontend"]["files"][format!("data/mcp_capture/{name}")] = pinned(&root.join(name));
    }
    fixture.save();
    (fixture, root)
}
fn repin(fixture: &mut Fixture, root: &Path, name: &str) {
    fixture.source["native"]["frontend"]["files"][format!("data/mcp_capture/{name}")] = pinned(&root.join(name));
    fixture.save();
}

#[test]
fn old_frontend_omits_optional_mcp_capture_without_successful_resource_default() {
    let fixture = Fixture::new();
    let selection = fixture.read().unwrap();
    assert!(selection.frontend.file(MCP_CAPTURE).is_none());
    assert!(selection.frontend.open_mcp_resource().unwrap().is_none());
    selection.assert_current().unwrap();
    assert_eq!(fs::read_dir(&fixture.state).unwrap().count(), 0);
}

#[test]
fn actual_frontend_opens_copied_current_c_resource_with_pinned_named_siblings() {
    assert_eq!(DOCUMENT.len(), 101_225);
    assert_eq!(blake3::hash(CAPTURE).to_hex().as_str(), CAPTURE_PIN);
    let (fixture, _) = with_capture();
    let selection = fixture.read().unwrap();
    selection.assert_current().unwrap();
    let resource = selection.frontend.open_mcp_resource().unwrap().unwrap();
    let meta: Value = serde_json::from_slice(RESOURCE).unwrap();
    assert_eq!(resource.resource_uri(), meta["uri"].as_str().unwrap());
    assert_eq!(fs::read_dir(&fixture.state).unwrap().count(), 0);
}

#[test]
fn mcp_field_keeps_frontend_and_pinned_data_descriptor_schemas_strict() {
    let mut fixture = Fixture::new();
    fixture.source["native"]["frontend"]["mcp_capture_typo"] = json!(null);
    fixture.save();
    assert!(fixture.read().is_err());
    let (fixture, _) = with_capture();
    let mut carried: Value = serde_json::from_slice(&fs::read(&fixture.carried).unwrap()).unwrap();
    carried["files"][MCP_CAPTURE]["unexpected"] = json!(true);
    fs::write(&fixture.carried, serde_json::to_vec(&carried).unwrap()).unwrap();
    assert!(fixture.read().is_err());
}

#[test]
fn mcp_receipt_pin_and_selected_current_witness_refuse_tampering_or_swap() {
    let (fixture, root) = with_capture();
    let selection = fixture.read().unwrap();
    fs::write(root.join("capture.json"), b"{}").unwrap();
    assert!(selection.assert_current().is_err());
    assert!(selection.frontend.open_mcp_resource().is_err());
    assert!(fixture.read().is_err());
    let (fixture, root) = with_capture();
    let selection = fixture.read().unwrap();
    fs::write(root.join("other.json"), b"{}").unwrap();
    fs::rename(root.join("other.json"), root.join("capture.json")).unwrap();
    assert!(selection.assert_current().is_err());
    assert!(selection.frontend.open_mcp_resource().is_err());
}

#[test]
fn mcp_capture_requires_original_receipt_name_and_valid_declared_pin() {
    // A receipt carried under another name is not the capture: the reader opens only its own path.
    let (mut fixture, root) = with_capture();
    fs::rename(root.join("capture.json"), root.join("renamed.json")).unwrap();
    let files = fixture.source["native"]["frontend"]["files"].as_object_mut().unwrap();
    files.remove(MCP_CAPTURE);
    repin(&mut fixture, &root, "renamed.json");
    assert!(fixture.read().unwrap().frontend.open_mcp_resource().unwrap().is_none());
    let (mut fixture, root) = with_capture();
    for pin in [
        json!({"bytes":CAPTURE.len(),"blake3":"0".repeat(64)}),
        json!({"bytes":0,"blake3":CAPTURE_PIN}),
        json!({"bytes":CAPTURE.len(),"blake3":"invalid"}),
    ] {
        repin(&mut fixture, &root, "capture.json");
        fixture.source["native"]["frontend"]["files"][MCP_CAPTURE]["pin"] = pin;
        fixture.save();
        assert!(fixture.read().is_err());
    }
}

#[test]
fn valid_receipt_cannot_cover_changed_or_absent_document_resource_siblings() {
    // A changed or absent sibling is refused: by its own carried pin, and (repinned) by the receipt's pin of it.
    for name in ["screen.html", "resource.json"] {
        let (mut fixture, root) = with_capture();
        let selection = fixture.read().unwrap();
        fs::write(root.join(name), b"changed").unwrap();
        assert!(selection.assert_current().is_err());
        assert!(fixture.read().is_err());
        repin(&mut fixture, &root, name);
        assert!(fixture.read().unwrap().frontend.open_mcp_resource().is_err());
        let (mut fixture, root) = with_capture();
        fs::remove_file(root.join(name)).unwrap();
        assert!(fixture.read().is_err());
        fixture.source["native"]["frontend"]["files"].as_object_mut().unwrap().remove(&format!("data/mcp_capture/{name}"));
        fixture.save();
        assert!(fixture.read().unwrap().frontend.open_mcp_resource().is_err());
    }
}

#[test]
fn repinned_named_receipt_with_swapped_format_or_artifact_name_refuses() {
    for change in ["schema", "name"] {
        let (mut fixture, root) = with_capture();
        let mut capture: Value = serde_json::from_slice(CAPTURE).unwrap();
        if change == "schema" {
            capture["schema"] = json!("trillion.workspace-shell-capture/v1");
        } else {
            let artifact = capture["artifacts"]
                .as_object_mut()
                .unwrap()
                .remove("screen.html")
                .unwrap();
            capture["artifacts"]["renamed.html"] = artifact;
        }
        fs::write(
            root.join("capture.json"),
            serde_json::to_vec(&capture).unwrap(),
        )
        .unwrap();
        repin(&mut fixture, &root, "capture.json");
        let selection = fixture.read().unwrap();
        assert!(selection.frontend.open_mcp_resource().is_err());
    }
}

#[test]
fn same_byte_receipt_or_sibling_alias_does_not_gain_selected_frontend_custody() {
    let (fixture, root) = with_capture();
    let held = root.join("held-capture.json");
    fs::rename(root.join("capture.json"), &held).unwrap();
    symlink(&held, root.join("capture.json")).unwrap();
    assert!(fixture.read().is_err());
    for name in ["screen.html", "resource.json"] {
        let (mut fixture, root) = with_capture();
        let held = root.join(format!("held-{name}"));
        fs::rename(root.join(name), &held).unwrap();
        symlink(&held, root.join(name)).unwrap();
        assert!(fixture.read().is_err(), "an aliased carried file is refused by the map");
        fixture.source["native"]["frontend"]["files"].as_object_mut().unwrap().remove(&format!("data/mcp_capture/{name}"));
        fixture.save();
        assert!(fixture.read().unwrap().frontend.open_mcp_resource().is_err());
    }
}
