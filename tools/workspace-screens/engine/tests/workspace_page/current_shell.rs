// Consume actual C artifacts from a fixed copy of the canonical source. These are local
// renderer/asset controls, not account, installed-app or complete toolchain proof.
use super::*;
use content_crypto::advanced::blake3;
use trillion_local::workspace_page::CapturedMcpResource;

const CURRENT_CAPTURE: &str = "4d66771d30dd16ff8e886ea1d50da592246c458326ce00cbdf5b810b7a4c86b4";
const CURRENT_MANIFEST: &str = "1141e11f8db7e5b82c470a765b00cce725a0a55277c6320850934a07221595e5";
const CURRENT_TREE: &str = "c76e225c8d59e170572ef2c61882e9d0bb8b2b3fe88e0d1b4465047cf86f9b2b";
const CURRENT_MODULES: &str = "88524498e99a5de1edced6cfac848dcc3059502903bae51b201f176a76299e62";
const CURRENT_RESOURCE: &str = "3350a34fd3d4d51c78ffbe7585c91ba4babfd7ebd7264da6acd8e31ae47bf17c";
const CURRENT_FIRST: &str = "6cf55c4061545ca43de3f422c908a341db2c404296b7094a761f9abb1e9eb86b";
const CURRENT_INPUTS: &str = "6a580e935bc7a96cebefa683da4160e185f2d63ee5321e77d6295a3090d67f93";

/// The original shell documents of the current-C capture, committed as bytes.
fn shell_fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/workspace-shell-current")
}
/// The old app's checkout, for the cohorts whose built frontend trees are too
/// large to commit; the tests that need it are ignored without it.
fn current() -> PathBuf {
    PathBuf::from(std::env::var_os("OLD_APP_ROOT").expect("OLD_APP_ROOT names the old app's checkout"))
        .join(".local/mcp-apps-current-browser-20261026-c")
}
fn receipt() -> Value {
    let bytes = fs::read(shell_fixtures().join("capture.json")).unwrap();
    assert_eq!(blake3::hash(&bytes).to_hex().as_str(), CURRENT_CAPTURE);
    serde_json::from_slice(&bytes).unwrap()
}
fn fixture() -> (tempfile::TempDir, Value) {
    let temp = tempfile::tempdir().unwrap();
    for name in ["opening.html", "repaint.html", "surfaces.json"] {
        fs::copy(shell_fixtures().join(name), temp.path().join(name)).unwrap();
    }
    (temp, receipt())
}
fn open(root: &Path, capture: &Value) -> Result<CapturedWorkspaceShell, WorkspaceError> {
    let bytes = serde_json::to_vec(capture).unwrap();
    fs::write(root.join("capture.json"), &bytes).unwrap();
    CapturedWorkspaceShell::open(root, blake3::hash(&bytes).to_hex().as_str())
}

#[test]
fn actual_current_v2_shell_preserves_both_original_documents_without_inventing_a_script() {
    let capture = receipt();
    let shell = CapturedWorkspaceShell::open(shell_fixtures(), CURRENT_CAPTURE).unwrap();
    assert!(!shell_fixtures().join("early-socket.txt").exists());
    for (name, repaint) in [("opening.html", false), ("repaint.html", true)] {
        let original = fs::read_to_string(shell_fixtures().join(name)).unwrap();
        let slot = &capture["artifacts"][name]["canonical_origin_slot"];
        let at = slot["offset"].as_u64().unwrap() as usize;
        let end = at + slot["length"].as_u64().unwrap() as usize;
        let expected = format!("{}{}{}", &original[..at], ORIGIN, &original[end..]);
        assert_eq!(shell.document(ORIGIN, repaint).unwrap(), expected);
    }
}

#[test]
fn v2_absence_is_explicit_and_cannot_override_v1_required_supply_or_conflicting_metadata() {
    for case in 0..7 {
        let (temp, mut capture) = fixture();
        match case {
            0 => {
                capture.as_object_mut().unwrap().remove("early_socket");
            }
            1 => {
                capture["early_socket"]["kind"] = json!("unknown");
            }
            2 => {
                capture["early_socket"]["extra"] = json!(true);
            }
            3 => {
                capture["artifacts"]["early-socket.txt"] =
                    json!({"bytes":0,"blake3":blake3::hash(b"").to_hex().as_str()});
            }
            4 => {
                capture["artifacts"]["unexpected.txt"] =
                    json!({"bytes":0,"blake3":blake3::hash(b"").to_hex().as_str()});
            }
            5 => {
                capture["schema"] = json!("trillion.workspace-shell-capture/v1");
            }
            _ => {
                capture["schema"] = json!("trillion.workspace-shell-capture/v1");
                capture.as_object_mut().unwrap().remove("early_socket");
            }
        }
        assert!(open(temp.path(), &capture).is_err(), "opposing case {case}");
    }
}

