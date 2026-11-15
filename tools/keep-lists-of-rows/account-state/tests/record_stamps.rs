//! Source-rule fixtures, not a claim of whole-account sync/erasure parity.
use serde_json::{json, Value};
use trillion_local::record_stamps::{self as stamps, Cell, Envelope, EnvelopeBody, Fields, FloorKind, Kept, Meta, OrderedMap, StampMap, State};

fn fields(input: &[(&str, Value)]) -> Fields { input.iter().map(|(name, value)| (name.to_string(), value.clone())).collect() }
fn encoding(value: &Value) -> Result<String, std::convert::Infallible> { Ok(serde_json::to_string(value).unwrap()) }
fn envelope(body: EnvelopeBody, at: &str) -> Envelope {
    Envelope { id: "record".into(), record_type: Some("note".into()), body,
        at: Some(at.into()), floor: None, floor_kind: None, stamps: StampMap::new(), removed: StampMap::new() }
}
fn whole(at: &str, value: &[(&str, Value)]) -> State { stamps::state_from(&envelope(EnvelopeBody::Whole(fields(value)), at), "unused") }
fn patch(at: &str, set: &[(&str, Value)], unset: &[&str]) -> State {
    stamps::state_from(&envelope(EnvelopeBody::Patch { set: fields(set), unset: unset.iter().map(|s| s.to_string()).collect() }, at), "unused")
}
fn joined(a: &State, b: &State) -> State { stamps::merge(a, b, &encoding).unwrap() }
fn semantic(state: &State) -> Value { serde_json::to_value(stamps::kept_from(state)).unwrap() }

#[test]
fn whole_write_floor_discards_older_fields_and_keeps_equal_floor_fields() {
    let old = whole("001", &[("old", json!(1)), ("same", json!("old"))]);
    let replacement = whole("005", &[("fresh", json!(2))]);
    let merged = joined(&old, &replacement);
    let kept = stamps::kept_from(&merged).unwrap();
    assert_eq!(kept.value.unwrap(), fields(&[("fresh", json!(2))]));
    assert_eq!(kept.meta.unwrap(), Meta { at: "005".into(), ..Meta::default() });
    assert_eq!(semantic(&merged), semantic(&joined(&replacement, &old)));
    assert!(stamps::exists(&whole("005", &[])), "a whole empty record remains live");
}

#[test]
fn removed_floor_does_not_resurrect_equal_or_older_fields_but_newer_field_does() {
    let removal = stamps::state_from(&envelope(EnvelopeBody::Remove, "005"), "unused");
    for at in ["001", "005"] {
        let result = joined(&removal, &patch(at, &[("body", json!(null))], &[]));
        assert!(!stamps::exists(&result));
        assert_eq!(stamps::kept_from(&result).unwrap().record_type, None);
    }
    let result = joined(&removal, &patch("006", &[("body", json!(null))], &[]));
    let kept = stamps::kept_from(&result).unwrap();
    assert_eq!(kept.record_type.as_deref(), Some("note"));
    assert_eq!(kept.value.unwrap().get("body"), Some(&Value::Null));
    let meta = kept.meta.unwrap();
    assert_eq!(meta.f.as_deref(), Some("005"));
    assert_eq!(meta.k, Some(FloorKind::Removed));
}

#[test]
fn three_copies_converge_in_all_orders_and_passing_changes_on_again_does_not_change_values() {
    let base = whole("001", &[("p", json!("base")), ("q", json!("base"))]);
    let changes = [patch("002", &[("p", json!("copy-a"))], &[]),
        patch("004", &[("q", json!("copy-b"))], &[]),
        patch("003", &[("r", json!("copy-c"))], &["p"])];
    let reference = semantic(&joined(&joined(&joined(&base, &changes[0]), &changes[1]), &changes[2]));
    for order in [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]] {
        let mut state = base.clone();
        for index in order { state = joined(&state, &changes[index]); }
        for index in order.into_iter().rev() { state = joined(&state, &changes[index]); }
        assert_eq!(semantic(&state), reference);
        assert_eq!(semantic(&joined(&state, &state)), reference);
    }
    assert_eq!(semantic(&joined(&joined(&changes[0], &changes[1]), &changes[2])),
        semantic(&joined(&changes[0], &joined(&changes[1], &changes[2]))));
}

