use super::*;
use crate::tool_runs::tools::{computer::grants::Who, Held, Workshop};
use computer_binding::{Launch, Reach, Refused, RuntimeFolder, Started, TrashOutcome, TrashSource};
use serde_json::json;
use std::{
    cell::RefCell,
    sync::{atomic::AtomicUsize, Mutex},
};
use zeroize::Zeroizing;

const ACCOUNT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOOL: &str = "synthetic-parent-action";
const CAPABILITY: &str = "synthetic-folder-capability";
const PARAMETER: &str = "chosen-root";
const REQUEST: &str = "synthetic-parent-run";
type Observer = Box<dyn FnMut(Option<&ComputerRunProof>)>;
thread_local! { static OBSERVER: RefCell<Option<Observer>> = RefCell::new(None); }
pub(super) fn observe(proof: Option<&ComputerRunProof>) {
    OBSERVER.with(|observer| {
        if let Some(observer) = observer.borrow_mut().as_mut() {
            observer(proof);
        }
    });
}
struct Reset;
impl Drop for Reset {
    fn drop(&mut self) {
        OBSERVER.with(|observer| {
            observer.borrow_mut().take();
        });
        os::composition::choose(Some(os::composition::sbpl()));
    }
}
/// What the door writes as the person's confirmation of one change for a caller whose sign-in pass is fresh
/// (src/native_boot/mcp_local.rs `invoke_as`, Better Auth's freshAge); these controls call the grants door directly.
fn person_present() -> Value {
    json!({"fresh_pass": true})
}


