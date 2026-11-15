// crates/composition-engine/src/slot_work/answer_request.rs
//
// PURPOSE
//   The one decision every host makes with a request's bytes: a composition transaction is applied to the session it
//   names, otherwise a scene delta is applied to the sessions it touches, and the changed session's snapshot is the
//   reply. The slot ABI (slot_entry/do_work_when_asked.rs) and the page entry (run_in_a_page.rs) both call this, so the
//   two hosts can never answer the same bytes differently.
//
// INVARIANTS
//   - Ok(Some(bytes)) is the snapshot JSON of the session the request changed.
//   - Ok(None) means there is nothing to reply with: a payload that is not a delta, a delta that carried no scene
//     content, or a session with no scene to render.
//   - Err(reason) is a request that could not be read or applied; the reason names which.

use slot_protocol::DeltaPayload;

use crate::slot_work::{composition_transaction, delta_apply, scene_state};

pub(crate) fn answer_request(payload: &[u8]) -> Result<Option<Vec<u8>>, String> {
    match composition_transaction::decode(payload) {
        // Apply returns the SESSION the transaction addressed; the reply
        // snapshot renders THAT session's scene (never another document's).
        Ok(Some(transaction)) => {
            let session = scene_state::apply_composition_transaction(transaction)
                .map_err(|e| format!("composition transaction apply error: {}", e))?;
            return Ok(scene_state::render_snapshot_bytes(&session));
        }
        Ok(None) => {}
        // decode already names which step failed (parse or shape).
        Err(reason) => return Err(reason),
    }

    let delta = match serde_json::from_slice::<DeltaPayload>(payload) {
        Ok(delta) if delta.is_delta() => delta,
        Ok(_) => return Ok(None),
        Err(e) => return Err(format!("delta parse error: {}", e)),
    };

    // A delta touches per-ADDRESS sessions; the reply renders the last session
    // the delta actually changed (None = the delta carried no scene content).
    match delta_apply::apply_delta(delta) {
        Ok(Some(session)) => Ok(scene_state::render_snapshot_bytes(&session)),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("delta apply error: {}", e)),
    }
}
