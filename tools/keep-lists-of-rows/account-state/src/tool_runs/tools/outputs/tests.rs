//! A row's outputs: the declaration, the files read from the run's folder, and the person's files they are kept in.
//! The files are a real account files over a record store in memory and an in-memory byte port.
use super::*;
use crate::{
    account_files::{
        objects::{Listing, ObjectError, Objects, Origin, Stat},
        AccountFiles, ORIGINS,
    },
    records::{Mutation, Records},
    storage::{
        memory::Memory,
        record_store::{settings, RecordStore, RealClock},
    },
};
use std::{
    cell::RefCell,
    collections::HashMap,
    io::Write,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

const ACCOUNT: &str = "account-a";
/// A media type for the fixtures.
const MEDIA: &str = "made-media";

/// Bytes kept by the byte port, by (origin, key).
#[derive(Default)]
struct Held(Mutex<HashMap<(String, String), Vec<u8>>>);
struct Port(Arc<Held>);
impl Objects for Port {
    /// A stand-in in memory sends no request, so it only keeps the control.
    fn set_control(&mut self, _: crate::account_files::CallControl) {}
    fn read(
        &self,
        origin: &str,
        key: &str,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, ObjectError> {
        let objects = self.0 .0.lock().unwrap();
        let bytes = objects
            .get(&(origin.to_owned(), key.to_owned()))
            .ok_or(ObjectError::Refused(404, crate::cause!()))?;
        Ok(bytes[offset as usize..(offset + length) as usize].to_vec())
    }
    fn write(&self, origin: &str, key: &str, bytes: &[u8], _: &str) -> Result<(), ObjectError> {
        self.0
             .0
            .lock()
            .unwrap()
            .insert((origin.to_owned(), key.to_owned()), bytes.to_vec());
        Ok(())
    }
    fn write_stream(
        &self,
        _: &str,
        _: &str,
        _: crate::account_files::objects::Body<'_>,
        _: &str,
    ) -> Result<(), ObjectError> {
        Err(ObjectError::Refused(501, crate::cause!()))
    }
    fn stat(&self, origin: &str, key: &str) -> Result<Option<Stat>, ObjectError> {
        Ok(self
            .0
             .0
            .lock()
            .unwrap()
            .get(&(origin.to_owned(), key.to_owned()))
            .map(|bytes| Stat {
                length: bytes.len() as u64,
                media_type: None,
            }))
    }
    fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<Listing, ObjectError> {
        Ok(Listing::default())
    }
}

/// An account files with one store that takes new bytes, standing for the person's files.
struct Person {
    account_files: RefCell<AccountFiles<Memory>>,
    held: Arc<Held>,
}
fn person() -> Person {
    let held = Arc::new(Held::default());
    let limits = settings::Limits::fixed(1 << 20, 10 << 30);
    let mut store = RecordStore::new(
        Memory::open("record_store").unwrap(),
        Box::new(RealClock),
        limits,
    )
    .unwrap();
    let origin: Origin = serde_json::from_value(json!({
        "kind": "namespace-origin", "rank": 1, "file_key_prefix": "files/",
        "reach": {"key_id": {"value": "k"}, "secret": {"value": "s"}, "bucket": {"value": "b"},
                  "endpoint": {"value": "https://s3.example.test"}, "region": {"value": "r"}}
    }))
    .unwrap();
    store
        .mutate(
            ACCOUNT,
            ORIGINS,
            Mutation {
                id: "store-one".into(),
                expected_version: 0,
                request_key: "origin-one".into(),
                deleted: false,
                value: serde_json::to_value(origin).unwrap(),
            },
        )
        .unwrap();
    Person {
        account_files: RefCell::new(AccountFiles::with_objects(
            store,
            ACCOUNT,
            Box::new(Port(held.clone())),
        )),
        held,
    }
}
impl Files for Person {
    fn name(&self, tool: &str, run: &str, file: &str) -> Result<String, Refused> {
        Ok(AccountFilesDoor::shipped()
            .ok_or(crate::cause!(Refused::Unavailable))?
            .run_output_name(tool, run, file))
    }
    fn call(&self, operation: &str, input: &Value) -> Result<Value, Refused> {
        self.account_files
            .borrow_mut()
            .call(operation, input)
            .expect("an account's files tool")
            .map_err(|error| match error {
                AccountFilesError::NotFound(_) => crate::cause!(Refused::Missing),
                AccountFilesError::Invalid(_, _) => crate::cause!(Refused::TooLarge),
                _ => crate::cause!(Refused::Unavailable),
            })
    }
}

/// The folder that stands for the container's `/`, the way the runner maps a row's paths into it.
fn folder() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let inside = fs::canonicalize(dir.path()).unwrap();
    fs::create_dir_all(base(&inside).join("out")).unwrap();
    (dir, inside)
}

/// Where the tool's files stand in the run's folder.
fn base(inside: &Path) -> PathBuf {
    inside.join("opt").join("tool")
}

/// The id of a tool, the way a row names it.
fn tool(name: &str) -> String {
    format!("tool{}{name}", ':')
}

fn placed(inside: &Path) -> impl Fn(&str) -> Option<PathBuf> + '_ {
    move |text| {
        text.strip_prefix("/opt/tool/")
            .map(|rest| base(inside).join(rest))
    }
}

fn output(extra: Value) -> Value {
    let mut item = json!({"name": "site", "path": "/opt/tool/out/site.json", "keep_in": "files", "media_type": MEDIA});
    item.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    item
}

fn declared_from(items: Value, inside: &Path) -> Result<Vec<Output>, Failure> {
    declared(&json!({"outputs": items}), &placed(inside))
}

