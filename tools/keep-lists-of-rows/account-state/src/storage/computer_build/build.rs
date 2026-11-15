//! The computer build compiles the engine's storage files with cfg `computer_build` (src/storage/mod.rs leaves out, under it,
//! the supplies and owners that need a database file or the rest of the engine).

fn main() {
    crate::quiet_println!("cargo:rustc-check-cfg=cfg(computer_build)");
    // Set only by the module computer (src/native_entry/module_computer), which adds the record store to this build.
    crate::quiet_println!("cargo:rustc-check-cfg=cfg(hosted_records)");
    crate::quiet_println!("cargo:rustc-cfg=computer_build");
    crate::quiet_println!("cargo:rerun-if-changed=build.rs");
}
