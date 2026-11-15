// src/native_entry.rs
//
// Purpose: Compose the native executable around the selected existing account.
// Non-Negotiable Invariants: never enter Store::open, initialize a new account,
// substitute the legacy backend or start a cloud service from native startup.
// Key Concepts: independently selected account, existing state lock,
// supplied protected root, retained frontend and private parent pipes.
// Security Considerations: stdout belongs solely to signed private replies;
// unavailable domain/session/live producers refuse rather than return fake data.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod live;
pub mod computer;
pub mod home;
pub(crate) mod parent_kept;
mod preparation_gate;
mod computer_key_lock;

use crate::{
    account::{
        AccountIdentity, AccountResult, NativeAccountOwner,
        SecretNativeKey,
    },
    local_account::{LocalAccount, SelectedLocalState},
    local_workspace::LocalWorkspace,
    native::{self, Launch, PrivateInput, PrivateOutput},
    native_boot::{SelectedAccount, Selection},
    native_host::AccountMount,
    workspace::{WorkspaceLimits, WorkspaceSupplies},
    workspace_domain::{CanonicalWorkspace, OwnerRoutes, StartupContract},
    workspace_page::WorkspacePageProducer,
    workspace_session::{WorkspaceSessionSettings, WorkspaceSessions},
    workspace_stream::StreamLimits,
};
use std::{
    io,
    net::{SocketAddr, TcpListener},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

/// The stop the engine's computer (computer/hosting.rs) runs under: set once the app's host lifetime ended, and every
/// writer turn it holds is handed over then.
static HOSTING_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Fixed startup stages emitted to the app's bounded stderr decoder. Keep
/// private error details inside trillion-local; the installed app needs
/// to know where startup stopped, not the source path or account values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupStage {
    Selection,
    ProductData,
    LaunchChannel,
    FrontendData,
    AccountOpen,
    AccountComposition,
    WorkspaceComposition,
    Listener,
}
impl StartupStage {
    fn word(self) -> &'static str {
        match self {
            Self::Selection => "selection",
            Self::ProductData => "product-data",
            Self::LaunchChannel => "launch-channel",
            Self::FrontendData => "frontend-data",
            Self::AccountOpen => "account-open",
            Self::AccountComposition => "account-composition",
            Self::WorkspaceComposition => "workspace-composition",
            Self::Listener => "listener",
        }
    }
}

struct StartupFailure {
    stage: StartupStage,
    /// Which check inside the stage refused, when the stage has more than one: a fixed word, never a value.
    step: Option<&'static str>,
    source: Box<dyn std::error::Error>,
    cause: crate::refusal_cause::Cause,
}
impl std::fmt::Debug for StartupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartupFailure").field("stage", &self.stage).field("step", &self.step).field("cause", &self.cause).finish()
    }
}
crate::impl_caused!(StartupFailure);
impl StartupFailure {
    fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.cause }
}
impl std::fmt::Display for StartupFailure {
    // `stage=<stage>` or `stage=<stage>:<step>`: one word either way, so a reader that keeps the stage as one word
    // keeps the step with it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "native-startup-error stage={}", self.stage.word())?;
        match self.step {
            Some(step) => write!(f, ":{step}")?,
            None => (),
        }
        write!(f, " cause={}", self.cause)
    }
}
impl std::error::Error for StartupFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.cause_ref())
    }
}
#[track_caller]
fn startup<T, E: Into<Box<dyn std::error::Error>> + crate::refusal_cause::Caused>(
    stage: StartupStage,
    result: Result<T, E>,
) -> Result<T, StartupFailure> {
    match result {
        Ok(value) => Ok(value),
        Err(source) => {
            let cause = crate::refusal_cause::Caused::cause(&source);
            Err(StartupFailure { stage, step: None, source: source.into(), cause })
        }
    }
}
/// Which binding check of the launch message refused: its owner process (the app's own child is the server, so
/// `owner_pid` must be this process), or its state and origin against this selection.
fn launch_binding_step(error: &crate::native::Error) -> &'static str {
    match error {
        crate::native::Error::ForeignProcess(_) => "owner-pid",
        _ => "state-or-origin",
    }
}
/// `startup` for one named check of a stage with several.
#[track_caller]
fn startup_step<T, E: Into<Box<dyn std::error::Error>> + crate::refusal_cause::Caused>(
    stage: StartupStage,
    step: &'static str,
    result: Result<T, E>,
) -> Result<T, StartupFailure> {
    match result {
        Ok(value) => Ok(value),
        Err(source) => {
            let cause = crate::refusal_cause::Caused::cause(&source);
            Err(StartupFailure { stage, step: Some(step), source: source.into(), cause })
        }
    }
}