/// A process-unique id for a test's own account.
fn uuid_like() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!("{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

struct SyntheticBinding {
    report: Report,
    allowed: AtomicBool,
    calls: AtomicUsize,
    last: Mutex<Option<(PathBuf, PathBuf, String)>>,
}
fn synthetic_binding() -> &'static SyntheticBinding {
    Box::leak(Box::new(SyntheticBinding {
        report: Report {
            capabilities: vec![Offered {
                id: CAPABILITY.into(),
                words: "Synthetic folder control".into(),
                parameters: BTreeMap::from([(PARAMETER.into(), Parameter::Folder)]),
                program_by: None,
                permission: None,
            }],
            programs: Vec::new(),
        },
        allowed: AtomicBool::new(true),
        calls: AtomicUsize::new(0),
        last: Mutex::new(None),
    }))
}
impl ComputerBinding for SyntheticBinding {
    fn implementation(&self) -> &'static str {
        "synthetic-proof-control"
    }
    fn report(&self) -> &Report {
        &self.report
    }
    fn find_program(&self, _: &str, _: &[u8], _: &str) -> Option<BTreeMap<String, String>> {
        None
    }
    fn admits(&self, id: &str) -> bool {
        self.allowed.load(Ordering::Acquire) && self.report.capability(id).is_some()
    }
    fn runtime(
        &self,
        _: &Path,
        _: &[RuntimeFolder<'_>],
        _: &[PathBuf],
    ) -> Result<Runtime, Refused> {
        Ok(Runtime::default())
    }
    fn render(&self, _: &Reach<'_>) -> Result<String, Refused> {
        Err(Refused::Unavailable)
    }
    fn start(&self, _: &Launch<'_>) -> Result<Started, Refused> {
        panic!("synthetic proof controls never start a process")
    }
    fn trash_source_capability(&self) -> Option<(&str, &str)> {
        Some((CAPABILITY, PARAMETER))
    }
    fn trash_source(
        &self,
        scope: &Path,
        source: TrashSource<'_>,
        current: &dyn Fn() -> bool,
    ) -> TrashOutcome {
        if !current() || !source.path.starts_with(scope) {
            return TrashOutcome::Refused;
        }
        self.calls.fetch_add(1, Ordering::AcqRel);
        *self.last.lock().unwrap() = Some((
            scope.to_owned(),
            source.path.to_owned(),
            source.expected_generation.to_owned(),
        ));
        TrashOutcome::Moved
    }
}
struct NoValues;
impl Held for NoValues {
    fn plain(&self, _: &str) -> Result<Zeroizing<String>, Failure> {
        Err(trillion_local::cause!(Failure::Credential))
    }
}
struct NativeIssuer {
    context: Context,
    physical: Arc<AtomicBool>,
}
impl Issuer for NativeIssuer {
    fn issue(&self, _: &Value, _: Duration) -> Result<Issued, Refusal> {
        Err(trillion_local::cause!(Refusal::NotGranted))
    }
    fn task_context(&self) -> Option<Context> {
        Some(self.context.clone())
    }
    fn computer_current(&self) -> Option<crate::account::account_routes::Current> {
        let live = self.physical.clone();
        Some(Arc::new(move || live.load(Ordering::Acquire)))
    }
}
#[derive(Clone)]
pub(crate) struct Fixture {
    pub(crate) account: &'static str,
    pub(crate) of: RunOf,
    pub(crate) source: PathBuf,
    pub(crate) generation: &'static str,
    scope: PathBuf,
    state: PathBuf,
    tools: PathBuf,
    parent: Arc<AtomicBool>,
    physical: Arc<AtomicBool>,
    binding: &'static SyntheticBinding,
    admitted_binding: &'static dyn ComputerBinding,
}
impl Fixture {
    /// The existing binding-injection owner is thread-local. A synthetic callback server thread explicitly
    /// chooses this same binding; production proof checks never bypass binding identity for a test fixture.
    pub(crate) fn select_binding_for_current_thread(&self) {
        os::composition::choose(Some(self.admitted_binding));
    }
    pub(crate) fn choose_binding_for_this_thread(&self) {
        self.select_binding_for_current_thread();
    }
    pub(crate) fn calls(&self) -> usize {
        self.binding.calls.load(Ordering::Acquire)
    }
    /// Test-only readback of the real proof's predicates. No predicate is
    /// repaired here, and no path, token, grant value or pointer is returned.
    pub(crate) fn proof_failure_stages(&self, proof: &ComputerRunProof) -> Vec<&'static str> {
        let mut stages = Vec::new();
        if proof.account != self.account || proof.run_of != self.of {
            stages.push("run_identity");
        }
        if !(proof.physical_current)() {
            stages.push("physical_parent_closed");
        }
        if proof.cancel.load(Ordering::Acquire) {
            stages.push("producer_cancelled");
        }
        if proof.deadline.is_some_and(|until| Instant::now() >= until) {
            stages.push("producer_deadline");
        }
        if proof.parent.check(self.account).is_err() {
            stages.push("native_task_context");
        }
        match proof.capabilities.binding() {
            None => stages.push("thread_binding_absent"),
            Some(binding) => {
                if !std::ptr::eq(binding, proof.binding) {
                    stages.push(if std::ptr::addr_eq(binding, proof.binding) {
                        "thread_binding_vtable_identity"
                    } else {
                        "thread_binding_object_identity"
                    });
                }
                if binding.trash_source_capability()
                    != Some((
                        proof.trash_capability.as_str(),
                        proof.folder_parameter.as_str(),
                    ))
                {
                    stages.push("thread_binding_action_mapping");
                }
                if proof
                    .holdings
                    .iter()
                    .any(|holding| !binding.admits(&holding.capability.id))
                {
                    stages.push("thread_binding_grant_refused");
                }
            }
        }
        if fs::canonicalize(&proof.state_root).ok().as_ref() != Some(&proof.state_root) {
            stages.push("state_root_identity");
        }
        match proof
            .capabilities
            .settings
            .grants
            .open_read_only(&proof.state_root)
        {
            Err(_) => stages.push("grant_book_open"),
            Ok(book) => {
                if book.identity().ok() != Some(proof.book_identity) {
                    stages.push("grant_book_identity");
                }
                let before = book.stamp(self.account);
                if before.is_err() {
                    stages.push("grant_stamp_read");
                }
                for holding in &proof.holdings {
                    match proof.capabilities.capability(&holding.capability.id) {
                        Some(capability) if std::ptr::eq(capability, holding.capability) => {}
                        _ => stages.push("offered_capability_identity"),
                    }
                    match book.holding(self.account, &self.of.tool, &holding.capability.id) {
                        Err(_) => stages.push("holding_read"),
                        Ok(None) => stages.push("holding_absent"),
                        Ok(Some((version, sets))) => {
                            let held = proof.holdings.iter().filter(|other| other.capability.id == holding.capability.id).count();
                            if version != holding.version || sets.len() != held || sets.get(holding.slot) != Some(&holding.kept_parameters) {
                                stages.push("holding_version_or_parameters");
                            }
                            let kept = &holding.kept_parameters;
                            match proof.capabilities.shape(holding.capability, kept) {
                                None => stages.push("holding_shape"),
                                Some((kinds, _)) => {
                                    if !still_valid(holding.capability, &kinds, kept) {
                                        stages.push("holding_parameter_validity");
                                    }
                                    if folder_identities(&kinds, kept).as_ref()
                                        != Some(&holding.folders)
                                    {
                                        stages.push("holding_folder_identity");
                                    }
                                }
                            }
                        }
                    }
                }
                if let Ok(before) = before {
                    if book.stamp(self.account).ok() != Some(before) {
                        stages.push("grant_stamp_changed");
                    }
                }
            }
        }
        stages
    }
    fn change_grant(&self, folder: Option<&Path>, key: &str) {
        let owner = shipped().unwrap();
        let workshop = Workshop::from_data(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/tool_runs/tools/tool-runs.json"
        )))
        .unwrap();
        let door = &owner.settings.grants;
        let (method, mut input) = match folder {
            Some(folder) => {
                let parameters = Map::from_iter([(PARAMETER.to_owned(), json!(folder))]);
                (
                    door.grant_method.as_str(),
                    json!({"tool":TOOL,"capability":CAPABILITY,"parameters":parameters,"until":4_102_444_800_000_i64,"why":"synthetic proof grant"}),
                )
            }
            None => (
                door.revoke_method.as_str(),
                json!({"tool":TOOL,"capability":CAPABILITY}),
            ),
        };
        if method == door.revoke_method {
            // A revoke is the person's: confirmed by the person's passkey over exactly this removal.
            let record = json!([TOOL, CAPABILITY]).to_string();
            input["person_present"] = person_present();
        } else if method == door.grant_method {
            // A grant applies an offer the person confirms: the offer is made, confirmed with the passkey, then applied.
            let offered = owner.call_at(&workshop, &self.tools, &self.state, self.account, &Who::with_operators("synthetic-person", None, crate::tool_runs::tools::computer::grants::test_operators()), &door.offer_method, &format!("{key}-offer"), &input).unwrap();
            let id = offered["offer"].as_str().unwrap().to_owned();
            let person_present = person_present();
            input = json!({"offer": id, "person_present": person_present});
        }
        owner
            .call_at(
                &workshop,
                &self.tools,
                &self.state,
                self.account,
                &Who::with_operators("synthetic-person", None, crate::tool_runs::tools::computer::grants::test_operators()),
                method,
                key,
                &input,
            )
            .unwrap();
    }

    /// Recovery reads the actual row and current native context with no running-job registration.
    /// Every effect-bearing issuer/secret method panics, so success cannot hide preparation.
    fn recovery(&self, options: Recovery) -> Result<Value, Failure> {
        struct ReadOnlyIssuer(Context);
        impl Issuer for ReadOnlyIssuer {
            fn issue(&self, _: &Value, _: Duration) -> Result<Issued, Refusal> {
                panic!("recovery must not issue rights")
            }
            fn issue_recordless(&self, _: &Value, _: Duration) -> Result<Issued, Refusal> {
                panic!("recovery must not issue recordless rights")
            }
            fn task_context(&self) -> Option<Context> {
                Some(self.0.clone())
            }
            fn recovery_source(&self) -> Result<Value, Refusal> {
                Ok(json!({"native_source":"synthetic-computer-recovery"}))
            }
            fn computer_current(&self) -> Option<crate::account::account_routes::Current> {
                panic!("recovery must not mint physical-action proof")
            }
        }
        struct NoSecrets;
        impl Held for NoSecrets {
            fn plain(&self, _: &str) -> Result<Zeroizing<String>, Failure> {
                panic!("recovery must not read secrets")
            }
        }
        let workshop = Workshop::from_data(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/tool_runs/tools/tool-runs.json"
        )))
        .unwrap();
        assert!(workshop.running.lock().unwrap().is_empty());
        assert!(workshop.cancels.lock().unwrap().is_empty());
        let data: Value = serde_json::from_slice(
            &fs::read(self.tools.join("tools/fixture/tool-rows.json")).unwrap(),
        )
        .unwrap();
        let mut row = data["records"][0]["payload"].clone();
        row["invoke"]["kind"] = json!(options.kind);
        let parent = self.parent.clone();
        let issuer = ReadOnlyIssuer(Context::account_at(
            self.account,
            Arc::new(move || parent.load(Ordering::Acquire)),
        ));
        let place = Place {
            account: self.account,
            state_root: &self.state,
            door: options.context.then_some(&issuer as &dyn Issuer),
            origin: None,
        };
        let cancelled = AtomicBool::new(options.cancelled);
        let cancel = AtomicBool::new(options.cancel);
        let input = json!({"grants":{(CAPABILITY):{(PARAMETER):"forged-input-root"}}});
        let task = json!({"grants":{(CAPABILITY):{(PARAMETER):"forged-task-root"}},"actor":{"current":true}});
        let run = Run {
            workshop: &workshop,
            root: &self.tools,
            row: &row,
            request_key: REQUEST,
            input: &input,
            task: &task,
            started_ms: chrono::Utc::now().timestamp_millis(),
            until_ms: options.until_ms,
            request_deadline: options.deadline,
            place: &place,
            held: &NoSecrets,
            cancelled: &cancelled,
            cancel: &cancel,
            capture: false,
        };
        let result = Computer.admit_recovery(&run);
        assert!(workshop.running.lock().unwrap().is_empty());
        assert!(workshop.cancels.lock().unwrap().is_empty());
        result
    }
}

