// examples/observe_local_account.rs
//
// Purpose: Exercise the real current-state observer through bounded private input.
// Non-Negotiable Invariants: observation grants no authority and acquires no state lock;
// an explicit record inspection uses the selected account's existing state lock,
// current browser admission and canonical decoder, never a second authority.
// preserve the existing session, database schemas, active owner and Cloudflare hold.
// Key Concepts: independently pinned selection, ordinary read-only SQLite/WAL,
// exact existing protected-session lookup and sanitized consumer readback.
// Security Considerations: no raw input, account, session identifier or key output.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#[cfg(unix)]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use serde::Deserialize;
    use std::{
        io::{self, Read},
        path::PathBuf,
    };
    use trillion_local::{
        account::{current_browser, SignInRules},
        import::FilePin,
        local_account::{LocalAccount, LocalAccountObserver, ProcessIdentity, SelectedLocalState},
        native_boot::PinnedData,
    };
    use zeroize::Zeroizing;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Prior {
        pid: u32,
        started_seconds: u64,
        started_fraction: u64,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        state: PathBuf,
        receipt: FilePin,
        app_kv_sqlite: PathBuf,
        app_kv_store: String,
        prior_processes: Vec<Prior>,
        sign_in_rules: PinnedData,
        #[serde(default)]
        record_id: Option<String>,
        #[serde(default)]
        logical: bool,
    }
    let mut bytes = Zeroizing::new(Vec::new());
    io::stdin().take(16_385).read_to_end(&mut bytes)?;
    if bytes.len() > 16_384 {
        return Err("current-state observation input exceeds bound".into());
    }
    let input: Request =
        serde_json::from_slice(&bytes).map_err(|_| "current-state observation input refused")?;
    if input.prior_processes.is_empty() || input.prior_processes.len() > 16 {
        return Err("current-state owner input refused".into());
    }
    let rules = SignInRules::from_source_json(
        &serde_json::from_slice(&input.sign_in_rules.read()?)
            .map_err(|_| "current-state rules input refused")?,
    )?;
    let selected = SelectedLocalState {
        root: input.state,
        receipt: input.receipt,
        app_kv_sqlite: input.app_kv_sqlite,
        app_kv_store: input.app_kv_store,
        prior_processes: input
            .prior_processes
            .into_iter()
            .map(|p| ProcessIdentity {
                pid: p.pid,
                started_seconds: p.started_seconds,
                started_fraction: p.started_fraction,
            })
            .collect(),
    };
    if input.logical && input.record_id.is_none() {
        return Err("logical inspection requires an exact record".into());
    }
    if let Some(id) = input.record_id {
        let id = Zeroizing::new(id);
        let mut owner = LocalAccount::open_selected_after_handoff(selected, rules)?;
        let session = owner.session_identity();
        let admitted = current_browser(&mut owner, &session)?;
        if input.logical {
            let record = owner.current_logical_record(
                &session,
                &id,
                Default::default(),
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )?;
            let digest = record
                .as_ref()
                .map(|record| {
                    let bytes = Zeroizing::new(trillion_local::ecma_json::stringify(
                        record.value(),
                        Default::default(),
                    )?);
                    Ok::<_, trillion_local::ecma_json::Error>(
                        content_crypto::advanced::blake3::hash(bytes.as_bytes())
                            .to_hex()
                            .to_string(),
                    )
                })
                .transpose()?;
            let current = current_browser(&mut owner, &session)?;
            if current.account != admitted.account
                || !admitted.still()
            {
                return Err("logical record inspection admission changed".into());
            }
            let observed = owner.sql_work()?;
            if observed.active_statements != 0 {
                return Err("logical SQL observation is unfinished".into());
            }
            println!(
                "{}",
                serde_json::json!({
                    "selected_current_account":true,"present":record.is_some(),
                    "logical_record":true,"value_blake3":digest,"cloud_execution":false,
                    "nested_model_policy_supplied":false,
                    "undeclared_sealed_fields_refuse":true,
                    "logical_work":record.as_ref().map(|record|serde_json::json!({
                        "stored_reads":record.work.stored_reads,"key_reads":record.work.key_reads,
                        "sealed_fields_opened":record.work.sealed_fields_opened,
                        "parsed_bytes":record.work.parsed_bytes,"expanded_bytes":record.work.expanded_bytes,
                        "nodes":record.work.nodes
                    })),
                    "selected_account_sql_work":observed.work,
                    "sql_query_families":observed.families,
                    "sql_work_scope":"selected account process lifetime including setup and policy",
                    "account_policy_work_included":true
                })
            );
            return Ok(());
        }
        let record = owner.current_stored_record(
            &session,
            &id,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )?;
        let digest = record.as_ref().map(|r| {
            content_crypto::advanced::blake3::hash(r.value_json.as_bytes())
                .to_hex()
                .to_string()
        });
        let current = current_browser(&mut owner, &session)?;
        if current.account != admitted.account
            || !admitted.still()
        {
            return Err("current record inspection admission changed".into());
        }
        println!(
            "{}",
            serde_json::json!({
                "selected_current_account":true,"present":record.is_some(),
                "record_count":u8::from(record.is_some()),"value_json_blake3":digest,
                "stored_representation_only":true,"cloud_execution":false
            })
        );
        return Ok(());
    }
    let observer = LocalAccountObserver::observe_current(selected, rules)?;
    observer.assert_observed()?;
    println!(
        "{}",
        serde_json::json!({"observed_current_owner":true,
        "state_identity":observer.state_identity(),"account_authority_adopted":false,
        "session_created":false,"cloud_execution":false})
    );
    Ok(())
}
fn main() -> std::process::ExitCode {
    #[cfg(unix)]
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("current-state observation refused: {error}");
            std::process::ExitCode::FAILURE
        }
    }
    #[cfg(not(unix))]
    {
        eprintln!("current-state observation unavailable on this platform");
        std::process::ExitCode::FAILURE
    }
}