#[test]
fn an_account_with_no_account_files_store_is_refused_with_the_door_step_that_failed() {
    let state = tempfile::tempdir().unwrap();
    let files = FilesInProcess {
        state_root: state.path(),
        account: "account-1",
        until: Instant::now() + std::time::Duration::from_secs(5),
    };
    let refused = files.call("files_summary", &json!({})).unwrap_err();
    assert!(matches!(&refused, Refused::Because(said, _) if said == r#"{"reason":"","step":"no_store_file"}"#));
    let said = refused.said();
    assert!(
        said.contains("no_store_file")
            && said.starts_with("your files are not available to keep it in"),
        "{said}"
    );
}

#[test]
fn a_row_with_no_outputs_declares_none() {
    let (_dir, inside) = folder();
    assert_eq!(
        declared(&json!({"argv": ["x"]}), &placed(&inside)),
        Ok(Vec::new())
    );
    assert_eq!(declared_from(json!([]), &inside), Ok(Vec::new()));
}

#[test]
fn an_output_is_declared_with_its_file_media_type_and_explicit_byte_bound() {
    let (_dir, inside) = folder();
    let outputs = declared_from(
        json!([output(json!({"max_bytes": 200_000_000u64}))]),
        &inside,
    )
    .unwrap();
    assert_eq!(
        outputs,
        vec![Output {
            name: "site".into(),
            path: base(&inside).join("out").join("site.json"),
            file: "site.json".into(),
            media_type: MEDIA.into(),
            limit: 200_000_000,
            tree: None,
            identity: None,
        }]
    );
    let small = declared_from(json!([output(json!({"max_bytes": 10}))]), &inside).unwrap();
    assert_eq!(small[0].limit, 10);
    let unbounded = declared_from(json!([output(json!({}))]), &inside).unwrap();
    assert_eq!(unbounded[0].limit, WRITE_MAX_BYTES as u64);
}

#[test]
fn a_declaration_the_engine_cannot_honour_refuses_the_run() {
    let (_dir, inside) = folder();
    let refused = |items: Value| matches!(declared_from(items, &inside), Err(Failure::NotRunnableHere(_)));
    assert!(refused(json!({"name": "site"})), "not a list");
    assert!(
        refused(json!([output(json!({"keep_in": "elsewhere"}))])),
        "the only place is files"
    );
    assert!(
        refused(
            json!([{"name": "site", "path": "/opt/tool/out/site.json", "media_type": "other-media"}])
        ),
        "no place"
    );
    assert!(
        refused(json!([output(json!({"path": "/etc/passwd"}))])),
        "a path outside the run's folder"
    );
    assert!(
        refused(json!([output(json!({"path": "/opt/tool/out/"}))])),
        "a folder, not a file"
    );
    assert!(
        refused(json!([output(json!({"name": &format!("a{}b", '/')}))])),
        "a name with a separator"
    );
    assert!(
        refused(json!([output(json!({"media_type": ""}))])),
        "an empty media type"
    );
    assert!(
        refused(json!([output(json!({"media_type": "other-media\n"}))])),
        "a control character in the media type"
    );
    assert!(
        refused(json!([output(json!({"max_bytes": 0}))])),
        "a limit of nothing"
    );
    assert!(
        refused(json!([output(json!({"max_bytes": "all"}))])),
        "a limit that is not a number"
    );
    assert!(
        refused(json!([
            output(json!({})),
            output(json!({"path": "/opt/tool/out/other.json"}))
        ])),
        "one name twice"
    );
    assert!(
        refused(json!([
            output(json!({})),
            output(json!({"name": "other", "path": "/opt/tool/elsewhere/site.json"}))
        ])),
        "one kept file name twice"
    );
    let many: Vec<Value> = (0..=MOST_OUTPUTS)
        .map(|n| output(json!({"name": format!("o{n}")})))
        .collect();
    assert!(
        refused(Value::Array(many)),
        "more outputs than a row may declare"
    );
}

#[test]
fn a_finished_runs_file_is_kept_in_the_persons_files_once_and_described() {
    let (_dir, inside) = folder();
    let bytes = br#"{"files":{"index.html":"<p>hello</p>"}}"#;
    fs::write(base(&inside).join("out").join("site.json"), bytes).unwrap();
    let outputs = declared_from(json!([output(json!({}))]), &inside).unwrap();
    let person = person();
    let files = keep(
        &outputs,
        &inside,
        &person,
        &tool("copy-a-site"),
        "0123456789abcdef",
        false,
    )
    .unwrap();
    let site = &files["site"];
    let hex: String = content_crypto::hash(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(site["identity"], format!("1f:{hex}"));
    assert_eq!(site["bytes"], bytes.len());
    assert_eq!(site["media_type"], MEDIA);
    let name = site["name"].as_str().unwrap().to_owned();
    assert!(
        name.ends_with("/copy-a-site/0123456789abcdef/site.json"),
        "{name}"
    );
    // The file is in the person's files under that name, with those bytes.
    let read = person
        .call("read_file", &json!({"name_or_identity": name}))
        .unwrap();
    assert_eq!(read["content"], std::str::from_utf8(bytes).unwrap());
    assert_eq!(person.held.0.lock().unwrap().len(), 1);
    // The same run kept again is the same file: nothing new is stored.
    let again = keep(
        &outputs,
        &inside,
        &person,
        &tool("copy-a-site"),
        "0123456789abcdef",
        false,
    )
    .unwrap();
    assert_eq!(again, files);
    assert_eq!(person.held.0.lock().unwrap().len(), 1);
}

#[test]
fn a_retry_of_a_finished_run_finds_its_files_by_name_and_reads_no_folder() {
    let (_dir, inside) = folder();
    fs::write(base(&inside).join("out").join("site.json"), b"{}").unwrap();
    let outputs = declared_from(json!([output(json!({}))]), &inside).unwrap();
    let person = person();
    let first = keep(
        &outputs,
        &inside,
        &person,
        &tool("copy-a-site"),
        "run-one",
        false,
    )
    .unwrap();
    let (_other, empty) = folder();
    let outputs = declared_from(json!([output(json!({}))]), &empty).unwrap();
    assert_eq!(
        keep(
            &outputs,
            &empty,
            &person,
            &tool("copy-a-site"),
            "run-one",
            true
        )
        .unwrap(),
        first
    );
    // A retry of a run that never kept its file has nothing to find.
    let said = keep(
        &outputs,
        &empty,
        &person,
        &tool("copy-a-site"),
        "run-two",
        true,
    )
    .unwrap_err();
    assert_eq!(
        said.code,
        "the output site was not kept: the tool did not make the file"
    );
}

#[test]
fn a_file_that_is_missing_too_large_or_not_inside_the_folder_is_not_kept() {
    let (_dir, inside) = folder();
    let person = person();
    let outputs = declared_from(json!([output(json!({"max_bytes": 4}))]), &inside).unwrap();
    let run = |outputs: &[Output]| keep(outputs, &inside, &person, &tool("t"), "r", false);
    assert_eq!(
        run(&outputs).unwrap_err().code,
        "the output site was not kept: the tool did not make the file"
    );
    fs::write(base(&inside).join("out").join("site.json"), b"12345").unwrap();
    assert_eq!(
        run(&outputs).unwrap_err().code,
        "the output site was not kept: the file is larger than a tool may keep"
    );
    fs::remove_file(base(&inside).join("out").join("site.json")).unwrap();
    // A link out of the run's folder is no file of the run's.
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), b"x").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        base(&inside).join("out").join("site.json"),
    )
    .unwrap();
    assert_eq!(
        run(&outputs).unwrap_err().code,
        "the output site was not kept: the path is not a file inside the tool's folder"
    );
    fs::remove_file(base(&inside).join("out").join("site.json")).unwrap();
    // A folder is no file.
    fs::create_dir(base(&inside).join("out").join("site.json")).unwrap();
    assert_eq!(
        run(&outputs).unwrap_err().code,
        "the output site was not kept: the path is not a file inside the tool's folder"
    );
    assert!(person.held.0.lock().unwrap().is_empty(), "nothing was kept");
}