/// The private native connection and HTTP session adapter borrow the same selected
/// account. Only immutable selected identity/DATA are copied; each actual read
/// borrows the current owner with a finite contention wait, without a second
/// account authority or an async guard across unrelated work.
struct SharedNativeAccount {
    owner: Arc<Mutex<SelectedAccount>>,
    account: AccountIdentity,
}
impl SharedNativeAccount {
    fn read<T>(
        &self,
        operation: impl FnOnce(&mut SelectedAccount) -> AccountResult<T>,
    ) -> AccountResult<T> {
        let mut owner = crate::workspace_session::owner_wait::acquire(&self.owner, || false)
            .map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceUnavailable, error))?;
        operation(&mut owner)
    }
}
impl NativeAccountOwner for SharedNativeAccount {
    fn resource_connection_key(
        &mut self,
        session: &str,
        key: &SecretNativeKey,
    ) -> AccountResult<Option<crate::account::SecretResourceKey>> {
        self.read(|owner| owner.resource_connection_key(session, key))
    }

    fn account(&self) -> AccountIdentity {
        self.account.clone()
    }
    fn now_ms(&mut self) -> AccountResult<u64> {
        self.read(NativeAccountOwner::now_ms)
    }
    fn assert_source_current(&mut self) -> AccountResult<()> {
        self.read(NativeAccountOwner::assert_source_current)
    }
}


/// The account's routes, composed the same way for the hosting app and for a computer (`native_boot::Chosen` chose the
/// account either way): MCP on `owner` with reads admitted on `admission` and every credential admitted by `sign_in`
/// (the Better Auth JWT, `account::signed_in`), at `mcp_host`, which a tool run started at these routes calls back on at
/// `loopback` (the hosting app's own loopback address; a computer's own loopback listener for the account); and where
/// the account has a public `origin`, the account's resource-connection routes, which its outbound connection and the
/// forwarder reach at the same origin. Sign-in pages are the Better Auth Workshop tool's, never these routes. No browser
/// build is read.
pub(crate) fn door(
    owner: Arc<Mutex<SelectedAccount>>,
    admission: Arc<Mutex<SelectedAccount>>,
    sign_in: Arc<crate::account::account_routes::SignIn>,
    mcp_host: String,
    loopback: Option<std::net::SocketAddr>,
    origin: Option<&str>,
) -> Result<axum::Router, crate::refusal_cause::CodedError<&'static str>> {
    let mcp = crate::native_boot::mcp_local::route_table_reached_at(owner.clone(), admission, sign_in.clone(), mcp_host, loopback).map_err(crate::refusal_cause::CodedError::from)?;
    // The selected account answers at its own address too (`/a/<address>/mcp`, the path a run's descriptor names), whether or
    // not its sign-in names a base: the app's sign-in has none, so its address is the base. A request for another address
    // never reaches this route.
    let base = match sign_in.base() {
        "" => format!("/a/{}", sign_in.address()),
        base => base.to_owned(),
    };
    let mcp = axum::Router::new().nest(&base, mcp.clone()).merge(mcp);
    Ok(match origin {
        Some(_) => {
            let slots = Arc::new(crate::native_boot::mcp_credential::SelectedCredentialAdmission::new(owner));
            mcp.merge(crate::account::devices::routes(slots, std::sync::Arc::new(crate::storage::time_source::RealClock)))
        }
        None => mcp,
    })
}

/// Production native invocation from the descriptor the app names: its state folder and loopback port select.
pub fn run_at(descriptor: &Path) -> Result<(), Box<dyn std::error::Error>> {
    // Every line this program writes on its standard error is also kept beside its descriptor, from the first one, so a start
    // that never becomes ready says why to whoever reads the file (on 2026-11-14 a start sat at "account preparing" for 20
    // minutes and its reason reached only the app's pipe).
    if let Some(folder) = descriptor.parent() { keep_error_lines(&folder.join(ERROR_LINES_FILE)); }
    // The selection stage names which of its checks refused (native_boot::Refused: one fixed word, never a path or value).
    let selection = Selection::installed_at_checked(descriptor)
        .map_err(|refused| StartupFailure { stage: StartupStage::Selection, step: Some(refused.step()), cause: refused.cause(), source: Box::new(refused) })?;
    let address = selection.address();
    follow_app_releases(&selection.selected.receipt.blake3);
    run_selected(selection, address)
}

/// The app's variables naming the trillion-local release feed this program follows (trillion-apps
/// macos/Shared/LocalRuntimeReadiness.swift `NativeEngineLaunch.Following`): the app's carried release settings and the
/// person's releases folder.
pub const APP_RELEASE_FEED: &str = "TRILLION_RELEASE_FEED";
pub const APP_RELEASES: &str = "TRILLION_RELEASES";