struct Recovery {
    kind: &'static str,
    cancelled: bool,
    cancel: bool,
    deadline: Option<Instant>,
    until_ms: Option<u64>,
    context: bool,
}
impl Default for Recovery {
    fn default() -> Self {
        Self {
            kind: Computer.name(),
            cancelled: false,
            cancel: false,
            deadline: None,
            until_ms: None,
            context: true,
        }
    }
}

/// Exact temporary-tree readback detects new folders, grant/journal writes and any source mutation.
fn tree_bytes(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    fn visit(root: &Path, path: &Path, result: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
        let metadata = fs::symlink_metadata(path).unwrap();
        let value = if metadata.is_dir() {
            None
        } else {
            Some(fs::read(path).unwrap())
        };
        result.insert(path.strip_prefix(root).unwrap().to_owned(), value);
        if metadata.is_dir() {
            for entry in fs::read_dir(path).unwrap() {
                visit(root, &entry.unwrap().path(), result);
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result);
    result
}

/// Reusable native-producer fixture for the capability consumer's positive and once-only controls. The
/// callback runs while the real runner owns its cancellation registration and before any child starts.
pub(crate) fn with_proof(action: impl FnOnce(ComputerRunProof, Fixture) + 'static) {
    with_observation(true, move |proof, fixture| {
        action(proof.expect("actual native producer proof"), fixture)
    });
}
fn with_observation(
    explicit: bool,
    action: impl FnOnce(Option<ComputerRunProof>, Fixture) + 'static,
) {
    with_composition(explicit, true, action);
}
fn with_composition(
    explicit: bool,
    needs_grant: bool,
    action: impl FnOnce(Option<ComputerRunProof>, Fixture) + 'static,
) {
    let _reset = Reset;
    let tools = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let tools_root = tools.path().canonicalize().unwrap();
    let state_root = state.path().canonicalize().unwrap();
    let scope = state_root.join("granted-root");
    fs::create_dir(&scope).unwrap();
    let source = scope.join("source");
    fs::write(&source, b"synthetic source stays here").unwrap();
    let package = tools_root.join("tools/fixture");
    fs::create_dir_all(&package).unwrap();
    let declared = if needs_grant {
        json!([CAPABILITY])
    } else {
        json!([])
    };
    let mut invoke = json!({"kind":"computer","capabilities":declared,"argv":["sh","-c","true"]});
    if explicit {
        invoke["parent_actions"] = json!({"fd":3});
    }
    fs::write(
        package.join("tool-rows.json"),
        json!({"records":[{"payload":{"kind":"ai-tool-descriptor","id":TOOL,"invoke":invoke}}]})
            .to_string(),
    )
    .unwrap();
    let binding = synthetic_binding();
    os::composition::choose(Some(binding));
    let admitted_binding = os::binding().expect("original fixture binding");
    let parent = Arc::new(AtomicBool::new(true));
    let physical = Arc::new(AtomicBool::new(true));
    let checked = parent.clone();
    // One account per fixture: a passkey registration is per account, so parallel tests must not share one. The issuer
    // and the run name this same account.
    let account: &'static str = Box::leak(format!("proof-{}", uuid_like()).into_boxed_str());
    let issuer = NativeIssuer {
        context: Context::account_at(account, Arc::new(move || checked.load(Ordering::Acquire))),
        physical: physical.clone(),
    };
    let fixture = Fixture {
        account,
        of: RunOf {
            tool: TOOL.into(),
            request_key: REQUEST.into(),
        },
        source,
        generation: "synthetic-observePath-snapshot",
        scope,
        state: state_root.clone(),
        tools: tools_root.clone(),
        parent,
        physical,
        binding,
        admitted_binding,
    };
    if needs_grant {
        fixture.change_grant(Some(&fixture.scope), "original-grant");
    }
    let seen = Arc::new(AtomicBool::new(false));
    let observed = seen.clone();
    let mut action = Some(action);
    OBSERVER.with(|observer| {
        *observer.borrow_mut() = Some(Box::new(move |proof| {
            observed.store(true, Ordering::Release);
            action.take().unwrap()(proof.cloned(), fixture.clone());
        }))
    });
    let workshop = Workshop::from_data(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/tool_runs/tools/tool-runs.json"
    )))
    .unwrap();
    let place = Place {
        account,
        state_root: &state_root,
        door: Some(&issuer),
        origin: None,
    };
    let _ = workshop.answer(
        &tools_root,
        workshop.run_method(),
        REQUEST,
        &json!({"tool":TOOL,"input":{}}),
        &place,
        &NoValues,
        &AtomicBool::new(false),
    );
    assert!(
        seen.load(Ordering::Acquire),
        "the real Computer::run reached native admission"
    );
    if !needs_grant {
        assert!(
            matches!(
                shipped()
                    .unwrap()
                    .settings
                    .grants
                    .open_read_only(&state_root),
                Err(Failure::NotGranted(_))
            ),
            "a zero-capability run neither requires nor creates a grant book"
        );
    }
}

