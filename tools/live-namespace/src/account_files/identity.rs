//! The product's identity, read once from the product settings file the launcher of this computer writes and names in
//! the launch setting `identity.json` declares (`launch_setting`). No product word, host, tools source or secret
//! helper is shipped here: every engine name that carries the product's word (a header, a launch setting, a hash
//! domain) and every product address is built from that file, never written as a literal. A missing, oversized or
//! malformed file is refused with `Malformed`, which names the setting.
//!
//! Besides the identity fields, the file may hold the `sections` the setting declares, each read by its own owner
//! through `section` (where secrets live, the root credentials folder, the tools' source, the hosting app's report,
//! the one-time carry). A section the setting does not declare is not read: it is counted in one log line and
//! skipped, so a newer launcher's file still loads here.

use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, fmt, io::Read, sync::OnceLock};

/// This module's own setting: which launch setting names the product settings file, and what it may hold.
#[derive(Deserialize)]
struct Setting {
    launch_setting: String,
    max_bytes: u64,
    sections: Vec<String>,
}

fn setting() -> &'static Setting {
    static VALUE: OnceLock<Setting> = OnceLock::new();
    VALUE.get_or_init(|| serde_json::from_slice(include_bytes!("identity.json")).expect("src/account_files/identity.json is valid"))
}

/// The name of the launch setting that names the product settings file.
pub fn launch_setting() -> &'static str {
    &setting().launch_setting
}

/// The product settings are not readable (the launch setting is absent, the file is missing, too large or malformed,
/// the word is empty, or a name cannot be made from it).
#[derive(Debug, Clone)]
pub struct Malformed(crate::refusal_cause::Cause);
impl Malformed {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.0 }
}
crate::impl_caused!(Malformed);
impl PartialEq for Malformed { fn eq(&self, _: &Self) -> bool { true } }
impl Eq for Malformed {}
impl fmt::Display for Malformed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "the product settings the launch setting {} names are missing or malformed", launch_setting())
    }
}
impl std::error::Error for Malformed {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
/// An account read that needs the identity it cannot have is unavailable source.
impl From<Malformed> for crate::account::AccountError {
    fn from(error: Malformed) -> Self {
        Self::SourceUnavailable(error.cause())
    }
}

#[derive(Deserialize)]
pub struct Identity {
    pub word: String,
    pub site_host: String,
    pub app_host: String,
    pub brand_mark_path: String,
    pub restore_placeholder_owner: String,
    #[serde(flatten)]
    sections: BTreeMap<String, Value>,
    #[serde(skip)]
    bytes: Vec<u8>,
}

/// The identity in `bytes`, when it is a valid product settings file: a word, and only the sections the setting declares.
fn parse(bytes: Vec<u8>) -> Result<Identity, Malformed> {
    let mut identity: Identity = serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(Malformed, error))?;
    let declared = |name: &String| name.starts_with('_') || setting().sections.contains(name);
    if identity.word.is_empty() { return Err(crate::cause!(Malformed)); }
    let undeclared = identity.sections.keys().filter(|name| !declared(name)).count();
    if undeclared > 0 {
        crate::quiet_eprintln!("product-settings event=undeclared-sections count={undeclared}");
        identity.sections.retain(|name, _| declared(name));
    }
    identity.bytes = bytes;
    Ok(identity)
}

static NAMED: OnceLock<std::path::PathBuf> = OnceLock::new();

/// The product settings file a computer's config names (`product_settings`), set when the config is read, before the first
/// identity read. The launch setting, when set, overrides it.
pub fn name_settings_file(path: &std::path::Path) {
    let _ = NAMED.set(path.to_path_buf());
}

/// The file the identity reads: the launch setting's when it is set, else the one the config named.
fn settings_path(launch: Option<std::path::PathBuf>, named: Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    launch.or(named)
}

/// The declared sections a settings file lacks, in the setting's own order.
pub fn absent_sections(identity: &Identity) -> Vec<&'static str> {
    setting().sections.iter().filter(|name| !identity.sections.contains_key(name.as_str())).map(String::as_str).collect()
}

/// Names each absent declared section at startup (`product-settings event=absent-section`). Absence is a valid state for a
/// product that does not use the section, but it is never silent.
pub fn report_absent(identity: &Identity) -> Vec<&'static str> {
    let absent = absent_sections(identity);
    for name in &absent { crate::quiet_eprintln!("product-settings event=absent-section section={name}"); }
    absent
}

/// The absent declared sections of the settings in `bytes`, as the startup parse reads them (no file, no launch setting).
pub fn absent_sections_of(bytes: Vec<u8>) -> Result<Vec<&'static str>, Malformed> {
    parse(bytes).map(|identity| absent_sections(&identity))
}

/// The product settings the launch setting names: an absolute path to a regular file of at most `max_bytes`, read once.
pub fn identity() -> Result<&'static Identity, Malformed> {
    static IDENTITY: OnceLock<Result<Identity, Malformed>> = OnceLock::new();
    IDENTITY
        .get_or_init(|| {
            let path = settings_path(std::env::var_os(launch_setting()).map(std::path::PathBuf::from), NAMED.get().cloned()).ok_or(crate::cause!(Malformed))?;
            let limit = setting().max_bytes;
            if !path.is_absolute() { return Err(crate::cause!(Malformed)); }
            let metadata = std::fs::metadata(&path).map_err(|error| crate::carry_cause!(Malformed, error))?;
            if !metadata.is_file() { return Err(crate::cause!(Malformed)); }
            let mut bytes = Vec::new();
            std::fs::File::open(&path).map_err(|error| crate::carry_cause!(Malformed, error))?
                .take(limit + 1).read_to_end(&mut bytes).map_err(|error| crate::carry_cause!(Malformed, error))?;
            if bytes.len() as u64 > limit { return Err(crate::cause!(Malformed)); }
            let identity = parse(bytes)?;
            report_absent(&identity);
            Ok(identity)
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The product settings file's bytes, also what an AI instruction fill `{"from": "identity"}` reads
/// (src/mcp/instructions.rs).
pub fn bytes() -> Result<&'static [u8], Malformed> {
    identity().map(|identity| identity.bytes.as_slice())
}

/// The section `name` of the product settings (one the setting declares), `None` when the launcher wrote none.
pub fn section(name: &str) -> Result<Option<&'static Value>, Malformed> {
    debug_assert!(setting().sections.iter().any(|declared| declared == name), "{name} is a declared section");
    identity().map(|identity| identity.sections.get(name))
}

