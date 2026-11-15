// src/native_boot/tool_screens.rs
//
// Purpose: Compose the opened account's tool screens as the original tools defined them.
// Invariants: Retain the selected account, browser admission, pinned program
//   sources, locale and effective catalog identity through final disclosure.
// Security: Reuse the same current own-record snapshot; no path/store selection,
//   locale fallback, tool execution or partial result after source refusal.
// AI Assistant Directive: Preserve and extend these authority boundaries.

use super::SelectedAccount;
use crate::{
    account::{self, BrowserAdmission, NativeAccountOwner},
    ecma_json::JsString,
    native_boot::PinnedData,
    tools_catalog::{self, Catalog},
    tool_fact_page,
    workspace_tool_screens::{
        CurrentToolScreenAuthority, Failure, Limits as ProjectionLimits, Placement, ToolScreenPage,
        ToolScreenProjection,
    },
};
use content_crypto::advanced::blake3;
use serde::Deserialize;
use std::{
    cmp::Ordering,
    sync::{Arc, Mutex},
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const MAX_PAGE_ITEMS: usize = tool_fact_page::MAX_PAGE_ITEMS;

/// The tool screens' program DATA: the carried surfaces and looks files and the host name, as the carried
/// declaration `TOOL_SCREENS` names them.
#[derive(Clone)]
pub struct ProgramSources {
    pub surfaces: PinnedData,
    pub looks: PinnedData,
    pub host: String,
}
/// The carried file this reader opens: `{"surfaces": <carried path>, "looks": <carried path>, "host": <name>}`. It is
/// one entry of the app's opaque carried file map, pinned and checked with every other; the two paths it names must be
/// entries of the same map. Which tools have screens is the account's own Workshop catalog rows, never this file.
pub const TOOL_SCREENS: &str = "data/tool_screens.json";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Declared {
    surfaces: String,
    looks: String,
    host: String,
}

/// The selected native locale owner supplies the one permitted label ordering.
/// No process locale or bytewise fallback is used by this adapter.
pub trait ToolLabelLocale: Send + Sync {
    fn assert_current(&self) -> Result<(), Failure>;
    fn compare(&self, left: &JsString, right: &JsString) -> Result<Ordering, Failure>;
}

#[derive(Clone, Debug)]
pub struct ReadLimits {
    pub catalog: tools_catalog::Limits,
    pub page: tool_fact_page::Limits,
    pub projection: ProjectionLimits,
    pub elapsed: Duration,
}
impl Default for ReadLimits {
    fn default() -> Self {
        Self {
            catalog: tools_catalog::Limits::default(),
            page: tool_fact_page::Limits::default(),
            projection: ProjectionLimits::default(),
            elapsed: Duration::from_secs(5),
        }
    }
}

fn check_time(deadline: Instant, cancel: &AtomicBool) -> Result<Duration, Failure> {
    if cancel.load(AtomicOrdering::Acquire) {
        return Err(crate::cause!(Failure::Cancelled));
    }
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(crate::cause!(Failure::Bounds))
}
fn catalog_failure(error: tools_catalog::Failure) -> Failure {
    let cause = error.cause();
    match error {
        tools_catalog::Failure::Invalid(_) => Failure::Invalid("selected Workshop catalog refused", cause),
        tools_catalog::Failure::Source(_) => Failure::Source(cause),
        tools_catalog::Failure::Integrity(_) => Failure::Integrity(cause),
        tools_catalog::Failure::Bounds(_) => Failure::Bounds(cause),
        tools_catalog::Failure::Cancelled(_) => Failure::Cancelled(cause),
    }
}
fn pin_failure(error: super::Error) -> Failure {
    Failure::Source(error.cause())
}

fn same_admission(left: &BrowserAdmission, right: &BrowserAdmission) -> bool {
    left.account == right.account
        && left.same_as(&right)
}
fn checked_admission(
    selected: &mut SelectedAccount,
    session_id: &str,
    expected: &BrowserAdmission,
) -> Result<(), Failure> {
    selected
        .selection
        .assert_current()
        .map_err(|error| Failure::Source(error.cause()))?;
    selected
        .assert_source_current()
        .map_err(|error| Failure::Source(error.cause()))?;
    let current = account::current_browser_read_only(selected, session_id).map_err(|error| Failure::Source(error.cause()))?;
    if !same_admission(expected, &current) {
        return Err(crate::cause!(Failure::Source));
    }
    Ok(())
}
pub(super) fn read_sources(
    selected: &SelectedAccount,
) -> Result<(ProgramSources, Zeroizing<Vec<u8>>, Zeroizing<Vec<u8>>), Failure> {
    let frontend = selected.selection.frontend().map_err(|error| Failure::Source(error.cause()))?;
    let declared = frontend.file(TOOL_SCREENS).ok_or(crate::cause!(Failure::Source))?.read().map_err(pin_failure)?;
    let declared: Declared = serde_json::from_slice(&declared).map_err(|error| crate::carry_cause!(Failure::Integrity, error))?;
    let carried = |name: &str| frontend.file(name).cloned().ok_or(crate::cause!(Failure::Source));
    let sources = ProgramSources {
        surfaces: carried(&declared.surfaces)?,
        looks: carried(&declared.looks)?,
        host: declared.host,
    };
    let surfaces = sources.surfaces.read().map_err(pin_failure)?;
    let looks = sources.looks.read().map_err(pin_failure)?;
    Ok((sources, surfaces, looks))
}
/// The placements and tool screens made from one kept catalog and the pinned surfaces and looks, made once and used
/// again while all three are the same: both are pure functions of those bytes (the catalog by its BLAKE3 identity,
/// the surfaces and looks by their pins) and of the program size bound. Parsing the same catalog twice on every
/// tool-screens read was most of what was left of it inside the account owner once the catalog itself was kept.
pub(super) fn kept_projection(
    catalog: &Catalog,
    programs: &ProgramSources,
    surfaces: &[u8],
    looks: &[u8],
    limits: &ProjectionLimits,
) -> Result<(Vec<Placement>, Arc<ToolScreenProjection>), Failure> {
    let key = (
        catalog.identity.clone(),
        programs.surfaces.pin.blake3.clone(),
        programs.looks.pin.blake3.clone(),
        limits.program_bytes,
        limits.catalog_bytes,
    );
    let mut kept = KEPT_PROJECTION.lock().map_err(|error| crate::carry_cause!(Failure::Source, error))?;
    if let Some(held) = kept.as_ref().filter(|held| held.key == key) {
        return Ok((held.placements.clone(), held.projection.clone()));
    }
    let placements = crate::workspace_tool_screens::catalog::placements_from_catalog(
        &catalog.bytes,
        limits.catalog_bytes,
    )?;
    let projection = Arc::new(
        ToolScreenProjection::from_sources(
            surfaces,
            &programs.surfaces.pin.blake3,
            looks,
            &programs.looks.pin.blake3,
            limits,
        )?
        .with_shared_catalog(&catalog.bytes, &catalog.identity, limits)?,
    );
    *kept = Some(KeptProjection {
        key,
        placements: placements.clone(),
        projection: projection.clone(),
    });
    Ok((placements, projection))
}
/// The catalog identity, surfaces pin, looks pin, program size bound and catalog size bound kept tool screens were made from.
type ProjectionKey = (String, String, String, usize, usize);
struct KeptProjection {
    key: ProjectionKey,
    placements: Vec<Placement>,
    projection: Arc<ToolScreenProjection>,
}
static KEPT_PROJECTION: Mutex<Option<KeptProjection>> = Mutex::new(None);
fn source_identity_pair(sources: &ProgramSources) -> (String, String) {
    (
        sources.surfaces.pin.blake3.clone(),
        sources.looks.pin.blake3.clone(),
    )
}
fn per_read(first_answers: &[u8], pin: &str) -> Result<usize, Failure> {
    if first_answers.len() > 1024 * 1024 || blake3::hash(first_answers).to_hex().as_str() != pin {
        return Err(crate::cause!(Failure::Integrity));
    }
    let value: serde_json::Value =
        serde_json::from_slice(first_answers).map_err(|error| crate::carry_cause!(Failure::Integrity, error))?;
    let limit = value
        .get("tool_screens_per_read")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| (1..=MAX_PAGE_ITEMS).contains(value))
        .ok_or(crate::cause!(Failure::Integrity))?;
    Ok(limit)
}