#[test]
fn v2_preserves_actual_artifact_integrity_and_never_substitutes_missing_bytes() {
    let (temp, capture) = fixture();
    fs::write(temp.path().join("opening.html"), b"changed original output").unwrap();
    assert!(open(temp.path(), &capture).is_err());
    let (temp, capture) = fixture();
    fs::remove_file(temp.path().join("surfaces.json")).unwrap();
    assert!(open(temp.path(), &capture).is_err());
}

#[test]
#[ignore = "needs OLD_APP_ROOT: this cohort's built frontend tree (about 65 MB) is not a committed fixture"]
fn actual_current_c_asset_module_and_mcp_resource_consumers_accept_the_same_cohort() {
    let built = current().join("built");
    let modules = ScreenModules::open(&built, CURRENT_MODULES).unwrap();
    let _assets = WorkspaceAssets::open_with_modules(
        built.join("assets"),
        CURRENT_MANIFEST,
        CURRENT_TREE,
        Some(modules),
    )
    .unwrap();
    let resource =
        CapturedMcpResource::open(current().join("mcp-screen"), CURRENT_RESOURCE).unwrap();
    assert_eq!(resource.resource_uri(), "ui://trillion/screen.html");
    let source = current()
        .with_file_name("mcp-apps-current-browser-20261026-b")
        .join("source");
    let first = fs::read(source.join("src/workspace/first-answers.json")).unwrap();
    let inputs = fs::read(source.join("src/workspace/inputs.json")).unwrap();
    let _startup =
        StartupContract::from_sources(&first, CURRENT_FIRST, &inputs, CURRENT_INPUTS).unwrap();
    // The real Frontend::open derives DOM settings from first-answers DATA;
    // inputs.json is the separate startup program input, not a DOM descriptor.
    let _dom = WorkspaceDom::from_source(&first, CURRENT_FIRST).unwrap();
    let _settings = trillion_local::workspace_session::WorkspaceSessionSettings::from_source(
        &first,
        CURRENT_FIRST,
    )
    .unwrap();
}

#[test]
#[ignore = "needs OLD_APP_ROOT: this cohort's built frontend tree (about 65 MB) is not a committed fixture"]
fn actual_d_workspace_opens_without_setup_dependency_and_preserves_guide_and_hold() {
    setup_independent_cohort(
        "mcp-apps-current-browser-20261027-d",
        "4da425caab767e685353c365eadbcb3a9dd1dd836a90307db6c6adf9955dbce6",
    );
}

#[test]
#[ignore = "needs OLD_APP_ROOT: this cohort's built frontend tree (about 65 MB) is not a committed fixture"]
fn actual_e_tour_repair_assets_preserve_setup_independent_workspace_consumers() {
    setup_independent_cohort(
        "mcp-apps-current-browser-20261027-e",
        "0512f6a2088c6cde166eaea1c848061ddbe74be857935e8de583f2b1426189e1",
    );
}

#[test]
fn actual_f4_missing_mount_data_is_refused_by_tool_projection() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/workspace-f4-missing-mount");
    let looks = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/retired-snapshot/frontend-contract/src/workshop-looks.json");
    let bytes = fs::read(root.join("coherent-frontend-candidate.json")).unwrap();
    assert_eq!(
        blake3::hash(&bytes).to_hex().as_str(),
        "c3bfdafde900efe033a76d5fe158933218c9bb5bda4412dd2b2754817e70ead1"
    );
    let packet: Value = serde_json::from_slice(&bytes).unwrap();
    let programs = &packet["native_frontend_fragment"]["tool_screens"];
    fn text(value: &Value) -> &str {
        value.as_str().unwrap()
    }
    let projection = trillion_local::workspace_tool_screens::ToolScreenProjection::from_sources(
        &fs::read(root.join("surfaces.json")).unwrap(),
        text(&programs["surfaces"]["pin"]["blake3"]),
        &fs::read(looks).unwrap(),
        text(&programs["looks"]["pin"]["blake3"]),
        &Default::default(),
    );
    assert!(matches!(projection, Err(trillion_local::workspace_tool_screens::Failure::Integrity(_))));
}

