//! Native text controls on the pinned ICU profile. This target is deliberately unmounted
//! until root adopts the exact parent patch. A missing profile is a failure,
//! never a skip. Expected casing vectors check ICU behavior, not a whole-JS
//! oracle or an equivalence claim beyond separately captured source evidence.

use std::{fs, path::PathBuf};
use trillion_local::{
    ecma_json::JsString,
    rule_bindings::{Error, TextSemantics},
    tool_label_locale::{self, Profile, QualifiedLocale},
};

const MAX_UNITS: usize = 1024 * 1024;

fn selected_profile() -> Profile {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("crates/icu-collation/profile.json");
    let bytes = fs::read(path)
        .expect("the actual selected pinned ICU profile must be prepared; no fallback fixture");
    let profile: Profile =
        serde_json::from_slice(&bytes).expect("selected pinned ICU profile schema");
    assert_eq!(profile.icu_version, [78, 2, 0, 0]);
    assert!(
        matches!(profile.locale_id.as_str(), "en_US" | "en-US"),
        "these vectors require the explicitly selected original en-US locale"
    );
    profile
}

fn qualified() -> QualifiedLocale {
    tool_label_locale::open(&selected_profile())
        .expect("the selected images/data/probes must actually qualify before text calls")
}

#[test]
fn lowercasing_uses_actual_selected_icu_context_and_expansion() {
    let mut locale = qualified();
    for (input, expected) in [
        ("", ""),
        ("ASCII Mixed", "ascii mixed"),
        ("ÄÖÜ", "äöü"),
        ("İ", "i\u{0307}"),
        ("ΟΣ", "ος"),
        ("ΟΣΑ", "οσα"),
        ("\u{10400}", "\u{10428}"),
    ] {
        assert_eq!(
            locale.to_locale_lowercase(&JsString::from(input)).unwrap(),
            JsString::from(expected),
            "actual selected ICU casing vector"
        );
    }
}

#[test]
fn uppercasing_uses_actual_selected_locale_context_and_expansion() {
    let locale = qualified();
    for (input, expected) in [
        ("", ""),
        ("ascii Mixed", "ASCII MIXED"),
        ("i", "I"),
        ("ß", "SS"),
        ("ﬃ", "FFI"),
        ("ὀδυσσεύς", "ὈΔΥΣΣΕΎΣ"),
        ("\u{10428}", "\u{10400}"),
    ] {
        assert_eq!(
            locale.to_locale_uppercase(&JsString::from(input)).unwrap(),
            JsString::from(expected),
            "actual selected ICU locale uppercase vector"
        );
    }
}

#[test]
fn uppercasing_preserves_lone_surrogates_and_embedded_nul() {
    let locale = qualified();
    let input = JsString::from_units(vec![0xd800, 0x0061, 0x0000, 0x00df, 0xdc00]);
    assert_eq!(
        locale.to_locale_uppercase(&input).unwrap().units(),
        &[0xd800, 0x0041, 0x0000, 0x0053, 0x0053, 0xdc00]
    );
}

#[test]
fn shared_native_owner_supplies_the_same_checked_text_semantics() {
    let locale = std::sync::Arc::new(qualified());
    let mut borrowed = locale.as_ref();
    assert_eq!(
        borrowed
            .to_locale_lowercase(&JsString::from("ΟΣ İ"))
            .unwrap(),
        JsString::from("ος i\u{0307}")
    );
    assert!(borrowed
        .trim_is_empty(&JsString::from("\u{feff}\u{2029}"))
        .unwrap());
}

#[test]
fn lowercasing_preserves_lone_surrogates_and_embedded_nul_without_lossy_conversion() {
    let mut locale = qualified();
    let input = JsString::from_units(vec![0xd800, 0x0041, 0x0000, 0x0042, 0xdc00]);
    assert_eq!(
        locale.to_locale_lowercase(&input).unwrap().units(),
        &[0xd800, 0x0061, 0x0000, 0x0062, 0xdc00]
    );
}

#[test]
fn trim_uses_ecmascript_space_and_line_terminators_instead_of_rust_whitespace() {
    let mut locale = qualified();
    let spaces = [
        0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
        0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
        0x205f, 0x3000, 0xfeff,
    ];
    assert!(locale.trim_is_empty(&JsString::from("")).unwrap());
    assert!(locale
        .trim_is_empty(&JsString::from_units(spaces.to_vec()))
        .unwrap());
    for unit in spaces {
        assert!(locale
            .trim_is_empty(&JsString::from_units(vec![unit]))
            .unwrap());
    }
    for non_space in [0x0000, 0x0085, 0x180e, 0x200b, 0x2060, 0xd800, 0xdc00] {
        assert!(!locale
            .trim_is_empty(&JsString::from_units(vec![0xfeff, non_space, 0x0020]))
            .unwrap());
    }
}

#[test]
fn input_and_expanded_output_limits_refuse_without_truncation() {
    let mut locale = qualified();
    let oversized = JsString::from_units(vec![0x0041; MAX_UNITS + 1]);
    assert_eq!(locale.to_locale_lowercase(&oversized), Err(trillion_local::cause!(Error::Bounds)));
    assert_eq!(locale.trim_is_empty(&oversized), Err(trillion_local::cause!(Error::Bounds)));
    assert_eq!(locale.to_locale_uppercase(&oversized), Err(trillion_local::cause!(Error::Bounds)));
    // En-US full lowercase expands U+0130 to two UTF-16 units. The input is
    // within its bound, but no partial output may escape the output bound.
    let expansion = JsString::from_units(vec![0x0130; MAX_UNITS / 2 + 1]);
    assert_eq!(locale.to_locale_lowercase(&expansion), Err(trillion_local::cause!(Error::Bounds)));
    assert_eq!(
        locale
            .to_locale_lowercase(&JsString::from("AFTER"))
            .unwrap(),
        JsString::from("after"),
        "a bounded input refusal does not corrupt the qualified runtime"
    );
    assert_eq!(
        locale
            .to_locale_uppercase(&JsString::from("AFTER"))
            .unwrap(),
        JsString::from("AFTER"),
        "uppercase remains usable after a bounded input refusal"
    );
    // Selected ICU full uppercase expands sharp-s to SS. The input is within
    // its bound, but the complete output exceeds it and must not be truncated.
    let uppercase_expansion = JsString::from_units(vec![0x00df; MAX_UNITS / 2 + 1]);
    assert_eq!(
        locale.to_locale_uppercase(&uppercase_expansion),
        Err(trillion_local::cause!(Error::Bounds))
    );
}

#[test]
fn unqualified_profile_never_creates_a_text_fallback() {
    let selected = selected_profile();
    for change in ["missing-probes", "missing-locale"] {
        let mut profile = selected.clone();
        match change {
            "missing-probes" => profile.probes.clear(),
            "missing-locale" => profile.locale_id.clear(),
            _ => unreachable!(),
        }
        assert!(tool_label_locale::open(&profile).is_err(), "{change}");
    }
}
