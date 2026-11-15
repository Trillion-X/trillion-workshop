// crates/composition-engine/src/slot_work/scene_state.rs
//
// Owns the composition-engine slot's scene state — a SESSION MAP, not a single
// scene. One slot instance serves N independent scenes at once (a shell scene
// delivered by subscribed asserts, any number of authoring documents driven by
// composition transactions). Each session is its own Kernel; the session key is
// DATA carried by the work itself:
//   • subscribed asserts   → keyed by the assert's address
//   • composition txns     → keyed by the transaction's `session` field
//     (absent = the shared anonymous session, so a session-less caller still
//     gets a working scene rather than an error)
//
// WHY A MAP (L055/L063, live incident 2026-07-10): with a single `static mut
// KERNEL`, the studio shell's subscribed scene assert REPLACED the editor's
// handed-off document in the one kernel — every subsequent editor patch hit
// NodeNotFound and every save failed. Before the runtime's single-session pool
// fix the same collision hid as flakiness: N pooled instances = the shell and
// the editor usually landed on DIFFERENT kernels by accident, and a burst
// instance answered with an empty default scene ("Pages could not load", the
// overlap flicker). Sessions make the category structurally impossible: no two
// scenes ever share a kernel, whatever the pool does.

use std::collections::HashMap;

use composition_engine_core::kernel::types::{SceneNode, Size};
use composition_engine_core::kernel::Kernel;

use crate::slot_work::composition_transaction::{self, CompositionTransaction};

static mut KERNELS: Option<HashMap<String, Kernel>> = None;

/// The session for transactions that carry no `session` field. A name no
/// address hash can collide with (addresses are hex multihashes).
pub(crate) const ANONYMOUS_SESSION: &str = "session:anonymous";

const DEFAULT_VIEWPORT: Size = Size {
    w: 1280.0,
    h: 720.0,
};

/// The canonical canvas actions the slot ships as DATA (L083 capable default):
/// `action:navigate` centers the camera on a target node — the "Go to a page" /
/// link-to-page action the documents automation-catalog references.
/// The kernel registers this BLINDLY (`register_ephemeral_actions_from_json` names
/// nothing and just deserializes `EphemeralAction` DATA) — adding or overriding an
/// action is a DATA change to this string, ZERO engine code (L090/enum-dissolution).
/// The MECHANISM (CenterOnNode) is Physics in the kernel; the NAMED composition
/// (`action:navigate` = center-on-node) is Society, so it lives here as DATA, not
/// in the engine core. (Future: an admitted ephemeral-actions record overrides this seed.)
const DEFAULT_CANVAS_ACTIONS_JSON: &str = r#"[{"id":"action:navigate","steps":[{"CenterOnNode":{"node_id_template":"{{input.target}}"}}]}]"#;

/// A kernel with the canonical canvas actions registered, so authored automations
/// ("Go to a page", link-to-page) execute in-kernel instead of dead-ending. A
/// malformed constant must never crash boot, so a parse error is ignored.
fn new_kernel(root: SceneNode, viewport: Size) -> Kernel {
    let mut kernel = Kernel::new(root, viewport);
    let _ = kernel.register_ephemeral_actions_from_json(DEFAULT_CANVAS_ACTIONS_JSON);
    kernel
}

fn kernels() -> &'static mut HashMap<String, Kernel> {
    unsafe {
        let kernels = core::ptr::addr_of_mut!(KERNELS);
        if (*kernels).is_none() {
            *kernels = Some(HashMap::new());
        }
        (*kernels).as_mut().expect("kernels map just initialized")
    }
}

fn kernel_for(session: &str) -> &'static mut Kernel {
    kernels()
        .entry(session.to_string())
        .or_insert_with(|| new_kernel(composition_transaction::default_scene(), DEFAULT_VIEWPORT))
}

/// Boot-time seed: makes the anonymous session exist so the slot's start-up
/// snapshot reply renders (same contract as before sessions). Only the slot
/// ABI starts up; the page entry has no start-up step.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub(crate) fn initialize_if_needed(root: SceneNode, viewport: Size) {
    kernels()
        .entry(ANONYMOUS_SESSION.to_string())
        .or_insert_with(|| new_kernel(root, viewport));
}

/// A subscribed scene assert replaces THAT ADDRESS's session scene — and no
/// other. Returns the session key so the caller can render the right snapshot.
pub(crate) fn update_scene(root: SceneNode, address: String) -> Result<String, String> {
    kernel_for(&address)
        .update_scene(root)
        .map_err(|e| format!("scene update error: {:?}", e))?;
    Ok(address)
}

pub(crate) fn apply_composition_transaction(
    transaction: CompositionTransaction,
) -> Result<String, String> {
    let session = transaction
        .session
        .clone()
        .unwrap_or_else(|| ANONYMOUS_SESSION.to_string());
    composition_transaction::apply_to_kernel(kernel_for(&session), transaction)?;
    Ok(session)
}

/// A retract of a subscribed scene address drops that session entirely (the
/// next assert recreates it fresh). Other sessions are untouched.
pub(crate) fn reset_scene_if_current(address: &str) -> Result<bool, String> {
    Ok(kernels().remove(address).is_some())
}

pub(crate) fn render_snapshot_bytes(session: &str) -> Option<Vec<u8>> {
    kernels().get_mut(session).and_then(|kernel| {
        let snapshot = kernel.render(16.0);
        // Rendering resolves visibility/style bindings; an editor must save the
        // authored tree rather than freeze those expressions into current pixels.
        // Both projections come from this same accepted kernel transaction.
        let mut reply = serde_json::to_value(&snapshot).ok()?;
        reply.as_object_mut()?.insert(
            "authored_tree".to_string(),
            serde_json::to_value(&kernel.get_state().scene_tree).ok()?,
        );
        serde_json::to_vec(&reply).ok()
    })
}