#[test]
#[ignore = "needs OLD_APP_ROOT: this cohort's built frontend tree (about 65 MB) is not a committed fixture"]
fn actual_f5_needs_you_and_shared_mount_data_preserve_workspace_consumers() {
    setup_independent_cohort(
        "mcp-apps-current-browser-20261027-f5",
        "a48833e205b84203d6108c837732190956dd9c1f416190653ec606b60549a81f",
    );
}

fn setup_independent_cohort(name: &str, packet_pin: &str) {
    let root = current().with_file_name(name);
    let packet_bytes = fs::read(root.join("coherent-frontend-candidate.json")).unwrap();
    assert_eq!(
        blake3::hash(&packet_bytes).to_hex().as_str(),
        packet_pin
    );
    let packet: Value = serde_json::from_slice(&packet_bytes).unwrap();
    let frontend = &packet["native_frontend_fragment"];
    let text = |value: &Value| value.as_str().unwrap().to_owned();
    let built = root.join("built");
    let modules =
        ScreenModules::open(&built, &text(&frontend["module_manifest_identity"])).unwrap();
    let assets = WorkspaceAssets::open_with_modules(
        built.join("assets"),
        &text(&frontend["manifest_identity"]),
        &text(&frontend["tree_identity"]),
        Some(modules),
    )
    .unwrap();
    let first = fs::read(text(&frontend["first_answers"]["path"])).unwrap();
    let inputs = fs::read(text(&frontend["inputs"]["path"])).unwrap();
    let first_pin = text(&frontend["first_answers"]["pin"]["blake3"]);
    let startup = StartupContract::from_sources(
        &first,
        &first_pin,
        &inputs,
        &text(&frontend["inputs"]["pin"]["blake3"]),
    )
    .unwrap();
    let route_input = std::collections::BTreeMap::new();
    let opening_plan = startup.plan(None, &route_input).unwrap();
    assert!(!opening_plan
        .listed_reads
        .iter()
        .any(|p| p == "/work/api/screens/get-started"));
    assert!(opening_plan
        .listed_reads
        .iter()
        .any(|p| p == "/work/api/needs-you-hold"));
    assert!(startup
        .plan(Some("get-started"), &route_input)
        .unwrap()
        .listed_reads
        .iter()
        .any(|p| p == "/work/api/screens/get-started"));
    let dom = WorkspaceDom::from_source(&first, &first_pin).unwrap();
    let _settings = trillion_local::workspace_session::WorkspaceSessionSettings::from_source(
        &first, &first_pin,
    )
    .unwrap();
    let shell = CapturedWorkspaceShell::open(
        root.join("shell"),
        &text(&frontend["shell_capture"]["pin"]["blake3"]),
    )
    .unwrap();
    let rendered = trillion_local::workspace::render_page(
        &assets,
        &dom,
        trillion_local::workspace::WorkspacePage {
            document: shell.document(ORIGIN, false).unwrap(),
            screen_entry: None,
            listed_reads: opening_plan.listed_reads,
            item_reads: vec![],
            known: vec![],
            answers: vec![],
        },
        16 * 1024 * 1024,
        "current_shell_nonce_0123",
    )
    .unwrap();
    // The shell's inline thread cover runs under the page policy only with the response's nonce.
    assert!(rendered.contains("<script nonce=\"current_shell_nonce_0123\">"));
    assert!(!rendered.contains("<script>"));
    let entry = assets.manifest()["script"].as_str().unwrap();
    assert!(
        rendered.find("id=\"root\"").unwrap() < rendered.find(&format!("src=\"{entry}\"")).unwrap()
    );
    let programs = &frontend["tool_screens"];
    let _projection = trillion_local::workspace_tool_screens::ToolScreenProjection::from_sources(
        &fs::read(text(&programs["surfaces"]["path"])).unwrap(),
        &text(&programs["surfaces"]["pin"]["blake3"]),
        &fs::read(text(&programs["looks"]["path"])).unwrap(),
        &text(&programs["looks"]["pin"]["blake3"]),
        &Default::default(),
    )
    .unwrap();
}
