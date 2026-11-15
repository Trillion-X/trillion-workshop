// build.rs
//
// Purpose: Build the pinned ICU 78.2 source as static libraries and link them into the engine, the same way on every computer.
// Invariants: The tarball's byte size and BLAKE3 must equal icu-source.json (beside this file) before any byte is unpacked.
//   The symbols keep ICU's own _78 suffix. No system ICU, no dynamic loading, no other collation library.
// Security: Downloads only the pinned https URL. TRILLION_ICU_TARBALL may name an already downloaded tarball; it is pin-checked the same way.
// Cross builds: a target other than the building computer is built from the same source with configure's `--host` (the
//   target's autoconf name, icu-source.json `configure_host`, else the target itself) and `--with-cross-build` (the
//   building computer's own ICU build, made first, whose tools build the data). Its compilers are the ones cc-rs reads
//   (CC_<target>, CXX_<target>, AR_<target>, RANLIB_<target>), its C++ runtime CXXSTDLIB_<target> when given. A
//   `cargo check` links nothing: TRILLION_ICU_CHECK_ONLY=1 builds and links no ICU at all.
// AI Assistant Directive: Change the pin only with the new tarball's byte size and BLAKE3, computed from that tarball.

use content_crypto::advanced::blake3;
use serde::Deserialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const PIN: &str = "icu-source.json";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    version: String,
    url: String,
    bytes: u64,
    blake3: String,
    configure_args: Vec<String>,
    /// configure's `--host` for a target whose autoconf name is not the target itself.
    configure_host: std::collections::BTreeMap<String, String>,
    /// The source folders a cross build makes and installs, in order: the libraries and the data only. The target's
    /// own tools are never made; the building computer's tools make its data.
    cross_make_folders: Vec<String>,
    libraries: Vec<String>,
    /// The static libraries' names for a target whose ICU names them otherwise (by target).
    libraries_by_target: std::collections::BTreeMap<String, Vec<String>>,
    cxx_runtime: CxxRuntime,
}

/// The C++ runtime library ICU's archives need, chosen by the target's vendor or C library (`CARGO_CFG_TARGET_VENDOR`,
/// `CARGO_CFG_TARGET_ENV`), never by its system's name. An empty name links none (a toolchain that brings its own).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CxxRuntime {
    by_vendor: std::collections::BTreeMap<String, String>,
    by_env: std::collections::BTreeMap<String, String>,
    otherwise: String,
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets the manifest dir"));
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={PIN}");
    println!("cargo:rerun-if-env-changed=TRILLION_ICU_TARBALL");
    println!("cargo:rerun-if-env-changed=TRILLION_ICU_CACHE");
    println!("cargo:rerun-if-env-changed=TRILLION_ICU_CHECK_ONLY");
    let pin: Pin = serde_json::from_slice(&fs::read(manifest.join(PIN)).expect("read the ICU pin"))
        .expect("parse the ICU pin");
    if env::var("TRILLION_ICU_CHECK_ONLY").as_deref() == Ok("1") {
        // A check compiles the Rust declarations of ICU's C API and links nothing.
        return;
    }
    let target = |name: &str| env::var(name).unwrap_or_default();
    let building_for = target("TARGET");
    let c_plus_plus = tool("CXXSTDLIB", &building_for).unwrap_or_else(|| {
        pin.cxx_runtime.by_vendor.get(&target("CARGO_CFG_TARGET_VENDOR"))
            .or_else(|| pin.cxx_runtime.by_env.get(&target("CARGO_CFG_TARGET_ENV")))
            .unwrap_or(&pin.cxx_runtime.otherwise)
            .clone()
    });
    let building_on = target("HOST");
    let install = if building_for == building_on {
        build_or_reuse(&manifest, &pin, None)
    } else {
        // The building computer's own ICU build first: its tools make the target's data.
        let own = build_or_reuse(&manifest, &pin, None);
        let tools = own.parent().expect("an install has a cache folder").join("src").join("icu").join("source");
        build_or_reuse(&manifest, &pin, Some(Cross { target: &building_for, tools: &tools }))
    };
    let lib = install.join("lib");
    println!("cargo:rustc-link-search=native={}", lib.display());
    for library in pin.libraries_by_target.get(&building_for).unwrap_or(&pin.libraries) {
        println!("cargo:rustc-link-lib=static={library}");
        println!("cargo:rerun-if-changed={}", lib.join(format!("lib{library}.a")).display());
    }
    if !c_plus_plus.is_empty() {
        println!("cargo:rustc-link-lib={c_plus_plus}");
    }
}

/// A build for a target other than the building computer: the target, and the building computer's own ICU build.
struct Cross<'a> {
    target: &'a str,
    tools: &'a Path,
}

/// A tool for `target` the way cc-rs names it: `NAME_<target>` (with `-` or `_`), `TARGET_NAME`, then `NAME`.
fn tool(name: &str, target: &str) -> Option<String> {
    for key in [format!("{name}_{target}"), format!("{name}_{}", target.replace('-', "_")), format!("TARGET_{name}"), name.to_owned()] {
        println!("cargo:rerun-if-env-changed={key}");
        if let Ok(value) = env::var(&key) {
            return Some(value);
        }
    }
    None
}