#[test]
fn callback_thread_reselects_the_original_native_binding_after_unrelated_thread_state() {
    with_proof(|proof, fixture| {
        assert!(std::ptr::eq(fixture.admitted_binding, proof.binding));
        assert!(proof.check(fixture.account, &fixture.of).is_ok());
        let callback_proof = proof.clone();
        let callback_fixture = fixture.clone();
        std::thread::spawn(move || {
            // A pooled callback thread may have served an unrelated test's
            // binding first. That binding must refuse this original proof.
            os::composition::choose(Some(os::composition::sbpl()));
            assert!(callback_proof
                .check(callback_fixture.account, &callback_fixture.of)
                .is_err());
            assert!(callback_fixture
                .proof_failure_stages(&callback_proof)
                .contains(&"thread_binding_object_identity"));
            // Matching implementation and grant data cannot authorize a
            // different instance of the original concrete binding type.
            let other_binding = synthetic_binding();
            os::composition::choose(Some(other_binding));
            assert!(callback_proof
                .check(callback_fixture.account, &callback_fixture.of)
                .is_err());
            assert!(callback_fixture
                .proof_failure_stages(&callback_proof)
                .contains(&"thread_binding_object_identity"));
            assert_eq!(other_binding.calls.load(Ordering::Acquire), 0);
            callback_fixture.choose_binding_for_this_thread();
            assert!(std::ptr::eq(
                os::binding().expect("restored callback binding"),
                callback_proof.binding
            ));
            let stages = callback_fixture.proof_failure_stages(&callback_proof);
            assert!(
                stages.is_empty(),
                "original callback binding was not restored: {stages:?}"
            );
            assert!(callback_proof
                .check(callback_fixture.account, &callback_fixture.of)
                .is_ok());
            assert_eq!(callback_fixture.calls(), 0);
        })
        .join()
        .unwrap();
        assert!(
            proof.check(fixture.account, &fixture.of).is_ok(),
            "another thread's selection never changes this producer thread"
        );
        assert_eq!(fixture.calls(), 0);
    });
}

