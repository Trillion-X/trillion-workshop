// src/native_entry/module_computer/host_clock.rs
//
// Purpose: the clock and the randomness the record store reads in the module computer (cfg `hosted_records`). On its
// host (wasm32-unknown-unknown) there is no operating system: `SystemTime::now` panics there, so the clock is the
// host's (`Date.now`) and the randomness is the host's (`crypto.getRandomValues`, through getrandom's `js` backend).
// Elsewhere (this package's own tests) they are the system's.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    return js_sys::Date::now() as u64;
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Fill `bytes` with cryptographic randomness. A host that has none stops the computer: no identifier is ever made from
/// predictable bytes.
pub fn fill_random(bytes: &mut [u8]) {
    getrandom::getrandom(bytes).expect("the host gives cryptographic randomness");
}