struct PageAuthority<'a> {
    identity: &'a str,
    placements: Vec<Placement>,
    locale: &'a dyn ToolLabelLocale,
    cancel: &'a AtomicBool,
    deadline: Instant,
}
impl CurrentToolScreenAuthority for PageAuthority<'_> {
    fn assert_current(&mut self) -> Result<(), Failure> {
        check_time(self.deadline, self.cancel)?;
        self.locale.assert_current()
    }
    fn assert_shared_catalog(&mut self, identity: &str) -> Result<(), Failure> {
        self.assert_current()?;
        if identity != self.identity {
            return Err(crate::cause!(Failure::Integrity));
        }
        Ok(())
    }
    fn placements(&mut self) -> Result<Vec<Placement>, Failure> {
        self.assert_current()?;
        Ok(self.placements.clone())
    }
    /// One comparison of a sort: the deadline and cancellation only. The locale's images are witnessed by the page
    /// read's own `assert_current` before and after it orders the tools (workspace_tool_screens::read_tool_screen_page),
    /// never once per comparison, which put thousands of file-system checks inside the account owner.
    fn compare_labels(&mut self, left: &JsString, right: &JsString) -> Result<Ordering, Failure> {
        check_time(self.deadline, self.cancel)?;
        self.locale.compare(left, right)
    }
}

impl SelectedAccount {
    /// Make the kept catalog and the kept tool screens a tool-screens read uses, with the limits the workspace mounts
    /// (`ReadLimits::default`), so the first read finds both made. Called once at startup, before the page can open.
    pub(crate) fn prepare_tool_screens(&mut self, session_id: &str, cancel: &AtomicBool) -> Result<(), Failure> {
        let limits = ReadLimits::default();
        let (programs, surfaces, looks) = read_sources(self)?;
        let kept = self
            .kept_tools_catalog(session_id, &limits.catalog, cancel)
            .map_err(catalog_failure)?;
        kept_projection(&kept.catalog, &programs, &surfaces, &looks, &limits.projection)?;
        Ok(())
    }

