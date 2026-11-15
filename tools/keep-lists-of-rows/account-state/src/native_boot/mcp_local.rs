//! The MCP dispatch of the account's routes over the selected account, shared by the local
//! routes and the connection that answers the public ones. Every operation is admitted
//! by the account routes' own sign-in (src/account/account_routes.rs): the credential is asked again
//! for this exact operation and its scopes must reach it (`sign_in_check::
//! permits`), and that right is checked again at every check the operation's
//! owner keeps. No other source decides who a caller is or what it may do.
//! The host may merge this into its existing listener; no socket, route grant,
//! public endpoint or account store is created by this composition.
use super::SelectedAccount;
use crate::{
    account::account_routes::{self, Caller, SignIn},
    mcp::{
        Operation, OperationFailure, Principal, CallAnswerer,
        http::axum_adapter::{self, Service},
    },
    record_log::CanonicalLogIds,
    workspace_session::owner_wait,
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
mod installed_instructions;
mod reach_reader;
mod view_matcher;
#[path = "../server/records_result.rs"]
mod records_result;
#[path = "../server/computer_actions.rs"]
mod computer_actions;
#[path = "../server/tool_recovery.rs"]
mod tool_recovery;

/// The time an account's files call keeps, after its last step, to check the key again and answer.
/// What a refusal of a kind that stays on this computer says to the person's AI.
const DEVICE_ONLY_WORDS: &str = "These records stay on this computer. An AI app reading through its key, or a tool that can reach the internet or the person's files, cannot read them; only a tool running here with no way out can.";
/// What a refusal of a filter that would read every row of a large kind says to the person's AI.
const WHOLE_KIND_WORDS: &str = "This kind has too many records to filter by reading them one by one. Filter on a field that has a declared order, or narrow the read with prefix, above or below.";
const ACCOUNT_FILES_ANSWER_MARGIN: Duration = Duration::from_millis(500);

pub(super) struct LocalSelectedMcp {
    owner: Arc<Mutex<SelectedAccount>>,
    /// An owner of the same account that holds no writer (`SelectedAccount::admission_owner`): a records read is
    /// admitted and confirmed on it, so neither waits on the account's writer.
    admission: Arc<Mutex<SelectedAccount>>,
    /// The account's own sign-in, the one source of who a credential is and what it may do.
    sign_in: Arc<SignIn>,
    ids: Mutex<CanonicalLogIds>,
    /// One idle command context, taken out for a request. The mutex protects only take/return, never command I/O.
    commands: Mutex<Option<SelectedAccount>>,
    /// This endpoint's own loopback address, when a tool run may call back into it with a run capability
    /// (`account_rights::run_capability`): only the native listener knows it.
    door: Option<std::net::SocketAddr>,
    /// This same endpoint, for the kept parents whose runs call back into it (`StandingParents`); empty for an endpoint
    /// with no loopback listener (the connection's).
    me: std::sync::Weak<LocalSelectedMcp>,
    /// This endpoint's registration as its account's resolver of kept parents, while it lives.
    standing: std::sync::OnceLock<crate::account_rights::run_cause::ResolverRegistration>,
}
#[track_caller]
fn refusal(code: &str, unknown: bool) -> OperationFailure {
    OperationFailure { cause: (crate::refusal_cause::Cause::from_caller()).into(),
        code: code.into(),
        outcome_unknown: unknown,
        detail: None,
    }
}
#[track_caller]
fn refusal_from<E: crate::refusal_cause::Caused>(error: E, code: &str, unknown: bool) -> OperationFailure {
    OperationFailure { cause: error.cause(), ..refusal(code, unknown) }
}
/// A tools refusal as the account routes': its code, and its own words when it has them (a capability this computer does
/// not offer, named) in the detail.
fn workshop_refusal(failure: crate::tool_runs::tools::Failure) -> OperationFailure {
    OperationFailure { cause: (failure.cause()).into(), detail: failure.detail().map(serde_json::Value::String), ..refusal(failure.code(), failure.outcome_unknown()) }
}
/// An account answer's refusal as the account routes'. An effect may have begun before a refusal of a write or a run, so no
/// refusal here is a known no-effect one, except a read's own.
pub(super) fn personal_refusal(error: crate::account::AccountError) -> OperationFailure {
    use crate::account::AccountError;
    let code = match error {
        AccountError::InvalidInput(_) => "original_input_refused",
        AccountError::RightsRefused(_) | AccountError::KeyWithdrawn(_) | AccountError::RightsChanging(_)
        | AccountError::SourceChanged(_) | AccountError::Cancelled(_) | AccountError::DeadlineElapsed(_) => "current_workspace_rights_refused",
        AccountError::SourceUnavailable(_) => "original_workspace_source_unavailable",
        AccountError::BrowserInactive(_) => "browser_sign_in_inactive",
        AccountError::OriginalBindingUnavailable(_) => "mac_issuer_binding_unavailable",
        AccountError::RecoveryPending(_) => "owner_recovery_pending",
        AccountError::AlreadyIssued(_) => "credential_reveal_window_ended",
        AccountError::RootUnavailable(_) => "native_key_root_unavailable",
        AccountError::DeviceOnly(_) => "kind_stays_on_this_computer",
        AccountError::WholeKind(_) => "list_filter_reads_whole_kind",
        AccountError::UseNoteRequired(_) => "current_workspace_rights_refused",
    };
    let failure = match error {
        // A read has no effect to be unsure of; the words say what stays and why.
        AccountError::DeviceOnly(_) => OperationFailure {
            detail: Some(serde_json::json!({"words": DEVICE_ONLY_WORDS})),
            ..refusal(code, false)
        },
        AccountError::WholeKind(_) => OperationFailure {
            detail: Some(serde_json::json!({"field": "where", "expected": WHOLE_KIND_WORDS})),
            ..refusal(code, false)
        },
        _ => refusal(code, true),
    };
    logged(OperationFailure { cause: (error.cause()).into(), ..failure })
}
/// Whether an owner of this call's input can say what is wrong with it (`input_fault`).
fn input_owner_asks(call: &Operation) -> bool {
    crate::record_value::account_routes::Door::shipped().is_ok_and(|door| door.answers(&call.resource, &call.operation))
}

/// What is wrong with a refused call's input, said by the owner of its operation: the records routes' reads parse
/// their input together, and that parse names the field. None when no owner names one.
fn input_fault(resource: &str, operation: &str, input: &serde_json::Value) -> Option<crate::mcp::InputFault> {
    let door = crate::record_value::account_routes::Door::shipped().ok()?;
    door.answers(resource, operation).then(|| door.input_fault(operation, input)).flatten()
}
/// A records write's refusal as the account routes'. `Source` is the one cause the writer cannot name: when the call's own
/// deadline has passed, the database interrupt that stopped the write is a timeout, and it says so. That write is
/// certainly undone, so the refusal says the outcome is known: `Source` reaches here only after the command's
/// transaction rolled back with nothing committed before (`selected_workspace_command.rs`: a failed rollback or an
/// earlier commit answers `OutcomeUnknown`), and the record store answers a storage failure before its commit as
/// unavailable, never as an outcome unknown (`record_store/mod.rs` `write`).
pub(crate) fn write_refusal(error: crate::local_account::record_writer::Error, deadline: Instant,
    named: Option<crate::local_account::record_writer::Named>) -> OperationFailure {
    use crate::local_account::record_writer::{Error, Named};
    let refused = match error {
        Error::OutcomeUnknown(_) => refusal("original_command_outcome_unknown", true),
        Error::CommittedAnswerWithheld(_) => OperationFailure::committed("original_command_committed_answer_withheld"),
        Error::ProtectedResultUnavailable(_) => refusal("original_result_unavailable", false),
        Error::Conflict(_) => refusal("original_command_conflict", false),
        Error::Invalid(_) | Error::Bounds(_) => refusal("original_input_refused", false),
        Error::Refused(_) => refusal("current_workspace_rights_refused", false),
        Error::NotMigrated(_) => refusal("own_records_not_migrated", false),
        // The refusals that name the person's own field and value, and for a move the value it changes from (to their
        // own caller; the log line below carries the variant only).
        Error::OutsideChoices(_) | Error::MoveNotDeclared(_) => OperationFailure {
            detail: match named {
                Some(Named::Outside(outside)) => Some(outside.detail()),
                _ => None,
            },
            ..refusal(if matches!(error, Error::MoveNotDeclared(_)) { "move_not_declared" } else { "value_outside_choices" }, false)
        },
        // Names what the person must confirm. Nothing in the engine confirms the person present since sign-in left it
        // (`account::person_present`), so the write stays refused.
        Error::NeedsPersonPresent(_) => OperationFailure {
            detail: match named {
                Some(Named::NeedsPersonPresent(needed)) => Some(serde_json::json!({
                    "record": needed.requirement.record, "field": needed.requirement.field, "value": needed.requirement.value,
                    "marked_changes": needed.marked_changes,
                })),
                _ => None,
            },
            ..refusal(crate::account::person_present::REFUSAL_CODE, false)
        },
        Error::Source(_) if Instant::now() >= deadline => refusal("write_deadline_exceeded", false),
        Error::Source(_) => refusal("original_workspace_source_unavailable", false),
    };
    logged(OperationFailure { cause: (error.cause()).into(), ..refused })
}
/// The refusal, after one log line naming only its code and the error variant that caused it (never content).
fn logged(refused: OperationFailure) -> OperationFailure {
    crate::quiet_eprintln!("{}", refused.log_line());
    refused
}
impl LocalSelectedMcp {
    /// The MCP endpoint on one writer, retaining the same account's read-only admission owner separately.
    pub(super) fn new(owner: Arc<Mutex<SelectedAccount>>) -> Result<Self, crate::refusal_cause::CodedError<&'static str>> {
        let (sign_in, admission) = {
            let selected = owner.lock().map_err(|_| crate::refusal_cause::CodedError::new("selected account unavailable"))?;
            let sign_in = selected.sign_in().map_err(|error| crate::refusal_cause::CodedError::with_cause("the account's sign-in is not open", error.cause()))?.clone();
            let admission = selected.admission_owner().map_err(|error| crate::refusal_cause::CodedError::with_cause("selected account admission unavailable", error.cause()))?;
            (sign_in, Arc::new(Mutex::new(admission)))
        };
        Ok(Self { owner, admission, sign_in, ids: Mutex::new(CanonicalLogIds::default()), commands: Mutex::new(None), door: None,
            me: std::sync::Weak::new(), standing: std::sync::OnceLock::new() })
    }

    /// The MCP endpoint on `owner` with reads admitted on `admission` and its loopback address `door`, installed as the
    /// account's resolver of kept parents for as long as it lives.
    fn at(owner: Arc<Mutex<SelectedAccount>>, admission: Arc<Mutex<SelectedAccount>>, door: Option<std::net::SocketAddr>,
        account: &str) -> Result<Arc<Self>, crate::refusal_cause::CodedError<&'static str>> {
        let sign_in = owner.lock().map_err(|_| crate::refusal_cause::CodedError::new("selected account unavailable"))?.sign_in()
            .map_err(|error| crate::refusal_cause::CodedError::with_cause("the account's sign-in is not open", error.cause()))?.clone();
        let made = Arc::new_cyclic(|me| Self { owner, admission, sign_in, ids: Mutex::new(CanonicalLogIds::default()), commands: Mutex::new(None), door,
            me: me.clone(), standing: std::sync::OnceLock::new() });
        let me: std::sync::Weak<dyn StandingDoor> = Arc::downgrade(&made) as std::sync::Weak<LocalSelectedMcp>;
        let resolver = Arc::new(StandingParents { door: me, account: account.to_owned() });
        let registration = crate::account_rights::run_cause::register_resolver(account, resolver)
            .map_err(|error| crate::refusal_cause::CodedError::with_cause("standing grants resolver refused", error.cause()))?;
        let _ = made.standing.set(registration);
        Ok(made)
    }

    /// This endpoint's own route: its loopback door, named by its owner's sign-in address. None where no loopback listener runs.
    pub(crate) fn route(&self) -> Option<crate::account_rights::run_capability::Route> {
        crate::account_rights::run_capability::Route::loopback(self.door?, self.sign_in.address())
    }

    /// The owned parent of the run cause `name` (`SignIn::standing`), run through this endpoint.
    fn standing_parent(&self, name: &str) -> Option<Arc<dyn crate::account_rights::run_capability::ParentAuthority>> {
        let door: std::sync::Weak<dyn StandingDoor> = self.me.clone();
        self.me.upgrade().is_some().then(|| Arc::new(SignInParent { door, name: name.to_owned() }) as _)
    }

    /// Keep the original credential in protected process memory for this run only. Every callback and byte pause
    /// is admitted afresh by this endpoint's sign-in; a presented signed-in token gets no wider scope.
    fn credential_parent(&self, caller: &Caller) -> Option<Arc<dyn crate::account_rights::run_capability::ParentAuthority>> {
        let door: std::sync::Weak<dyn StandingDoor> = self.me.clone();
        self.me.upgrade().is_some().then(|| Arc::new(CredentialParent { door, bearer: caller.credential.clone() }) as _)
    }

    /// The caller a share's kept act grant acts as for `call`: the party that kept it, named by its cause name
    /// (`Grants::kept_party`), admitted as that party now (`SignIn::standing_caller`).
    fn party_caller(&self, party: &str, call: &Operation) -> Result<Caller, account_routes::Refusal> {
        let found = self.sign_in.standing(party)?.ok_or(crate::cause!(account_routes::Refusal::Unauthenticated))?;
        let principal = self.sign_in.mcp_principal(&found);
        self.sign_in.standing_caller(party, &principal, call)
    }

    /// One call that acts on this computer for the caller's own account (a tool run, a capability grant, a grant
    /// kept): a bounded request key, and a caller whose right to call still stands on this account; the account and its state
    /// folder, with the call's cancellation flag. The owner is released before the answer, so a long run never holds
    /// the account.
    fn private_admitted(&self, caller: &Caller, call: &Operation,
        disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Result<(String, std::path::PathBuf, Arc<std::sync::atomic::AtomicBool>), OperationFailure> {
        use crate::account::NativeAccountOwner;
        if call.request_key.is_empty() || call.request_key.encode_utf16().count() > 512 {
            return Err(refusal("original_input_refused", false));
        }
        let limit = disclosure.started_at() + crate::legacy_records::Bounds::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let cancel = disclosure.cancellation_flag();
        let (account, state_root) = {
            let mut selected = owner_wait::acquire(&self.admission, || {
                cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
            })
            .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?;
            disclosure.stage("lock_wait");
            selected.assert_source_current().map_err(personal_refusal)?;
            let account = selected.account().owner_id;
            if account != caller.principal.account_id {
                return Err(refusal("current_workspace_rights_refused", false));
            }
            (account, selected.state_root().to_owned())
        };
        // Whether the caller's right still stands is asked with the account released: a page run's capability stands
        // while its page is still signed in (local_workspace.rs `page_task_context`), which takes this same account, so
        // asked under it the check waited on itself until the call gave up and the run's records call was refused
        // (Nov 13 2026: a new account's get-started screen read answered 502, task_context.rs:120 NotGranted).
        if !caller.stands() {
            return Err(refusal("current_workspace_rights_refused", false));
        }
        Ok((account, state_root, cancel))
    }

    /// A tool row run on this computer for `caller`. A row that declares records gets a run capability
    /// attenuated from the caller's own credential, for this run only, reaching this endpoint on its loopback address: its
    /// every call is admitted by the account's sign-in again, as the caller. `journal_input` is false only for a run a
    /// share's act grant started with `journal: none`.
    #[allow(clippy::too_many_arguments)]
    fn workshop_at(&self, workshop: &'static crate::tool_runs::tools::Workshop, caller: &Caller,
        call: &Operation, disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
        journal_input: bool, context: crate::tool_runs::tools::task_context::Context,
    ) -> Result<serde_json::Value, OperationFailure> {
        use crate::account_rights::run_capability::{Issuer, ParentIssuer, ParentKey};
        use crate::tool_runs::tools::{HomeVault, Place};
        let (account, state_root, cancel) = self.private_admitted(caller, call, disclosure, deadline_override)?;
        let admitted = self.admit_private_projection(caller, disclosure, deadline_override)?;
        disclosure.stage("admission");
        // A run an AI starts at this endpoint has no wake cause: its writes are the AI's own, admitted like them.
        let route = self.route();
        let parent = route.as_ref().map(|route| ParentKey { address: &route.address, account: &account, bearer: &caller.credential, door: route.door, cause: None });
        let authority = match caller.standing_grant() {
            Some(name) => self.standing_parent(name),
            None => self.credential_parent(caller),
        };
        // An operation that needs no loopback capability still has its actual native credential/scope owner.
        // Keep that private source independently of the records pipe; public task context remains unchanged.
        let context = match authority.as_ref() {
            Some(source) => {
                let source=source.clone();
                context.also_recovery_source(Arc::new(move || source.recovery_source()))
            }
            None => context,
        };
        // The run's issuer also says whether its journal keeps a digest of its input; a run that must keep none and
        // has no loopback address to say it through is refused.
        let issuer: Option<Box<dyn Issuer + '_>> = match parent {
            Some(parent) => {
                let authority = authority.clone().ok_or_else(|| refusal("current_workspace_rights_refused", false))?;
                Some(Box::new(ParentIssuer { parent, authority, journal_input }))
            }
            None if journal_input => None,
            None => return Err(refusal("current_workspace_rights_refused", false)),
        };
        let recovery_context = context.clone();
        let issuer = crate::tool_runs::tools::task_context::ContextIssuer { parent: issuer.as_deref(), context };
        // Physical parent actions also retain the original request's owned cancellation/deadline. This extra
        // pause belongs only to action proofs; ordinary kept-open sessions retain their existing lifetime.
        let parent_cancel = cancel.clone();
        let issuer = computer_actions::ParentActionIssuer { parent: &issuer,
            current: Arc::new(move || !parent_cancel.load(std::sync::atomic::Ordering::Acquire)
                && deadline_override.is_none_or(|deadline| Instant::now() < deadline)) };
        let place = Place { account: &account, state_root: &state_root, door: Some(&issuer), origin: None };
        let (ran,recovered) = crate::tool_runs::tools::with_recovery_receipt(|| workshop
            .call(&call.operation, &call.request_key, &call.input, &place, &HomeVault { place: &place }, &cancel))
            .map_err(workshop_refusal)?;
        disclosure.stage("run");
        let answer = ran.map_err(workshop_refusal)?;
        if let Some(proof) = recovered {
            self.retain_tool_recovery(workshop,caller,disclosure,cancel,deadline_override,
                Some(recovery_context),journal_input,None,proof)?;
        } else {
            self.register_private_projection_custody(caller, call, admitted, disclosure, deadline_override)?;
        }
        Ok(answer)
    }

    /// A tool run another run started (Round 2 contract A, tool-runs.json `runs`), its call already narrowed to a tool
    /// the parent's row names (`Admitted::narrow`). Admitted like any run at this endpoint, as the parent's credential;
    /// its capability is the started row's `invoke.records` met with the parent run's (`Admitted::nested_issuer`), its
    /// request key derived from the parent run's key, the tool and the key the call gave (`Workshop::nested_key`), and
    /// it ends by the parent's deadline (`deadline_override`, already the parent capability's in `invoke_as`).
    fn nested_workshop_at(&self, workshop: &'static crate::tool_runs::tools::Workshop, caller: &Caller, call: &Operation,
        run: &crate::account_rights::run_capability::Admitted, disclosure: &crate::mcp::RequestDisclosure,
        deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        use crate::tool_runs::tools::{HomeVault, Place};
        let refused = || refusal("current_workspace_rights_refused", false);
        let of = run.run_of().ok_or_else(refused)?;
        let tool = call.input.get("tool").and_then(serde_json::Value::as_str).ok_or_else(|| refusal("original_input_refused", false))?;
        let deadline = run.deadline().map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?;
        let deadline = deadline_override.map_or(deadline, |given| given.min(deadline));
        let (account, state_root, cancel) = self.private_admitted(caller, call, disclosure, Some(deadline))?;
        let admitted = self.admit_private_projection(caller, disclosure, Some(deadline))?;
        disclosure.stage("admission");
        let route = self.route().ok_or_else(refused)?;
        let issuer = run.nested_issuer(&route);
        // A nested computer row must earn its own checked native holdings. Retain only this callback's physical
        // request pause here; no ComputerRunProof is inherited from its parent run.
        let parent_cancel = cancel.clone();
        let issuer = computer_actions::ParentActionIssuer { parent: &issuer,
            current: Arc::new(move || !parent_cancel.load(std::sync::atomic::Ordering::Acquire)
                && Instant::now() < deadline) };
        let key = workshop.nested_key(&of.request_key, tool, &call.request_key);
        let place = Place { account: &account, state_root: &state_root, door: Some(&issuer), origin: None };
        let (ran,recovered) = crate::tool_runs::tools::with_recovery_receipt(|| workshop
            .call_before(workshop.run_method(), &key, &call.input, &place, &HomeVault { place: &place }, &cancel, deadline))
            .map_err(workshop_refusal)?;
        disclosure.stage("run");
        let answer = ran.map_err(workshop_refusal)?;
        if let Some(proof) = recovered {
            self.retain_tool_recovery(workshop,caller,disclosure,cancel,Some(deadline),None,true,Some(run.duplicate()),proof)?;
        } else {
            self.register_private_projection_custody(caller, call, admitted, disclosure, Some(deadline))?;
        }
        Ok(answer)
    }

    /// Get started's facts about the account's own mechanics (account-files-routes.json `setup_facts`, Round 2
    /// contract C), admitted like any private read of this account: ported from old trillion src/native-setup.mjs
    /// facts() (tag old-trillion-before-worker-retire, :196-271) and trillion-rust src/workspace_setup/facts.rs with
    /// src/local_account/setup_sign_in_inventory before 2159cb24, for the facts whose owner the engine still has.
    /// Who is signed in is the Better Auth Workshop tool's (src/account/signed_in.rs), so these facts name none.
    /// `shared_rules` and `context`: the operator's published show rules and setup context (old readSetupPolicy's
    /// operator records); one that cannot be read is left out, so it is unknown, never empty (old Promise.allSettled).
    /// `origin` is echoed as old facts() answered it. `facts` names no fact the engine cannot answer one to one; the
    /// DATA's `_setup_facts` says which are left out and why.
    fn setup_facts_at(&self, files: &crate::account_files::account_routes::AccountFilesDoor, caller: &Caller,
        call: &Operation, disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        let (_user_agent, origin) = files.setup_facts_asked(&call.input).ok_or_else(|| refusal("original_input_refused", false))?;
        self.private_admitted(caller, call, disclosure, deadline_override)?;
        let admitted = self.admit_private_projection(caller, disclosure, deadline_override)?;
        disclosure.stage("admission");
        let mut answer = serde_json::json!({"facts": {}, "origin": origin});
        let limit = crate::legacy_records::Bounds::default().elapsed;
        if let Ok((shared, context)) = self.personal_on(&self.admission, disclosure, limit, deadline_override, |selected, _, _| {
            selected.owner.operator_setup_records()
        }) {
            answer["shared_rules"] = shared;
            answer["context"] = context;
        }
        disclosure.stage("store_read");
        self.register_private_projection_custody(caller, call, admitted, disclosure, deadline_override)?;
        Ok(answer)
    }

    /// Which of the account's connected accounts hold values in its vault (account-files-routes.json
    /// `held_connections`), admitted like any private read of this account: the vault's names alone
    /// (secrets.rs `names_only`, no value is opened), read as connections by src/tool_runs/tools.rs `held_connections`.
    /// It is what old trillion's held-values `list` stood on (the box's connections, src/held-values.mjs before
    /// 4ffa1dc4a2) and nothing more: the connection's other facts are the person's own `connection` records. An
    /// account whose vault cannot be opened is refused, never answered as holding nothing.
    fn held_connections_at(&self, caller: &Caller, call: &Operation, disclosure: &crate::mcp::RequestDisclosure,
        deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        if !call.input.as_object().is_some_and(|fields| fields.is_empty()) {
            return Err(refusal("original_input_refused", false));
        }
        let (account, state_root, _) = self.private_admitted(caller, call, disclosure, deadline_override)?;
        let admitted = self.admit_private_projection(caller, disclosure, deadline_override)?;
        disclosure.stage("admission");
        let names = crate::secrets::open_home(&state_root, &account)
            .and_then(|vault| vault.names_only())
            .map_err(|error| refusal_from(error, "current_source_unavailable", false))?;
        let answer = serde_json::json!({"connections": crate::tool_runs::tools::held_connections(&names)});
        disclosure.stage("store_read");
        self.register_private_projection_custody(caller, call, admitted, disclosure, deadline_override)?;
        Ok(answer)
    }

    /// `held-values:put` for `caller` (secrets.rs `HELD_VALUES_PUT`): a held value kept by name, its value in the request body.
    /// Admitted by the sign-in's reach like any private write of this account (`reach.json` `vault`). The value is never logged,
    /// echoed or answered: the answer is `{accepted: true}`, which is true at the writer (written) and at a computer that is not
    /// the writer (queued for the writer's sealed settle).
    fn held_put_at(&self, caller: &Caller, call: &Operation, disclosure: &crate::mcp::RequestDisclosure,
        deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        let (name, value) = crate::secrets::held_value_put_input(&call.input).ok_or_else(|| refusal("original_input_refused", false))?;
        let (account, state_root, _) = self.private_admitted(caller, call, disclosure, deadline_override)?;
        disclosure.stage("admission");
        crate::secrets::open_home(&state_root, &account)
            .and_then(|vault| vault.put_as(name, zeroize::Zeroizing::new(value.to_owned()), crate::secrets::HeldAs::Plain))
            .map_err(|error| refusal_from(error, "held_put_refused", false))?;
        disclosure.stage("store_write");
        Ok(serde_json::json!({"accepted": true}))
    }

    /// `held-values:remove` for `caller` (secrets.rs `HELD_VALUES_REMOVE`): the held value under a name removed, admitted by the
    /// sign-in's reach like `held-values:put`. The answer carries the name and what happened, never a value: `removed` is true
    /// when the writer held one and false when it held none; a computer that is not the writer answers `queued` instead, the
    /// removal sealed to the writer for its settle.
    fn held_remove_at(&self, caller: &Caller, call: &Operation, disclosure: &crate::mcp::RequestDisclosure,
        deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        let name = crate::secrets::held_value_remove_input(&call.input).ok_or_else(|| refusal("original_input_refused", false))?;
        let (account, state_root, _) = self.private_admitted(caller, call, disclosure, deadline_override)?;
        disclosure.stage("admission");
        let removal = crate::secrets::open_home(&state_root, &account)
            .and_then(|vault| vault.remove_as(name))
            .map_err(|error| refusal_from(error, "held_remove_refused", false))?;
        disclosure.stage("store_write");
        Ok(match removal {
            crate::secrets::Removal::Removed => serde_json::json!({"name": name, "removed": true}),
            crate::secrets::Removal::Absent => serde_json::json!({"name": name, "removed": false}),
            crate::secrets::Removal::Queued => serde_json::json!({"name": name, "queued": true}),
        })
    }

    /// `held-values:sign` for `caller` (secrets.rs `HELD_VALUES_SIGN`): an Ed25519 signature made with the held key under the
    /// call's name, reached only through a run capability (`invoke_as` refuses every other caller). The key never leaves the
    /// vault: the answer is the signature alone.
    fn held_sign_at(&self, caller: &Caller, call: &Operation, disclosure: &crate::mcp::RequestDisclosure,
        deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        let (name, payload) = crate::secrets::held_sign_input(&call.input).ok_or_else(|| refusal("original_input_refused", false))?;
        let (account, state_root, _) = self.private_admitted(caller, call, disclosure, deadline_override)?;
        disclosure.stage("admission");
        let signature = crate::secrets::open_home(&state_root, &account)
            .and_then(|vault| vault.sign_ed25519(name, payload.as_bytes()))
            .map_err(|error| refusal_from(error, "held_sign_refused", false))?;
        disclosure.stage("store_read");
        Ok(serde_json::json!({"signature": signature}))
    }

    /// `sign-in:delete-account` for `caller` (src/account/erase.rs): the deletion's steps over this account's own tool
    /// runs (src/tool_runs/tools/erasure.rs), its files (the account files' own functions) and its own records (the
    /// record store's own destruction), each a bounded page, until the call's time ends; the sign-in step is the
    /// sign-in's own.
    fn delete_account_at(&self, caller: &Caller, call: &Operation, disclosure: &crate::mcp::RequestDisclosure,
        deadline_override: Option<Instant>) -> Result<serde_json::Value, OperationFailure> {
        use crate::account::erase;
        let (account, state_root, cancel) = self.private_admitted(caller, call, disclosure, deadline_override)?;
        let limit = disclosure.started_at() + crate::legacy_records::Bounds::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let until = deadline.checked_sub(ACCOUNT_FILES_ANSWER_MARGIN).unwrap_or(deadline);
        let unavailable = || refusal("account_erasure_step_unavailable", false);
        let tools = crate::tool_runs::tools::shipped().map_err(|error| refusal_from(error, "account_erasure_step_unavailable", false))?;
        let files = crate::account_files::account_routes::Files::shipped().ok_or_else(unavailable)?;
        let mut tool_runs = erase::ToolRunsStep(|cursor: &str| tools.erase_runs_page(&account, &state_root, cursor));
        let mut files = FilesErasure { files, account: &account, state_root: &state_root };
        let mut records = RecordsErasure { owner: &self.owner, cancel, until };
        let mut steps = erase::Steps { given: vec![
            (erase::TOOL_RUNS, &mut tool_runs as &mut dyn erase::Step),
            (erase::FILES, &mut files as &mut dyn erase::Step),
            (erase::RECORDS, &mut records as &mut dyn erase::Step),
        ] };
        self.sign_in.delete_account(caller, call, &mut steps, until)
    }

    /// List, grant or revoke the person's grants of computer capabilities to tools, for the caller's own
    /// account, admitted like a tool run. A run capability never reaches here: `invoke_admitted` narrows it to the
    /// records and account files routes first.
    fn computer_grants_at(&self, grants: &crate::tool_runs::tools::computer::Capabilities, caller: &Caller,
        call: &Operation, disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        let workshop = crate::tool_runs::tools::shipped().map_err(|failure| refusal(failure.code(), false))?;
        let (account, state_root, _) = self.private_admitted(caller, call, disclosure, deadline_override)?;
        let admitted = self.admit_private_projection(caller, disclosure, deadline_override)?;
        let place = crate::tool_runs::tools::Place { account: &account, state_root: &state_root, door: None, origin: None };
        // Who is calling is the caller's own admitted sign-in, and the account's own grant rules are read by the engine
        // as the account's owner: nothing of either comes from the request.
        let limit = disclosure.started_at() + crate::legacy_records::Bounds::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let cancel = disclosure.cancellation_flag();
        let policy = owner_wait::acquire(&self.admission, || {
            cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
        })
        .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?
        .grant_policy(grants.grant_policy_label(), cancel.clone(), deadline)?;
        let who = crate::tool_runs::tools::computer::grants::Who::admitted(&state_root, &caller.principal.sign_in, policy);
        let answer = grants
            .call(workshop, &place, &who, &call.operation, &call.request_key, &call.input)
            .map_err(workshop_refusal)?;
        self.register_private_projection_custody(caller, call, admitted, disclosure, deadline_override)?;
        Ok(answer)
    }

    /// One record, one page of a kind or one record's history from the account's own records, for `caller`. The
    /// account is held only to admit the call and to confirm it before the answer leaves, both on the owner that checks reads;
    /// the read between runs on a read-only handle of the account's own records file, so it waits on no other request
    /// and on no writer.
    ///
    /// `remote` is a caller that is not a tool run of this computer (an AI app): a kind that stays on this computer
    /// is refused to it, by name, before it is read (`Door::device_only_asked`). A tool run is held to its row when it
    /// starts (`run_capability::leaves_this_computer_with`).
    fn records_read_at(&self, caller: &Caller, call: &Operation, remote: bool,
        disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        let door = crate::record_value::account_routes::Door::shipped().map_err(|error| refusal_from(error, "current_source_unavailable", false))?;
        // A reverse read reaches the target/root and holders, not just its operation name. Require the ordinary
        // own-record read scope too and retain its current check through the same disclosure. Run capabilities
        // cannot reach this operation: its input-only rule cannot attest grants for discovered holders.
        let caller = if call.operation == door.references_operation() {
            let sign_in = self.sign_in.clone();
            let credential = caller.credential.clone();
            let principal = caller.principal.clone();
            let resource = door.resource().to_owned();
            let operation = door.read_operation().to_owned();
            sign_in.admitted(&credential, &principal, &resource, &operation).map_err(|error| error.failure())?;
            caller.also(Arc::new(move || sign_in.admitted(&credential, &principal, &resource, &operation).is_ok()))
        } else { caller.clone() };
        let caller = &caller;
        let limit = crate::workspace_store::Limits::default().elapsed;
        let admitted = self.personal_on(&self.admission, disclosure, limit, deadline_override, |selected, cancel, deadline| {
            selected.admit_door_records_read(caller, call, cancel, deadline)
        })?;
        let answer = admitted.read(call, remote).map_err(personal_refusal)?;
        self.personal_on(&self.admission, disclosure, limit, deadline_override, |selected, _, _| {
            selected.confirm_door_records_read(&admitted)
        })?;
        let limit = disclosure.started_at() + crate::workspace_store::Limits::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        // The last confirmation, as the body leaves, runs where this read was admitted and confirmed: on the admission
        // owner, so a records read never waits on the account's writer.
        self.register_personal_read_custody(caller, call, admitted, disclosure, deadline, &self.admission)?;
        Ok(answer)
    }

    /// One of the account routes' operations on the person's wakes (records-routes.json `wake`). A switch writes the wake
    /// book, so it has the routes' write bound, not the read's.
    fn wake_at(&self, caller: &Caller, call: &Operation,
        disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        let limit = crate::legacy_records::Bounds::default().elapsed;
        // The account's run details are copied under a short hold; the tool rows are read outside it, and
        // the account is held again only for the check that lets the call in and the wake book's record operations.
        let started = disclosure.started_at();
        let deadline = deadline_override.map_or(started + limit, |deadline| deadline.min(started + limit));
        let cancel = disclosure.cancellation_flag();
        let (account, state_root) = owner_wait::acquire(&self.owner, || {
            cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
        })
        .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?
        .tool_place();
        let prepared = super::mcp_selected_personal::workspace_read::prepare_wake_call(call, account, state_root)
            .map_err(|error| match error {
                crate::account::AccountError::InvalidInput(cause) => OperationFailure { cause, ..refusal("original_input_refused", false) },
                other => personal_refusal(other),
            })?;
        // A switch is written by the caller's party (`SignIn::party_of`), whose runs then act as that party
        // (`account_rights::run_cause`): its cause name is kept on the wake, never a credential. Whether
        // the caller still stands is asked with the account released, before and after the book is written.
        let by = self.sign_in.party_of(caller).ok_or_else(|| refusal("current_workspace_rights_refused", false))?;
        if !caller.stands() {
            return Err(refusal("current_workspace_rights_refused", false));
        }
        let answer = self.personal_at(disclosure, limit, deadline_override, |selected, cancel, deadline| {
            selected.door_wake_call(caller, &by, &prepared, cancel, deadline)
        })?;
        if !caller.stands() {
            return Err(refusal("current_workspace_rights_refused", false));
        }
        Ok(answer)
    }

    /// Run one account answer on the selected account within `limit` of the call's start (or its own earlier
    /// deadline), its refusals as the account routes'.
    fn personal_at<T>(&self, disclosure: &crate::mcp::RequestDisclosure, limit: Duration, deadline_override: Option<Instant>,
        answer: impl FnOnce(&mut SelectedAccount, Arc<std::sync::atomic::AtomicBool>, Instant) -> crate::account::AccountResult<T>,
    ) -> Result<T, OperationFailure> {
        self.personal_on(&self.owner, disclosure, limit, deadline_override, answer)
    }

    /// `personal_at` on `owner`: the account's own owner, or the owner that checks its reads.
    fn personal_on<T>(&self, owner: &Arc<Mutex<SelectedAccount>>, disclosure: &crate::mcp::RequestDisclosure, limit: Duration,
        deadline_override: Option<Instant>,
        answer: impl FnOnce(&mut SelectedAccount, Arc<std::sync::atomic::AtomicBool>, Instant) -> crate::account::AccountResult<T>,
    ) -> Result<T, OperationFailure> {
        let limit = disclosure.started_at() + limit;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let cancel = disclosure.cancellation_flag();
        let mut selected = owner_wait::acquire(owner, || {
            cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
        })
        .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?;
        // One hold, one full check of the account's state lock and files, carried for the rest of the hold
        // (`LocalAccount::carry_witness`); a read admits in one hold and confirms in another before it answers.
        let _carried = selected.owner.carry_witness();
        answer(&mut selected, cancel, deadline).map_err(personal_refusal)
    }

    /// One call at the person's files routes for `caller`: the caller's right is checked under the
    /// account, the account is released while the account files answers (a read may wait on a byte store), and the
    /// right is checked again before the answer leaves; a refusal there after a write leaves its outcome unknown.
    fn account_files_at(&self, files: &crate::account_files::account_routes::AccountFilesDoor, caller: &Caller,
        call: &Operation, disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        let (answer, admitted) = self.account_files_answer(files, caller, call, disclosure, deadline_override)?;
        self.register_private_projection_custody(caller, call, admitted, disclosure, deadline_override)?;
        Ok(answer)
    }

    /// `account_files_at` before its answer's custody is registered: the answer, and the checked right a custody would hold.
    /// A call that answers with another owner's answer too (the one search) registers one custody for the whole.
    fn account_files_answer(&self, files: &crate::account_files::account_routes::AccountFilesDoor, caller: &Caller,
        call: &Operation, disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Result<(serde_json::Value, crate::native_boot::mcp_selected_personal::workspace_read::AdmittedRecordsRead), OperationFailure> {
        let (account, state_root, cancel) = self.private_admitted(caller, call, disclosure, deadline_override)?;
        let limit = crate::account_files::settings::call_deadline(disclosure.started_at(),
            crate::legacy_records::Bounds::default().elapsed, &call.input);
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let admitted = self.admit_private_projection(caller, disclosure, deadline_override)?;
        let effect_current = {
            let cancel = cancel.clone();
            let current = caller.current.clone();
            Arc::new(move || !cancel.load(std::sync::atomic::Ordering::Acquire)
                && Instant::now() < deadline && current())
        };
        // A paged call stops taking steps in time to check the caller again and answer inside the call's deadline.
        let answer = files.call_while_fitting(&state_root, &account, &call.operation, &call.input,
            deadline.checked_sub(ACCOUNT_FILES_ANSWER_MARGIN).unwrap_or(deadline), effect_current,
            &crate::mcp::tool_answer_fits);
        if !caller.stands() {
            return Err(refusal("current_workspace_rights_refused", true));
        }
        let answer = answer.map_err(|failure| {
            let (code, unknown) = failure.code();
            OperationFailure { cause: failure.cause().into(), detail: failure.detail(), ..refusal(code, unknown) }
        })?;
        Ok((answer, admitted))
    }

    /// One read by someone this account shared records with (`account_rights::share_grant`): the account is held
    /// once, its grants are read from its own store and the call is narrowed against them in that same hold, and only
    /// the labels the grants give this bearer now are projected. No person's credential takes part; the grant is the
    /// right.
    fn shared_read_at(&self, grants: &crate::account_rights::share_grant::Grants, principal: &Principal, bearer: &[u8],
        call: &Operation, disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        use crate::account::NativeAccountOwner;
        if call.request_key.is_empty() || call.request_key.encode_utf16().count() > 512 {
            return Err(refusal("original_input_refused", false));
        }
        let limit = disclosure.started_at() + crate::workspace_store::Limits::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let cancel = disclosure.cancellation_flag();
        let snapshot = {
            let mut selected = owner_wait::acquire(&self.admission, || {
                cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
            })
            .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?;
            if selected.account().owner_id != principal.account_id {
                return Err(refusal("current_workspace_rights_refused", false));
            }
            selected.shared_read(grants, bearer, call, cancel, deadline)?
        };
        let crate::workspace_domain::DomainAnswer::Http { status, headers, body } =
            crate::local_workspace::tool_answer(snapshot, &call.request_key)
                .map_err(|error| refusal_from(error, "original_workspace_read_unavailable", false))?
        else {
            return Err(refusal("original_workspace_read_unavailable", false));
        };
        let content_type = headers.get(axum::http::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
        crate::mcp_apps::WorkspaceAnswer::structured_content(
            status.as_u16(), content_type, &body, Some(&call.request_key), true, true, true,
        )
        .map_err(|error| refusal_from(error, "original_read_output_unavailable", false))
    }

    /// One call at this endpoint. A call refused for its input answers what was wrong, by field name and expected shape
    /// (`mcp::InputFault`), whichever stage refused it: the owner of the operation's input says it (`input_fault`),
    /// and a refusal that already names its own detail keeps that.
    pub(super) fn invoke_at(&self, principal: &Principal, bearer: &[u8], call: Operation,
        disclosure: &crate::mcp::RequestDisclosure, parent_current: account_routes::Current,
        deadline_override: Option<Instant>) -> Result<serde_json::Value, OperationFailure> {
        disclosure.name_stages(&call.request_key);
        // The JSON-RPC chunk read and its dispatch to this endpoint.
        disclosure.stage("transport");
        let asked = input_owner_asks(&call).then(|| (call.resource.clone(), call.operation.clone(), call.input.clone()));
        self.invoke_admitted(principal, bearer, call, disclosure, parent_current, deadline_override)
            .map_err(|failure| match asked {
                Some((resource, operation, input)) if failure.code == "original_input_refused" && failure.detail.is_none() => {
                    input_fault(&resource, &operation, &input).map_or(failure, crate::mcp::InputFault::into_failure)
                }
                _ => failure,
            })
    }

    fn invoke_admitted(&self, principal: &Principal, bearer: &[u8], call: Operation,
        disclosure: &crate::mcp::RequestDisclosure, parent_current: account_routes::Current,
        deadline_override: Option<Instant>) -> Result<serde_json::Value, OperationFailure> {
        if let Some(answer) = self.instructions_at(principal, bearer, &call, disclosure, parent_current.clone(), deadline_override) {
            return answer;
        }
        // A share bearer reads only what this account's grants give it now, or acts only as one of its act grants
        // allows, and nothing else at this endpoint.
        if let Ok(grants) = crate::account_rights::share_grant::Grants::shipped() {
            if grants.is_share(bearer) {
                if let Some(answer) = self.reach_door_at(grants, bearer, &call, disclosure, deadline_override) {
                    return answer;
                }
                if grants.reads(&call.resource, &call.operation) {
                    return self.shared_read_at(grants, principal, bearer, &call, disclosure, deadline_override);
                }
                return self.granted_at(grants, principal, bearer, call, disclosure, parent_current, deadline_override);
            }
        }
        // A tool run's capability: it authenticated as the credential that started the run; every call is
        // narrowed to the operations and kinds its row declared, then admitted as that credential, so the account's
        // sign-in decides again here.
        let run = match crate::account_rights::run_capability::held(bearer) {
            None => None,
            Some(Ok(run)) => Some(run),
            Some(Err(_)) => return Err(refusal("current_workspace_rights_refused", false)),
        };
        // A native computer action has its own typed source proof in this exact live run. It uses this same
        // endpoint and private run descriptor, but cannot be expressed as a records right or called by a raw key.
        if crate::tool_runs::tools::computer::shipped().is_ok_and(|computer| {
            let (resource, operation) = computer.trash_source_route();
            call.resource == resource && call.operation == operation
        }) {
            return Self::computer_action_at(principal, bearer, &call, run.as_ref(), disclosure, parent_current, deadline_override);
        }
        if let Some(answer) = run.as_ref().and_then(|run| run.invoke_parent(principal, call.clone(), disclosure)) {
            return answer;
        }
        let credential: &[u8] = run.as_ref().map_or(bearer, |run| &run.parent);
        let mut caller = self.sign_in.caller(credential, principal, &call).map_err(account_routes::Refusal::failure)?
            .also(parent_current);
        if let Some(run) = &run {
            caller = caller.also(run.current_checker());
        }
        self.invoke_as(&caller, call, run, disclosure, deadline_override)
    }

    /// One call by someone this account gave an act grant (`account_rights::share_grant::Act`). The account's sharing
    /// records are read in one hold and the bearer's act grants found in them. A tool run one of them names is admitted
    /// as the key that grant was kept with and runs as that key's run would, with the grant's identity in its input
    /// and its journal choice. A records operation is narrowed to a grant's rights by a run capability of the
    /// grant's key, minted for this call alone and revoked when it answers, and then admitted like any run's call.
    /// The key is admitted by the account's sign-in for the call, and kept admitted, as long as the grant stands. Every
    /// other call, and a grant not kept with exactly what it declares now, is refused.
    #[allow(clippy::too_many_arguments)]
    fn granted_at(&self, grants: &crate::account_rights::share_grant::Grants, principal: &Principal, bearer: &[u8],
        call: Operation, disclosure: &crate::mcp::RequestDisclosure, parent_current: account_routes::Current,
        deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        use crate::account::NativeAccountOwner;
        use crate::account_rights::{run_capability, share_grant::Refusal};
        let not_granted = || refusal("current_workspace_rights_refused", false);
        let refused = |refused: Refusal| match refused {
            Refusal::Unavailable(_) => refusal("original_workspace_source_unavailable", false),
            Refusal::Input(_) => refusal("original_input_refused", false),
            Refusal::NotGranted(_) => not_granted(),
        };
        if call.request_key.is_empty() || call.request_key.encode_utf16().count() > 512 {
            return Err(refusal("original_input_refused", false));
        }
        let limit = disclosure.started_at() + crate::legacy_records::Bounds::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let cancel = disclosure.cancellation_flag();
        let (sharing, account, state_root) = {
            let mut selected = owner_wait::acquire(&self.admission, || {
                cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
            })
            .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?;
            disclosure.stage("lock_wait");
            let account = selected.account().owner_id;
            if account != principal.account_id {
                return Err(not_granted());
            }
            (selected.sharing_records(grants, cancel.clone(), deadline)?, account, selected.state_root().to_owned())
        };
        disclosure.stage("store_read");
        let reached = grants.acting(&sharing, bearer);
        if reached.is_empty() {
            return Err(not_granted());
        }
        let vault = crate::secrets::open_home(&state_root, &account)
            .map_err(|error| refusal_from(error, "original_workspace_source_unavailable", false))?;
        disclosure.stage("unseal");
        // The party that kept the grant, by its cause name, admitted as that party now by the account's routes for
        // `call` and kept admitted while the grant stands.
        let as_party = |party: &str, call: &Operation,
            reach: &crate::account_rights::share_grant::Reach| -> Result<Caller, OperationFailure> {
            let grant_current = self.share_current(&account, reach, bearer, vault.clone(), cancel.clone(), deadline)?;
            Ok(self.party_caller(party, call).map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?
                .also(parent_current.clone()).also(grant_current))
        };
        // A tool run one of the bearer's grants names; no other method of the tool routes.
        if let Ok(workshop) = crate::tool_runs::tools::shipped() {
            if workshop.runs(&call.resource, &call.operation) {
                let tool = call.input.get("tool").and_then(serde_json::Value::as_str)
                    .ok_or_else(|| refusal("original_input_refused", false))?;
                let reach = reached.iter().find(|reach| reach.act.runs(tool)).ok_or_else(not_granted)?;
                let party = grants.kept_party(&*vault, reach).map_err(refused)?;
                let mut call = call;
                call.input = grants.tool_input(reach, &call.input).map_err(refused)?;
                disclosure.stage("admission");
                let caller = as_party(&party, &call, reach)?;
                let proof = crate::mcp::ShareActProof::admitted(principal, bearer, &caller.principal, party.as_bytes(), &call,
                    caller.current.clone());
                let child = disclosure.delegated_child();
                let context = crate::tool_runs::tools::task_context::Context::shared(&caller, reach).map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?;
                let answer = self.workshop_at(workshop, &caller, &call, &child, deadline_override, reach.act.journals_input(), context);
                if answer.is_ok() { proof.transfer_personal(&call, &child, disclosure, caller.current.clone()).map_err(|error| refusal_from(error, "current_workspace_rights_refused", true))?; }
                return answer;
            }
        }
        // A records operation: the first of the bearer's grants whose rights cover the whole call.
        for reach in &reached {
            let Some(rights) = grants.rights_for(reach, &state_root).map_err(refused)? else { continue };
            let party = match grants.kept_party(&*vault, reach) {
                Ok(party) => party,
                Err(Refusal::NotGranted(_)) => continue,
                Err(other) => return Err(refused(other)),
            };
            // Who the keeping party is now: its live standing decides, for the whole call, before anything is narrowed.
            let Ok(key_principal) = self.party_caller(&party, &call).map(|caller| caller.principal) else { continue };
            let lifetime = deadline.saturating_duration_since(Instant::now());
            let authority = self.standing_parent(&party).ok_or_else(not_granted)?;
            let capability = run_capability::mint_with_authority(&account, party.as_bytes(), rights, None, lifetime, authority)
                .map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?;
            let Some(Ok(run)) = run_capability::held(capability.token().as_bytes()) else {
                return Err(refusal("original_workspace_source_unavailable", false));
            };
            let narrowed_input = match run.narrow(&key_principal, &call) {
                Ok(input) => input,
                Err(_) => continue,
            };
            let mut call = call.clone();
            call.input = narrowed_input;
            let caller = as_party(&party, &call, reach)?.also(run.current_checker());
            let proof = crate::mcp::ShareActProof::admitted(principal, bearer, &caller.principal, party.as_bytes(), &call,
                caller.current.clone()).keeping_run(capability);
            let child = disclosure.delegated_child();
            let answer = self.invoke_as(&caller, call.clone(), Some(run), &child, deadline_override);
            if answer.is_ok() { proof.transfer_personal(&call, &child, disclosure, caller.current.clone()).map_err(|error| refusal_from(error, "current_workspace_rights_refused", true))?; }
            return answer;
        }
        Err(not_granted())
    }

    /// The check that the act grant `reach` still names `bearer` in this account's sharing records and is still kept in
    /// the vault, read on the owner of the account that checks reads. The sealed key is unsealed once, by the caller
    /// that admitted the call; this check reads only the sharing record and the vault's entry metadata (no value), so a
    /// withdrawal or a changed grant mid-call withholds the answer without a vault read per check. A re-keep under the
    /// same grant is not seen here; see `Grants::still_kept` for the accepted limit.
    #[allow(clippy::too_many_arguments)]
    fn share_current(&self, account: &str, reach: &crate::account_rights::share_grant::Reach, bearer: &[u8],
        vault: Arc<crate::secrets::OwnVault>, cancel: Arc<std::sync::atomic::AtomicBool>, deadline: Instant,
    ) -> Result<account_routes::Current, OperationFailure> {
        use crate::{account::NativeAccountOwner, account_rights::share_grant::Grants};
        let account = account.to_owned();
        let admission = {
            let owner = owner_wait::acquire(&self.admission, || cancel.load(std::sync::atomic::Ordering::Acquire)
                || Instant::now() >= deadline).map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?;
            Arc::new(Mutex::new(owner.admission_owner().map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?))
        };
        let expected = reach.clone();
        let bearer = zeroize::Zeroizing::new(bearer.to_vec());
        let current: account_routes::Current = Arc::new(move || {
            if cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline { return false; }
            let Ok(grants) = Grants::shipped() else { return false; };
            let Ok(mut selected) = owner_wait::acquire(&admission, || cancel.load(std::sync::atomic::Ordering::Acquire)
                || Instant::now() >= deadline) else { return false; };
            if selected.account().owner_id != account { return false; }
            let Ok(sharing) = selected.sharing_records(grants, cancel.clone(), deadline) else { return false; };
            if !grants.acting(&sharing, &bearer).iter().any(|reach| reach == &expected) { return false; }
            grants.still_kept(&*vault, &expected) && !cancel.load(std::sync::atomic::Ordering::Acquire) && Instant::now() < deadline
        });
        Ok(current)
    }

    /// The sharer keeping or withdrawing an act grant with their own credential (`share_grant::Grants::keep`), input
    /// `{label, on}`: admitted like a tool run. Kept, the credential and the grant the sharing record on that label
    /// declares now are sealed in the account's vault; withdrawn, removed.
    fn grant_keep_at(&self, grants: &crate::account_rights::share_grant::Grants, caller: &Caller,
        call: &Operation, disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        use crate::account_rights::share_grant::Refusal;
        let (label, on) = grants.keep_asked(&call.input).ok_or_else(|| refusal("original_input_refused", false))?;
        let (account, state_root, cancel) = self.private_admitted(caller, call, disclosure, deadline_override)?;
        let unavailable = || refusal("original_workspace_source_unavailable", false);
        let vault = crate::secrets::open_home(&state_root, &account).map_err(|error| refusal_from(error, "original_workspace_source_unavailable", false))?;
        if !on {
            let kept = grants.withdraw(&*vault, label).map_err(|error| refusal_from(error, "original_workspace_source_unavailable", false))?;
            return Ok(serde_json::json!({"label": label, "on": false, "was_kept": kept}));
        }
        let limit = disclosure.started_at() + crate::legacy_records::Bounds::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let sharing = owner_wait::acquire(&self.admission, || {
            cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline
        })
        .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?
        .sharing_records(grants, cancel.clone(), deadline)?;
        let record = sharing.get(&format!("{}{label}", grants.record_prefix()))
            .ok_or_else(|| refusal("original_input_refused", false))?;
        // The keeper's party, by its cause name (never its credential), is what the share's act runs as from now on.
        let party = self.sign_in.party_of(caller).ok_or_else(|| refusal("standing_grant_refused", false))?;
        if !caller.stands() {
            return Err(refusal("current_workspace_rights_refused", false));
        }
        let keep = grants.keep(&*vault, label, &party, record);
        keep.map_err(|refused| {
            let cause = refused.cause();
            let failure = match refused { Refusal::Input(_) => refusal("original_input_refused", false), _ => unavailable() };
            OperationFailure { cause, ..failure }
        })?;
        Ok(serde_json::json!({"label": label, "on": true}))
    }

    /// The person keeping (`{door, label, key}`) or removing (`{door, label, on: false}`) the key of a share someone
    /// gave them (`share_given::Receiving`), admitted like a grant keep. The key goes only into the account's vault;
    /// the answer names the record (`{door, label, given_at}`, no key) the person's client writes through the generic
    /// records write, which is what their show-rules read then reads at the sharer's account routes.
    fn share_receive_at(&self, receiving: &crate::account_rights::share_given::Receiving, caller: &Caller,
        call: &Operation, disclosure: &crate::mcp::RequestDisclosure, deadline_override: Option<Instant>,
    ) -> Result<serde_json::Value, OperationFailure> {
        use crate::account_rights::share_given::Refusal;
        let asked = receiving.asked(&call.input).ok_or_else(|| refusal("original_input_refused", false))?;
        let (account, state_root, _) = self.private_admitted(caller, call, disclosure, deadline_override)?;
        let unavailable = || refusal("original_workspace_source_unavailable", false);
        let vault = crate::secrets::open_home(&state_root, &account).map_err(|error| refusal_from(error, "original_workspace_source_unavailable", false))?;
        let Some(key) = &asked.key else {
            let kept = receiving.forget(&*vault, &asked.given).map_err(|error| refusal_from(error, "original_workspace_source_unavailable", false))?;
            return Ok(serde_json::json!({"label": receiving.record_label(&asked.given), "on": false, "was_kept": kept}));
        };
        let given_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| refusal_from(error, "original_workspace_source_unavailable", false))?
            .as_millis();
        let given_at = i64::try_from(given_at).map_err(|error| refusal_from(error, "original_workspace_source_unavailable", false))?;
        let (label, record) = receiving.receive(&*vault, &asked.given, key, given_at).map_err(|refused| {
            let cause = refused.cause();
            let failure = match refused { Refusal::Input(_) => refusal("original_input_refused", false), Refusal::Unavailable(_) => unavailable() };
            OperationFailure { cause, ..failure }
        })?;
        Ok(serde_json::json!({"label": label, "on": true, "record": record}))
    }

    /// A records call for one kind goes to that kind's home: the history its `home:<kind>` row names (records-routes.json
    /// `homes`). A list moved into a store of its own (Workshop tools/keep-a-lists-rows-in-one-of-the-accounts-databases-
    /// while, old trillion src/placed-lists.mjs invariant 1: "One store answers for a list's rows: its home") keeps its
    /// rows in a record domain (src/storage/record_store_resources/domains.rs); its `home:` row is written before its rows
    /// leave the primary, so from then on every call that names the kind (a list or read with `type`, a write whose
    /// records are all of it) is answered there, by the caller's own rights, as if it had named that `scope` itself.
    /// A call that names a scope, or no single kind, is left as it is; a write that mixes a homed kind with another
    /// is refused, since one command writes one history. `scope: null` names the primary (reads, and writes that only
    /// remove), so the move can take out what is left there once the home is set. The `home:` row is read through this same door, so it is
    /// admitted and confirmed like any read of the caller's, under its own answer custody (`delegated_child`): the request's
    /// custody is registered once, by the call itself. A second registration on the request's own custody made every call
    /// naming a `record:` kind refused at answer time (body_custody_refused, src/mcp/disclosure.rs register), 2026-11-14.
    fn to_kinds_home(&self, caller: &Caller, call: &mut Operation, disclosure: &crate::mcp::RequestDisclosure,
        deadline_override: Option<Instant>) -> Result<(), OperationFailure> {
        let Ok(door) = crate::record_value::account_routes::Door::shipped() else { return Ok(()) };
        if call.resource != door.resource() { return Ok(()) }
        let writes = crate::record_write_model::write_command::Command::is_shipped(&call.operation);
        let key = call.request_key.clone();
        let mut read_home = |id: &str| {
            let read = Operation {
                resource: door.resource().to_owned(),
                operation: door.read_operation().to_owned(),
                request_key: format!("{key}:{id}"),
                input: serde_json::json!({"id": id}),
                person_present: None,
            };
            self.records_read_at(caller, &read, false, &disclosure.delegated_child(), deadline_override)
                .map(|held| held.get("value").cloned().unwrap_or(serde_json::Value::Null))
        };
        let operation = call.operation.clone();
        if door.to_home(&operation, &mut call.input, writes, &mut read_home)? { Ok(()) } else { Err(refusal("original_input_refused", false)) }
    }

    /// One call by `caller`, admitted by the account's sign-in for it; with `run`, a run capability's call (narrowed to
    /// what the capability allows, admitted as the credential that started the run).
    fn invoke_as(&self, caller: &Caller, call: Operation,
        run: Option<crate::account_rights::run_capability::Admitted>, disclosure: &crate::mcp::RequestDisclosure,
        deadline_override: Option<Instant>) -> Result<serde_json::Value, OperationFailure> {
        let deadline_override = match &run {
            Some(run) => {
                let until = run.deadline().map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?;
                Some(deadline_override.map_or(until, |deadline| deadline.min(until)))
            }
            None => deadline_override,
        };
        // Result reconciliation admits and narrows its ORIGINAL write, not a
        // generic result operation granting access to another command's scope.
        if crate::record_value::account_routes::Door::shipped()
            .is_ok_and(|door| door.answers_result(&call.resource, &call.operation))
        {
            return self.records_result_at(caller, &call, run.as_ref(), disclosure, deadline_override);
        }
        let mut call = call;
        person_present_word(&mut call, run.is_none() && caller.fresh);
        match &run {
            // The narrowed input: the tool's own, with every written record stamped with the run's wake cause.
            Some(run) => call.input = run.narrow(&caller.principal, &call)
                .map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?,
            // A write no run caused is not a run's own change: a stamp copied from a stored value is dropped.
            None => crate::account_rights::run_capability::unstamp(&call.operation, &mut call.input)
                .map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?,
        }
        self.to_kinds_home(caller, &mut call, disclosure, deadline_override)?;
        // Deleting the account (src/account/erase.rs): its steps reach the account's runs, files and records here.
        if SignIn::deletes(&call) {
            return self.delete_account_at(caller, &call, disclosure, deadline_override);
        }
        // The account door's own operations: its computers, limits and copy rule rows, and its deletion's state.
        if SignIn::answers(&call) {
            return self.sign_in.call(caller, &call);
        }
        // The person keeping or withdrawing an act grant of a share (src/account_rights/share-grant.json door_grant.act).
        if let Ok(grants) = crate::account_rights::share_grant::Grants::shipped() {
            if grants.keeps(&call.resource, &call.operation) {
                return self.grant_keep_at(grants, caller, &call, disclosure, deadline_override);
            }
        }
        // The person keeping or removing the key of a share someone gave them
        // (src/account_rights/share-given.json given.receive_operation).
        if let Ok(receiving) = crate::account_rights::share_given::Receiving::shipped() {
            if receiving.receives(&call.resource, &call.operation) {
                return self.share_receive_at(receiving, caller, &call, disclosure, deadline_override);
            }
        }
        // One AI harness hook event (src/account/hooks.json): each of its steps is an ordinary operation of this same
        // caller, admitted again here.
        if let Ok(hooks) = crate::account::hooks::HookRoutes::shipped() {
            if hooks.answers(&call.resource, &call.operation) {
                let now = crate::account::hooks::now_iso();
                // A kept record's kind is the one this account's installed tools' model names for it.
                let (_, state_root, _) = self.private_admitted(caller, &call, disclosure, deadline_override)?;
                let kind_of = |section: &str, key: &str| crate::record_model_policy::installed(&state_root).ok()
                    .and_then(|model| model.named(section, key).map(str::to_owned));
                let home=std::env::var_os("HOME").map(std::path::PathBuf::from);
                let env=|name:&str|std::env::var(name).ok();
                let computer=crate::account::hooks::Computer{env:&env,home,now_ms:chrono::Utc::now().timestamp_millis()};
                let proofs=hooks.verify_executions(&call.input,&kind_of,&computer)?;
                if !proofs.is_empty(){
                    let limit=crate::legacy_records::Bounds::default().elapsed;
                    let deadline=deadline_override.map_or(disclosure.started_at()+limit,|d|d.min(disclosure.started_at()+limit));
                    let captured=self.personal_at(disclosure,limit,deadline_override,|selected,cancel,_|{
                        if !caller.stands()||self.sign_in.admitted(&caller.credential,&caller.principal,&call.resource,&call.operation).is_err(){return Err(crate::cause!(crate::account::AccountError::RightsRefused))}
                        // Hook receipt I/O has its own admitted owner. Share only each ID allocation, never its whole write.
                        let mut ids=CanonicalLogIds::shared(&self.ids);
                        Ok(selected.door_hook_receipts(caller,&call,&proofs,cancel,deadline,&mut ids))
                    })?;
                    captured.map_err(|error|write_refusal(error,deadline,None))?;
                }
                let mut input=call.input.clone();
                input.as_object_mut().ok_or_else(||refusal("original_input_refused",false))?.remove("executions");
                let mut answer=hooks.receive(&input, &now, &kind_of, &mut |step| {
                    // The caller's credential is asked again for this step's own resource and operation.
                    if !caller.stands() || self.sign_in.admitted(&caller.credential, &caller.principal, &step.resource, &step.operation).is_err() {
                        return Err(refusal("current_workspace_rights_refused", false));
                    }
                    self.invoke_as(caller, step, None, disclosure, deadline_override)
                })?;
                answer["executions_accepted"]=serde_json::Value::Array(proofs.iter().map(|proof|serde_json::json!({
                    "call_id":proof.receipt["call_id"],
                    "execution_ref":crate::local_account::record_writer::native_command_context::execution_metadata::reference(&proof.receipt["call_id"].as_str().unwrap_or("").into()).ok().and_then(|id|id.to_rust_string().ok()),
                    "event_phase":proof.receipt["event_phase"]})).collect());
                return Ok(answer);
            }
        }
        // The account's own records, one record or one page of a kind (product DATA records-routes.json).
        if let Ok(door) = crate::record_value::account_routes::Door::shipped() {
            if door.answers(&call.resource, &call.operation) {
                return self.records_read_at(caller, &call, run.is_none(), disclosure, deadline_override);
            }
            if door.answers_wake(&call.resource, &call.operation) {
                return self.wake_at(caller, &call, disclosure, deadline_override);
            }
        }
        // The person's files files (product DATA account-files-routes.json).
        if let Some(files) = crate::account_files::account_routes::AccountFilesDoor::shipped() {
            // Get started's facts about the account's own mechanics (Round 2 contract C), at the same door.
            if files.answers_setup_facts(&call.resource, &call.operation) {
                return self.setup_facts_at(files, caller, &call, disclosure, deadline_override);
            }
            // Which connected accounts hold values in the account's vault, by the names alone, at the same door.
            if files.answers_held_connections(&call.resource, &call.operation) {
                return self.held_connections_at(caller, &call, disclosure, deadline_override);
            }
            if files.answers(&call.resource, &call.operation) {
                return self.account_files_at(files, caller, &call, disclosure, deadline_override);
            }
        }
        // A held value kept by name (secrets.rs `HELD_VALUES_PUT`): the vault's own write, admitted by the sign-in's reach.
        if crate::secrets::resource().is_ok_and(|resource| call.resource == resource) && call.operation == crate::secrets::HELD_VALUES_PUT {
            return self.held_put_at(caller, &call, disclosure, deadline_override);
        }
        // A held value removed by name (secrets.rs `HELD_VALUES_REMOVE`): the vault's own delete, admitted the same way.
        if crate::secrets::resource().is_ok_and(|resource| call.resource == resource) && call.operation == crate::secrets::HELD_VALUES_REMOVE {
            return self.held_remove_at(caller, &call, disclosure, deadline_override);
        }
        // A held key's signature (secrets.rs `HELD_VALUES_SIGN`): reached only by a run whose row declared this key name by a
        // `held-value` right, which its run capability narrowed above. Every other caller is refused, whatever its sign-in reaches.
        if crate::secrets::resource().is_ok_and(|resource| call.resource == resource) && call.operation == crate::secrets::HELD_VALUES_SIGN {
            if run.is_none() {
                return Err(refusal("current_workspace_rights_refused", false));
            }
            return self.held_sign_at(caller, &call, disclosure, deadline_override);
        }
        // Tool rows run on this computer; the address and methods are product DATA (tool-runs.json).
        if let Ok(workshop) = crate::tool_runs::tools::shipped() {
            if workshop.answers(&call.resource, &call.operation) {
                // A run's own call here was narrowed above to the tools its row names in `runs` (tool-runs.json
                // `runs`): the nested run is held to that run's rights, deadline and key.
                if let Some(run) = &run {
                    return self.nested_workshop_at(workshop, caller, &call, run, disclosure, deadline_override);
                }
                let context = crate::tool_runs::tools::task_context::Context::account(caller)
                    .map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?;
                return self.workshop_at(workshop, caller, &call, disclosure, deadline_override, true, context);
            }
        }
        // The person's grants of computer capabilities to tools (product DATA tools/computer/grants.json).
        if let Ok(grants) = crate::tool_runs::tools::computer::shipped() {
            if grants.answers(&call.resource, &call.operation) {
                return self.computer_grants_at(grants, caller, &call, disclosure, deadline_override);
            }
        }
        // A queued put is settled in-process by the writer (settle_command.rs), never through the door, for any caller.
        if crate::secrets::settled_in_process_only(&call.operation) {
            return Err(refusal("current_workspace_rights_refused", false));
        }
        if call.operation != "workspace:read" {
            let limit = disclosure.started_at() + crate::legacy_records::Bounds::default().elapsed;
            let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
            let cancel = disclosure.cancellation_flag();
            // A records command owns its mutable account context. The admission hold ends before writer selection,
            // physical I/O or any current-rights callback; a read holding the primary account cannot delay this write.
            if crate::record_write_model::write_command::Command::is_shipped(&call.operation) {
                let expected_generation = disclosure.accepted_command_generation(
                    &caller.principal.account_id, &call.resource, &call.request_key,
                ).map_err(|error| {
                    let mut answer = refusal_from(&error, "original_command_conflict", false);
                    answer.detail = Some(serde_json::json!({"cause": error.cause().id()}));
                    answer
                })?;
                let cached = self.commands.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
                let mut owner = match cached {
                    Some(owner) => owner,
                    None => {
                        let admission = owner_wait::acquire(&self.admission, || cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline)
                            .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?;
                        admission.command_owner().map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?
                    }
                };
                let mut ids = CanonicalLogIds::shared(&self.ids);
                let operation = call.operation.as_str();
                let original_input = &call.input;
                let within = run.as_ref().map(|run| move |kind: &str| run.reaches_input(operation, kind, original_input));
                let written = owner.door_records_write_at_generation(caller, &call, cancel, deadline, &mut ids,
                    within.as_ref().map(|within| within as &dyn Fn(&str) -> bool), run.as_ref().and_then(|run| run.cause()),
                    &|| run.as_ref().is_none_or(|run| run.current().is_ok()), expected_generation);
                let answer = written.map_err(|error| write_refusal(error, deadline, owner.owner.take_write_refusal()));
                // All request witnesses and transactions ended before reuse; the next request admits itself again.
                let mut kept = self.commands.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if kept.is_none() { *kept = Some(owner); }
                return answer;
            }
            // Workspace writes retain their existing account and output custody through physical disclosure.
            let mut owner = owner_wait::acquire(&self.owner, || cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline)
                .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?;
            let mut ids = CanonicalLogIds::shared(&self.ids);
            let refused = |error| write_refusal(error, deadline, None);
            let (value, prepared) = owner.prepare_door_workspace_write_result(caller, &call, cancel, deadline, &mut ids,
                &|| run.as_ref().is_none_or(|run| run.current().is_ok()))
                .map_err(refused)?;
            prepared.register(disclosure, self.owner.clone()).map_err(|error| refusal_from(error, "original_command_output_unknown", true))?;
            return Ok(value);
        }
        if call.resource != "@own-records"
            || call.request_key.is_empty()
            || call.request_key.encode_utf16().count() > 512
            || crate::local_workspace::selection(&call.input).is_err()
        {
            return Err(refusal("original_input_refused", false));
        }
        let limit = disclosure.started_at() + crate::workspace_store::Limits::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let cancel = disclosure.cancellation_flag();
        let stopped = || cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline;
        let refused = |failure: crate::workspace_store::Failure| {
            use crate::workspace_store::Kind;
            let (code, unknown) = match failure.kind {
                Kind::Invalid(_) => ("original_input_refused", false),
                Kind::Bounds(_) => ("original_read_exceeds_bound", false),
                Kind::Cancelled(_) => ("original_read_cancelled", false),
                Kind::SourceUnavailable(_) => ("original_workspace_source_unavailable", false),
                Kind::SourceChanged(_) => ("current_workspace_rights_refused", false),
                Kind::Schema(_) | Kind::Corrupt(_) => ("original_workspace_read_unavailable", false),
            };
            // A read has no effect: every refusal of it is a known no-effect one.
            OperationFailure { cause: failure.cause(), ..refusal(code, unknown) }
        };
        // The account is held to admit the read and again to admit it after; the read between holds none.
        let admitted = owner_wait::acquire(&self.admission, stopped)
            .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?
            .admit_door_record_selection(caller, &call.input, Some(&call.request_key), cancel.clone(), deadline)
            .map_err(refused)?;
        let snapshot = admitted.read().map_err(refused)?;
        let prepared = owner_wait::acquire(&self.admission, stopped)
            .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?
            .finish_door_record_selection(admitted, snapshot)
            .map_err(refused)?;
        prepared.into_mcp_value(disclosure, self.admission.clone())
    }
}

