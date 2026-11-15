// Source-contract controls for the ordinary-browser viewer operation. Synthetic
// selected policy/config suppliers only; root owns real account/native mounts.
use serde_json::{json, Value};
use content_crypto::advanced::blake3;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use trillion_local::{
    account::{AccountError, AccountIdentity, AccountResult, BrowserAdmission},
    workspace_startup::{viewer, ProgramData, ViewerSource, ViewerState},
};

fn row(id: &str, setting: &str, audience: &str) -> Value {
    json!({"id":id,"host":{"account":{"setting":setting},"audience":audience}})
}
fn data(rows: Vec<Value>) -> ProgramData {
    let bytes = json!({"programs":rows}).to_string().into_bytes();
    ProgramData::from_source(&bytes, blake3::hash(&bytes).to_hex().as_str()).unwrap()
}
struct Source {
    user: String,
    held: Value,
    held_available: bool,
    settings: BTreeMap<String, Option<String>>,
    reads: BTreeMap<String, usize>,
    current_reads: usize,
    window_ends: bool,
    session_withdrawn: bool,
    config_changes: bool,
    source_current: bool,
    cancel: Option<Arc<AtomicBool>>,
}
impl Source {
    fn new(user: &str) -> Self {
        Self {
            user: user.into(),
            held: Value::Null,
            held_available: true,
            settings: BTreeMap::from([("OPERATOR_ACCOUNT_ID".into(), Some("operator".into()))]),
            reads: BTreeMap::new(),
            current_reads: 0,
            window_ends: false,
            session_withdrawn: false,
            config_changes: false,
            source_current: true,
            cancel: None,
        }
    }
}
impl ViewerSource for Source {
    fn current_viewer(&mut self, session: &str) -> AccountResult<ViewerState> {
        assert_eq!(session, "a".repeat(64));
        self.current_reads += 1;
        if self.current_reads > 1 && self.session_withdrawn {
            return Err(trillion_local::cause!(AccountError::BrowserInactive));
        }
        if let Some(cancel) = &self.cancel {
            cancel.store(true, Ordering::Release)
        }
        Ok(ViewerState {
            admission: BrowserAdmission {
                account: AccountIdentity {
                    user_id: self.user.clone(),
                    owner_id: "b".repeat(64),
                },
                // The window's session row ends between the two reads.
                current: Arc::new({
                    let ends = self.window_ends && self.current_reads > 1;
                    move || !ends
                }),
            },
            client_programs: self.held_available.then(|| self.held.clone()),
        })
    }
    fn service_setting(&mut self, name: &str) -> AccountResult<Option<String>> {
        let reads = self.reads.entry(name.to_owned()).or_default();
        *reads += 1;
        if self.config_changes && *reads > 1 {
            return Ok(Some("different-current-account".into()));
        }
        self.settings
            .get(name)
            .cloned()
            .ok_or(trillion_local::cause!(AccountError::SourceUnavailable))
    }
    fn assert_current(&mut self) -> AccountResult<()> {
        if self.source_current {
            Ok(())
        } else {
            Err(trillion_local::cause!(AccountError::SourceChanged))
        }
    }
}
fn read(source: &mut Source, data: &ProgramData) -> AccountResult<Value> {
    viewer(source, data, &"a".repeat(64), &AtomicBool::new(false))
}

#[test]
fn real_operator_and_program_host_comparisons_preserve_original_order() {
    let data = data(vec![
        row("shipped1", "HOST_A", "audience:a"),
        row("shipped2", "HOST_B", "audience:b"),
    ]);
    let mut source = Source::new("operator");
    source
        .settings
        .insert("HOST_A".into(), Some("operator".into()));
    source
        .settings
        .insert("HOST_B".into(), Some("someone-else".into()));
    source.held = json!([
        row("own1", "OPERATOR_ACCOUNT_ID", "audience:held"),
        row("own2", "HOST_B", "audience:foreign")
    ]);
    assert_eq!(
        read(&mut source, &data),
        Ok(
            json!({"access_refs":["audience:operator","audience:a","audience:held"],"throwaway":false})
        )
    );
    assert_eq!(source.current_reads, 2);
    assert!(
        source.reads.values().all(|reads| *reads == 2),
        "one current read and one source recheck per referenced setting"
    );
}

#[test]
fn ordinary_account_uses_shipped_programs_without_reading_operator_held_program_settings() {
    let data = data(vec![row("shipped", "OTHER_HOST", "audience:host")]);
    let mut source = Source::new("person");
    source
        .settings
        .insert("OTHER_HOST".into(), Some("person".into()));
    source.held = json!([row(
        "unrelated",
        "UNAVAILABLE_OPERATOR_DETAIL",
        "private-audience"
    )]);
    assert_eq!(
        read(&mut source, &data),
        Ok(json!({"access_refs":["audience:host"],"throwaway":false}))
    );
    assert!(!source.reads.contains_key("UNAVAILABLE_OPERATOR_DETAIL"));
}

#[test]
fn held_rows_exclude_shipped_ids_and_foreign_hosts_but_do_not_deduplicate_audiences() {
    let data = data(vec![row("same", "OPERATOR_ACCOUNT_ID", "audience:same")]);
    let mut source = Source::new("operator");
    source
        .settings
        .insert("FOREIGN".into(), Some("other".into()));
    source.held = json!([row("same","MUST_NOT_READ","ignored"),row("held","OPERATOR_ACCOUNT_ID","audience:same"),row("held","OPERATOR_ACCOUNT_ID","audience:same"),row("foreign","FOREIGN","ignored"),{}, {"id":"no-host"}]);
    assert_eq!(
        read(&mut source, &data),
        Ok(
            json!({"access_refs":["audience:operator","audience:same","audience:same","audience:same"],"throwaway":false})
        )
    );
    assert!(!source.reads.contains_key("MUST_NOT_READ"));
}