#[test]
fn a_file_larger_than_one_write_uses_the_existing_chunk_upload_and_keeps_its_blake3_identity() {
    let (_dir, inside) = folder();
    let big = vec![b'a'; WRITE_MAX_BYTES + 1];
    fs::write(base(&inside).join("out").join("site.json"), &big).unwrap();
    let outputs = declared_from(json!([output(json!({"max_bytes": u64::MAX}))]), &inside).unwrap();
    let person = person();
    let kept = keep(&outputs, &inside, &person, &tool("t"), "large", false).unwrap();
    let hex: String = content_crypto::hash(&big)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(kept["site"]["identity"], format!("1f:{hex}"));
    assert_eq!(kept["site"]["bytes"], big.len());
    let name = kept["site"]["name"].as_str().unwrap();
    let tail = person
        .call(
            "read_file",
            &json!({"name_or_identity": name, "offset": WRITE_MAX_BYTES, "length": 1}),
        )
        .unwrap();
    assert_eq!(tail["content"], "a");
    assert_eq!(
        keep(&outputs, &inside, &person, &tool("t"), "large", true).unwrap(),
        kept
    );
}

/// The account files accepts the first piece but is temporarily unavailable at the next. Calls reach the real
/// Namespace upload owner; only the transport interruption is a stand-in, with no second upload implementation.
struct Interrupted {
    person: Person,
    interrupt: std::cell::Cell<bool>,
    offsets: RefCell<Vec<u64>>,
}
impl Files for Interrupted {
    fn name(&self, tool: &str, run: &str, file: &str) -> Result<String, Refused> {
        self.person.name(tool, run, file)
    }
    fn call(&self, operation: &str, input: &Value) -> Result<Value, Refused> {
        if operation == "write_file_piece" {
            let offset = input["offset"].as_u64().unwrap();
            self.offsets.borrow_mut().push(offset);
            assert!(
                STANDARD
                    .decode(input["content_base64"].as_str().unwrap())
                    .unwrap()
                    .len()
                    <= SUBTREE_BYTES
            );
            if offset > 0 && self.interrupt.replace(false) {
                return Err(crate::cause!(Refused::Unavailable));
            }
        }
        self.person.call(operation, input)
    }
}

#[test]
fn an_interrupted_large_output_resumes_its_existing_upload_and_checks_accepted_bytes_again() {
    let (_dir, inside) = folder();
    let path = base(&inside).join("out").join("site.json");
    let bytes = vec![b'x'; WRITE_MAX_BYTES + 1];
    fs::write(&path, &bytes).unwrap();
    let outputs =
        declared_from(json!([output(json!({"max_bytes": bytes.len()}))]), &inside).unwrap();
    let files = Interrupted {
        person: person(),
        interrupt: std::cell::Cell::new(true),
        offsets: RefCell::new(Vec::new()),
    };
    assert!(keep(&outputs, &inside, &files, &tool("t"), "resume", false).is_err());
    let name = files.name(&tool("t"), "resume", "site.json").unwrap();
    assert!(matches!(files.call("find_file", &json!({"name_or_identity": name})), Err(Refused::Missing(_) )));
    assert_eq!(&*files.offsets.borrow(), &[0, SUBTREE_BYTES as u64]);
    let kept = keep(&outputs, &inside, &files, &tool("t"), "resume", true).unwrap();
    assert_eq!(kept["site"]["bytes"], bytes.len());
    assert_eq!(
        files.offsets.borrow()[2],
        0,
        "accepted pieces are verified again on retry"
    );
}

#[test]
fn a_retry_cannot_replace_the_bytes_an_interrupted_upload_already_accepted() {
    let (_dir, inside) = folder();
    let path = base(&inside).join("out").join("site.json");
    let mut bytes = vec![b'x'; WRITE_MAX_BYTES + 1];
    fs::write(&path, &bytes).unwrap();
    let outputs =
        declared_from(json!([output(json!({"max_bytes": bytes.len()}))]), &inside).unwrap();
    let files = Interrupted {
        person: person(),
        interrupt: std::cell::Cell::new(true),
        offsets: RefCell::new(Vec::new()),
    };
    assert!(keep(&outputs, &inside, &files, &tool("t"), "changed", false).is_err());
    bytes[0] = b'y';
    fs::write(&path, &bytes).unwrap();
    assert!(keep(&outputs, &inside, &files, &tool("t"), "changed", true).is_err());
    let name = files.name(&tool("t"), "changed", "site.json").unwrap();
    assert!(matches!(files.call("find_file", &json!({"name_or_identity": name})), Err(Refused::Missing(_) )));
}

#[test]
fn an_account_whose_files_are_not_available_says_so_and_keeps_nothing() {
    let (_dir, inside) = folder();
    fs::write(base(&inside).join("out").join("site.json"), b"{}").unwrap();
    let outputs = declared_from(json!([output(json!({}))]), &inside).unwrap();
    let state = tempfile::tempdir().unwrap();
    let files = FilesInProcess {
        state_root: state.path(),
        account: ACCOUNT,
        until: Instant::now() + std::time::Duration::from_secs(5),
    };
    let said = keep(&outputs, &inside, &files, &tool("t"), "r", false).unwrap_err();
    assert_eq!(said.code, "the output site was not kept: your files are not available to keep it in ({\"reason\":\"\",\"step\":\"no_store_file\"})");
    assert_eq!(
        fs::read_dir(state.path()).unwrap().count(),
        0,
        "no store was made"
    );
}