/// The app's process follower (releases.rs `Follower`): one thread that looks at the release feed the app names (its
/// engine watch) and at every hosted account's Workshop (`app_follower().add`). Set once at start (`follow_app_releases`).
static APP_FOLLOWER: std::sync::OnceLock<Arc<computer::releases::Follower>> = std::sync::OnceLock::new();

/// The process follower the app's hosted accounts' Workshop watches are added to (`follow_app_releases` set it).
pub fn app_follower() -> Option<Arc<computer::releases::Follower>> {
    APP_FOLLOWER.get().cloned()
}

/// Start the app's one follow thread (releases.rs `Follower::follow`): the release feed the app names (`APP_RELEASE_FEED`,
/// `APP_RELEASES`) is its engine watch, if it names one that checks; the hosted accounts' Workshops join it as they start.
/// A switch ends the process (after the writer turns it holds are handed over): the app starts `current` on the next launch.
fn follow_app_releases(computer: &str) {
    use computer::releases;
    let follower = Arc::new(releases::Follower::empty(computer.to_owned(), Arc::new(releases::Logged::default()), Duration::from_millis(200)));
    let _ = APP_FOLLOWER.set(follower.clone());
    static STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let _ = std::thread::Builder::new().name("native-release-follower".into()).spawn(move || {
        let Some(commit) = follower.follow(&STOP) else { return };
        if let Some(hand_over) = SWITCH_HAND_OVER.get() {
            hand_over();
        }
        crate::quiet_eprintln!("computer-release event=restarting commit={commit}");
        std::process::exit(0);
    });
}

/// What a switched release does before this process ends: the hosting computer hands its writer turns over, as a stop does.
/// Set once the computer is composed; a switch before that ends the process with no turn to hand over.
static SWITCH_HAND_OVER: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>> = std::sync::OnceLock::new();

fn open_selected_account(
    selection: &Selection,
) -> Result<LocalAccount, StartupFailure> {
    startup(StartupStage::AccountOpen, selection.assert_current())?;
    let selected = SelectedLocalState {
        root: selection.selected.root.clone(),
        receipt: selection.selected.receipt.clone(),
        app_kv_sqlite: selection.selected.app_kv_sqlite.clone(),
        app_kv_store: selection.selected.app_kv_store.clone(),
        prior_processes: selection.selected.prior_processes.clone(),
    };
    startup(StartupStage::AccountOpen, selection.write_starting_rows())?;
    let owner = startup(StartupStage::AccountOpen, LocalAccount::open_selected_after_handoff(selected))?;
    startup(StartupStage::AccountOpen, selection.assert_current())?;
    Ok(owner)
}

/// Library composition seam for an independently prepared existing selection.
/// Constructing selection, loading program bytes or binding a listener does not
/// establish working account domain operations or qualify an installed app.
/// The hosting app's own computer report (its launcher's product settings section `hosting_app_report`, src/account/computers.rs
/// `hosting_app_report`: its local ports and its program folders), chosen once at start the same way a computer chooses its
/// config's `report` (native_entry/computer.rs), so the hosting app's runs find its programs and reach its local ports. A
/// launcher that declares none leaves the default report (no local ports, no program folders).
pub(crate) fn choose_hosting_app_report() -> Result<(), crate::refusal_cause::CodedError<&'static str>> {
    use crate::account::computers;
    let Some(report) = computers::hosting_app_report() else { return Ok(()) };
    match computers::choose_this_computer(report.clone()) {
        Err(error) if computers::this_computer() != &report => Err(crate::refusal_cause::CodedError::with_cause("this engine already runs as another computer", error.cause())),
        _ => Ok(()),
    }
}