/// The files step of an account's erasure: each page on the account's files as every account files call opens them.
struct FilesErasure<'a> {
    files: &'a crate::account_files::account_routes::Files,
    account: &'a str,
    state_root: &'a std::path::Path,
}
impl crate::account::erase::Step for FilesErasure<'_> {
    fn page(&mut self, cursor: &str) -> Result<crate::account::erase::Page, crate::account::erase::StepFailure> {
        self.files.erasure_page(self.state_root, self.account, cursor)
    }
}

/// The records step of an account's erasure: each page holds the account for itself alone and erases on its own
/// record store (`OwnRecords::store_mut`), once the account's own records are all moved in.
struct RecordsErasure<'a> {
    owner: &'a Arc<Mutex<SelectedAccount>>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    until: Instant,
}
impl crate::account::erase::Step for RecordsErasure<'_> {
    fn page(&mut self, cursor: &str) -> Result<crate::account::erase::Page, crate::account::erase::StepFailure> {
        use crate::account::{erase::StepFailure, NativeAccountOwner};
        let busy = |words: &str, cause: crate::refusal_cause::Cause| StepFailure { words: words.to_owned(), transient: true, cause };
        let mut selected = owner_wait::acquire(self.owner, || {
            self.cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= self.until
        })
        .map_err(|error| busy("the account is held", error.cause()))?;
        selected.assert_source_current().map_err(|error| busy("the account changed", error.cause()))?;
        let mut held = selected.owner.take_own_records().map_err(|error| busy(&error.to_string(), error.cause()))?;
        // Erased while its old records are still being moved in, they would be moved in again.
        let page = if held.ready() {
            let (store, account) = held.store_mut();
            let account = account.to_owned();
            crate::account::erase::records_page(store, &account, cursor)
        } else {
            Err(busy("the account's own records are still being moved in", crate::cause!(condition: erasure_records_not_migrated)))
        };
        selected.owner.put_own_records(held);
        page
    }
}