#[test]
fn per_field_stamps_and_removal_floor_survive_compact_value_model_roundtrip() {
    let mut sent = envelope(EnvelopeBody::Whole(fields(&[("earlier", json!(1)), ("latest", json!(2))])), "009");
    sent.floor = Some("005".into()); sent.floor_kind = Some(FloorKind::Removed);
    sent.stamps.insert("earlier", "007".into());
    sent.removed.insert("gone", "008".into());
    let state = stamps::state_from(&sent, "unused");
    let kept = stamps::kept_from(&state).unwrap();
    let meta = kept.meta.as_ref().unwrap();
    assert_eq!(meta.s.get("earlier").map(String::as_str), Some("007"));
    assert_eq!(meta.d.get("gone").map(String::as_str), Some("008"));
    let carried = stamps::envelope_of_kept("record", &kept).unwrap();
    let restored = stamps::state_from(&carried, "wrong-fallback");
    assert_eq!(semantic(&restored), semantic(&state));
    assert_eq!(semantic(&stamps::state_of(Some(&kept))), semantic(&state));
    let removal = stamps::kept_from(&stamps::state_from(&envelope(EnvelopeBody::Remove, "010"), "unused")).unwrap();
    assert_eq!(semantic(&joined(&restored, &stamps::state_of(Some(&removal)))), serde_json::to_value(Some(removal)).unwrap());
}

#[test]
fn local_stamp_advances_beyond_a_remote_stamp_even_when_local_clock_is_behind() {
    assert_eq!(stamps::stamp_after("0000000000000000002", "9999999999999999999").unwrap(), "99999999999999999990000002");
    assert_eq!(stamps::stamp_after("010", "009").unwrap(), "010");
    assert_eq!(stamps::stamp_after("010", "010").unwrap(), "010010");
    assert_eq!(stamps::stamp_after("short", "zz").unwrap(), "zzshort");
    assert_eq!(stamps::stamp_after("001", "").unwrap(), "001");
    assert!(stamps::stamp_after("😀123456", "\u{e000}").is_err(), "do not replace a split surrogate with a different stamp");
}

#[test]
fn same_stamp_content_ties_prefer_removal_then_lower_original_json_text() {
    let a = patch("010", &[("body", json!("z"))], &[]);
    let b = patch("010", &[("body", json!("a"))], &[]);
    let erased = patch("010", &[], &["body"]);
    for (left, right) in [(&a, &b), (&b, &a)] {
        assert_eq!(joined(left, right).fields.get("body"), Some(&Cell::live("010", json!("a"))));
    }
    assert!(joined(&a, &erased).fields.get("body").unwrap().is_removed());
    assert!(joined(&erased, &a).fields.get("body").unwrap().is_removed());
    let supplementary = patch("010", &[("body", json!("😀"))], &[]);
    let bmp = patch("010", &[("body", json!("\u{e000}"))], &[]);
    assert_eq!(joined(&supplementary, &bmp).fields.get("body"), supplementary.fields.get("body"), "UTF-16 differs from UTF-8 order here");
}

#[test]
fn supplied_encoding_is_used_and_failure_does_not_mutate_either_input() {
    let a = patch("010", &[("body", json!(1e20))], &[]);
    let b = patch("010", &[("body", json!(2))], &[]);
    let exact = |value: &Value| -> Result<String, ()> {
        if value == &json!(1e20) { Ok("100000000000000000000".into()) } else { Ok("2".into()) }
    };
    assert_eq!(stamps::merge(&a, &b, &exact).unwrap().fields.get("body"), a.fields.get("body"));
    let before = (a.clone(), b.clone());
    assert_eq!(stamps::merge(&a, &b, &|_: &Value| Err::<String, _>("codec unavailable")), Err("codec unavailable"));
    assert_eq!((a, b), before);
}

