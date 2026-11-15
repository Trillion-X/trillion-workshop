//! The module computer compiles trillion-local's storage seam as src/storage/mod.rs builds it for a host that lends
//! SQLite through one statement call (the first cfg below, the one that build already uses), and adds the record store
//! with cfg `hosted_records`: src/storage/record_store, src/records.rs and src/resource_authority.rs leave out, under
//! it, what needs a database file or the rest of trillion-local.

fn main() {
    for name in ["computer_build", "hosted_records"] {
        crate::quiet_println!("cargo:rustc-check-cfg=cfg({name})");
        crate::quiet_println!("cargo:rustc-cfg={name}");
    }
    crate::quiet_println!("cargo:rerun-if-changed=build.rs");
}