/// The account's resolver of run causes (`run_cause::ParentResolver`): a cause name (`SignIn::standing`) acts as that
/// cause through this endpoint, admitted again at every call. Nothing is unsealed.
struct StandingParents {
    door: std::sync::Weak<dyn StandingDoor>,
    account: String,
}

/// The endpoint a kept parent runs through: its sign-in, its own dispatch of one admitted call
/// of a run (`LocalSelectedMcp::invoke_as`), and its loopback address.
trait StandingDoor: Send + Sync {
    fn sign_in(&self) -> &Arc<SignIn>;
    fn dispatch(&self, caller: &Caller, call: Operation, run: crate::account_rights::run_capability::Admitted,
        disclosure: &crate::mcp::RequestDisclosure) -> Result<serde_json::Value, OperationFailure>;
    fn loopback(&self) -> Option<std::net::SocketAddr>;
}

impl StandingDoor for LocalSelectedMcp {
    fn sign_in(&self) -> &Arc<SignIn> {
        &self.sign_in
    }
    fn dispatch(&self, caller: &Caller, call: Operation, run: crate::account_rights::run_capability::Admitted,
        disclosure: &crate::mcp::RequestDisclosure) -> Result<serde_json::Value, OperationFailure> {
        self.invoke_as(caller, call, Some(run), disclosure, None)
    }
    fn loopback(&self) -> Option<std::net::SocketAddr> {
        self.door
    }
}