/// The install prefix for this pin (and for `cross`'s target). Reused when its completion marker exists; built otherwise.
fn build_or_reuse(manifest: &Path, pin: &Pin, cross: Option<Cross>) -> PathBuf {
    let root = match &cross {
        None => cache_root(manifest, pin),
        Some(cross) => cache_root(manifest, pin).with_file_name(format!("{}-{}-{}", pin.version, &pin.blake3[..16], cross.target)),
    };
    let install = root.join("install");
    if install.join(".complete").exists() {
        return install;
    }
    fs::create_dir_all(&root).expect("create the ICU cache");
    let tarball = tarball(&root, pin);
    let sources = root.join("src");
    let _ = fs::remove_dir_all(&sources);
    fs::create_dir_all(&sources).expect("create the ICU source directory");
    run(Command::new("tar").arg("-xzf").arg(&tarball).arg("-C").arg(&sources), &root.join("tar.log"));
    let source = sources.join("icu").join("source");
    let mut configure = Command::new(source.join("configure"));
    configure.current_dir(&source).arg(format!("--prefix={}", install.display())).args(&pin.configure_args);
    if let Some(cross) = &cross {
        let host = pin.configure_host.get(cross.target).map(String::as_str).unwrap_or(cross.target);
        configure.arg(format!("--host={host}")).arg(format!("--with-cross-build={}", cross.tools.display()));
        for (name, variable) in [("CC", "CC"), ("CXX", "CXX"), ("AR", "AR"), ("RANLIB", "RANLIB")] {
            match tool(name, cross.target) {
                Some(value) => { configure.env(variable, value); }
                None if name == "CC" || name == "CXX" => panic!(
                    "building ICU for {} needs its {name}: set {name}_{} (docs/build-targets.md)", cross.target, cross.target.replace('-', "_")),
                None => {}
            }
        }
    }
    run(&mut configure, &root.join("configure.log"));
    let jobs = env::var("NUM_JOBS").unwrap_or_else(|_| "2".into());
    if cross.is_some() {
        // The folders' shared outputs, which the whole-tree make would have made first.
        for made in [source.join("lib"), source.join("bin"), install.join("lib"), install.join("bin")] {
            fs::create_dir_all(made).expect("create ICU's output folders");
        }
        for folder in &pin.cross_make_folders {
            let at = source.join(folder);
            run(Command::new("make").current_dir(&at).arg(format!("-j{jobs}")), &root.join(format!("make-{folder}.log")));
            run(Command::new("make").current_dir(&at).arg("install"), &root.join(format!("install-{folder}.log")));
        }
    } else {
        run(Command::new("make").current_dir(&source).arg(format!("-j{jobs}")), &root.join("make.log"));
        run(Command::new("make").current_dir(&source).arg("install"), &root.join("install.log"));
    }
    fs::write(install.join(".complete"), b"").expect("mark the ICU build complete");
    install
}

/// `TRILLION_ICU_CACHE`, else the target directory's `icu4c` folder. Keyed by version and pin, so a new pin never
/// reuses an old build.
fn cache_root(manifest: &Path, pin: &Pin) -> PathBuf {
    let base = match env::var_os("TRILLION_ICU_CACHE") {
        Some(dir) => PathBuf::from(dir),
        None => env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| manifest.join("target"))
            .join("icu4c"),
    };
    base.join(format!("{}-{}", pin.version, &pin.blake3[..16]))
}

/// The pinned tarball: the named local file, or the cached download (fetched once, then checked again).
fn tarball(root: &Path, pin: &Pin) -> PathBuf {
    if let Some(given) = env::var_os("TRILLION_ICU_TARBALL") {
        let path = PathBuf::from(given);
        check_pin(&path, pin).unwrap_or_else(|error| panic!("{error}"));
        return path;
    }
    let path = root.join(format!("icu4c-{}-sources.tgz", pin.version));
    if check_pin(&path, pin).is_err() {
        let partial = root.join("download.partial");
        let _ = fs::remove_file(&partial);
        run(
            Command::new("curl")
                .args(["--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", "--output"])
                .arg(&partial)
                .arg(&pin.url),
            &root.join("download.log"),
        );
        check_pin(&partial, pin).unwrap_or_else(|error| panic!("{error}"));
        fs::rename(&partial, &path).expect("keep the pinned ICU tarball");
    }
    path
}

/// The exact byte size and BLAKE3 of the pinned tarball, read in full.
fn check_pin(path: &Path, pin: &Pin) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    if bytes.len() as u64 != pin.bytes {
        return Err(format!("{} is {} bytes; the ICU pin is {}", path.display(), bytes.len(), pin.bytes));
    }
    let hash = blake3::hash(&bytes).to_hex();
    if hash.as_str() != pin.blake3 {
        return Err(format!("{} has BLAKE3 {}; the ICU pin is {}", path.display(), hash.as_str(), pin.blake3));
    }
    Ok(())
}

fn run(command: &mut Command, log: &Path) {
    let file = fs::File::create(log).expect("create a build log");
    let status = command
        .stdout(Stdio::from(file.try_clone().expect("share the build log")))
        .stderr(Stdio::from(file))
        .status()
        .unwrap_or_else(|error| panic!("start {:?}: {error}", command.get_program()));
    if !status.success() {
        panic!("{:?} failed with {status}; see {}", command.get_program(), log.display());
    }
}