pub fn run_selected(
    selection: Selection,
    address: SocketAddr,
) -> Result<(), Box<dyn std::error::Error>> {
    startup(StartupStage::Selection, selection.assert_current())?;
    startup(StartupStage::ProductData, choose_hosting_app_report())?;
    // The account files byte counters (RAM only) leave the process as one stderr line per five minutes, only when a count
    // changed, from their own thread: no request waits on it, and it reads and writes no store.
    crate::account_files::counters::flush_changes_every(Duration::from_secs(300), |line| crate::quiet_eprintln!("{line}"));
    // Each account's own usage counts (stored bytes, source bytes, tool work time) go into its own day rows from one
    // thread of their own, every `usage.flush_seconds` (account-files-routes.json): never on a request path.
    if let Some(door) = crate::account_files::account_routes::AccountFilesDoor::shipped() {
        crate::account_files::usage::flush_rows_every(door.usage_flush_period(), |line| crate::quiet_eprintln!("{line}"));
        // Account routes that let bytes in only by funding gets this host's funded allowances: each account's opened from its
        // own protected funding home over its current signed capture, with the issuers DATA `funded` trusts. Refused
        // DATA installs none, so every byte sent to those routes is refused, never let in unfunded.
        if door.funds_bytes() {
            use crate::resource_authority::budget::account_files::{Funded, WallClock};
            match Funded::from_settings(door.funded_settings(), Arc::new(WallClock)) {
                Ok(funded) => { door.fund(Arc::new(funded)); }
                Err(error) => crate::quiet_eprintln!("namespace-funding refused=settings cause={}", error.cause()),
            }
        }
    }
    if selection.address() != address {
        startup(
            StartupStage::Selection,
            Err::<(), _>(io::Error::new(
                io::ErrorKind::InvalidInput,
                "native address differs from adopted selection",
            )),
        )?;
    }
    // Each check of the private launch channel is named when it refuses: the parent's pipes, the one launch message,
    // its fields and key, its owner process (the app's own child is the server, so `owner_pid` is this process),
    // and its state and origin against this selection.
    let launch_stage = StartupStage::LaunchChannel;
    let mut input = startup_step(launch_stage, "stdin-pipe", PrivateInput::standard())?;
    let output = native::ParentWriter::new(startup_step(launch_stage, "stdout-pipe", PrivateOutput::standard())?);
    let message = startup_step(
        launch_stage,
        "read-frame",
        input.read_message(crate::native::MAX_LAUNCH_BYTES, Duration::from_secs(30)),
    )?;
    let mut launch = startup_step(launch_stage, "parse-frame", Launch::parse(message.as_bytes()))?;
    launch
        .assert_selection(&selection.selected.receipt.blake3, &format!("http://{address}"))
        .map_err(|error| StartupFailure {
            stage: launch_stage,
            step: Some(launch_binding_step(&error)),
            cause: error.cause(),
            source: error.into(),
        })?;
    // The parent's door credential and what it keeps for this program (parent_kept), taken from the message once.
    let (owner_binding, kept) = launch.take_owner_and_kept();
    let owner_binding = startup_step(launch_stage, "owner-binding", owner_binding.ok_or(crate::cause!(crate::native::Error::InvalidLaunch)))?;
    let parent_kept = Arc::new(parent_kept::ParentKept::from_launch(kept, output.clone(), launch.boot_id()));
    // The secrets vault opens with the key the app keeps (parent_kept), given before the account opens. When the app
    // sends none yet, the one this computer kept before is read once (never written) and handed to the app.
    let vault_root = startup_step(StartupStage::AccountOpen, "vault-root", parent_kept.vault_root(crate::secrets::SecretsKey::kept_before))?;
    startup_step(StartupStage::AccountOpen, "vault-root", crate::secrets::secrets_key::give(vault_root))?;
    let (assets, dom, first_answers, shell, session_settings) = startup(
        StartupStage::FrontendData,
        (|| -> Result<_, StartupFailure> {
            let (assets, dom) = startup(StartupStage::FrontendData, selection.frontend.open(Some(
                &selection
                    .selected
                    .root
                    .join(crate::native_boot::KEPT_ASSET_TREES),
            )))?;
            let first_source = startup(StartupStage::FrontendData, selection.frontend.required(crate::native_boot::FIRST_ANSWERS))?;
            let first_answers = startup(StartupStage::FrontendData, first_source.read())?;
            let shell = startup(StartupStage::FrontendData, selection.frontend.open_shell())?;
            let session_settings = startup(StartupStage::FrontendData, WorkspaceSessionSettings::from_source(
                &first_answers,
                &first_source.pin.blake3,
            )
            .map_err(|error| crate::refusal_cause::CodedError::with_cause("native workspace session DATA refused", error.cause())))?;
            Ok((assets, dom, first_answers, shell, session_settings))
        })(),
    )?;
    let first_identity = selection.frontend.required(crate::native_boot::FIRST_ANSWERS).map(|first| first.pin.blake3.clone());
    let first_identity = startup(StartupStage::FrontendData, first_identity)?;
    let (routes, startup_contract) = startup(
        StartupStage::WorkspaceComposition,
        (|| -> Result<_, StartupFailure> {
            let routes =
                startup(StartupStage::WorkspaceComposition, OwnerRoutes::from_product().map_err(|error| crate::refusal_cause::CodedError::with_cause("native workspace route DATA refused", error.cause())))?;
            let first_source = startup(StartupStage::FrontendData, selection.frontend.required(crate::native_boot::FIRST_ANSWERS))?;
            let inputs_source = startup(StartupStage::FrontendData, selection.frontend.required(crate::native_boot::INPUTS))?;
            let first_answers = startup(StartupStage::FrontendData, first_source.read())?;
            let inputs = startup(StartupStage::FrontendData, inputs_source.read())?;
            let startup_contract = startup(StartupStage::WorkspaceComposition, StartupContract::from_sources(
                &first_answers,
                &first_source.pin.blake3,
                &inputs,
                &inputs_source.pin.blake3,
            )
            .map_err(|error| crate::refusal_cause::CodedError::with_cause("native workspace startup DATA refused", error.cause())))?;
            Ok((routes, startup_contract))
        })(),
    )?;
    let owner = startup(StartupStage::AccountOpen, open_selected_account(&selection))?;
    let session_id = owner.session_identity();
    let state_identity = owner.state_identity().to_owned();
    startup(StartupStage::AccountComposition, selection.assert_current())?;
    let account = owner.account();
    let tool_label_locale = startup(
        StartupStage::AccountComposition,
        crate::native_boot::tool_label_locale::engine_locale().map(Some),
    )?;
    let service_origin = startup(
        StartupStage::AccountComposition,
        selection.selected_service_origin(),
    )?;
    let access = owner.access_reader();
    let records = owner.records_file();
    let mut owner = startup(
        StartupStage::AccountComposition,
        SelectedAccount::new(owner, selection),
    )?;
    // The account's own rows and signing key (`SignIn`), opened once: the local account routes, the connection and the
    // app's channel all reach the account through it; who a credential is, is the Better Auth JWT (`account::signed_in`).
    // Its rows are read and written through the copies' view (`rows_copy::CopiedRows`), as at every computer: it passes
    // every row through until the account's copies run here (computer/hosting.rs), then a copied row's change goes to them.
    // The account's signing key (src/account/computers.rs), kept in its vault under the secrets key, is read there: it
    // signs the account's computers row, which the outbound connection and the engine's computer tell to the forwarder.
    let serving = parent_kept.computer_key().ok()
        .and_then(|key| crate::account::computers::ComputerSigner::of(&key).ok())
        .map(|signer| signer.computer_id());
    let (rows_view, sign_in) = startup(
        StartupStage::AccountComposition,
        computer::hosting::hosting_sign_in(&mut owner, &account, access.clone(), service_origin.as_deref(), serving.as_deref()),
    )?;
    // Owners of this account that hold no sign-in of their own find it here while the account's routes run.
    let _sign_in_registration = crate::account::account_routes::register(&sign_in);
    // Sessions are admitted on a read-only owner of the same account, so a request's rights check never waits on
    // the account's writer (a page write, a long read).
    let admission = Arc::new(Mutex::new(startup(
        StartupStage::AccountComposition,
        owner.admission_owner(),
    )?));
    let owner = Arc::new(Mutex::new(owner));
    let sessions = startup(
        StartupStage::WorkspaceComposition,
        WorkspaceSessions::new(
            owner.clone(),
            &format!("http://{address}"),
            session_settings,
        )
        .map_err(|error| crate::refusal_cause::CodedError::with_cause("native workspace session supply refused", crate::refusal_cause::Caused::cause(&error))),
    )?
    .with_admission(admission.clone());
    // A browser signed in at the account's public origin opens the same workspace there (old trillion served it at
    // its public origin, src/worker.mjs workspaceAddress); any other address stays refused.
    let sessions = match service_origin.as_deref() {
        Some(origin) => startup(
            StartupStage::WorkspaceComposition,
            sessions.with_public_origin(origin).map_err(|error| crate::refusal_cause::CodedError::with_cause("native workspace public origin refused", crate::refusal_cause::Caused::cause(&error))),
        )?,
        None => sessions,
    };
    // The page's tool runs reach the records routes at this same loopback listener, named by the owner's sign-in address.
    let route = crate::account_rights::run_capability::Route::loopback(address, sign_in.address());
    let executor = startup(
        StartupStage::WorkspaceComposition,
        LocalWorkspace::new(owner.clone(), sessions.clone())
            .map_err(|error| crate::refusal_cause::CodedError::with_cause("native workspace account supply differs", crate::refusal_cause::Caused::cause(&error))),
    )?
    .with_route(route.clone());
    let executor = match tool_label_locale {
        Some(locale) => executor
            .with_tool_screens(locale.clone(), Default::default())
            .with_show_rules(locale),
        None => executor,
    };
    let api = Arc::new(CanonicalWorkspace::new(
        routes,
        startup_contract,
        Arc::new(executor),
        None,
    ));
    // The page's live socket: one owner on the account's change notifier, admitted like every page request.
    let live = startup(
        StartupStage::WorkspaceComposition,
        live::LiveOwner::start(owner.clone(), sessions.clone(), &account.owner_id)
            .map_err(|error| crate::refusal_cause::CodedError::with_cause("native live socket supply refused", crate::refusal_cause::Caused::cause(&error))),
    )?;
    let sessions: Arc<dyn crate::workspace::CurrentSession> = Arc::new(sessions);
    let operations: Arc<dyn crate::workspace::WorkspaceOperations> = match shell {
        Some(shell) => {
            let page = startup(
                StartupStage::WorkspaceComposition,
                WorkspacePageProducer::new(
                    shell,
                    assets.clone(),
                    &format!("http://{address}"),
                    &first_answers,
                    &first_identity,
                    sessions.clone(),
                    api.clone(),
                    None,
                    StreamLimits::default(),
                )
                .map_err(|error| crate::refusal_cause::CodedError::with_cause("native page producer refused", crate::refusal_cause::Caused::cause(&error))),
            )?;
            Arc::new(api.with_page(Arc::new(page)))
        }
        None => api,
    };
    // Ordinary sessions now reach the SAME actual selected account. Canonical
    // workspace-record reads now use their actual selected physical owner.
    // The selected captured frontend supplies the original shell when present.
    // Remaining domain operations await their real owners; this composition
    // does not substitute successful empty application data.
    // The account's routes (MCP, and the sign-in and device routes where the signed app names a public origin): the
    // same composition a computer makes from its config (`door`).
    let door_origin = service_origin.clone();
    if let Some(origin) = door_origin.as_deref() {
        let root = owner.lock().map_err(|_| crate::refusal_cause::CodedError::new("native owner unavailable"))?.state_root().to_owned();
        startup(
            StartupStage::AccountComposition,
            crate::account::rows::write_door_note(&root, &account.user_id, sign_in.address(), origin).map_err(|error| crate::refusal_cause::CodedError::with_cause("door note refused", crate::refusal_cause::Caused::cause(&error))),
        )?;
    }
    // The app opens its page through the owner page (parent_kept owner_page) with this launch's owner binding, which
    // sets the window's session cookie from this state folder.
    let owner_binding = Arc::new(owner_binding);
    let page_state = owner.lock().map_err(|_| crate::refusal_cause::CodedError::new("native owner unavailable"))?.state_root().to_owned();
    // The engine as a computer of its own account (computer/hosting.rs): its own key from the app's blob, its session to
    // the forwarder its outbound connection reaches, its copies once the account's row names voters. Where it cannot be
    // made (no public origin, no forwarder, a refused key), the engine serves as before: only the app's own routes and
    // its outbound connection; one fixed line says why.
    if door_origin.is_none() {
        crate::quiet_eprintln!("native-computer event=absent cause=no public origin for this engine");
    }
    let hosting = door_origin.as_deref().and_then(|origin| {
        let forwarder = owner.lock().ok()?.forwarder_endpoint();
        if forwarder.is_none() {
            crate::quiet_eprintln!("native-computer event=forwarder-absent cause=no MCP service endpoint; hosting continues without an outbound forwarder");
        }
        let computer_key = match parent_kept.computer_key() {
            Ok(key) => key,
            Err(detail) => {
                crate::quiet_eprintln!("native-computer event=not-started cause={}", detail.cause());
                return None;
            }
        };
        let parts = computer::hosting::Hosting {
            owner: owner.clone(),
            admission: admission.clone(),
            rows_view: rows_view.clone(),
            access: access.clone(),
            user_id: account.user_id.clone(),
            owner_id: account.owner_id.clone(),
            state_root: owner.lock().ok()?.state_root().to_owned(),
            records: records.clone(),
            public_origin: origin.to_owned(),
            forwarder,
            loopback: Some(address).filter(|door| door.ip().is_loopback()),
            computer_key,
        };
        match computer::Computer::hosting(parts) {
            Ok(computer) => {
                crate::quiet_eprintln!("native-computer event=started");
                Some(computer)
            }
            Err(error) => {
                crate::quiet_eprintln!("native-computer event=not-started cause={}", error.cause());
                None
            }
        }
    });
    let local_mcp = startup(
        StartupStage::WorkspaceComposition,
        door(owner.clone(), admission.clone(), sign_in.clone(), address.to_string(), Some(address).filter(|door| door.ip().is_loopback()),
            door_origin.as_deref())
            .map(|door| match &hosting {
                Some(computer) => computer::hosting::pending_layer(door, computer.clone(), address.to_string()),
                None => door,
            })
            .map(|door| parent_kept::owner_page(door, owner_binding.clone(), page_state))
            .map_err(|error| crate::refusal_cause::CodedError::with_cause("native local MCP supplies refused", error.cause())),
    )?;
    // The original parent can supply or withdraw its issued connection after
    // startup. The task waits on this same private host lifetime; direct local
    // MCP remains mounted independently of the remote connection's outcome.
    // Every request but the host's readiness probe waits, answered busy, until the first start has the account's
    // own records ready on record store (preparation_gate).
    let records_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Events the Mac sends over the parent channel (host_event messages) wait here for the account's wake ticker.
    let host_events = Arc::new(startup(
        StartupStage::WorkspaceComposition,
        crate::wake::host_events::HostEvents::shipped().ok_or_else(|| crate::refusal_cause::CodedError::new("native host events DATA refused")),
    )?);
    if let Some(computer) = &hosting {
        computer.keep_hosting(&HOSTING_STOP);
        let switching = computer.clone();
        let _ = SWITCH_HAND_OVER.set(Box::new(move || {
            HOSTING_STOP.store(true, std::sync::atomic::Ordering::Release);
            crate::quiet_eprintln!("native-computer event=stopped writer_turns_handed_over={}", switching.hand_over_writer_turns());
        }));
    }
    let outbound = Some(crate::native_boot::own_records_start::with_connection(
        crate::native_boot::mcp_outbound::prepare(owner.clone()),
        owner.clone(),
        session_id.clone(),
        records_ready.clone(),
        // The causes wake starts call back to these same local routes (mcp_local), on the account's own route.
        route,
        host_events.clone(),
    ));
    let workspace = startup(
        StartupStage::WorkspaceComposition,
        crate::workspace::route_table(
            assets,
            WorkspaceSupplies {
                sessions: Some(sessions),
                operations: Some(operations),
                live: Some(Arc::new(live)),
                dom,
            },
            WorkspaceLimits::default(),
        )
        .map_err(|error| crate::refusal_cause::CodedError::with_cause("native workspace supplies refused", error.cause())),
    )?
    .merge(local_mcp);
    // Every request at the app's own routes makes the account active at its computer (its copies step, the writer turn
    // is renewed while used) and, at the writer, sends a change of the account stores it made as records (`hosting.rs`).
    // The account's Home at its own address (`/a/<address>/`, served by this engine as a computer of the account): the same
    // workspace routes, behind the same readiness gate; the request already woke the account (`Computer::wake`).
    if let Some(computer) = &hosting {
        computer.set_home(preparation_gate::layer(workspace.clone(), records_ready.clone()));
    }
    let workspace = match hosting.clone() {
        Some(computer) => computer::hosting::layer(workspace, computer),
        None => workspace,
    };
    let workspace = preparation_gate::layer(workspace, records_ready);
    let listener = startup(StartupStage::Listener, TcpListener::bind(address))?;
    // The app's host lifetime ended (or never started): the engine's computer stops, and every writer turn it holds is
    // handed over at once, so another computer of the account takes writes without waiting for the term to run out.
    let stop_hosting = || if let Some(computer) = &hosting {
        HOSTING_STOP.store(true, std::sync::atomic::Ordering::Release);
        crate::quiet_eprintln!("native-computer event=stopped writer_turns_handed_over={}", computer.hand_over_writer_turns());
    };
    let served = startup(
        StartupStage::Listener,
        crate::native_host::serve_with_owned_connection(
            listener,
            launch,
            input,
            output,
            AccountMount {
                owner: SharedNativeAccount {
                    owner,
                    account,
                },
                state_identity,
                host_events: Some(host_events),
            },
            workspace,
            outbound,
        ),
    );
    stop_hosting();
    served?;
    Ok(())
}