#[test]
fn metadata_is_sorted_by_utf16_and_object_index_names_are_enumerated_numerically() {
    let mut value = Fields::new();
    for name in ["z", "10", "2", "\u{e000}", "😀", "a"] { value.insert(name, json!(name)); }
    value.insert("latest", json!(true));
    let mut sent = envelope(EnvelopeBody::Whole(value), "009");
    sent.floor = Some("001".into());
    for name in ["z", "10", "2", "\u{e000}", "😀", "a"] { sent.stamps.insert(name, "008".into()); }
    let expanded = stamps::state_from(&sent, "unused");
    assert_eq!(expanded.fields.keys().collect::<Vec<_>>(), ["2", "10", "z", "\u{e000}", "😀", "a", "latest"]);
    let kept = stamps::kept_from(&expanded).unwrap();
    assert_eq!(kept.meta.unwrap().s.keys().collect::<Vec<_>>(), ["2", "10", "a", "z", "😀", "\u{e000}"]);
}

#[test]
fn unset_wins_a_same_envelope_set_and_whole_removed_map_wins_its_value() {
    let state = patch("003", &[("a", json!(true))], &["a"]);
    assert!(state.fields.get("a").unwrap().is_removed());
    let mut sent = envelope(EnvelopeBody::Whole(fields(&[("a", json!(true))])), "003");
    sent.removed.insert("a", "004".into());
    assert_eq!(stamps::state_from(&sent, "unused").fields.get("a"), Some(&Cell::removed("004")));
}

#[test]
fn legacy_kept_fields_have_empty_stamps_and_transport_requires_real_meta() {
    let kept = Kept { record_type: Some("note".into()), value: Some(fields(&[("a", json!(false))])), meta: None };
    let state = stamps::state_of(Some(&kept));
    assert_eq!(state.floor, ""); assert_eq!(state.kind, Some(FloorKind::Whole));
    assert_eq!(state.fields.get("a"), Some(&Cell::live("", json!(false))));
    assert!(stamps::envelope_of_kept("record", &kept).is_err());
    assert_eq!(stamps::state_of(None), State::default());
    assert_eq!(stamps::kept_from(&State::default()), None);
}

#[test]
fn original_equal_type_stamp_left_preference_is_preserved_and_not_hidden_as_convergence() {
    let mut a = whole("001", &[("a", json!(1))]);
    let mut b = a.clone(); a.record_type = Some("left".into()); b.record_type = Some("right".into());
    assert_eq!(joined(&a, &b).record_type.as_deref(), Some("left"));
    assert_eq!(joined(&b, &a).record_type.as_deref(), Some("right"));
}

#[test]
fn duplicate_map_names_keep_first_position_last_value_and_kept_equality_uses_actual_encoder() {
    let decoded: OrderedMap<Value> = serde_json::from_str(r#"{"b":1,"a":2,"b":3}"#).unwrap();
    assert_eq!(decoded.keys().collect::<Vec<_>>(), ["b", "a"]);
    assert_eq!(decoded.get("b"), Some(&json!(3)));
    let a = stamps::kept_from(&whole("001", &[("b", json!(1)), ("a", json!(2))])).unwrap();
    let b = stamps::kept_from(&whole("001", &[("a", json!(2)), ("b", json!(1))])).unwrap();
    let encode = |kept: Option<&Kept>| serde_json::to_vec(&kept);
    assert!(!stamps::same_kept(Some(&a), Some(&b), &encode).unwrap());
    assert!(stamps::same_kept(Some(&a), Some(&a), &encode).unwrap());
}
