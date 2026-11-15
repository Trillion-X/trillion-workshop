// crates/composition-engine/src/slot_work/delta_apply.rs
//
// Applies subscribed delta payloads to the slot's scene sessions.

use slot_protocol::DeltaPayload;

use crate::slot_work::{scene_decode, scene_state};

/// Applies every scene assert/retract to ITS OWN per-address session and
/// returns the last session an assert updated (the caller renders that one's
/// reply snapshot). None = the delta carried no scene content for this slot.
pub(crate) fn apply_delta(delta: DeltaPayload) -> Result<Option<String>, String> {
    let mut updated_session: Option<String> = None;

    for assert in delta.asserts {
        let Some(root) = scene_decode::decode_scene_assert(&assert)? else {
            continue;
        };

        updated_session = Some(scene_state::update_scene(root, assert.address)?);
    }

    for retract in delta.retracts {
        // Dropping a retracted address's session is per-session — other
        // documents/scenes are untouched; the next assert recreates it fresh.
        scene_state::reset_scene_if_current(&retract)?;
    }

    Ok(updated_session)
}