#[cfg(test)]
mod startup_diagnostic_tests {
    use super::*;
    use std::error::Error as _;

    #[test]
    fn startup_keeps_the_inner_native_refusal_origin() {
        let inner = crate::cause!(crate::native::Error::InvalidRequest);
        let expected = inner.cause();
        let error = startup(StartupStage::LaunchChannel, Err::<(), _>(inner)).unwrap_err();
        assert_eq!(error.cause(), expected);
        assert!(error.to_string().contains(&expected.id()));
    }

    #[test]
    fn startup_error_exposes_only_its_closed_stage_not_the_underlying_error() {
        let error = startup(
            StartupStage::Selection,
            Err::<(), _>(io::Error::new(
                io::ErrorKind::InvalidData,
                "private path or record value",
            )),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), format!("native-startup-error stage=selection cause={}", error.cause()));
        assert!(error.source().is_some());
        assert!(!error.to_string().contains("private path"));
    }

    #[test]
    fn a_selection_refusal_names_its_check_and_never_the_app_files_list_path() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("private-app-files-list.json");
        let error = run_at(&missing).unwrap_err();
        assert_eq!(error.to_string(), format!("native-startup-error stage=selection:app-files-list cause={}", error.downcast_ref::<StartupFailure>().unwrap().cause()));
        // This user's own private list that parses: a test binary is no app's program, so the next check refuses.
        let list = serde_json::json!({"version":"trillion.local-runtime-adoption/v1","state":temp.path(),
            "receipt_identity":"a".repeat(64),"port":28788,"native":{"version":"trillion.native-selection/v1",
            "receipt_bytes":1024,"app_kv":{"sqlite":"kv.sqlite","namespace":"app"},"prior_processes":[],"root_source":null}});
        let path = std::fs::canonicalize(temp.path()).unwrap().join("list.json");
        std::fs::write(&path, serde_json::to_vec(&list).unwrap()).unwrap();
        std::fs::set_permissions(&path, <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o600)).unwrap();
        let error = run_at(&path).unwrap_err();
        assert_eq!(error.to_string(), format!("native-startup-error stage=selection:app-contents cause={}", error.downcast_ref::<StartupFailure>().unwrap().cause()));
        assert!(!error.to_string().contains(temp.path().to_str().unwrap()));
    }

    #[test]
    fn a_launch_channel_refusal_names_its_check_in_the_same_word() {
        let error = startup_step(
            StartupStage::LaunchChannel,
            "read-frame",
            Err::<(), _>(crate::cause!(crate::native::Error::PipeTimedOut)),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), format!("native-startup-error stage=launch-channel:read-frame cause={}", error.cause()));
        // A launch message keyed for another process (a shell that launched trillion-local names itself) is the owner check.
        let message = serde_json::json!({"version": crate::native::LAUNCH_VERSION, "boot_id": "synthetic-launch-step",
            "state_identity": "a".repeat(64), "origin": "http://127.0.0.1:7199",
            "owner_pid": std::process::id() + 1, "readiness_key": "b".repeat(64), "owner_binding": "d".repeat(64)});
        let mut bytes = serde_json::to_vec(&message).unwrap();
        bytes.push(b'\n');
        let launch = Launch::parse(&bytes).unwrap();
        let foreign = launch.assert_selection(&"a".repeat(64), "http://127.0.0.1:7199").unwrap_err();
        assert_eq!(launch_binding_step(&foreign), "owner-pid");
        let own = serde_json::json!({"version": crate::native::LAUNCH_VERSION, "boot_id": "synthetic-launch-step",
            "state_identity": "a".repeat(64), "origin": "http://127.0.0.1:7199",
            "owner_pid": std::process::id(), "readiness_key": "b".repeat(64), "owner_binding": "d".repeat(64)});
        let mut bytes = serde_json::to_vec(&own).unwrap();
        bytes.push(b'\n');
        let other_state = Launch::parse(&bytes).unwrap().assert_selection(&"c".repeat(64), "http://127.0.0.1:7199").unwrap_err();
        assert_eq!(launch_binding_step(&other_state), "state-or-origin");
    }

    #[test]
    fn startup_stage_words_are_a_closed_protocol() {
        let stages = [
            StartupStage::Selection,
            StartupStage::ProductData,
            StartupStage::LaunchChannel,
            StartupStage::FrontendData,
            StartupStage::AccountOpen,
            StartupStage::AccountComposition,
            StartupStage::WorkspaceComposition,
            StartupStage::Listener,
        ];
        let words: Vec<_> = stages.into_iter().map(StartupStage::word).collect();
        assert_eq!(
            words,
            [
                "selection",
                "product-data",
                "launch-channel",
                "frontend-data",
                "account-open",
                "account-composition",
                "workspace-composition",
                "listener"
            ]
        );
    }
}