#[test]
fn actual_computer_producer_checks_scope_current_cancel_deadline_and_synthetic_binding() {
    with_proof(|proof, fixture| {
        assert!(proof.check(fixture.account, &fixture.of).is_ok());
        assert!(proof.check("another-account", &fixture.of).is_err());
        for of in [
            RunOf {
                tool: "another-tool".into(),
                ..fixture.of.clone()
            },
            RunOf {
                request_key: "another-request".into(),
                ..fixture.of.clone()
            },
        ] {
            assert!(proof.check(fixture.account, &of).is_err());
        }
        fixture.parent.store(false, Ordering::Release);
        assert!(proof.check(fixture.account, &fixture.of).is_err());
        fixture.parent.store(true, Ordering::Release);
        fixture.physical.store(false, Ordering::Release);
        assert!(proof.check(fixture.account, &fixture.of).is_err());
        fixture.physical.store(true, Ordering::Release);
        proof.cancel.store(true, Ordering::Release);
        assert!(proof.check(fixture.account, &fixture.of).is_err());
        proof.cancel.store(false, Ordering::Release);
        let mut expired = proof.clone();
        expired.deadline = Some(Instant::now());
        assert!(expired.check(fixture.account, &fixture.of).is_err());
        fixture.binding.allowed.store(false, Ordering::Release);
        assert!(proof.check(fixture.account, &fixture.of).is_err());
        fixture.binding.allowed.store(true, Ordering::Release);
        assert_eq!(
            proof.trash_source(&fixture.source, fixture.generation, &|| false),
            TrashOutcome::Refused
        );
        assert_eq!(fixture.calls(), 0);
        assert_eq!(
            proof.trash_source(&fixture.source, fixture.generation, &|| true),
            TrashOutcome::Moved
        );
        assert_eq!(fixture.calls(), 1);
        assert_eq!(
            fixture.binding.last.lock().unwrap().as_ref(),
            Some(&(
                fixture.scope.clone(),
                fixture.source.clone(),
                fixture.generation.to_owned()
            ))
        );
        assert!(
            fixture.source.is_file(),
            "the synthetic binding performs no real Trash or delete"
        );
    });
}
#[test]
fn original_folder_and_grant_version_are_rechecked_without_regranting() {
    with_proof(|proof, fixture| {
        let moved = fixture.scope.with_file_name("old-root");
        fs::rename(&fixture.scope, &moved).unwrap();
        fs::create_dir(&fixture.scope).unwrap();
        assert!(
            proof.check(fixture.account, &fixture.of).is_err(),
            "same folder text with a new inode is not the held scope"
        );
        fs::remove_dir(&fixture.scope).unwrap();
        fs::rename(&moved, &fixture.scope).unwrap();
        assert!(proof.check(fixture.account, &fixture.of).is_ok());
        fixture.change_grant(None, "revoke");
        assert!(proof.check(fixture.account, &fixture.of).is_err());
        fixture.change_grant(Some(&fixture.scope), "regrant");
        assert!(
            proof.check(fixture.account, &fixture.of).is_err(),
            "identical parameters under a new version do not revive old authority"
        );
        assert_eq!(fixture.calls(), 0);
    });
}
#[test]
fn changed_grant_parameters_do_not_widen_the_original_scope() {
    with_proof(|proof, fixture| {
        let other = fixture.state.join("another-root");
        fs::create_dir(&other).unwrap();
        fixture.change_grant(Some(&other), "changed-parameters");
        assert!(proof.check(fixture.account, &fixture.of).is_err());
        assert_eq!(
            proof.trash_source(&fixture.source, fixture.generation, &|| true),
            TrashOutcome::Refused
        );
        assert_eq!(fixture.calls(), 0);
        assert!(fixture.source.is_file());
    });
}
#[test]
fn zero_capability_computer_run_reaches_its_boundary_without_a_grants_book() {
    with_composition(false, false, |proof, _| assert!(proof.is_none()));
}
#[test]
fn ordinary_computer_grant_does_not_mint_parent_action_evidence() {
    with_observation(false, |proof, _| assert!(proof.is_none()));
}