impl crate::account_rights::run_cause::ParentResolver for StandingParents {
    fn resolve_cause(&self, account: &str, sign_in: &str)
        -> Result<Arc<dyn crate::account_rights::run_capability::ParentAuthority>, crate::account_rights::run_capability::Refusal> {
        use crate::account_rights::run_capability::Refusal;
        if account != self.account || sign_in.is_empty() {
            return Err(crate::cause!(Refusal::NotGranted));
        }
        if self.door.upgrade().is_none() {
            return Err(crate::cause!(Refusal::Unavailable));
        }
        Ok(Arc::new(SignInParent { door: self.door.clone(), name: sign_in.to_owned() }))
    }

    fn door(&self) -> Option<std::net::SocketAddr> {
        self.door.upgrade()?.loopback()
    }
}

/// The owned parent of a run's live cause (`run_capability::ParentAuthority`): its sign-in `name` (an OAuth grant, a
/// personal key or a browser session, `SignIn::standing`), never a token, key or cookie. It signs in while that sign-in
/// stands on this account; each call of a run it started is admitted again as that sign-in for that exact call (its
/// scopes must reach it) and runs through this endpoint's own dispatch, with the run's narrowing and its lifetime.
struct SignInParent {
    door: std::sync::Weak<dyn StandingDoor>,
    name: String,
}