/// The file beside the descriptor that keeps this program's standard error lines (`keep_error_lines`).
const ERROR_LINES_FILE: &str = "engine-errors.log";
/// The most bytes the error lines file grows to; past it, lines go only to the standard error they were written on.
const ERROR_LINES_MOST_BYTES: u64 = 16 * 1024 * 1024;

/// Send standard error through a pipe whose reader writes each byte both to the standard error the process was given and to
/// `path` (made empty at each start, at most `ERROR_LINES_MOST_BYTES`). A file that cannot be made leaves standard error as it was.
#[cfg(unix)]
fn keep_error_lines(path: &Path) {
    use std::io::{Read, Write};
    use std::os::fd::FromRawFd;
    let Ok(mut file) = std::fs::File::create(path) else { return };
    let mut fds = [0i32; 2];
    // SAFETY: plain POSIX calls on descriptors this function owns; a failure leaves standard error untouched.
    unsafe {
        if libc::pipe(fds.as_mut_ptr()) != 0 { return; }
        let given = libc::dup(2);
        if given < 0 || libc::dup2(fds[1], 2) < 0 { libc::close(fds[0]); libc::close(fds[1]); return; }
        libc::close(fds[1]);
        let mut reader = std::fs::File::from_raw_fd(fds[0]);
        let mut given = std::fs::File::from_raw_fd(given);
        let _ = std::thread::Builder::new().name("error-lines".into()).spawn(move || {
            let (mut buffer, mut kept) = ([0u8; 8192], 0u64);
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 { break; }
                let _ = given.write_all(&buffer[..read]);
                if kept < ERROR_LINES_MOST_BYTES { let _ = file.write_all(&buffer[..read]); kept += read as u64; }
            }
        });
    }
}
#[cfg(not(unix))]
fn keep_error_lines(_path: &Path) {}