#[test]
fn recovery_rechecks_current_native_admission_read_only_without_a_live_run() {
    with_proof(|_, fixture| {
        let before = tree_bytes(&fixture.state);
        let first = fixture.recovery(Recovery::default()).unwrap();
        assert_eq!(first, fixture.recovery(Recovery::default()).unwrap());
        assert_eq!(
            first["holdings"][0]["kept_parameters"][PARAMETER],
            json!(fixture.scope)
        );
        assert_eq!(
            before,
            tree_bytes(&fixture.state),
            "recovery creates no folders or journal/grant/source changes"
        );
        assert_eq!(
            fixture.calls(),
            0,
            "recovery performs no native leaf action"
        );
        assert!(fixture.source.is_file());
        assert!(fixture
            .recovery(Recovery {
                kind: container::Container.name(),
                ..Recovery::default()
            })
            .is_err());
        assert!(fixture
            .recovery(Recovery {
                context: false,
                ..Recovery::default()
            })
            .is_err());
        assert!(fixture
            .recovery(Recovery {
                cancelled: true,
                ..Recovery::default()
            })
            .is_err());
        assert!(fixture
            .recovery(Recovery {
                cancel: true,
                ..Recovery::default()
            })
            .is_err());
        assert!(fixture
            .recovery(Recovery {
                deadline: Some(Instant::now()),
                ..Recovery::default()
            })
            .is_err());
        assert_eq!(
            first,
            fixture
                .recovery(Recovery {
                    until_ms: Some(0),
                    ..Recovery::default()
                })
                .unwrap(),
            "a finished answer remains admissible after its original execution deadline"
        );
        fixture.parent.store(false, Ordering::Release);
        assert!(fixture.recovery(Recovery::default()).is_err());
        fixture.parent.store(true, Ordering::Release);
        fixture.binding.allowed.store(false, Ordering::Release);
        assert!(fixture.recovery(Recovery::default()).is_err());
        fixture.binding.allowed.store(true, Ordering::Release);
        assert_eq!(first, fixture.recovery(Recovery::default()).unwrap());
        assert_eq!(before, tree_bytes(&fixture.state));
    });
}