#[test]
fn current_absence_and_empty_config_are_distinct_from_unavailable_config() {
    let data = data(vec![]);
    let mut source = Source::new("person");
    source.settings.clear();
    assert!(matches!(read(&mut source, &data), Err(AccountError::SourceUnavailable(_))));
    for actual in [None, Some(String::new())] {
        source.settings.insert("OPERATOR_ACCOUNT_ID".into(), actual);
        assert_eq!(
            read(&mut source, &data),
            Ok(json!({"access_refs":[],"throwaway":false}))
        );
    }
    let mut source = Source::new("operator");
    assert_eq!(read(&mut source,&data),Ok(json!({"access_refs":["audience:operator"],"throwaway":false})),"known current absent held control means [] as heldPrograms, without losing operator identity");
    source.held_available = false;
    assert!(matches!(read(&mut source, &data), Err(AccountError::SourceUnavailable(_))), "operator needs its actual current held-program source");
    source.user = "person".into();
    assert_eq!(
        read(&mut source, &data),
        Ok(json!({"access_refs":[],"throwaway":false})),
        "nonoperator never depends on an unrelated held-program source"
    );
}

#[test]
fn revoked_session_changed_policy_config_and_source_never_disclose_a_response() {
    let data = data(vec![]);
    for what in ["session", "window", "config", "source"] {
        let mut source = Source::new("operator");
        match what {
            "session" => source.session_withdrawn = true,
            "window" => source.window_ends = true,
            "config" => source.config_changes = true,
            "source" => source.source_current = false,
            _ => unreachable!(),
        }
        let actual = read(&mut source, &data).unwrap_err();
        assert!(if what == "session" {
            matches!(actual, AccountError::BrowserInactive(_))
        } else {
            matches!(actual, AccountError::SourceChanged(_))
        }, "{what}: {actual}");
    }
}

#[test]
fn cancellation_before_or_during_read_uses_original_flag_and_invalid_ids_do_not_read() {
    let data = data(vec![]);
    let mut source = Source::new("operator");
    assert!(matches!(viewer(&mut source, &data, &"a".repeat(64), &AtomicBool::new(true)), Err(AccountError::SourceChanged(_))));
    assert_eq!(source.current_reads, 0);
    assert!(matches!(viewer(
            &mut source,
            &data,
            "not-a-selected-session",
            &AtomicBool::new(false)
        ), Err(AccountError::InvalidInput(_))));
    assert_eq!(source.current_reads, 0);
    let cancel = Arc::new(AtomicBool::new(false));
    source.cancel = Some(cancel.clone());
    assert!(matches!(viewer(&mut source, &data, &"a".repeat(64), &cancel), Err(AccountError::SourceChanged(_))));
}

#[test]
fn corrupt_programs_pins_and_oversized_policies_refuse_instead_of_empty_viewer() {
    let bytes = br#"{"programs":[]}"#;
    assert!(ProgramData::from_source(bytes, &"0".repeat(64)).is_err());
    for bytes in [
        br#"{"programs":{}}"#.as_slice(),
        br#"{"programs":[{}]}"#.as_slice(),
    ] {
        assert!(ProgramData::from_source(bytes, blake3::hash(bytes).to_hex().as_str()).is_err());
    }
    let data = data(vec![]);
    let mut source = Source::new("operator");
    source.held = json!({"not":"a-list"});
    assert_eq!(
        read(&mut source, &data),
        Ok(json!({"access_refs":["audience:operator"],"throwaway":false})),
        "the established current value follows original heldPrograms fallback"
    );
    source.held = json!("x".repeat(4 * 1024 * 1024));
    assert!(matches!(read(&mut source, &data), Err(AccountError::SourceUnavailable(_))));
}

#[test]
fn original_wrapped_program_list_and_projected_audience_values_are_preserved() {
    let data = data(vec![]);
    let mut source = Source::new("operator");
    let mut missing = row("one", "OPERATOR_ACCOUNT_ID", "unused");
    missing["host"].as_object_mut().unwrap().remove("audience");
    let mut numeric = row("two", "OPERATOR_ACCOUNT_ID", "unused");
    numeric["host"]["audience"] = json!(23);
    source.held =
        json!({"programs":[missing,numeric,row("three","OPERATOR_ACCOUNT_ID","audience:kept")]});
    assert_eq!(
        read(&mut source, &data),
        Ok(json!({"access_refs":["audience:operator",null,23,"audience:kept"],"throwaway":false}))
    );
}

#[test]
fn viewer_projection_and_debug_never_include_other_policy_or_program_fields() {
    let mut program = row("owned", "OPERATOR_ACCOUNT_ID", "audience:host");
    program["unrelated-private-field"] = json!("synthetic-private-value");
    let data = data(vec![]);
    let mut source = Source::new("operator");
    source.held = json!([program]);
    let answer = read(&mut source, &data).unwrap();
    assert_eq!(answer.as_object().unwrap().len(), 2);
    assert!(!answer.to_string().contains("synthetic-private"));
    assert!(!answer.to_string().contains("\"operator\""));
    let state = source.current_viewer(&"a".repeat(64)).unwrap();
    let debug = format!("{data:?} {state:?}");
    assert!(!debug.contains("synthetic-private"));
    assert!(!debug.contains("owned"));
}