    /// Read the original selected Workshop tool-screens page with all program,
    /// account, browser, locale and catalog evidence kept current until return.
    pub fn current_tool_screens(
        &mut self,
        session_id: &str,
        after: String,
        locale: &dyn ToolLabelLocale,
        limits: &ReadLimits,
        cancel: Arc<AtomicBool>,
    ) -> Result<ToolScreenPage, Failure> {
        if limits.elapsed.is_zero() || limits.elapsed > Duration::from_secs(30) {
            return Err(Failure::Invalid("tool-screen read deadline is invalid", crate::cause!()));
        }
        let started = Instant::now();
        let deadline = started.checked_add(limits.elapsed).ok_or(crate::cause!(Failure::Bounds))?;
        check_time(deadline, &cancel)?;
        self.selection
            .assert_current()
            .map_err(|error| Failure::Source(error.cause()))?;
        self.assert_source_current().map_err(|error| Failure::Source(error.cause()))?;
        let admitted = account::current_browser(self, session_id).map_err(|error| Failure::Source(error.cause()))?;

        let (programs, surfaces, looks) = read_sources(self)?;
        if programs.host.is_empty()
            || programs.host.len() > 128
            || programs.host.chars().any(char::is_control)
        {
            return Err(crate::cause!(Failure::Integrity));
        }
        let frontend = self.selection.frontend().map_err(|error| Failure::Source(error.cause()))?;
        let first_source = frontend.file(super::FIRST_ANSWERS).ok_or(crate::cause!(Failure::Source))?;
        let first_answers = first_source.read().map_err(pin_failure)?;
        let per_read = per_read(&first_answers, &first_source.pin.blake3)?;
        drop(first_answers);
        locale.assert_current()?;

        let mut first_catalog_limits = limits.catalog.clone();
        first_catalog_limits.elapsed = first_catalog_limits
            .elapsed
            .min(check_time(deadline, &cancel)?);
        let kept = self
            .kept_tools_catalog(session_id, &first_catalog_limits, &cancel)
            .map_err(catalog_failure)?;
        let first_catalog = kept.catalog.clone();
        check_time(deadline, &cancel)?;
        checked_admission(self, session_id, &admitted)?;
        let projection_remaining = check_time(deadline, &cancel)?;
        let mut projection_limits = limits.projection.clone();
        projection_limits.elapsed = projection_limits.elapsed.min(projection_remaining);
        let (placements, projection) = kept_projection(
            &first_catalog,
            &programs,
            &surfaces,
            &looks,
            &projection_limits,
        )?;
        let mut authority = PageAuthority {
            identity: &first_catalog.identity,
            placements,
            locale,
            cancel: &cancel,
            deadline,
        };
        let mut page_limits = limits.page.clone();
        page_limits.elapsed = page_limits.elapsed.min(check_time(deadline, &cancel)?);
        let mut projection_limits = projection_limits;
        projection_limits.elapsed = projection_limits
            .elapsed
            .min(check_time(deadline, &cancel)?);
        let mut effective_limits = limits.projection.clone();
        effective_limits.elapsed = effective_limits.elapsed.min(projection_limits.elapsed);
        let page = self.owner.current_tool_screen_page(
            session_id,
            &mut authority,
            &tool_fact_page::PageRequest {
                after,
                limit: per_read,
            },
            &page_limits,
            &projection,
            &JsString::from(programs.host.as_str()),
            &effective_limits,
            cancel.clone(),
        )?;
        check_time(deadline, &cancel)?;

        checked_admission(self, session_id, &admitted)?;
        locale.assert_current()?;
        let (fresh_programs, fresh_surfaces, fresh_looks) = read_sources(self)?;
        if source_identity_pair(&fresh_programs) != source_identity_pair(&programs)
            || fresh_surfaces.as_slice() != surfaces.as_slice()
            || fresh_looks.as_slice() != looks.as_slice()
        {
            return Err(crate::cause!(Failure::Source));
        }
        check_time(deadline, &cancel)?;

        // The catalog the page was projected from is still the one everything it was read from describes (its
        // witness: the KV file's data_version, every blob, the metadata, the earliest expiry). This replaces reading
        // the whole catalog a second time to compare.
        self.kept_tools_catalog_current(&kept)
            .map_err(catalog_failure)?;
        checked_admission(self, session_id, &admitted)?;
        locale.assert_current()?;
        let (last_programs, last_surfaces, last_looks) = read_sources(self)?;
        if source_identity_pair(&last_programs) != source_identity_pair(&programs)
            || last_surfaces.as_slice() != surfaces.as_slice()
            || last_looks.as_slice() != looks.as_slice()
        {
            return Err(crate::cause!(Failure::Source));
        }
        check_time(deadline, &cancel)?;
        Ok(page)
    }
}
