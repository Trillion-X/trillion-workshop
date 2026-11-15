// crates/composition-engine/src/run_in_a_page.rs
//
// PURPOSE
//   The page's one call into the composition engine: `answer_composition(request_bytes) -> snapshot_json_bytes`. The
//   request is a composition transaction or a scene delta, decided by slot_work::answer_request exactly as the slot ABI
//   decides it. An empty reply means there was nothing to render; a request the engine cannot read or apply is thrown
//   as an error with its reason, never answered with a guessed scene.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn answer_composition(request: &[u8]) -> Result<Vec<u8>, JsError> {
    crate::slot_work::answer_request::answer_request(request)
        .map(Option::unwrap_or_default)
        .map_err(|reason| JsError::new(&reason))
}
