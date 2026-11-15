// crates/resilience/src/lock.rs
//
// StateLock<T> — conditional type alias.
// native: parking_lot::RwLock<T> (poison-free, thread-safe)
// wasm32: WasmCell<T> — a RefCell wrapper that implements Sync.
//
// WASM is single-threaded (Physics constraint). RefCell is safe to share because
// there are no concurrent threads. But RefCell is !Sync, which makes Arc<RefCell<T>>
// !Send, which breaks async Send bounds in the workflow executor (UWHA Task E).
//
// WasmCell wraps RefCell and implements Sync. This is sound because:
// 1. WASM is single-threaded — no concurrent access is physically possible.
// 2. The RefCell runtime borrow checks still protect against re-entrant borrows.
// 3. parking_lot doesn't compile on wasm32 (no futex/thread support).
// 4. std::sync::RwLock isn't available (resilience is no_std on wasm32).
//
// WasmCell exposes .read()/.write()/.borrow()/.borrow_mut() so all call sites
// (both the .read() native paths and .borrow() wasm paths) work.
//
// spin::RwLock ELIMINATED (Round 5): priority inversion under OS scheduler.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

#[cfg(not(target_arch = "wasm32"))]
pub type StateLock<T> = parking_lot::RwLock<T>;

#[cfg(target_arch = "wasm32")]
pub type StateLock<T> = WasmCell<T>;

/// Single-threaded lock for WASM — RefCell with Sync + Send.
///
/// SAFETY: WASM is single-threaded. No concurrent access is possible.
/// The RefCell runtime borrow checks protect against re-entrant borrows.
#[cfg(target_arch = "wasm32")]
pub struct WasmCell<T>(core::cell::RefCell<T>);

#[cfg(target_arch = "wasm32")]
unsafe impl<T> Sync for WasmCell<T> {}
#[cfg(target_arch = "wasm32")]
unsafe impl<T> Send for WasmCell<T> {}

#[cfg(target_arch = "wasm32")]
impl<T> WasmCell<T> {
    pub fn new(value: T) -> Self {
        Self(core::cell::RefCell::new(value))
    }

    pub fn read(&self) -> core::cell::Ref<'_, T> {
        self.0.borrow()
    }

    pub fn write(&self) -> core::cell::RefMut<'_, T> {
        self.0.borrow_mut()
    }

    pub fn borrow(&self) -> core::cell::Ref<'_, T> {
        self.0.borrow()
    }

    pub fn borrow_mut(&self) -> core::cell::RefMut<'_, T> {
        self.0.borrow_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_lock_wraps_value() {
        let lock = StateLock::new(42u32);
        assert_eq!(*lock.read(), 42u32);
    }
}