/// A run of a currently presented credential. This owner reauthenticates the
/// original credential itself; expiry or withdrawal stops it. Bytes stay zeroized in memory, never in a journal,
/// tool row or file-input manifest. The account routes remain the sole source of the exact operation's rights.
struct CredentialParent {
    door: std::sync::Weak<dyn StandingDoor>,
    bearer: zeroize::Zeroizing<Vec<u8>>,
}

impl crate::account_rights::run_capability::ParentAuthority for CredentialParent {
    fn recovery_source(&self) -> Result<serde_json::Value, crate::account_rights::run_capability::Refusal> {
        use crate::account_rights::run_capability::Refusal;
        let here = self.door.upgrade().ok_or(crate::cause!(Refusal::Unavailable))?;
        here.sign_in().recovery_source_for_credential(&self.bearer).map_err(|why| match why {
            account_routes::Refusal::Unavailable(cause) => Refusal::Unavailable(cause),
            other => Refusal::NotGranted(other.cause()),
        })
    }

    fn authenticate(&self) -> Result<Principal, crate::mcp::http::AuthenticationFailure> {
        let here = self.door.upgrade().ok_or(crate::cause!(crate::mcp::http::AuthenticationFailure::Unavailable))?;
        here.sign_in().authenticate(&self.bearer)
    }

