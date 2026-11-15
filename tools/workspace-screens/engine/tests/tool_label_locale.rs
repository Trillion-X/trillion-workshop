//! Draft controls for the qualified original-app tool-label comparator.
//!
//! This file is outside Cargo's discovered test targets until the native owner
//! adopts it. It requires the selected pinned profile and the pinned original
//! workerd oracle; absence is an explicit fixture failure, never a skip or a
//! substitute fixture.

use std::{
    cmp::Ordering,
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use content_crypto::advanced::blake3;
use trillion_local::{
    ecma_json::JsString,
    native_boot::tool_screens::ToolLabelLocale,
    tool_label_locale::{self, Profile},
    workspace_tool_screens::Failure,
};

const PROFILE_PATH: &str = "crates/icu-collation/profile.json";
const ORIGINAL_ORACLE_PATH: &str = ".local/original-tool-label-locale-20261026/oracle.json";
const ORIGINAL_ORACLE_BLAKE3: &str =
    "78b3e6aa7bac2f5820ca43003f179f14271ae8540fb9382004ff78fb2e976ba8";

fn root_path(relative: impl AsRef<Path>) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}
fn selected_profile() -> Profile {
    let bytes = fs::read(root_path(PROFILE_PATH))
        .expect("selected pinned workerd ICU profile must be prepared by the source owner");
    let profile: Profile =
        serde_json::from_slice(&bytes).expect("selected pinned ICU profile schema");
    assert_eq!(
        profile.icu_version,
        [78, 2, 0, 0],
        "the selected profile must use ICU 78.2 from the source pinned by V8"
    );
    profile
}
fn original_oracle() -> serde_json::Value {
    let bytes = fs::read(PathBuf::from(std::env::var_os("RETIRED_SNAPSHOT_ROOT").expect("RETIRED_SNAPSHOT_ROOT test setting")).join(ORIGINAL_ORACLE_PATH))
        .expect("pinned original workerd Intl oracle is required");
    assert_eq!(
        blake3::hash(&bytes).to_hex().as_str(),
        ORIGINAL_ORACLE_BLAKE3,
        "original oracle bytes must match the selected incident evidence"
    );
    let oracle: serde_json::Value =
        serde_json::from_slice(&bytes).expect("pinned original oracle JSON");
    assert_eq!(oracle["schema"], "trillion.original-tool-label-locale/v1");
    assert_eq!(oracle["resolved"]["locale"], "en-US");
    assert_eq!(oracle["resolved"]["usage"], "sort");
    assert_eq!(oracle["resolved"]["sensitivity"], "variant");
    assert_eq!(oracle["resolved"]["numeric"], false);
    assert_eq!(oracle["resolved"]["ignorePunctuation"], false);
    assert_eq!(oracle["resolved"]["caseFirst"], "false");
    oracle
}
fn probe_key(left: &[u16], right: &[u16]) -> (Vec<u16>, Vec<u16>) {
    (left.to_vec(), right.to_vec())
}
fn oracle_probes(oracle: &serde_json::Value) -> BTreeMap<(Vec<u16>, Vec<u16>), i8> {
    oracle["probes"]
        .as_array()
        .expect("original oracle probe rows")
        .iter()
        .map(|row| {
            let units = |key: &str| {
                row[key]
                    .as_array()
                    .expect("UTF-16 unit array")
                    .iter()
                    .map(|unit| {
                        u16::try_from(unit.as_u64().expect("nonnegative UTF-16 unit"))
                            .expect("UTF-16 unit is bounded")
                    })
                    .collect::<Vec<_>>()
            };
            let left = units("left");
            let right = units("right");
            let sign = i8::try_from(row["sign"].as_i64().expect("original comparator sign"))
                .expect("small original comparison sign");
            assert_eq!(row["collator_sign"].as_i64(), Some(i64::from(sign)));
            (probe_key(&left, &right), sign)
        })
        .collect()
}
fn comparison_sign(order: Ordering) -> i8 {
    match order {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

#[test]
fn selected_profile_qualifies_every_original_utf16_probe_and_preserves_oracle_ties() {
    let oracle = original_oracle();
    let expected = oracle_probes(&oracle);
    let profile = selected_profile();
    assert_eq!(profile.probes.len(), expected.len());
    let mut supplied = BTreeMap::new();
    for probe in &profile.probes {
        assert!((-1..=1).contains(&probe.sign));
        supplied.insert(probe_key(&probe.left, &probe.right), probe.sign);
    }
    assert_eq!(
        supplied.len(),
        profile.probes.len(),
        "profile pairs are unique"
    );
    assert_eq!(
        supplied, expected,
        "profile probes must retain the original oracle pairs and signs"
    );
    assert!(
        expected.values().any(|sign| *sign == 0),
        "the pinned source oracle includes equivalence probes"
    );

    let locale = tool_label_locale::open(&profile)
        .expect("selected ICU must qualify against source evidence");
    locale.assert_current().unwrap();
    for ((left, right), expected_sign) in &expected {
        let actual = locale
            .compare(
                &JsString::from_units(left.clone()),
                &JsString::from_units(right.clone()),
            )
            .expect("qualified selected ICU comparison");
        assert_eq!(comparison_sign(actual), *expected_sign);
    }
}

#[test]
fn the_engine_locale_is_the_selected_profile_on_the_linked_icu() {
    let profile = selected_profile();
    assert_eq!(
        tool_label_locale::engine_profile()
            .expect("the engine's own profile parses")
            .probes
            .len(),
        profile.probes.len(),
        "the engine profile is the selected profile"
    );
    let locale = tool_label_locale::engine().expect("the linked ICU qualifies against the engine profile");
    locale.assert_current().unwrap();
}

#[test]
fn changed_expected_icu_version_or_any_original_probe_sign_refuses_qualification() {
    let profile = selected_profile();
    let mut wrong_version = profile.clone();
    wrong_version.icu_version[0] = wrong_version.icu_version[0].wrapping_add(1);
    assert!(matches!(
        tool_label_locale::open(&wrong_version),
        Err(Failure::Source(_))
    ));

    let mut wrong_probe = profile;
    let probe = wrong_probe
        .probes
        .first_mut()
        .expect("selected profile carries the original probe set");
    probe.sign = if probe.sign == -1 { 1 } else { -1 };
    assert!(matches!(
        tool_label_locale::open(&wrong_probe),
        Err(Failure::Source(_))
    ));
}