#[test]
fn recovery_witness_distinguishes_regrants_and_changed_real_folder_authority() {
    with_proof(|_, fixture| {
        let original = fixture.recovery(Recovery::default()).unwrap();
        let moved = fixture.scope.with_file_name("old-recovery-root");
        fs::rename(&fixture.scope, &moved).unwrap();
        assert!(
            fixture.recovery(Recovery::default()).is_err(),
            "a missing folder refuses recovery"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&moved, &fixture.scope).unwrap();
            assert!(
                fixture.recovery(Recovery::default()).is_err(),
                "a symlink cannot replace the granted folder"
            );
            fs::remove_file(&fixture.scope).unwrap();
        }
        fs::create_dir(&fixture.scope).unwrap();
        assert_ne!(
            original,
            fixture.recovery(Recovery::default()).unwrap(),
            "same path with a new inode cannot recover the old receipt"
        );
        fs::remove_dir(&fixture.scope).unwrap();
        fs::rename(&moved, &fixture.scope).unwrap();
        assert_eq!(original, fixture.recovery(Recovery::default()).unwrap());
        fixture.change_grant(None, "recovery-revoke");
        assert!(fixture.recovery(Recovery::default()).is_err());
        fixture.change_grant(Some(&fixture.scope), "recovery-regrant");
        assert_ne!(
            original,
            fixture.recovery(Recovery::default()).unwrap(),
            "a new grant version cannot revive the original receipt"
        );
        let other = fixture.state.join("recovery-another-root");
        fs::create_dir(&other).unwrap();
        let regranted = fixture.recovery(Recovery::default()).unwrap();
        fixture.change_grant(Some(&other), "recovery-change-parameters");
        assert_ne!(regranted, fixture.recovery(Recovery::default()).unwrap());
        assert_eq!(fixture.calls(), 0);
        assert!(fixture.source.is_file());
    });
}

#[test]
fn recovery_of_zero_capability_computer_neither_requires_nor_creates_grant_book() {
    with_composition(false, false, |proof, fixture| {
        assert!(proof.is_none());
        let before = tree_bytes(&fixture.state);
        let witness = fixture.recovery(Recovery::default()).unwrap();
        assert_eq!(witness["holdings"], json!([]));
        assert!(witness["grant_book"].is_null());
        assert_eq!(before, tree_bytes(&fixture.state));
    });
}