    fn checker_for(&self, principal: &Principal, call: &Operation)
        -> Result<Arc<dyn Fn() -> bool + Send + Sync>, crate::account_rights::run_capability::Refusal> {
        use crate::account_rights::run_capability::Refusal;
        let here = self.door.upgrade().ok_or(crate::cause!(Refusal::Unavailable))?;
        let caller = here.sign_in().caller(&self.bearer, principal, call).map_err(|error| crate::carry_cause!(Refusal::NotGranted, error))?;
        if !caller.stands() { return Err(crate::cause!(Refusal::NotGranted)) }
        Ok(caller.current)
    }

    fn invoke(&self, principal: &Principal, call: Operation, run: &crate::account_rights::run_capability::Admitted,
        disclosure: &crate::mcp::RequestDisclosure) -> Result<serde_json::Value, OperationFailure> {
        let here = self.door.upgrade().ok_or_else(|| refusal("current_workspace_rights_refused", false))?;
        let caller = here.sign_in().caller(&self.bearer, principal, &call).map_err(account_routes::Refusal::failure)?
            .also(run.current_checker());
        here.dispatch(&caller, call, run.duplicate(), disclosure)
    }
}

impl crate::account_rights::run_capability::ParentAuthority for SignInParent {
    fn recovery_source(&self) -> Result<serde_json::Value, crate::account_rights::run_capability::Refusal> {
        use crate::account_rights::run_capability::Refusal;
        let here = self.door.upgrade().ok_or(crate::cause!(Refusal::Unavailable))?;
        here.sign_in().recovery_source_for_standing(&self.name).map_err(|why| match why {
            account_routes::Refusal::Unavailable(cause) => Refusal::Unavailable(cause),
            other => Refusal::NotGranted(other.cause()),
        })
    }

