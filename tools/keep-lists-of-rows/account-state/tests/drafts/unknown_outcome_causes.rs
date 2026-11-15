//! Real command-reader faults keep their original source condition through the
//! door's common public code, structured answer and content-free log line.
//! These controls use a newly made SQLite file; they never open an account.
use super::*;
use crate::{mcp, native_boot::mcp_local, storage::sqlite};
use std::{collections::HashSet, time::Duration};

const PRIVATE: &str = "SYNTHETIC_PRIVATE_VALUE_DO_NOT_LOG";
const SOURCE_FILE: &str = "src/local_account/native_command_context.rs";
const SOURCE: &str = include_str!("../../src/local_account/native_command_context.rs");

fn native(db: &Connection, path: PathBuf) -> NativeContext<'static> {
    NativeContext {
        selection_check: &|| Ok(()),
        physical_path: path,
        base_readers: None,
        record_domain: None,
        adoption: None,
        workspace_generation: None,
        writer_road: "key",
        binding: CommandBinding {
            permit_id: PRIVATE.into(),
            identity: PRIVATE.into(),
            owner: PRIVATE.into(),
            resource: "@own-records".into(),
            generation: serde_json::json!(1),
            operation: "records:write".into(),
            request_key: PRIVATE.into(),
            input_identity: PRIVATE.into(),
        },
        durable_input: Zeroizing::new(PRIVATE.into()),
        durable_context: Zeroizing::new(PRIVATE.into()),
        execution_ref: format!("execution:{PRIVATE}"),
        pending_local_execution: None,
        reader: PRIVATE.into(),
        // SAFETY: retain only this live connection's address for the original
        // command witness's equality check; no raw handle is dereferenced.
        handle: unsafe { db.handle() } as usize,
        cancel: Arc::new(AtomicBool::new(false)),
        deadline: Instant::now() + Duration::from_secs(30),
        limits: Limits::fixed(1 << 20, 10 << 30),
        command_memory: None,
        model: crate::record_model_policy::own_model().unwrap(),
        outside: None,
        search: std::rc::Rc::new(crate::storage::record_store::SharedSearchMemory::new(
            Default::default(),
        )),
        list_resources: None,
    }
}

/// Resolve the exact macro invocation inside a uniquely named failing source
/// condition. This follows harmless line moves without accepting another site.
fn expected_site(condition: &str) -> (u32, u32) {
    let start = SOURCE
        .find(condition)
        .expect("the tested production condition exists");
    assert_eq!(
        SOURCE.matches(condition).count(),
        1,
        "the condition names one production site"
    );
    let at = start
        + SOURCE[start..]
            .find("crate::cause!(Error::OutcomeUnknown)")
            .expect("the production condition constructs its cause");
    let before = &SOURCE[..at];
    let line = before.bytes().filter(|byte| *byte == b'\n').count() as u32 + 1;
    let column = before.rsplit('\n').next().unwrap().chars().count() as u32 + 1;
    (line, column)
}

#[test]
fn three_real_unknown_outcomes_keep_distinct_exact_causes_at_the_door() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary
        .path()
        .canonicalize()
        .unwrap()
        .join("synthetic-command.sqlite");
    drop(
        sqlite::open_owned(
            &path,
            "record_store",
            sqlite::Bounds {
                value_bytes: 1 << 20,
                work: u64::MAX / 2,
                deadline: Duration::MAX,
                spend: sqlite::Spend::EachOperation,
                cancel: None,
                busy: Duration::ZERO,
            },
        )
        .unwrap(),
    );
    let mut db = Connection::open(&path).unwrap();
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let before = tx.total_changes();
    let mut context = native(&tx, path);
    let binding = clone_binding(&context.binding);
    let execution_ref = context.execution_ref.clone();
    let capture = Capture {
        durable_input: PRIVATE,
        durable_context: PRIVATE,
        execution_ref: &execution_ref,
    };

    // No saved execution exists. This is the production missing-execution path.
    let missing_execution = context.execution(&tx).unwrap_err();
    assert_eq!(
        context.execution(&tx).unwrap_err().cause(),
        missing_execution.cause(),
        "repeating the same failing condition keeps the same identifier"
    );
    assert_eq!(
        journal_error(context.assert_capture(&tx, &binding, &capture).unwrap_err()).cause(),
        missing_execution.cause(),
        "the original missing-execution cause crosses the journal unchanged"
    );

    // A captured execution exists but its contents do not bind this command.
    context.pending_local_execution =
        Some(Zeroizing::new(format!("{{\"private\":\"{PRIVATE}\"}}")));
    let mismatched_execution = context.execution(&tx).unwrap_err();
    assert_eq!(
        journal_error(context.assert_capture(&tx, &binding, &capture).unwrap_err()).cause(),
        mismatched_execution.cause(),
        "the original mismatched-execution cause crosses the journal unchanged"
    );

    // The saved protected result is absent, a separate unknown-outcome site.
    let missing_result = context.open_own_result(&tx).unwrap_err();
    let completion = journal::Completion {
        result_identity: "synthetic-result".into(),
        native_nonretaining: false,
    };
    assert_eq!(
        journal_error(
            context
                .assert_completion(&tx, &binding, &completion)
                .unwrap_err()
        )
        .cause(),
        missing_result.cause(),
        "the original missing-result cause crosses the journal unchanged"
    );

    let conditions = [
        (missing_execution, ".record(db, &self.execution_ref)?"),
        (mismatched_execution, "if kind != \"execution\""),
        (
            missing_result,
            "let (kind, value) = self.record(db, &id)?.ok_or(",
        ),
    ];
    let mut identities = HashSet::new();
    for (error, condition) in conditions {
        assert!(
            matches!(error, Error::OutcomeUnknown(_)),
            "the real condition is an unknown outcome"
        );
        let cause = error.cause();
        assert_eq!(cause.file(), SOURCE_FILE);
        assert_eq!((cause.line(), cause.column()), expected_site(condition));
        assert_eq!(cause.condition(), "Error::OutcomeUnknown");
        assert!(
            identities.insert(cause.id()),
            "separate production conditions must never collapse"
        );

        let failure =
            mcp_local::write_refusal(error, Instant::now() + Duration::from_secs(1), None);
        assert_eq!(
            failure.code, "original_command_outcome_unknown",
            "the existing caller code is preserved"
        );
        assert!(failure.outcome_unknown);
        assert_eq!(
            failure.cause, cause,
            "the door retains the construction cause"
        );
        let content = mcp::refusal_content(&failure);
        assert_eq!(content["code"], "original_command_outcome_unknown");
        assert_eq!(content["outcome"], "unknown");
        assert_eq!(content["cause"], cause.id());
        assert_eq!(
            failure.log_line(),
            format!("door-refusal code=original_command_outcome_unknown cause={cause}")
        );
        for public in [
            content.to_string(),
            failure.log_line(),
            format!("{cause:?}"),
        ] {
            assert!(
                !public.contains(PRIVATE),
                "the cause and log must contain no account or input values"
            );
        }
    }
    assert_eq!(tx.total_changes(), before, "fault diagnosis writes no record or retry state");
    tx.rollback().unwrap();
}