/// The product's identity word.
pub fn word() -> Result<&'static str, Malformed> {
    identity().map(|identity| identity.word.as_str())
}

/// `text` with each `{word}` replaced by the product's identity word: how an engine setting names a product-specific
/// item (a Keychain item, an account attribute) without writing the product's name. The word must be plain lowercase
/// letters, digits and `-`, so the result stays valid JSON text and a valid item name.
pub fn named(text: &str) -> Result<String, Malformed> {
    let word = word()?;
    if !word.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err(crate::cause!(Malformed));
    }
    Ok(text.replace("{word}", word))
}

/// `x-{word}-{suffix}`: one of the product's response headers.
pub fn header_name(suffix: &str) -> Result<axum::http::HeaderName, Malformed> {
    axum::http::HeaderName::from_bytes(format!("x-{}-{suffix}", word()?).as_bytes()).map_err(|error| crate::carry_cause!(Malformed, error))
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_launch_settings_product_reads_with_a_word() {
        assert!(!super::word().unwrap().is_empty());
        assert!(super::header_name("hold-stage").is_ok());
    }

    #[test]
    fn a_product_settings_file_with_no_word_is_refused_and_an_undeclared_section_is_skipped() {
        let good = br#"{"word":"w","site_host":"s.example","app_host":"a.example","brand_mark_path":"/m.svg","restore_placeholder_owner":"o","secret_home":{}}"#;
        assert!(super::parse(good.to_vec()).is_ok());
        let undeclared = br#"{"word":"w","site_host":"s","app_host":"a","brand_mark_path":"/m","restore_placeholder_owner":"o","more":1}"#;
        let loaded = super::parse(undeclared.to_vec()).expect("an undeclared section does not refuse the file");
        assert!(loaded.sections.is_empty(), "an undeclared section is not kept");
        let empty = br#"{"word":"","site_host":"s","app_host":"a","brand_mark_path":"/m","restore_placeholder_owner":"o"}"#;
        assert!(super::parse(empty.to_vec()).is_err());
    }

    #[test]
    fn malformed_settings_preserve_each_exact_parse_condition_without_values() {
        let missing_word = super::parse(br#"{"site_host":"private-value"}"#.to_vec()).err().unwrap();
        let empty_word = super::parse(br#"{"word":"","site_host":"private-value","app_host":"a","brand_mark_path":"/m","restore_placeholder_owner":"o"}"#.to_vec()).err().unwrap();
        let causes = [missing_word.cause(), empty_word.cause()];
        assert_ne!(causes[0], causes[1]);
        for (error, cause) in [missing_word, empty_word].into_iter().zip(causes) {
            assert_eq!(cause.file(), "src/account_files/identity.rs");
            assert!(!cause.id().contains("private-value"));
            let account: crate::account::AccountError = error.into();
            assert_eq!(account.cause(), cause);
        }
    }
}

// ---- item 3, boot-level (product settings drift from main: a settings file with no sign_up_hosting section) ----

#[cfg(test)]
mod drift_scenario_tests {
    use super::*;

    /// A place starts from a synthetic product settings file that declares sections but has no `sign_up_hosting` one (drift
    /// from main). The startup parse must name the missing declared section, in an identity record or a health row; today it
    /// accepts the file and records nothing about the drift. The scenario fails until the start names it (owner
    /// site-off-hosting, D25).
    fn product_settings_drift_is_named_at_boot_body() -> std::result::Result<(), String> {
        let drifted = br#"{"word":"synthetic-product","site_host":"example.invalid","app_host":"example.invalid","brand_mark_path":"","restore_placeholder_owner":"","sections":{"page_look":{}}}"#.to_vec();
        let absent = absent_sections_of(drifted).map_err(|_| "the startup parse refused a settings file with a missing section".to_string())?;
        if !absent.contains(&"sign_up_hosting") {
            return Err("the startup parse names no missing sign_up_hosting section".into());
        }
        Ok(())
    }

    #[test]
    fn product_settings_drift_is_named_at_boot() {
        crate::simulation::verdict("product-settings-drift-is-named-at-boot", product_settings_drift_is_named_at_boot_body);
    }
}

#[cfg(test)]
mod settings_path_tests {
    use super::settings_path;
    use std::path::PathBuf;

    #[test]
    fn the_launch_setting_overrides_the_file_the_config_names_and_the_config_names_it_otherwise() {
        let named = Some(PathBuf::from("/var/lib/unit/product-settings.json"));
        let launch = Some(PathBuf::from("/tmp/override.json"));
        assert_eq!(settings_path(None, named.clone()), named, "the config names the file when the launch setting is absent");
        assert_eq!(settings_path(launch.clone(), named), launch, "the launch setting wins when both are set");
        assert_eq!(settings_path(None, None), None, "neither names a file");
    }
}