    fn authenticate(&self) -> Result<Principal, crate::mcp::http::AuthenticationFailure> {
        use crate::mcp::http::AuthenticationFailure;
        let here = self.door.upgrade().ok_or(crate::cause!(AuthenticationFailure::Unavailable))?;
        match here.sign_in().standing(&self.name) {
            Ok(Some(found)) => {
                let principal = here.sign_in().mcp_principal(&found);
                if principal.valid() { Ok(principal) } else { Err(crate::cause!(AuthenticationFailure::Unauthorized)) }
            }
            Ok(None) => Err(crate::cause!(AuthenticationFailure::Unauthorized)),
            Err(_) => Err(crate::cause!(AuthenticationFailure::Unavailable)),
        }
    }

    fn checker_for(&self, principal: &Principal, call: &Operation)
        -> Result<Arc<dyn Fn() -> bool + Send + Sync>, crate::account_rights::run_capability::Refusal> {
        use crate::account_rights::run_capability::Refusal;
        let here = self.door.upgrade().ok_or(crate::cause!(Refusal::Unavailable))?;
        let caller = here.sign_in().standing_caller(&self.name, principal, call).map_err(|error| crate::carry_cause!(Refusal::NotGranted, error))?;
        if !caller.stands() { return Err(crate::cause!(Refusal::NotGranted)) }
        Ok(caller.current)
    }

    fn invoke(&self, principal: &Principal, call: Operation, run: &crate::account_rights::run_capability::Admitted,
        disclosure: &crate::mcp::RequestDisclosure) -> Result<serde_json::Value, OperationFailure> {
        let here = self.door.upgrade().ok_or_else(|| refusal("current_workspace_rights_refused", false))?;
        let caller = here.sign_in().standing_caller(&self.name, principal, &call).map_err(account_routes::Refusal::failure)?
            .also(run.current_checker());
        here.dispatch(&caller, call, run.duplicate(), disclosure)
    }
}

impl CallAnswerer for LocalSelectedMcp {
    fn instruction_text_with_disclosure(&self, principal: &Principal, bearer: &[u8], part: crate::mcp::instructions::MetadataPart,
        disclosure: &crate::mcp::RequestDisclosure) -> Option<String> {
        let call = crate::mcp::instructions::metadata_call(part)?;
        self.instructions_at(principal, bearer, &call, disclosure, Arc::new(|| true), None)?.ok()?.as_str().map(str::to_owned)
    }

    fn invoke(
        &self,
        _principal: &Principal,
        _call: Operation,
    ) -> Result<serde_json::Value, OperationFailure> {
        Err(refusal("request_key_credential_required", false))
    }
    fn invoke_with_bearer(&self, _principal: &Principal, _bearer: &[u8], _call: Operation) -> Result<serde_json::Value, OperationFailure> {
        // Physical result custody belongs to the authenticated request. A
        // Value-only caller cannot execute work then discard that boundary.
        Err(refusal("request_disclosure_required", false))
    }

    fn invoke_with_disclosure(&self, principal: &Principal, bearer: &[u8], call: Operation,
        disclosure: &crate::mcp::RequestDisclosure) -> Result<serde_json::Value, OperationFailure> {
        self.invoke_at(principal, bearer, call, disclosure, Arc::new(|| true), None)
    }

    fn view_matches(&self, rules: &serde_json::Value, fields: &[serde_json::Value], rows: &[&serde_json::Value]) -> Option<Vec<bool>> {
        self.view_matches_rows(rules, fields, rows)
    }

    fn public_share(&self, origin: &str, code: &str) -> Result<Option<serde_json::Value>, OperationFailure> {
        let grants = crate::account_rights::share_grant::Grants::shipped()
            .map_err(|error| refusal_from(error, "current_source_unavailable", false))?;
        // A key-free reach share first (a person's code opens it as a link does), else a public link to one record.
        let reach_deadline = Instant::now() + grants.reach_seconds();
        if let Some(collection) = self.public_collection(grants, code, reach_deadline)? {
            return Ok(collection);
        }
        let deadline = Instant::now() + crate::workspace_store::Limits::default().elapsed;
        let mut selected = owner_wait::acquire(&self.admission, || Instant::now() >= deadline)
            .map_err(|error| refusal_from(error, "selected_owner_unavailable", false))?;
        selected.public_share(grants, code.as_bytes(), Arc::new(std::sync::atomic::AtomicBool::new(false)), deadline)
            .map(|answer| answer.map(|record| grants.public_answer(&record, &format!("{origin}/share/{code}"))))
    }
}

/// The account routes' bearer check: a share bearer, a tool run's capability (authenticated as the credential that started
/// the run) or a credential the account's own sign-in admits.
pub(crate) fn authenticator(sign_in: Arc<SignIn>, account: String) -> Arc<dyn crate::mcp::http::BearerAuthenticator> {
    Arc::new(crate::account_rights::share_grant::Authenticator::new(
        crate::account_rights::run_capability::Authenticator::new(account_routes::Authenticator(sign_in)),
        account,
    ))
}

/// The door's word on the person present, written into `call`: the person present is Better Auth's fresh session, the
/// caller's own pass issued within its fresh age (`fresh`: false for a run's capability, a key or an older pass). What the
/// request itself says is never read: an operation that reads the person present from its input (a computer grant applied
/// or removed) reads the door's word too, since whatever the input carried there is replaced or removed.
fn person_present_word(call: &mut Operation, fresh: bool) {
    call.person_present = fresh.then(|| serde_json::json!({"fresh_pass": true}));
    if let Some(input) = call.input.as_object_mut() {
        if input.contains_key(crate::account::person_present::REQUEST_FIELD) {
            match &call.person_present {
                Some(word) => { input.insert(crate::account::person_present::REQUEST_FIELD.to_owned(), word.clone()); }
                None => { input.remove(crate::account::person_present::REQUEST_FIELD); }
            }
        }
    }
}

#[cfg(test)]
mod person_present_word_tests {
    use super::*;

    fn asked(input: serde_json::Value) -> Operation {
        Operation { person_present: Some(serde_json::json!({"fresh_pass": true})), resource: "@computer-grants".into(),
            operation: "grants:grant".into(), request_key: "k".into(), input }
    }

    #[test]
    fn a_fresh_pass_is_the_person_present_and_replaces_what_the_request_said() {
        let mut call = asked(serde_json::json!({"offer": "o", "person_present": {"passkey": "forged"}}));
        person_present_word(&mut call, true);
        assert_eq!(call.person_present, Some(serde_json::json!({"fresh_pass": true})));
        assert_eq!(call.input["person_present"], serde_json::json!({"fresh_pass": true}));
    }

    #[test]
    fn a_stale_pass_a_key_or_a_run_is_never_the_person_present_whatever_the_request_says() {
        let mut call = asked(serde_json::json!({"offer": "o", "person_present": {"fresh_pass": true}}));
        person_present_word(&mut call, false);
        assert_eq!(call.person_present, None, "a word the request carried is dropped");
        assert!(call.input.get("person_present").is_none(), "and removed from the input the operation reads");
        assert_eq!(call.input["offer"], "o");
    }
}

/// The MCP endpoint on one owner of the account, which also admits its reads.
#[cfg(test)]
pub(crate) fn route_table(owner: Arc<Mutex<SelectedAccount>>, expected_host: String) -> Result<axum::Router, crate::refusal_cause::CodedError<&'static str>> {
    let sign_in = owner.lock().map_err(|_| crate::refusal_cause::CodedError::new("selected account unavailable"))?.sign_in()
        .map_err(|error| crate::refusal_cause::CodedError::with_cause("the account's sign-in is not open", error.cause()))?.clone();
    route_table_with_admission(owner.clone(), owner, sign_in, expected_host)
}

/// The endpoint on the account's own owner, with records reads admitted on `admission`, an owner of the same account that
/// holds no writer (`SelectedAccount::admission_owner`), and every credential admitted by `sign_in`.
#[cfg(test)]
pub(crate) fn route_table_with_admission(
    owner: Arc<Mutex<SelectedAccount>>,
    admission: Arc<Mutex<SelectedAccount>>,
    sign_in: Arc<SignIn>,
    expected_host: String,
) -> Result<axum::Router, crate::refusal_cause::CodedError<&'static str>> {
    // The hosting app's account routes are served on its loopback address itself, so its host is also where a run calls back.
    let loopback = expected_host.parse::<std::net::SocketAddr>().ok().filter(|door| door.ip().is_loopback());
    route_table_reached_at(owner, admission, sign_in, expected_host, loopback)
}

/// `route_table_with_admission`, with the loopback address a tool run started at these routes calls back on
/// (`loopback`) given apart from the routes' own host. A computer serves the routes at its public host and reaches it on
/// loopback at a listener of its own (src/native_entry/computer.rs `LoopbackDoor`); the hosting app's routes are both.
/// With no loopback address, a run that declares records is refused (`workshop_tool_not_runnable_here`): measured at
/// place-fsn1 on 2026-11-04, every records tool run at a computer answered that until a computer gave its routes one.
pub(crate) fn route_table_reached_at(
    owner: Arc<Mutex<SelectedAccount>>,
    admission: Arc<Mutex<SelectedAccount>>,
    sign_in: Arc<SignIn>,
    expected_host: String,
    loopback: Option<std::net::SocketAddr>,
) -> Result<axum::Router, crate::refusal_cause::CodedError<&'static str>> {
    // A tool run started at these routes calls back into it on loopback with its run capability; someone this
    // account shared a record with calls with their share bearer (`account_rights::share_grant`).
    let account = {
        use crate::account::NativeAccountOwner;
        let mut held = owner.lock().map_err(|_| crate::refusal_cause::CodedError::new("selected account unavailable"))?;
        held.set_sign_in(sign_in.clone());
        held.account().owner_id
    };
    // A tool run that names one of the person's connections reads its fields where the connection's own row says they
    // are held (`tool_runs::tools::connection_names`).
    crate::tool_runs::tools::connection_names::install(&account, Arc::new(crate::tool_runs::tools::connection_names::OwnerRows { owner: Arc::downgrade(&admission) }));
    admission.lock().map_err(|_| crate::refusal_cause::CodedError::new("selected account unavailable"))?.set_sign_in(sign_in.clone());
    let auth = authenticator(sign_in, account.clone());
    let door = loopback.filter(|door| door.ip().is_loopback());
    let operations = LocalSelectedMcp::at(owner, admission, door, &account)?;
    // The account's own routes keep the whole account files' permits and answer the old byte routes.
    Ok(axum_adapter::route_table(Service::new(
        expected_host,
        auth,
        operations,
    )?.with_permits()))
}

