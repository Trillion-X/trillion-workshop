// crates/slot-protocol/src/web_host.rs
//
//! # Web host dispatch (wasm32-unknown-unknown only)
//!
//! Purpose: let a slot crate compiled as a plain WebAssembly module (the kind a
//! browser or Cloudflare Worker loads through wasm-bindgen) reach other slots
//! the same way its wasi slot entry does through `talk-to-other-slots`.
//!
//! Non-negotiable invariants:
//! - The host receives `target`, the partition's canonical multihash wire bytes
//!   and the payload bytes ALREADY SEPARATED. No envelope is encoded here and
//!   none has to be decoded in JavaScript.
//! - The host function is handed in once by the host (`install_host_dispatch`)
//!   and held in a thread-local. Each crate wraps [`dispatch`] into its own
//!   dispatch type; this module never names those crates (they depend on it).
//! - Missing host function, a thrown error, a rejected promise, or a reply that
//!   is not a `Uint8Array` is an `Err(String)`, never a silent empty reply.
//!
//! Host contract (JavaScript):
//! `dispatch(target: string, partition: Uint8Array, payload: Uint8Array | undefined)
//!   -> Uint8Array | Promise<Uint8Array>`
//!
//! Security: this module moves opaque bytes only. What a target may answer is
//! decided by the host's own map of targets, never here.

use std::cell::RefCell;
use std::sync::Arc;

use js_sys::{Function, Promise, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

use crate::PartitionKey;

thread_local! {
    static HOST_DISPATCH: RefCell<Option<Function>> = const { RefCell::new(None) };
}

/// Install the host's dispatch function. Replaces any earlier one.
pub fn install_host_dispatch(host_dispatch: Function) {
    HOST_DISPATCH.with(|slot| *slot.borrow_mut() = Some(host_dispatch));
}

/// True once the host has installed its dispatch function.
pub fn host_dispatch_installed() -> bool {
    HOST_DISPATCH.with(|slot| slot.borrow().is_some())
}

/// Send `payload` to `target` for `partition` through the host and await the
/// reply bytes.
pub async fn dispatch(
    target: &str,
    partition: &PartitionKey,
    payload: Option<&[u8]>,
) -> Result<Arc<[u8]>, String> {
    let host_dispatch = HOST_DISPATCH
        .with(|slot| slot.borrow().clone())
        .ok_or_else(|| {
            format!("web host dispatch to '{target}' failed: the host installed no dispatch function")
        })?;
    let partition_bytes = Uint8Array::from(partition.as_multihash().encode().as_slice());
    let payload_value = match payload {
        Some(bytes) => Uint8Array::from(bytes).into(),
        None => JsValue::UNDEFINED,
    };
    let returned = host_dispatch
        .call3(
            &JsValue::NULL,
            &JsValue::from_str(target),
            &partition_bytes.into(),
            &payload_value,
        )
        .map_err(|error| host_error(target, &error))?;
    let reply = JsFuture::from(Promise::resolve(&returned))
        .await
        .map_err(|error| host_error(target, &error))?;
    let bytes = reply.dyn_into::<Uint8Array>().map_err(|_| {
        format!("web host dispatch to '{target}' failed: the host reply was not a Uint8Array")
    })?;
    Ok(Arc::from(bytes.to_vec()))
}

fn host_error(target: &str, error: &JsValue) -> String {
    let reason = error
        .dyn_ref::<js_sys::Error>()
        .map(|js_error| String::from(js_error.message()))
        .or_else(|| error.as_string())
        .unwrap_or_else(|| "the host gave no reason".to_string());
    format!("web host dispatch to '{target}' failed: {reason}")
}