/// A Workshop folder with one tool that writes `out/site.json`, whose row declares that output.
fn making_workshop(extra: Value) -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    let package = root.path().join("tools").join("maker");
    fs::create_dir_all(package.join("do-work")).unwrap();
    fs::write(
        package.join("do-work").join("make.sh"),
        "mkdir -p \"$1\"; printf '{\"made\":true}' > \"$1/site.json\"; printf '{\"ok\":1}\\n'\n",
    )
    .unwrap();
    let mut invoke = json!({"kind": "container", "workdir": "/opt/maker", "stdout": "json",
        "argv": ["sh", "/opt/maker/do-work/make.sh", "/opt/maker/out"],
        "files": {"package_files": {"package": "maker", "paths": ["do-work"], "at": "/opt/maker"}},
        "outputs": [{"name": "site", "path": "/opt/maker/out/site.json", "keep_in": "files", "media_type": MEDIA}]});
    invoke
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let rows = json!({"records": [{"payload": {"kind": "ai-tool-descriptor", "id": tool("maker"), "result_selector": "$", "invoke": invoke}}]});
    fs::write(package.join("tool-rows.json"), rows.to_string()).unwrap();
    root
}

struct NoHeld;
impl super::super::Held for NoHeld {
    fn plain(&self, _: &str) -> Result<zeroize::Zeroizing<String>, Failure> {
        Err(crate::cause!(Failure::Credential))
    }
}

fn run_maker(root: &Path, state: &Path, key: &str) -> Result<Value, Failure> {
    run_named_maker(root, state, key, "maker")
}