impl SelectedAccount {
    /// The account's own record labelled `label` (its grant rules), or None when it keeps none, read in one projection
    /// inside the same current-selection check as every personal read.
    pub(super) fn grant_policy(&mut self, label: &str, cancel: Arc<std::sync::atomic::AtomicBool>, deadline: Instant,
    ) -> Result<Option<serde_json::Value>, OperationFailure> {
        use crate::workspace_store::Selection;
        let mut records = self.records_under(Selection { labels: vec![label.to_owned()], prefixes: Vec::new() }, cancel, deadline)?;
        Ok(records.remove(label))
    }

    /// The account's sharing records now (every label under the grants' record prefix, label to value), read in one
    /// projection inside the same current-selection check as every personal read.
    pub(super) fn sharing_records(&mut self, grants: &crate::account_rights::share_grant::Grants,
        cancel: Arc<std::sync::atomic::AtomicBool>, deadline: Instant,
    ) -> Result<std::collections::BTreeMap<String, serde_json::Value>, OperationFailure> {
        use crate::workspace_store::Selection;
        self.records_under(Selection { labels: Vec::new(), prefixes: vec![grants.record_prefix().to_owned()] }, cancel, deadline)
    }

    /// The records `wanted` selects, label to value, in one projection inside the same current-selection check as every
    /// personal read.
    fn records_under(&mut self, wanted: crate::workspace_store::Selection, cancel: Arc<std::sync::atomic::AtomicBool>,
        deadline: Instant,
    ) -> Result<std::collections::BTreeMap<String, serde_json::Value>, OperationFailure> {
        use crate::account::AccountError;
        let selection = &self.selection;
        let mut current = |_: &mut crate::local_account::LocalAccount| {
            selection.assert_current().map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))
        };
        let (held, _) = self.owner
            .prepare_personal_record_projection(&mut current, Some(&wanted), None, cancel, deadline)
            .map_err(|error| refusal_from(error, "original_workspace_source_unavailable", false))?;
        Ok(held.records.iter()
            .filter_map(|(label, value)| {
                let text = crate::ecma_json::stringify(value, Default::default()).ok()?;
                Some((label.clone(), serde_json::from_str(&text).ok()?))
            })
            .collect())
    }

    /// The record of the public link `code` opens now (`share_grant::Grants::public_link`), or None when no open public link
    /// holds the code; `Grants::public_answer` shapes it.
    pub(super) fn public_share(&mut self, grants: &crate::account_rights::share_grant::Grants, code: &[u8],
        cancel: Arc<std::sync::atomic::AtomicBool>, deadline: Instant,
    ) -> Result<Option<serde_json::Value>, OperationFailure> {
        use crate::workspace_store::Selection;
        let sharing = self.sharing_records(grants, cancel.clone(), deadline)?;
        let Some(shared) = grants.public_link(&sharing, code) else {
            return Ok(None);
        };
        let records = self.records_under(Selection { labels: vec![shared.clone()], prefixes: Vec::new() }, cancel, deadline)?;
        Ok(records.get(&shared).cloned())
    }

    /// The records a share bearer may read now, in one hold of this account: the account's grants (the labels under
    /// the grants' record prefix), the labels the call asks narrowed against what they give this bearer, then those
    /// labels only. Both projections run inside the same current-selection check as every personal read.
    fn shared_read(&mut self, grants: &crate::account_rights::share_grant::Grants, bearer: &[u8], call: &Operation,
        cancel: Arc<std::sync::atomic::AtomicBool>, deadline: Instant,
    ) -> Result<crate::workspace_store::Snapshot, OperationFailure> {
        use crate::{account::AccountError, workspace_store::Selection};
        let sharing = self.sharing_records(grants, cancel.clone(), deadline)?;
        let labels = grants
            .narrow(&grants.reached(&sharing, bearer), &call.resource, &call.operation, &call.input)
            .map_err(|error| refusal_from(error, "current_workspace_rights_refused", false))?;
        let selection = &self.selection;
        let mut current = |_: &mut crate::local_account::LocalAccount| {
            selection.assert_current().map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))
        };
        let (snapshot, _) = self.owner
            .prepare_personal_record_projection(&mut current, Some(&Selection { labels, prefixes: Vec::new() }), None, cancel, deadline)
            .map_err(|error| refusal_from(error, "original_workspace_source_unavailable", false))?;
        Ok(snapshot)
    }
}

#[cfg(test)]
mod refusal_tests {
    use super::*;
    use crate::account::AccountError;
    use crate::local_account::record_writer::Error;

    #[test]
    fn a_write_refusal_names_its_cause_instead_of_one_source_code() {
        let later = Instant::now() + Duration::from_secs(60);
        let code = |error| write_refusal(error, later, None).code;
        assert_eq!(code(crate::cause!(Error::NotMigrated)), "own_records_not_migrated");
        assert_eq!(code(crate::cause!(Error::Source)), "original_workspace_source_unavailable");
        assert_eq!(code(crate::cause!(Error::Invalid)), "original_input_refused");
        // Past the call's own deadline the database interrupt that ended the write is a timeout, and the write is
        // certainly undone (its transaction rolled back before any commit).
        let passed = Instant::now() - Duration::from_secs(1);
        let timed_out = write_refusal(crate::cause!(Error::Source), passed, None);
        assert_eq!((timed_out.code.as_str(), timed_out.outcome_unknown), ("write_deadline_exceeded", false));
        // A commit the supply could not confirm stays an outcome unknown, past the deadline too.
        assert_eq!(write_refusal(crate::cause!(Error::OutcomeUnknown), passed, None).code, "original_command_outcome_unknown");
    }

    #[test]
    fn every_account_error_has_its_own_safe_reason_where_its_cause_differs() {
        let code = |error| personal_refusal(error).code;
        let all = [
            (crate::cause!(AccountError::InvalidInput), "original_input_refused"),
            (crate::cause!(AccountError::SourceUnavailable), "original_workspace_source_unavailable"),
            (crate::cause!(AccountError::SourceChanged), "current_workspace_rights_refused"),
            (crate::cause!(AccountError::BrowserInactive), "browser_sign_in_inactive"),
            (crate::cause!(AccountError::RightsRefused), "current_workspace_rights_refused"),
            (crate::cause!(AccountError::RightsChanging), "current_workspace_rights_refused"),
            (crate::cause!(AccountError::KeyWithdrawn), "current_workspace_rights_refused"),
            (crate::cause!(AccountError::OriginalBindingUnavailable), "mac_issuer_binding_unavailable"),
            (crate::cause!(AccountError::RecoveryPending), "owner_recovery_pending"),
            (crate::cause!(AccountError::AlreadyIssued), "credential_reveal_window_ended"),
            (crate::cause!(AccountError::RootUnavailable), "native_key_root_unavailable"),
            (crate::cause!(AccountError::DeviceOnly), "kind_stays_on_this_computer"),
            (crate::cause!(AccountError::WholeKind), "list_filter_reads_whole_kind"),
            (crate::cause!(AccountError::UseNoteRequired), "current_workspace_rights_refused"),
        ];
        for (error, expected) in all {
            assert_eq!(code(error), expected);
        }
    }
}

/// Kept parents, from the switch's keep to a run's call, over a real signed-in token, the account's resolver, run
/// capability and the routes' bearer check; the endpoint's own dispatch is a stand-in that answers who it ran the call as.
#[cfg(test)]
mod standing_tests {
    use super::*;
    use crate::account::{account_routes::in_memory, signed_in::test_token};
    use crate::account_rights::{run_capability::{held, issue_from_authority, Admitted, ParentKey},
        run_cause::{register_resolver, resolve_cause, ParentResolver}};
    use crate::mcp::http::AuthenticationFailure;
    use serde_json::{json, Value};

    /// An account no other test registers a resolver for.
    /// The owner id, in the shape addresses take (64 lowercase hex).
    const ACCOUNT: &str = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";

    struct Door(Arc<SignIn>);
    impl StandingDoor for Door {
        fn sign_in(&self) -> &Arc<SignIn> {
            &self.0
        }
        fn dispatch(&self, caller: &Caller, call: Operation, run: Admitted, _: &crate::mcp::RequestDisclosure)
            -> Result<Value, OperationFailure> {
            Ok(json!({"as": caller.principal.sign_in, "stands": caller.stands(),
                "current": run.current().is_ok(), "operation": call.operation, "input": call.input}))
        }
        fn loopback(&self) -> Option<std::net::SocketAddr> {
            "127.0.0.1:28799".parse().ok()
        }
    }

    fn file_read(identity: &str) -> Operation {
        Operation { person_present: None, resource: crate::account_files::account_routes::AccountFilesDoor::shipped().unwrap().resource().into(),
            operation: "read_file".into(), request_key: "synthetic-file-read".into(), input: json!({"name_or_identity": identity}) }
    }

    #[test]
    fn a_presented_tokens_file_checks_reauthorize_the_token_and_the_exact_file() {
        let sign_in = in_memory("person", ACCOUNT);
        let token = test_token(ACCOUNT);
        let door: Arc<dyn StandingDoor> = Arc::new(Door(sign_in.clone()));
        let authority = Arc::new(CredentialParent { door: Arc::downgrade(&door), bearer: zeroize::Zeroizing::new(token.as_bytes().to_vec()) });
        let identity = content_crypto::Multihash::blake3(b"synthetic private input").to_code_hex();
        let records = json!({"fd": 3, "rights": [{"files": "/", "id": identity, "operations": ["read_file"]}]});
        let parent = ParentKey { address: "synthetic-address", account: ACCOUNT, bearer: token.as_bytes(), door: "127.0.0.1:28799".parse().unwrap(), cause: None };
        let issued = issue_from_authority(&parent, &records, None, Duration::from_secs(60), authority).unwrap();
        let run = held(issued.capability.token().as_bytes()).unwrap().unwrap();
        let principal = run.authenticate_parent().unwrap().unwrap();
        assert!(principal.sign_in.starts_with("jwt:"));
        let check = run.checker_for(&principal, &file_read(&identity)).unwrap();
        assert!(check());
        let sibling = content_crypto::Multihash::blake3(b"sibling input").to_code_hex();
        assert_ne!(run.checker_for(&principal, &file_read(&sibling)).map(|check| check()), Ok(true));
        let mut wrong_account = principal.clone(); wrong_account.account_id = "another-account".into();
        assert_ne!(run.checker_for(&wrong_account, &file_read(&identity)).map(|check| check()), Ok(true));
    }

    #[test]
    fn a_cause_resolves_by_its_party_name_while_it_stands_and_a_sign_in_name_or_token_resolves_to_nothing() {
        let sign_in = in_memory("person", ACCOUNT);
        let door: Arc<dyn StandingDoor> = Arc::new(Door(sign_in.clone()));
        let resolver = StandingParents { door: Arc::downgrade(&door), account: ACCOUNT.into() };
        let token = test_token(ACCOUNT);
        // What a switch keeps: the caller's party, never the token.
        let switch = Operation { person_present: None, resource: "@workshop-tools".into(), operation: "tools:run".into(),
            request_key: "p".into(), input: json!({}) };
        let principal = sign_in.authenticate(token.as_bytes()).unwrap();
        let caller = sign_in.caller(token.as_bytes(), &principal, &switch).unwrap();
        let party = sign_in.party_of(&caller).expect("a signed-in caller writes as its party");
        assert!(!party.contains(&token), "the token is never kept");
        assert_eq!(sign_in.authenticate(party.as_bytes()), Err(crate::cause!(AuthenticationFailure::Unauthorized)), "the name is no bearer");
        let parent = resolver.resolve_cause(ACCOUNT, &party).expect("the account's own party resolves");
        let acting = parent.authenticate().expect("the party stands");
        assert_eq!((acting.account_id.as_str(), acting.sign_in.as_str()), (ACCOUNT, party.as_str()));
        assert!(parent.checker_for(&acting, &switch).is_ok_and(|check| check()), "each call is admitted again as the party");
        assert!(resolver.resolve_cause("another-owner", &party).is_err(), "another account's resolver");
        let other = resolver.resolve_cause(ACCOUNT, "party:another").expect("a name resolves to a parent that asks");
        assert!(other.authenticate().is_err(), "another party stands nowhere here");
        assert!(resolver.resolve_cause(ACCOUNT, &principal.sign_in).unwrap().authenticate().is_err(), "a sign-in name is no cause");
        let _registration = register_resolver(ACCOUNT, Arc::new(StandingParents { door: Arc::downgrade(&door), account: ACCOUNT.into() })).unwrap();
        assert!(resolve_cause(ACCOUNT, &party).is_ok(), "the registered resolver answers the account's runs");
        drop(door);
        assert!(resolver.resolve_cause(ACCOUNT, &party).is_err(), "a door that is gone resolves nothing");
    }
}
