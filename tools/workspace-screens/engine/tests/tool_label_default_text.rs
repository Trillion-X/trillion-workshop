//! Default Unicode lowercase through the actually selected qualified ICU.
//! These checks exercise JS default casing independently of the selected
//! collator locale; no fallback profile or host ICU is accepted.

use std::{fs, path::PathBuf};
use trillion_local::{
    ecma_json::JsString,
    tool_label_locale::{self, Profile, QualifiedLocale},
};

const MAX_UNITS: usize = 1024 * 1024;

fn qualified() -> QualifiedLocale {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("crates/icu-collation/profile.json");
    let bytes = fs::read(path)
        .expect("the actual selected pinned ICU profile must be prepared; no fallback fixture");
    let profile: Profile = serde_json::from_slice(&bytes).expect("selected pinned ICU profile");
    assert_eq!(profile.icu_version, [78, 2, 0, 0]);
    assert!(matches!(profile.locale_id.as_str(), "en_US" | "en-US"));
    tool_label_locale::open(&profile)
        .expect("selected images/data/probes must qualify before default casing")
}

#[test]
fn default_lowercase_uses_unicode_context_and_expansion() {
    let locale = qualified();
    for (input, expected) in [
        ("", ""),
        ("ASCII Mixed", "ascii mixed"),
        ("İ", "i\u{0307}"),
        ("ΟΣ", "ος"),
        ("ΟΣΑ", "οσα"),
        ("\u{10400}", "\u{10428}"),
    ] {
        assert_eq!(
            locale.to_default_lowercase(&JsString::from(input)).unwrap(),
            JsString::from(expected),
            "ECMAScript default lowercase vector"
        );
    }
}

#[test]
fn default_lowercase_keeps_raw_utf16_and_embedded_nul() {
    let locale = qualified();
    let input = JsString::from_units(vec![0xd800, b'A' as u16, 0, b'B' as u16, 0xdc00]);
    assert_eq!(
        locale.to_default_lowercase(&input).unwrap().units(),
        &[0xd800, b'a' as u16, 0, b'b' as u16, 0xdc00]
    );
}

#[test]
fn default_lowercase_refuses_input_and_expansion_past_the_bound() {
    let locale = qualified();
    let oversized = JsString::from_units(vec![b'A' as u16; MAX_UNITS + 1]);
    assert_eq!(
        locale.to_default_lowercase(&oversized),
        Err(trillion_local::cause!(trillion_local::rule_bindings::Error::Bounds))
    );
    let expansion = JsString::from_units(vec![0x0130; MAX_UNITS / 2 + 1]);
    assert_eq!(
        locale.to_default_lowercase(&expansion),
        Err(trillion_local::cause!(trillion_local::rule_bindings::Error::Bounds))
    );
    assert_eq!(
        locale
            .to_default_lowercase(&JsString::from("AFTER"))
            .unwrap(),
        JsString::from("after")
    );
}