fn run_named_maker(root: &Path, state: &Path, key: &str, name: &str) -> Result<Value, Failure> {
    let workshop = super::super::Workshop::from_data(
        &fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/tool_runs/tools/tool-runs.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let place = super::super::Place {
        account: ACCOUNT,
        state_root: state,
        door: None,
        origin: None,
    };
    workshop.answer(
        root,
        &workshop.settings.run_method,
        key,
        &json!({"tool": tool(name), "input": {}}),
        &place,
        &NoHeld,
        &std::sync::atomic::AtomicBool::new(false),
    )
}

#[test]
fn a_run_whose_file_cannot_be_kept_answers_why_and_names_no_file() {
    let state = tempfile::tempdir().unwrap();
    let root = making_workshop(json!({}));
    let answer = run_maker(root.path(), state.path(), "make-one").unwrap();
    assert_eq!(answer["exit_code"], 0, "{answer}");
    assert_eq!(answer["error"], "the output site was not kept: your files are not available to keep it in ({\"reason\":\"\",\"step\":\"no_store_file\"})");
    assert!(
        answer.get("files").is_none() && answer.get("result").is_none(),
        "{answer}"
    );
    let digest: String = content_crypto::hash(format!("{ACCOUNT}\0make-one").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let retained = state.path().join("workshop-tool-runs").join(digest);
    assert_eq!(
        fs::read(retained.join("opt/maker/out/site.json")).unwrap(),
        br#"{"made":true}"#
    );
    // The prepared first-run script survives; changing the source cannot replace retained files or launch again.
    fs::write(root.path().join("tools/maker/do-work/make.sh"), "exit 99\n").unwrap();
    let retry = run_maker(root.path(), state.path(), "make-one").unwrap();
    assert_eq!(retry["exit_code"], 0, "{retry}");
    assert_eq!(retry["replayed"], true, "{retry}");
    assert_eq!(retry["error"], answer["error"]);
    assert!(retained.join("opt/maker/out/site.json").is_file());
}

#[test]
fn a_changed_row_cannot_erase_a_journal_owned_unpublished_output() {
    let state = tempfile::tempdir().unwrap();
    let root = making_workshop(json!({}));
    let first = run_maker(root.path(), state.path(), "retained-definition").unwrap();
    assert_eq!(first["exit_code"], 0, "{first}");
    assert!(
        first["error"].is_string(),
        "publication is unavailable: {first}"
    );
    let digest: String = content_crypto::hash(format!("{ACCOUNT}\0retained-definition").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let output = state
        .path()
        .join("workshop-tool-runs")
        .join(digest)
        .join("opt/maker/out/site.json");
    let rows_path = root.path().join("tools/maker/tool-rows.json");
    let original = fs::read(&rows_path).unwrap();
    let mut changed: Value = serde_json::from_slice(&original).unwrap();
    changed["records"][0]["payload"]["invoke"]
        .as_object_mut()
        .unwrap()
        .remove("outputs");
    fs::write(&rows_path, changed.to_string()).unwrap();
    assert!(matches!(run_maker(root.path(), state.path(), "retained-definition"), Err(Failure::KeyReused(_) )));
    assert_eq!(fs::read(&output).unwrap(), br#"{"made":true}"#);
    changed["records"][0]["payload"]["id"] = json!("tool:another-maker");
    fs::write(&rows_path, changed.to_string()).unwrap();
    assert!(matches!(run_named_maker(
            root.path(),
            state.path(),
            "retained-definition",
            "another-maker"
        ), Err(Failure::KeyReused(_) )));
    assert_eq!(fs::read(&output).unwrap(), br#"{"made":true}"#);
    // Restore the original action and prove its original process result still replays after the refused caller.
    fs::write(&rows_path, &original).unwrap();
    let again = run_maker(root.path(), state.path(), "retained-definition").unwrap();
    assert_eq!(again["replayed"], true, "{again}");
    assert_eq!(fs::read(&output).unwrap(), br#"{"made":true}"#);
}

#[test]
fn a_row_whose_output_leaves_its_folder_is_refused_before_anything_starts() {
    let state = tempfile::tempdir().unwrap();
    let root = making_workshop(
        json!({"outputs": [{"name": "site", "path": "/etc/hosts", "keep_in": "files", "media_type": "other-media"}]}),
    );
    assert!(matches!(run_maker(root.path(), state.path(), "make-two"), Err(Failure::NotRunnableHere(_) )));
    assert!(
        !state.path().join("workshop-tool-runs.sqlite").exists(),
        "nothing ran"
    );
}

fn tree_output(extra: Value) -> Value {
    let mut item = json!({"name": "bundle", "path": "/opt/tool/out/tree", "keep_in": "files", "media_type": MEDIA,
        "max_bytes": WRITE_MAX_BYTES as u64 + 1,
        "tree": {"files_from": "files", "max_files": 64, "max_bytes": 4 * WRITE_MAX_BYTES as u64}});
    item.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    item
}

fn tree_entry(name: &str, bytes: &[u8]) -> Value {
    let hash: String = content_crypto::hash(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    json!({"name": name, "bytes": bytes.len(), "blake3": hash})
}

/// Run the configured descriptor's declared synthetic sample through Workshop's existing JS row consumer, then feed
/// its raw selected result through the native Files owner. This is a deliberately split seam: it does not prove native
/// Workshop journal replay or a full producer-to-Files transaction. Product-specific row identity and fixture bytes
/// come from invocation environment and descriptor DATA.
#[test]
#[ignore = "integration: provide WORKSHOP_SOURCE_ROOT, TOOL_ROWS_PATH, TOOL_ID and SAMPLE_BYTES_B64"]
fn a_declared_synthetic_tree_result_is_kept_by_the_native_files_owner_and_replayed_from_its_manifest() {
    let source_root = PathBuf::from(std::env::var_os("WORKSHOP_SOURCE_ROOT").expect("set WORKSHOP_SOURCE_ROOT"));
    let rows_path = PathBuf::from(std::env::var_os("TOOL_ROWS_PATH").expect("set TOOL_ROWS_PATH"));
    let tool_id = std::env::var("TOOL_ID").expect("set TOOL_ID");
    let bytes = STANDARD.decode(std::env::var("SAMPLE_BYTES_B64").expect("set SAMPLE_BYTES_B64")).unwrap();
    let rows: Value = serde_json::from_slice(&fs::read(rows_path).unwrap()).unwrap();
    let row = rows["records"].as_array().unwrap().iter().map(|record| &record["payload"])
        .find(|payload| payload["id"] == tool_id).expect("descriptor exists in DATA");
    let sample = &row["verify"][0];
    assert_eq!(sample["kind"], "sample-run");
    let helper = r#"
      import { runRow } from './test-helpers/run-a-row.mjs';
      let data = ''; for await (const part of process.stdin) data += part;
      const { row, sample } = JSON.parse(data);
      const ran = await runRow(row, sample.input, sample);
      process.stdout.write(JSON.stringify(ran));
    "#;
    let mut child = Command::new("node").args(["--input-type=module", "-e", helper]).current_dir(&source_root)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    serde_json::to_writer(child.stdin.as_mut().unwrap(), &json!({"row": row, "sample": sample})).unwrap();
    child.stdin.take().unwrap().flush().unwrap();
    let process = child.wait_with_output().unwrap();
    assert!(process.status.success(), "{}", String::from_utf8_lossy(&process.stderr));
    let ran: Value = serde_json::from_slice(&process.stdout).unwrap();
    assert_eq!(ran["code"], 0, "{ran}");
    assert_eq!(ran["unanswered"], json!([]), "the declared sample made no provider or external request");
    let process_result = ran["last"].clone();
    let result = &process_result["result"];
    let item = &result["files"][0];
    let file_name = item["name"].as_str().unwrap();
    assert_eq!(item.as_object().unwrap().len(), 3, "the result exposes only its declared file metadata");
    assert_eq!(item["bytes"].as_u64(), Some(bytes.len() as u64));
    let hash: String = content_crypto::hash(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
    assert_eq!(item["blake3"], hash, "sample result manifest matches supplied fixture bytes");
    assert_eq!(result["file"], format!("1f:{hash}"));

    let (_dir, inside) = folder();
    let under = |text: &str| text.strip_prefix('/').map(|rest| inside.join(rest));
    let outputs = declared(&row["invoke"], &under).unwrap();
    let output_name = outputs[0].name.clone();
    let output_dir = outputs[0].path.clone();
    fs::create_dir_all(&output_dir).unwrap();
    fs::write(output_dir.join(file_name), &bytes).unwrap();
    assert_eq!(outputs[0].tree.as_ref().unwrap().files_from, "result.files");
    let person = person();
    let run_tool = tool(tool_id.strip_prefix("tool:").unwrap_or(&tool_id));
    let request_key = "original-synthetic-key";
    let first = keep_with_result(&outputs, &inside, &person, &run_tool, request_key, false, &process_result).unwrap();
    let kept_file = &first[&output_name]["files"][file_name];
    assert_eq!(kept_file["identity"], format!("1f:{hash}"));
    assert_eq!(kept_file["bytes"], bytes.len());
    assert_eq!(kept_file["media_type"], outputs[0].media_type);
    let name = kept_file["name"].as_str().unwrap().to_owned();
    let read = person.call("read_file", &json!({"name_or_identity": name, "encoding": "base64"})).unwrap();
    assert_eq!(STANDARD.decode(read["content"].as_str().unwrap()).unwrap(), bytes);
    assert_eq!(fs::read_dir(&output_dir).unwrap().count(), 1, "only the declared output file is materialized");

    let (_clean, empty) = folder();
    let under_empty = |text: &str| text.strip_prefix('/').map(|rest| empty.join(rest));
    let replay_outputs = declared(&row["invoke"], &under_empty).unwrap();
    assert_eq!(keep_with_result(&replay_outputs, &empty, &person, &run_tool, request_key, true, &process_result).unwrap(), first);
    assert!(!replay_outputs[0].path.exists(), "replay reads the kept identity without producer output");
    let mut changed = process_result.clone();
    changed["result"]["files"][0]["blake3"] = json!("0".repeat(64));
    assert!(keep_with_result(&replay_outputs, &empty, &person, &run_tool, request_key, true, &changed).is_err(),
        "a changed manifest cannot replace the originally kept output");
    assert_eq!(person.held.0.lock().unwrap().len(), 1, "replay adds no object");

    let state = tempfile::tempdir().unwrap();
    let denied = FilesInProcess { state_root: state.path(), account: ACCOUNT,
        until: Instant::now() + std::time::Duration::from_secs(5) };
    let said = keep_with_result(&outputs, &inside, &denied, &run_tool, "denied-synthetic-key", false, &process_result).unwrap_err();
    assert!(said.contains("your files are not available"), "{said}");
    assert_eq!(fs::read_dir(state.path()).unwrap().count(), 0, "Files denial leaves no state");
}

fn make_tree_file(inside: &Path, name: &str, bytes: &[u8]) {
    let path = base(inside).join("out/tree").join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn tree_declarations_keep_literal_result_selector_count_total_and_per_file_bounds() {
    let (_dir, inside) = folder();
    let outputs = declared_from(json!([tree_output(json!({"max_bytes": 5_000_000_000u64,
        "tree": {"files_from": "snapshot.files", "max_files": 64, "max_bytes": 20_000_000_000u64}}))]), &inside).unwrap();
    let result = json!({"snapshot": {"files": [{"name": "large.bin", "bytes": 3_780_000_000u64, "blake3": "a".repeat(64)}]}});
    let planned = members(&outputs[0], &result).unwrap();
    assert_eq!(planned[0].bytes, 3_780_000_000);
    assert_eq!(planned[0].output.limit, 3_780_000_000);
    for tree in [
        Value::Null,
        json!({}),
        json!({"files_from": "files", "max_files": 0, "max_bytes": 100}),
        json!({"files_from": "files", "max_files": MAX_PACKAGE_FILES + 1, "max_bytes": 100}),
        json!({"files_from": "files", "max_files": 4, "max_bytes": 0}),
        json!({"files_from": {"fill": {"from": "input", "field": "selector"}}, "max_files": 4, "max_bytes": 100}),
        json!({"files_from": "files", "max_files": {"fill": {"from": "input", "field": "count"}}, "max_bytes": 100}),
        json!({"files_from": "files", "max_files": 4, "max_bytes": {"fill": {"from": "input", "field": "bytes"}}}),
        json!({"files_from": "files", "max_files": 4, "max_bytes": 100, "extra": true}),
    ] {
        assert!(declared_from(json!([tree_output(json!({"tree": tree}))]), &inside).is_err());
    }
    // A normal output cannot replace a tree's Namespace folder, in either declaration order.
    let collision = output(json!({"name": "other", "path": "/opt/tool/out/bundle"}));
    assert!(declared_from(json!([tree_output(json!({})), collision]), &inside).is_err());
    assert!(declared_from(json!([collision, tree_output(json!({}))]), &inside).is_err());
}

#[test]
fn a_result_bound_tree_keeps_more_than_sixteen_files_relative_names_and_replays_without_its_folder()
{
    let (_dir, inside) = folder();
    let person = person();
    let mut entries = Vec::new();
    let mut total = 0usize;
    for index in 0..20 {
        let name = format!("nested/part-{index:02}.bin");
        let bytes = format!("synthetic shard {index}").into_bytes();
        total += bytes.len();
        make_tree_file(&inside, &name, &bytes);
        entries.push(tree_entry(&name, &bytes));
    }
    make_tree_file(
        &inside,
        "unlisted.bin",
        b"not named by the original process result",
    );
    entries.reverse();
    let result = json!({"snapshot": {"files": entries}});
    let declaration = tree_output(
        json!({"tree": {"files_from": "snapshot.files", "max_files": 64, "max_bytes": 4096}}),
    );
    let outputs = declared_from(json!([declaration]), &inside).unwrap();
    let first = keep_with_result(
        &outputs,
        &inside,
        &person,
        &tool("tree-maker"),
        "tree-run",
        false,
        &result,
    )
    .unwrap();
    assert_eq!(first["bundle"]["bytes"], total);
    assert_eq!(first["bundle"]["files"].as_object().unwrap().len(), 20);
    for entry in result["snapshot"]["files"].as_array().unwrap() {
        let relative = entry["name"].as_str().unwrap();
        let kept = &first["bundle"]["files"][relative];
        assert_eq!(
            kept["identity"],
            format!("1f:{}", entry["blake3"].as_str().unwrap())
        );
        assert!(kept["name"]
            .as_str()
            .unwrap()
            .ends_with(&format!("/bundle/{relative}")));
        let read = person
            .call("read_file", &json!({"name_or_identity": kept["identity"]}))
            .unwrap();
        assert_eq!(read["bytes_returned"], entry["bytes"]);
    }
    assert_eq!(
        person.held.0.lock().unwrap().len(),
        20,
        "no extra mutable recovery manifest was written"
    );
    let (_clean, empty) = folder();
    let outputs = declared_from(json!([declaration]), &empty).unwrap();
    assert_eq!(
        keep_with_result(
            &outputs,
            &empty,
            &person,
            &tool("tree-maker"),
            "tree-run",
            true,
            &result
        )
        .unwrap(),
        first
    );
    assert!(
        !base(&empty).join("out/tree").exists(),
        "replay recovered from the original result and Files metadata"
    );
}

#[test]
fn trees_validate_whole_count_sum_and_expected_identity_before_uploading_any_member() {
    for behavior in [
        "count",
        "total",
        "per-file",
        "wrong-hash",
        "wrong-length",
        "overflow",
    ] {
        let (_dir, inside) = folder();
        make_tree_file(&inside, "a.bin", b"first");
        make_tree_file(&inside, "b.bin", b"second");
        let mut declaration = tree_output(json!({}));
        let mut result =
            json!({"files": [tree_entry("a.bin", b"first"), tree_entry("b.bin", b"second")]});
        match behavior {
            "count" => declaration["tree"]["max_files"] = json!(1),
            "total" => declaration["tree"]["max_bytes"] = json!(10),
            "per-file" => declaration["max_bytes"] = json!(5),
            "wrong-hash" => result["files"][1]["blake3"] = json!("a".repeat(64)),
            "wrong-length" => result["files"][1]["bytes"] = json!(5),
            _ => {
                declaration["max_bytes"] = json!(u64::MAX);
                declaration["tree"]["max_bytes"] = json!(u64::MAX);
                result["files"][0]["bytes"] = json!(u64::MAX);
            }
        }
        let outputs = declared_from(json!([declaration]), &inside).unwrap();
        let person = person();
        assert!(
            keep_with_result(
                &outputs,
                &inside,
                &person,
                &tool("tree-maker"),
                behavior,
                false,
                &result
            )
            .is_err(),
            "{behavior}"
        );
        assert!(
            person.held.0.lock().unwrap().is_empty(),
            "{behavior}: every member is preflighted before the first upload"
        );
    }
}

#[test]
fn trees_refuse_unsafe_duplicate_prefix_and_malformed_original_manifest_entries() {
    let (_dir, inside) = folder();
    make_tree_file(&inside, "good.bin", b"good");
    let outputs = declared_from(json!([tree_output(json!({}))]), &inside).unwrap();
    for name in [
        "../escape",
        "/absolute",
        "a//b",
        "a/./b",
        "a\\b",
        "",
        "a\0b",
        "a\nb",
    ] {
        let person = person();
        let result = json!({"files": [tree_entry(name, b"good")]});
        assert!(
            keep_with_result(
                &outputs,
                &inside,
                &person,
                &tool("tree-maker"),
                "unsafe",
                false,
                &result
            )
            .is_err(),
            "{name:?}"
        );
        assert!(person.held.0.lock().unwrap().is_empty());
    }
    for entries in [
        json!([
            tree_entry("good.bin", b"good"),
            tree_entry("good.bin", b"good")
        ]),
        json!([tree_entry("a", b"good"), tree_entry("a/b", b"good")]),
        json!([{"name": "good.bin", "bytes": 4, "blake3": "not a digest"}]),
        json!([{"name": "good.bin", "bytes": -1, "blake3": "a".repeat(64)}]),
        json!([{"name": "good.bin", "bytes": 4, "blake3": "a".repeat(64), "url": "https://outside.invalid"}]),
        Value::Null,
    ] {
        let person = person();
        assert!(keep_with_result(
            &outputs,
            &inside,
            &person,
            &tool("tree-maker"),
            "malformed",
            false,
            &json!({"files": entries})
        )
        .is_err());
        assert!(person.held.0.lock().unwrap().is_empty());
    }
}

#[test]
fn tree_members_refuse_symbolic_links_hard_links_folders_and_special_objects_before_uploads() {
    for kind in ["symlink", "parent-link", "hard-link", "folder", "socket"] {
        let (_dir, inside) = folder();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("file.bin"), b"good").unwrap();
        let root = base(&inside).join("out/tree");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("file.bin");
        let mut socket = None;
        match kind {
            "symlink" => {
                std::os::unix::fs::symlink(outside.path().join("file.bin"), &path).unwrap()
            }
            "parent-link" => {
                fs::remove_dir(&root).unwrap();
                std::os::unix::fs::symlink(outside.path(), &root).unwrap();
            }
            "hard-link" => fs::hard_link(outside.path().join("file.bin"), &path).unwrap(),
            "folder" => fs::create_dir(&path).unwrap(),
            _ => socket = Some(std::os::unix::net::UnixListener::bind(&path).unwrap()),
        }
        let outputs = declared_from(json!([tree_output(json!({}))]), &inside).unwrap();
        let person = person();
        assert!(
            keep_with_result(
                &outputs,
                &inside,
                &person,
                &tool("tree-maker"),
                kind,
                false,
                &json!({"files": [tree_entry("file.bin", b"good")]})
            )
            .is_err(),
            "{kind}"
        );
        assert!(person.held.0.lock().unwrap().is_empty());
        drop(socket);
    }
}

#[test]
fn a_large_tree_member_resumes_the_existing_upload_and_replays_its_original_manifest() {
    let (_dir, inside) = folder();
    let bytes = vec![b'x'; WRITE_MAX_BYTES + 1];
    make_tree_file(&inside, "large.bin", &bytes);
    let result = json!({"files": [tree_entry("large.bin", &bytes)]});
    let declaration = tree_output(json!({}));
    let outputs = declared_from(json!([declaration]), &inside).unwrap();
    let files = Interrupted {
        person: person(),
        interrupt: std::cell::Cell::new(true),
        offsets: RefCell::new(Vec::new()),
    };
    assert!(keep_with_result(
        &outputs,
        &inside,
        &files,
        &tool("tree-maker"),
        "resume-tree",
        false,
        &result
    )
    .is_err());
    let answer = keep_with_result(
        &outputs,
        &inside,
        &files,
        &tool("tree-maker"),
        "resume-tree",
        true,
        &result,
    )
    .unwrap();
    assert_eq!(
        answer["bundle"]["files"]["large.bin"]["identity"],
        format!("1f:{}", result["files"][0]["blake3"].as_str().unwrap())
    );
    assert_eq!(
        files.offsets.borrow()[2],
        0,
        "the existing upload rechecks its accepted first piece"
    );
    let (_clean, empty) = folder();
    let outputs = declared_from(json!([declaration]), &empty).unwrap();
    assert_eq!(
        keep_with_result(
            &outputs,
            &empty,
            &files,
            &tool("tree-maker"),
            "resume-tree",
            true,
            &result
        )
        .unwrap(),
        answer
    );
    let mut changed = result.clone();
    changed["files"][0]["blake3"] = json!("d".repeat(64));
    assert!(
        keep_with_result(
            &outputs,
            &empty,
            &files,
            &tool("tree-maker"),
            "resume-tree",
            true,
            &changed
        )
        .is_err(),
        "a mutable later manifest cannot relabel a kept output's identity"
    );
}

#[test]
fn a_large_bounded_tree_is_kept_and_delivered_by_the_existing_answer_pager() {
    let (_dir, inside) = folder();
    let declaration =
        tree_output(json!({"tree": {"files_from": "files", "max_files": 160, "max_bytes": 4096}}));
    let outputs = declared_from(json!([declaration]), &inside).unwrap();
    let mut entries = Vec::new();
    for index in 0..160 {
        let name = format!("{index:04}-{}.bin", "x".repeat(140));
        let bytes = format!("synthetic file {index}").into_bytes();
        make_tree_file(&inside, &name, &bytes);
        entries.push(tree_entry(&name, &bytes));
    }
    let result = json!({"files": entries});
    let person = person();
    let kept = keep_with_result(
        &outputs,
        &inside,
        &person,
        &tool("tree-maker"),
        "paged-tree",
        false,
        &result,
    )
    .unwrap();
    assert_eq!(kept["bundle"]["files"].as_object().unwrap().len(), 160);
    let answer = json!({"tool": tool("tree-maker"), "exit_code": 0, "replayed": false, "result": result, "files": kept});
    assert!(!crate::mcp::tool_answer_fits(&answer));
    let expected = serde_json::to_vec(&answer).unwrap();
    let hash: String = content_crypto::hash(&expected)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut after = None;
    let mut joined = Vec::new();
    let mut pages = 0;
    loop {
        let page = super::super::pages::deliver(answer.clone(), after).unwrap();
        assert!(crate::mcp::tool_answer_fits(&page));
        let page = &page["byte_page"];
        assert_eq!(page["offset"], joined.len());
        assert_eq!(page["total"], expected.len());
        assert_eq!(page["blake3"], hash);
        let bytes = STANDARD.decode(page["base64"].as_str().unwrap()).unwrap();
        assert_eq!(page["length"], bytes.len());
        joined.extend_from_slice(&bytes);
        pages += 1;
        match page["next_after_byte"].as_u64() {
            Some(next) => {
                assert!(next > after.unwrap_or(0));
                after = Some(next);
            }
            None => break,
        }
    }
    assert!(pages > 1);
    assert_eq!(joined, expected);
    // A later page reconstructs the same Files manifest after source cleanup, and the pager normalizes replayed.
    let (_clean, empty) = folder();
    let outputs = declared_from(json!([declaration]), &empty).unwrap();
    let replay = keep_with_result(
        &outputs,
        &empty,
        &person,
        &tool("tree-maker"),
        "paged-tree",
        true,
        &result,
    )
    .unwrap();
    assert_eq!(replay, kept);
    let mut replay_answer = answer;
    replay_answer["replayed"] = json!(true);
    let replay_page = super::super::pages::deliver(replay_answer, Some(0)).unwrap();
    assert_eq!(replay_page["byte_page"]["blake3"], hash);
}

#[test]
fn a_large_member_changed_after_preflight_is_not_published_under_the_original_result() {
    struct ChangeAfterFirstFile {
        person: Person,
        path: PathBuf,
        changed: std::cell::Cell<bool>,
    }
    impl Files for ChangeAfterFirstFile {
        fn name(&self, tool: &str, run: &str, file: &str) -> Result<String, Refused> {
            self.person.name(tool, run, file)
        }
        fn call(&self, operation: &str, input: &Value) -> Result<Value, Refused> {
            let answer = self.person.call(operation, input)?;
            if operation == "write_file" && !self.changed.replace(true) {
                // Both files passed the keeper's local hash preflight. Simulate the second one's later change
                // before its upload starts, preserving its length so only the BLAKE3 witness detects it.
                use std::io::Write as _;
                let mut file = fs::OpenOptions::new().write(true).open(&self.path).unwrap();
                file.write_all(b"y").unwrap();
            }
            Ok(answer)
        }
    }
    let (_dir, inside) = folder();
    let bytes = vec![b'x'; WRITE_MAX_BYTES + 1];
    make_tree_file(&inside, "a.json", b"{}");
    make_tree_file(&inside, "z.bin", &bytes);
    let result = json!({"files": [tree_entry("a.json", b"{}"), tree_entry("z.bin", &bytes)]});
    let outputs = declared_from(json!([tree_output(json!({}))]), &inside).unwrap();
    let files = ChangeAfterFirstFile {
        person: person(),
        path: base(&inside).join("out/tree/z.bin"),
        changed: std::cell::Cell::new(false),
    };
    let error = keep_with_result(
        &outputs,
        &inside,
        &files,
        &tool("tree-maker"),
        "changed-after-preflight",
        false,
        &result,
    )
    .unwrap_err();
    assert!(
        error.contains("does not match the original process result"),
        "{error}"
    );
    let name = files
        .name(
            &tool("tree-maker"),
            "changed-after-preflight",
            "bundle/z.bin",
        )
        .unwrap();
    assert!(matches!(files.call("find_file", &json!({"name_or_identity": name})), Err(Refused::Missing(_) )), "the existing chunk upload never finished or published the changed file");
}

#[test]
fn a_tree_replays_deduplicated_bytes_with_the_existing_namespace_media_type() {
    let (_dir, inside) = folder();
    let bytes = b"synthetic previously kept content";
    let person = person();
    let earlier = person
        .call(
            "write_file",
            &json!({"name": "/earlier.txt", "text": std::str::from_utf8(bytes).unwrap(),
        "media_type": "text/plain"}),
        )
        .unwrap();
    make_tree_file(&inside, "content.bin", bytes);
    let result = json!({"files": [tree_entry("content.bin", bytes)]});
    let declaration = tree_output(json!({"media_type": "application/octet-stream"}));
    let outputs = declared_from(json!([declaration]), &inside).unwrap();
    let first = keep_with_result(
        &outputs,
        &inside,
        &person,
        &tool("tree-maker"),
        "deduplicated-mime",
        false,
        &result,
    )
    .unwrap();
    let content = &first["bundle"]["files"]["content.bin"];
    assert_eq!(content["identity"], earlier["identity"]);
    assert_eq!(content["bytes"], bytes.len());
    assert_eq!(
        content["media_type"], "text/plain",
        "Namespace keeps its original metadata when identical bytes deduplicate"
    );
    assert_eq!(person.held.0.lock().unwrap().len(), 1);
    let (_clean, empty) = folder();
    let outputs = declared_from(json!([declaration]), &empty).unwrap();
    assert_eq!(
        keep_with_result(
            &outputs,
            &empty,
            &person,
            &tool("tree-maker"),
            "deduplicated-mime",
            true,
            &result
        )
        .unwrap(),
        first
    );
    assert!(!base(&empty).join("out/tree").exists());
    assert_eq!(
        person.held.0.lock().unwrap().len(),
        1,
        "replay adds no second object or metadata owner"
    );
}

#[test]
fn a_small_output_write_refuses_changed_identity_or_length_in_actual_metadata_readback() {
    struct ChangedReadback {
        person: Person,
        field: &'static str,
    }
    impl Files for ChangedReadback {
        fn name(&self, tool: &str, run: &str, file: &str) -> Result<String, Refused> {
            self.person.name(tool, run, file)
        }
        fn call(&self, operation: &str, input: &Value) -> Result<Value, Refused> {
            let mut answer = self.person.call(operation, input)?;
            if operation == "find_file" {
                answer[self.field] = if self.field == "identity" {
                    json!(format!("1f:{}", "0".repeat(64)))
                } else {
                    json!(answer["byte_length"].as_u64().unwrap() + 1)
                };
            }
            Ok(answer)
        }
    }
    let (_dir, inside) = folder();
    let bytes = b"synthetic captured output bytes";
    fs::write(base(&inside).join("out/site.json"), bytes).unwrap();
    let outputs = declared_from(json!([output(json!({}))]), &inside).unwrap();
    for field in ["identity", "byte_length"] {
        let files = ChangedReadback {
            person: person(),
            field,
        };
        assert!(matches!(store(&files, &tool("small-maker"), field, &outputs[0], bytes), Err(Refused::IdentityMismatch(_) )), "a successful write response is insufficient when the name's actual metadata changed: {field}");
    }
}
