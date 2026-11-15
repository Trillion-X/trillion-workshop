#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
pub async fn send_request_bytes_to_other_slots(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    crate::slot_entry::wit_imports::talk_to_other_slots::send_request_bytes(0, bytes)
        .await
        .map_err(|e| format!("http-client talk_to_other_slots dispatch failed: {e}"))
}

#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
pub async fn send_request_bytes_to_other_slots(_bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    Err("http-client: WIT talk-to-other-slots is only available in a wasi slot".to_string())
}
