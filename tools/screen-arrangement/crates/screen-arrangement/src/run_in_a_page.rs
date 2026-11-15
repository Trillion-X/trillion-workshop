// crates/screen-arrangement/src/run_in_a_page.rs
//
// PURPOSE
//   The page's one call into the arrangement: `arrange_screen(request_json_bytes) -> reply_json_bytes`. A request the
//   arrangement cannot read is thrown as an error with its reason, never answered with a guessed layout.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn arrange_screen(request: &[u8]) -> Result<Vec<u8>, JsError> {
    crate::arrange::arrange_screen_bytes(request).map_err(|reason| JsError::new(&reason))
}
