// crates/composition-engine/src/slot_entry/mod.rs
//
// SharedBufferProtocol entry points for the composition-engine slot.

pub(crate) mod do_work_when_asked;
pub(crate) mod read_incoming_bytes;
pub(crate) mod start_up;
pub(crate) mod write_reply_bytes;

// The canonical scene assert can exceed 1 MiB once the imported package set
// carries the full authored extension graph. The slot owns the SharedBuffer ABI
// contract it advertises through `__init_buffers`.
pub(crate) const BUF_CAP: usize = 4 * 1024 * 1024;

pub(crate) static mut INPUT_BUFFER: [u8; BUF_CAP] = [0; BUF_CAP];
pub(crate) static mut OUTPUT_BUFFER: [u8; BUF_CAP] = [0; BUF_CAP];
pub(crate) static mut CMD_BUFFER: [u8; BUF_CAP] = [0; BUF_CAP];

// The host answers these two from its `env` import module; naming it keeps them imports for every linker (a
// wasm32-wasip1 link refuses an undefined symbol unless told it is an import).
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    pub(crate) fn __init_buffers(
        input_ptr: i32,
        input_cap: i32,
        output_ptr: i32,
        output_cap: i32,
        cmd_ptr: i32,
        cmd_cap: i32,
    ) -> i32;
    pub(crate) fn __notify_ready(cmd_len: i32, output_len: i32) -> i32;
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) unsafe fn __init_buffers(
    _input_ptr: i32,
    _input_cap: i32,
    _output_ptr: i32,
    _output_cap: i32,
    _cmd_ptr: i32,
    _cmd_cap: i32,
) -> i32 {
    0
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) unsafe fn __notify_ready(_cmd_len: i32, _output_len: i32) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn init() {
    start_up::start_up();
}

#[no_mangle]
pub extern "C" fn handle_query(input_len: i32) -> i32 {
    do_work_when_asked::do_work_when_asked(input_len)
}
