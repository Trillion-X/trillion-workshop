// Bounded native source observation proofs, over synthetic local transcripts only.
use super::*;
fn fixture() -> (tempfile::TempDir, PathBuf, Value) {
    let home = tempfile::tempdir().unwrap();
    let folder = home.path().join(".codex/sessions");
    std::fs::create_dir_all(&folder).unwrap();
    let path = std::fs::canonicalize(folder)
        .unwrap()
        .join("fixture-source-session.jsonl");
    let head = json!({"type":"session_meta","timestamp":"2026-11-07T12:00:00Z","payload":{"id":"fixture-source-session","source":"cli"}});
    let row = json!({"type":"response_item","timestamp":"2026-11-07T12:00:01Z","payload":{"type":"function_call","call_id":"fixture-call","name":"read_source","arguments":json!({"item":"record:fixture:input","token":"DO_NOT_KEEP","body":"DO_NOT_KEEP"}).to_string()}});
    std::fs::write(&path, format!("{head}\n{row}\n")).unwrap();
    (home, path, row)
}
#[test]
fn actual_occurrence_is_required_and_append_does_not_invalidate_an_earlier_source() {
    let (home, path, row) = fixture();
    let routes = HookRoutes::shipped().unwrap();
    let harness = routes.harness("codex").unwrap();
    let receipts = routes
        .execution_observations(&row, harness, "fixture-source-session", &Map::new())
        .unwrap();
    assert_eq!(
        receipts[0]["references"],
        json!([{"ref":"record:fixture:input","role":"input","basis":"claimed","path":["input","item"]}])
    );
    assert!(!receipts[0].to_string().contains("DO_NOT_KEEP"));
    let bytes = std::fs::read(&path).unwrap();
    let start = bytes.iter().position(|b| *b == b'\n').unwrap() + 1;
    let input = json!({"harness":"codex","event":"stop","payload":{"session_id":"fixture-source-session"},"executions":[{"receipt":receipts[0],"source":{"transcript_path":path,"offset":start,"end":bytes.len()}}]});
    let computer = Computer {
        env: &|_| None,
        home: Some(std::fs::canonicalize(home.path()).unwrap()),
        now_ms: 0,
    };
    let kind = |_: &str, _: &str| Some("session-card".to_owned());
    let verified = routes.verify_executions(&input, &kind, &computer).unwrap();
    assert_eq!(verified.len(), 1);
    assert!(verified[0].current());
    {
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{}\n")
            .unwrap();
    }
    assert!(verified[0].current());
    let mut changed = input.clone();
    changed["executions"][0]["source"]["offset"] = json!(1);
    assert!(routes
        .verify_executions(&changed, &kind, &computer)
        .is_err());
    let mut changed = input.clone();
    changed["executions"][0]["receipt"]["references"][0]["basis"] = json!("tool_result");
    assert!(routes
        .verify_executions(&changed, &kind, &computer)
        .is_err());
    let mut changed = input.clone();
    changed["payload"]["session_id"] = json!("different-session");
    assert!(routes
        .verify_executions(&changed, &kind, &computer)
        .is_err());
    let mut changed = input.clone();
    changed["messages"] = json!("not an array");
    assert!(routes
        .verify_executions(&changed, &kind, &computer)
        .is_err());
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[0] = b' ';
    std::fs::write(&path, &bytes).unwrap();
    assert!(!verified[0].current());
}
#[test]
fn native_reference_limits_refuse_the_whole_observation_and_unknown_fields_cannot_promote_identity()
{
    let (_home, _path, mut row) = fixture();
    let routes = HookRoutes::shipped().unwrap();
    let harness = routes.harness("codex").unwrap();
    let max = routes.settings.execution_references["max_references"]
        .as_u64()
        .unwrap() as usize;
    row["payload"]["arguments"]=json!(json!({"references":(0..=max).map(|i|json!({"ref":format!("future-kind:{i}"),"role":"source"})).collect::<Vec<_>>()} ).to_string());
    assert!(routes
        .execution_observations(&row, harness, "fixture-source-session", &Map::new())
        .is_err());
    row["payload"]["call_id"] = json!("x".repeat(
        routes.settings.execution_references["max_id_chars"]
            .as_u64()
            .unwrap() as usize
            + 1
    ));
    assert!(routes
        .execution_observations(&row, harness, "fixture-source-session", &Map::new())
        .is_err());
}
