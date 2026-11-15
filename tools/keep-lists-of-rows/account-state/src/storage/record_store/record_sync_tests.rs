// Record sync (digest.rs, stamps.rs, record_sync.rs, record_log.rs), held to old trillion's assertions.
//
// - `digest_*` / `stamps_*`: the same rows give the roots, bucket texts and merged states old trillion's
//   record-digest.mjs and record-stamps.mjs gave for them (computed by the old modules, Trillion-X/trillion d273ef3).
// - `vectors_*`: test/record-sync-vectors.test.mjs, one test for one test, over this engine's store.
// - `settle_*`: test/record-sync.test.mjs's settle between a copy and the copy it follows, and the cases of the
//   2026-11-03 port: two computers that both moved end on one root; a one-record change costs the same on a small and a
//   large store; an empty computer starts by the same settle; a conflict keeps the losing version; a repeated settle
//   writes nothing; a 4.3 MB record crosses.
// - `bucket_*`: test/record-sync-selected-bucket-stability.test.mjs and record-sync-outbound-read-bounds.test.mjs.

use super::digest::{bucket_of, bucket_text, json_text, text_hash, Sums};
use super::record_log::RecordLog;
use super::record_sync::*;
use super::stamps::{kept_from, merge, stamp_after, state_from, Envelope, Fields, Meta};
use crate::storage::memory::Memory;
use serde_json::{json, Value};
use std::collections::HashMap;

fn fields(value: Value) -> Fields {
    match value {
        Value::Object(map) => map,
        _ => Fields::new(),
    }
}

// ---- digest and stamps: byte-identical with old trillion ----

#[test]
fn digest_text_hash_and_buckets_match_old_trillion() {
    for (text, a, b) in [
        ("", 2872998923u32, 3954623016u32),
        ("a", 711464985, 3235027102),
        ("record-00000", 1286354747, 3093955771),
        ("héllo ✓ 𝄞", 1512320600, 2603882073),
        ("\u{0}kind", 3601004111, 1594451501),
    ] {
        assert_eq!(text_hash(text), [a, b], "{text:?}");
    }
    assert_eq!(bucket_of("shared"), 77);
    assert_eq!(bucket_of("record-00000"), 59);
    assert_eq!(bucket_of("kept-apart:contested"), 157);
}

#[test]
fn digest_roots_match_old_trillion_for_the_same_rows() {
    assert_eq!(Sums::new().root(), "836deb93db9234aa");
    let mut sums = Sums::new();
    sums.add("note-1", "note", &fields(json!({ "payload": "one", "count": 3, "ratio": 0.5, "tags": ["a", "b"], "nested": { "a": 1, "b": [true, null] } })));
    sums.stamps("note-1", None, Some(&Meta { at: "0190000000000000000".into(), ..Meta::default() }.text()));
    sums.add("note-2", "note", &fields(json!({ "payload": "two", "big": 1e21, "small": 1e-7, "neg": -0.25 })));
    let mut s = std::collections::BTreeMap::new();
    s.insert("big".to_string(), "0190000000000000001".to_string());
    sums.stamps("note-2", None, Some(&Meta { at: "0190000000001000000".into(), s: Some(s), ..Meta::default() }.text()));
    sums.stamps("gone", None, Some(&Meta { at: "0190000000002000000".into(), k: Some("removed".into()), ..Meta::default() }.text()));
    assert_eq!(bucket_text(&sums.text(), bucket_of("note-1")), "e0d7ba29b6e88dc5");
    assert_eq!(sums.root(), "c4001499801749d1");
    assert_eq!(json_text(&json!(1e21)), "1e+21");
    assert_eq!(json_text(&json!(1e-7)), "1e-7");
}

#[test]
fn stamps_merge_like_old_trillion_in_either_order() {
    assert_eq!(stamp_after("0190000000000000005", Some("0190000000000000009")), "01900000000000000090000005");
    assert_eq!(stamp_after("0190000000000000009", Some("0190000000000000005")), "0190000000000000009");
    let a = state_from(&Envelope { id: "x".into(), kind: Some("note".into()), value: Some(fields(json!({ "p": "left", "q": 1 }))), ..Envelope::default() }, "01900000000000a0000");
    let b = state_from(&Envelope { id: "x".into(), kind: Some("note".into()), set: Some(fields(json!({ "p": "right" }))), ..Envelope::default() }, "01900000000000b0000");
    let expected = r#"{"type":"note","value":{"p":"right","q":1},"meta":{"at":"01900000000000b0000","f":"01900000000000a0000","s":{"q":"01900000000000a0000"}}}"#;
    for kept in [kept_from(&merge(&a, &b)), kept_from(&merge(&b, &a))] {
        assert_eq!(serde_json::to_string(&kept.unwrap()).unwrap(), expected);
    }
}

// ---- record-sync-vectors.test.mjs ----

struct Side {
    name: &'static str,
    records: RecordLog<Memory>,
    seen: HashMap<String, Option<String>>,
}

fn store(name: &'static str) -> Side {
    Side { name, records: RecordLog::new(Memory::open("record_store").unwrap(), "account", "own-records"), seen: HashMap::new() }
}
fn write(side: &mut Side, id: &str, payload: &str) {
    side.records.write(&[(id, "note", Some(fields(json!({ "payload": payload }))))], Actor::by("person")).unwrap();
}
fn read(side: &Side, id: &str) -> Option<String> {
    side.records.read(id).unwrap().and_then(|value| value.get("payload").and_then(Value::as_str).map(str::to_string))
}
fn root(side: &Side) -> String {
    side.records.checksum().unwrap().root
}
// One way: `to` takes what `from` wrote since the last of `from`'s rows it read; answers the bytes that crossed.
fn sync_one_way(from: &Side, to: &mut Side) -> usize {
    let mut bytes = 0;
    let mut peer = |position: Option<&str>| {
        let answer = changes_after(&from.records, position, 5000, Bounds::default().bytes, &|_| false)?;
        bytes += serde_json::to_vec(&answer.rows).unwrap().len();
        Ok(answer)
    };
    let seen = to.seen.get(from.name).cloned().flatten();
    let taken = take_from_peer(&mut to.records, &mut peer, seen, Actor::by(from.name), KEPT_APART).unwrap();
    to.seen.insert(from.name.into(), taken.seen);
    bytes
}
fn fork_of(side: &Side, id: &str) -> Option<Fields> {
    side.records.read(&format!("{KEPT_APART}:{id}")).unwrap()
}
fn versions(side: &Side, id: &str) -> Vec<Value> {
    fork_of(side, id).unwrap_or_default().values().map(|version| version["value"].clone()).collect()
}

#[test]
fn vectors_two_stores_that_both_moved_converge_on_one_root_with_every_record_on_both() {
    let (mut left, mut right) = (store("left"), store("right"));
    write(&mut left, "shared", "before");
    assert!(sync_one_way(&left, &mut right) > 0, "the first sync carries the store");
    for n in ["one", "two", "three"] {
        write(&mut left, &format!("left-{n}"), &format!("L{n}"));
        write(&mut right, &format!("right-{n}"), &format!("R{n}"));
    }
    sync_one_way(&left, &mut right);
    sync_one_way(&right, &mut left);
    sync_one_way(&left, &mut right);
    assert_eq!(root(&left), root(&right));
    for side in [&left, &right] {
        assert_eq!(read(side, "shared").as_deref(), Some("before"));
        for n in ["one", "two", "three"] {
            assert_eq!(read(side, &format!("left-{n}")), Some(format!("L{n}")));
            assert_eq!(read(side, &format!("right-{n}")), Some(format!("R{n}")));
        }
    }
}

fn wire_cost_of_one_change(count: usize) -> usize {
    let mut source = store("source");
    for index in 0..count {
        write(&mut source, &format!("record-{index:05}"), "value");
    }
    let mut peer = store("peer");
    sync_one_way(&source, &mut peer);
    write(&mut source, "record-00000", "changed");
    let bytes = sync_one_way(&source, &mut peer);
    assert_eq!(read(&peer, "record-00000").as_deref(), Some("changed"));
    bytes
}

#[test]
fn vectors_one_changed_record_costs_the_same_on_the_wire_however_large_the_store() {
    let smaller = wire_cost_of_one_change(500);
    let larger = wire_cost_of_one_change(2000);
    assert!(larger < smaller * 2, "500 records cost {smaller} and 2000 cost {larger}");
}

#[test]
fn vectors_a_peer_away_through_a_thousand_writes_catches_up_in_one_exchange_paying_for_the_records() {
    let (mut live, mut away) = (store("live"), store("away"));
    write(&mut live, "record-0000", "prefill");
    sync_one_way(&live, &mut away);
    for round in 0..1000 {
        write(&mut live, &format!("record-{:04}", round % 20), &format!("v{round}"));
    }
    let bytes = sync_one_way(&live, &mut away);
    assert_eq!(root(&away), root(&live));
    assert_eq!(read(&away, "record-0019").as_deref(), Some("v999"));
    assert!(bytes < 20 * 200, "twenty records crossed as {bytes} bytes, not a thousand writes");
}

#[test]
fn vectors_a_stale_peer_does_not_beat_a_store_that_kept_writing_the_same_record() {
    let (mut live, mut away) = (store("live"), store("away"));
    write(&mut live, "contested", "prefill");
    sync_one_way(&live, &mut away);
    for round in 0..1000 {
        write(&mut live, "contested", &format!("v{round}"));
    }
    sync_one_way(&live, &mut away);
    sync_one_way(&away, &mut live);
    assert_eq!(read(&away, "contested").as_deref(), Some("v999"));
    assert_eq!(read(&live, "contested").as_deref(), Some("v999"));
}

#[test]
fn vectors_both_sides_changing_one_record_converge_and_keep_the_loser_readable_on_both() {
    let (mut left, mut right) = (store("left"), store("right"));
    write(&mut left, "contested", "base");
    sync_one_way(&left, &mut right);
    write(&mut left, "contested", "from-left");
    write(&mut right, "contested", "from-right");
    sync_one_way(&left, &mut right);
    sync_one_way(&right, &mut left);
    sync_one_way(&left, &mut right);
    assert_eq!(root(&left), root(&right));
    let settled = read(&left, "contested").unwrap();
    assert!(["from-left", "from-right"].contains(&settled.as_str()));
    assert_eq!(read(&right, "contested").as_deref(), Some(settled.as_str()));
    let loser = if settled == "from-left" { "from-right" } else { "from-left" };
    for side in [&left, &right] {
        let held = versions(side, "contested");
        assert!(held.contains(&json!(loser)), "{} lost the version that lost: {held:?}", side.name);
        assert!(held.contains(&json!(settled)), "{} lost the version that won", side.name);
        assert!(fork_of(side, "contested").unwrap().values().all(|version| version["record"] == "contested"));
    }
    for index in 0..12 {
        write(&mut left, &format!("unrelated-{index}"), "filler");
    }
    sync_one_way(&left, &mut right);
    assert!(versions(&left, "contested").contains(&json!(loser)), "the loser survives later writes");
}

#[test]
fn vectors_a_second_fork_on_one_record_does_not_erase_the_first() {
    let (mut left, mut right) = (store("left"), store("right"));
    write(&mut left, "contested", "base");
    sync_one_way(&left, &mut right);
    for round in ["first", "second"] {
        write(&mut left, "contested", &format!("{round}-from-left"));
        write(&mut right, "contested", &format!("{round}-from-right"));
        sync_one_way(&left, &mut right);
        sync_one_way(&right, &mut left);
        sync_one_way(&left, &mut right);
    }
    assert_eq!(root(&left), root(&right));
    for side in [&left, &right] {
        let held = versions(side, "contested");
        for written in ["first-from-left", "first-from-right", "second-from-left", "second-from-right"] {
            assert!(held.contains(&json!(written)), "{} lost {written}", side.name);
        }
    }
}

#[test]
fn vectors_a_record_nobody_contested_reports_no_fork() {
    let (mut left, mut right) = (store("left"), store("right"));
    write(&mut left, "quiet", "one");
    sync_one_way(&left, &mut right);
    assert_eq!(fork_of(&right, "quiet"), None);
    assert_eq!(fork_of(&right, "never-written"), None);
}

#[test]
fn vectors_a_peer_holding_nothing_starts_through_the_same_exchange_and_twice_changes_nothing() {
    let mut source = store("source");
    for index in 0..40 {
        write(&mut source, &format!("record-{index:04}"), "value");
    }
    let mut fresh = store("fresh");
    sync_one_way(&source, &mut fresh);
    assert_eq!(root(&fresh), root(&source));
    assert_eq!(read(&fresh, "record-0039").as_deref(), Some("value"));
    let before = root(&fresh);
    let rows = fresh.records.log_rows().unwrap();
    fresh.seen.remove("source");
    sync_one_way(&source, &mut fresh);
    assert_eq!(root(&fresh), before, "taking the same changes again moved the root");
    assert_eq!(fresh.records.log_rows().unwrap(), rows, "and wrote nothing");
}

#[test]
fn vectors_a_record_one_side_removed_and_the_other_changed_settles_the_same_with_the_change_kept_apart() {
    let (mut left, mut right) = (store("left"), store("right"));
    write(&mut left, "gone", "base");
    sync_one_way(&left, &mut right);
    left.records.write(&[("gone", "note", None)], Actor::by("person")).unwrap();
    write(&mut right, "gone", "edited");
    sync_one_way(&left, &mut right);
    sync_one_way(&right, &mut left);
    sync_one_way(&left, &mut right);
    assert_eq!(root(&left), root(&right));
    assert_eq!(read(&left, "gone"), read(&right, "gone"));
    for side in [&left, &right] {
        assert!(serde_json::to_string(&fork_of(side, "gone")).unwrap().contains("edited"), "{} dropped the edit", side.name);
    }
}

// ---- settle: a copy and the copy it follows, through a send that crosses as JSON (as the forwarder carries it) ----

/// Settles `copy` with `leader` through JSON text both ways; answers what the settle did.
fn settle(copy: &mut Side, leader: &mut Side, state: &mut SettleState) -> Settled {
    settle_bounded(copy, leader, state, Bounds::default())
}
fn settle_bounded(copy: &mut Side, leader: &mut Side, state: &mut SettleState, bounds: Bounds) -> Settled {
    let name = copy.name;
    let mut send = |request: &SettleRequest| {
        let request: SettleRequest = serde_json::from_slice(&serde_json::to_vec(request).unwrap()).unwrap();
        let answer = answer_settle(&mut leader.records, &request, bounds, "2026-11-03T00:00:00Z", KEPT_APART)?;
        Ok(serde_json::from_slice(&serde_json::to_vec(&answer).unwrap()).unwrap())
    };
    let settled = settle_with(&mut copy.records, &mut send, name, state.clone(), bounds, KEPT_APART, &mut |_| {}).unwrap();
    *state = settled.state.clone();
    settled
}

#[test]
fn settle_two_computers_that_both_moved_end_on_one_root() {
    let (mut computer, mut writer) = (store("computer-b"), store("computer-a"));
    let mut state = SettleState::default();
    write(&mut writer, "shared", "before");
    settle(&mut computer, &mut writer, &mut state);
    for n in 0..30 {
        write(&mut writer, &format!("a-{n}"), "A");
        write(&mut computer, &format!("b-{n}"), "B");
    }
    let settled = settle(&mut computer, &mut writer, &mut state);
    assert!(settled.equal, "one settle makes them equal: {settled:?}");
    assert_eq!(root(&computer), root(&writer));
    for n in 0..30 {
        for side in [&computer, &writer] {
            assert_eq!(read(side, &format!("a-{n}")).as_deref(), Some("A"));
            assert_eq!(read(side, &format!("b-{n}")).as_deref(), Some("B"));
        }
    }
    // The replying side keeps one position for this copy, beside the store: how far it took the copy's changes, under
    // the `from:` key (record_sync.rs `taken_from`). Its own position for the copy (how far the copy took ours) is
    // moved only on the equal-root answer.
    let positions = writer.records.positions().unwrap();
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0].0, "from:computer-b");
}

fn settle_cost_of_one_change(count: usize) -> usize {
    let (mut computer, mut writer) = (store("computer-b"), store("computer-a"));
    for index in 0..count {
        write(&mut writer, &format!("record-{index:05}"), "value");
    }
    let mut state = SettleState::default();
    settle(&mut computer, &mut writer, &mut state);
    write(&mut writer, "record-00000", "changed");
    let settled = settle(&mut computer, &mut writer, &mut state);
    assert!(settled.equal);
    assert_eq!(read(&computer, "record-00000").as_deref(), Some("changed"));
    settled.bytes
}

#[test]
fn settle_a_one_record_change_costs_the_same_on_a_small_and_a_large_store() {
    let small = settle_cost_of_one_change(200);
    let large = settle_cost_of_one_change(4000);
    assert!(large <= small + small / 10, "200 records cost {small} bytes, 4000 cost {large}");
}

#[test]
fn settle_an_empty_computer_starts_by_the_same_settle() {
    let (mut computer, mut writer) = (store("computer-b"), store("computer-a"));
    for index in 0..1200 {
        write(&mut writer, &format!("record-{index:05}"), "value");
    }
    let mut state = SettleState::default();
    let settled = settle(&mut computer, &mut writer, &mut state);
    assert!(settled.equal, "{settled:?}");
    assert_eq!(root(&computer), root(&writer));
    assert_eq!(read(&computer, "record-01199").as_deref(), Some("value"));
}

#[test]
fn settle_a_computer_whose_log_is_gone_is_settled_by_bucket_and_gives_back_what_only_it_holds() {
    let (mut computer, mut writer) = (store("computer-b"), store("computer-a"));
    for index in 0..50 {
        write(&mut writer, &format!("record-{index:03}"), "value");
    }
    // The computer took the records some other way (no shared log): only buckets can settle it.
    let mut other = store("computer-c");
    let mut state = SettleState::default();
    settle(&mut other, &mut writer, &mut state);
    let records = other.records.records_in_buckets(&(0..256).collect::<Vec<_>>()).unwrap();
    computer.records.take_records(&records, Actor::by("restore")).unwrap();
    write(&mut computer, "only-here", "mine");
    let mut fresh = SettleState { took_through: writer.records.last_log_id().unwrap(), sent_through: computer.records.last_log_id().unwrap() };
    let settled = settle(&mut computer, &mut writer, &mut fresh);
    assert!(settled.equal, "{settled:?}");
    assert!(settled.buckets_taken > 0, "the buckets that differ were compared");
    assert_eq!(read(&writer, "only-here").as_deref(), Some("mine"), "what only the computer held went back");
}

#[test]
fn settle_a_conflict_keeps_the_losing_version() {
    let (mut computer, mut writer) = (store("computer-b"), store("computer-a"));
    let mut state = SettleState::default();
    write(&mut writer, "contested", "base");
    settle(&mut computer, &mut writer, &mut state);
    write(&mut writer, "contested", "from-writer");
    write(&mut computer, "contested", "from-computer");
    let settled = settle(&mut computer, &mut writer, &mut state);
    let settled_again = settle(&mut computer, &mut writer, &mut state);
    assert!(settled.equal || settled_again.equal);
    assert!(!settled.conflicts.is_empty(), "the conflict is answered");
    assert_eq!(root(&computer), root(&writer));
    let won = read(&writer, "contested").unwrap();
    assert_eq!(read(&computer, "contested").as_deref(), Some(won.as_str()));
    let lost = if won == "from-writer" { "from-computer" } else { "from-writer" };
    for side in [&computer, &writer] {
        assert!(versions(side, "contested").contains(&json!(lost)), "{} kept the loser", side.name);
    }
}

#[test]
fn settle_a_repeated_settle_writes_nothing() {
    let (mut computer, mut writer) = (store("computer-b"), store("computer-a"));
    let mut state = SettleState::default();
    for index in 0..60 {
        write(&mut writer, &format!("record-{index:03}"), "value");
    }
    write(&mut writer, "contested", "base");
    settle(&mut computer, &mut writer, &mut state);
    write(&mut writer, "contested", "w");
    write(&mut computer, "contested", "p");
    settle(&mut computer, &mut writer, &mut state);
    settle(&mut computer, &mut writer, &mut state);
    let rows = (computer.records.log_rows().unwrap(), writer.records.log_rows().unwrap());
    let positions = writer.records.positions().unwrap();
    let again = settle(&mut computer, &mut writer, &mut state);
    assert!(again.equal);
    assert_eq!(again.requests, 1, "one request: the roots are equal");
    assert_eq!((computer.records.log_rows().unwrap(), writer.records.log_rows().unwrap()), rows, "no row anywhere");
    assert_eq!(writer.records.positions().unwrap(), positions, "and the position did not move");
    // From nothing (a lost cursor), the same: the equal root answers it.
    let mut lost = SettleState::default();
    let from_nothing = settle(&mut computer, &mut writer, &mut lost);
    assert!(from_nothing.equal);
    assert_eq!((computer.records.log_rows().unwrap(), writer.records.log_rows().unwrap()), rows);
}

#[test]
fn settle_a_4_3_mb_record_crosses() {
    let (mut computer, mut writer) = (store("computer-b"), store("computer-a"));
    let big = "x".repeat(4_300_000);
    write(&mut writer, "big", &big);
    write(&mut writer, "small", "value");
    let mut state = SettleState::default();
    let settled = settle_bounded(&mut computer, &mut writer, &mut state, Bounds::shipped());
    assert!(settled.equal, "{settled:?}");
    assert_eq!(read(&computer, "big").map(|text| text.len()), Some(4_300_000));
    // And back: a 4.3 MB record written at the computer crosses its upload.
    write(&mut computer, "big-back", &big);
    let settled = settle_bounded(&mut computer, &mut writer, &mut state, Bounds::shipped());
    assert!(settled.equal);
    assert_eq!(read(&writer, "big-back").map(|text| text.len()), Some(4_300_000));
}

#[test]
fn settle_answers_are_bounded_by_rows_and_bytes() {
    let (mut computer, mut writer) = (store("computer-b"), store("computer-a"));
    for index in 0..300 {
        write(&mut writer, &format!("record-{index:03}"), &"v".repeat(1000));
    }
    let bounds = Bounds { most_rows: 50, bytes: 20_000, ..Bounds::default() };
    let mut largest = 0;
    let mut state = SettleState::default();
    {
        let mut send = |request: &SettleRequest| {
            let answer = answer_settle(&mut writer.records, request, bounds, "now", KEPT_APART)?;
            largest = largest.max(serde_json::to_vec(&answer.rows).unwrap().len());
            assert!(answer.rows.iter().map(|row| row.envelopes.len()).sum::<usize>() <= 50);
            Ok(answer)
        };
        let settled = settle_with(&mut computer.records, &mut send, "computer-b", state.clone(), bounds, KEPT_APART, &mut |_| {}).unwrap();
        state = settled.state;
        assert!(settled.equal);
        assert!(settled.requests > 1);
    }
    assert!(largest < 20_000 + 2_000, "an answer carries about its byte bound: {largest}");
    assert_eq!(root(&computer), root(&writer));
    let _ = state;
}

#[test]
fn settle_refuses_a_copy_name_it_cannot_keep() {
    let mut writer = store("computer-a");
    let request = SettleRequest { copy: "a/b".into(), ..SettleRequest::default() };
    assert_eq!(answer_settle(&mut writer.records, &request, Bounds::default(), "now", KEPT_APART).unwrap_err().status, 400);
    let forget = SettleRequest { copy: "gone".into(), forget: true, ..SettleRequest::default() };
    assert_eq!(answer_settle(&mut writer.records, &forget, Bounds::default(), "now", KEPT_APART).unwrap().forgotten, Some(false));
}

// ---- record-sync-selected-bucket-stability / outbound-read-bounds ----

#[test]
fn bucket_records_that_arrived_changed_are_refused_with_nothing_taken() {
    let (mut computer, mut writer) = (store("computer-b"), store("computer-a"));
    for index in 0..40 {
        write(&mut writer, &format!("record-{index:03}"), "value");
    }
    let before = (root(&computer), computer.records.log_rows().unwrap());
    let mut send = |request: &SettleRequest| {
        let mut answer = answer_settle(&mut writer.records, request, Bounds::default(), "now", KEPT_APART)?;
        // No rows cross (the writer's log is gone for this copy), and a bucket page arrives changed on the way.
        answer.rows.clear();
        answer.more = false;
        if let Some(records) = answer.records.as_mut() {
            if let Some(first) = records.first_mut() {
                first.value = Some(fields(json!({ "payload": "tampered" })));
            }
        }
        Ok(answer)
    };
    let refused = settle_with(&mut computer.records, &mut send, "computer-b", SettleState::default(), Bounds::default(), KEPT_APART, &mut |_| {}).unwrap_err();
    assert_eq!(refused.status, 409);
    assert!(!refused.refused.is_empty());
    assert_eq!((root(&computer), computer.records.log_rows().unwrap()), before, "nothing was taken");
}

#[test]
fn bucket_a_group_that_keeps_moving_while_read_is_left_for_the_next_settle() {
    let (mut computer, mut writer) = (store("computer-b"), store("computer-a"));
    for index in 0..40 {
        write(&mut writer, &format!("record-{index:03}"), "value");
    }
    let mut page = 0;
    let mut send = |request: &SettleRequest| {
        let mut answer = answer_settle(&mut writer.records, request, Bounds { bucket_page_records: 1, ..Bounds::default() }, "now", KEPT_APART)?;
        answer.rows.clear();
        answer.more = false;
        if answer.records.is_some() {
            // Every page answers other bucket checksums: the group moved while it was read.
            page += 1;
            let mut buckets = answer.buckets.clone().unwrap();
            buckets.replace_range(0..8, &format!("{page:08x}"));
            for bucket in 0..256 {
                let at = bucket * 16;
                buckets.replace_range(at..at + 8, &format!("{page:08x}"));
            }
            answer.buckets = Some(buckets);
        }
        Ok(answer)
    };
    let settled = settle_with(&mut computer.records, &mut send, "computer-b", SettleState::default(), Bounds { bucket_page_records: 1, ..Bounds::default() }, KEPT_APART, &mut |_| {}).unwrap();
    assert!(settled.buckets_moved > 0, "{settled:?}");
    assert!(!settled.equal);
}

#[test]
fn bucket_pages_are_bounded_by_records_and_bytes() {
    let mut writer = store("computer-a");
    for index in 0..100 {
        write(&mut writer, &format!("record-{index:03}"), &"v".repeat(500));
    }
    let all: Vec<usize> = (0..256).collect();
    let (records, next) = writer.records.records_in_buckets_page(&all, None, 10, usize::MAX).unwrap();
    assert_eq!(records.len(), 10);
    assert!(next.is_some());
    let (records, _) = writer.records.records_in_buckets_page(&all, None, 1000, 2000).unwrap();
    assert!(records.len() <= 5, "about 2000 bytes of values: {}", records.len());
    let mut seen = 0;
    let mut after = None;
    loop {
        let (records, next) = writer.records.records_in_buckets_page(&all, after.as_deref(), 7, usize::MAX).unwrap();
        seen += records.len();
        match next {
            None => break,
            Some(cursor) => after = Some(cursor),
        }
    }
    assert_eq!(seen, 100, "paging reaches every record once");
}

// ---- carry.rs: resource-state-carry's prefilling contract ----

#[test]
fn carry_prefills_an_empty_store_in_bounded_pages_and_lets_the_source_retire_only_when_it_reads_back_whole() {
    use super::carry::{carry, CarryBounds};
    let mut source = store("source");
    for index in 0..3000 {
        write(&mut source, &format!("record-{index:05}"), &"v".repeat(1000));
    }
    source.records.write(&[("record-00007", "note", None)], Actor::by("person")).unwrap();
    write(&mut source, "big", &"x".repeat(4_300_000));
    let mut destination = store("destination");
    let carried = carry(&source.records, &mut destination.records, CarryBounds::default()).unwrap();
    assert!(carried.may_retire, "{carried:?}");
    assert_eq!(carried.source_count, 3001, "the removal carries its stamps too");
    assert_eq!(carried.destination_count, carried.source_count);
    assert_eq!(root(&destination), root(&source));
    assert!(carried.pages >= 4, "about 1 MiB a page: {} pages", carried.pages);
    assert_eq!(read(&destination, "big").map(|text| text.len()), Some(4_300_000), "a row past a page goes as its own page");
    // Carried again: nothing changes, and it may still retire.
    let rows = destination.records.log_rows().unwrap();
    assert!(carry(&source.records, &mut destination.records, CarryBounds::default()).unwrap().may_retire);
    assert_eq!(destination.records.log_rows().unwrap(), rows);
}

#[test]
fn carry_refuses_a_destination_that_does_not_read_back_as_the_source_and_a_row_past_its_bound() {
    use super::carry::{carry, CarryBounds};
    let mut source = store("source");
    for index in 0..20 {
        write(&mut source, &format!("record-{index:02}"), "value");
    }
    let mut destination = store("destination");
    write(&mut destination, "stray", "not in the source");
    let refused = carry(&source.records, &mut destination.records, CarryBounds::default()).unwrap_err();
    assert_eq!(refused.status, 409, "{refused}");
    write(&mut source, "huge", &"x".repeat(2000));
    let refused = carry(&source.records, &mut store("fresh").records, CarryBounds { row_bytes: 1000, ..CarryBounds::default() }).unwrap_err();
    assert_eq!(refused.status, 413);
}

// ---- measured: catch-up of an empty computer on SQLite files ----

/// Catch-up of an empty computer from a synthetic store on SQLite files, in MB of record values a second.
/// `SETTLE_MEASURE_BYTES` sets the store's size (default 1 GiB). Run in release:
/// `cargo test --release --lib settle_catch_up_measured -- --ignored --nocapture`.
#[test]
#[ignore = "a measurement: about 1 GiB of SQLite files and minutes of work"]
fn settle_catch_up_measured() {
    use crate::storage::sqlite;
    let target: usize = std::env::var("SETTLE_MEASURE_BYTES").ok().and_then(|text| text.parse().ok()).unwrap_or(1 << 30);
    let folder = tempfile::tempdir().unwrap();
    let open = |name: &str| sqlite::open_owned(&folder.path().join(name), "record_store", crate::storage::record_store_resources::bounds()).unwrap();
    let mut writer = RecordLog::new(open("writer.sqlite"), "account", "own-records");
    let mut computer = RecordLog::new(open("computer.sqlite"), "account", "own-records");
    let value = "v".repeat(4000);
    let started = std::time::Instant::now();
    let (mut written, mut index) = (0usize, 0usize);
    while written < target {
        let batch: Vec<(String, Fields)> = (0..200).map(|at| (format!("record-{:09}", index + at), fields(json!({ "payload": value, "n": index + at })))).collect();
        let rows: Vec<(&str, &str, Option<Fields>)> = batch.iter().map(|(id, value)| (id.as_str(), "note", Some(value.clone()))).collect();
        writer.write(&rows, Actor::by("person")).unwrap();
        index += 200;
        written += 200 * (value.len() + 40);
    }
    let prefilled = started.elapsed();
    let bounds = Bounds::shipped();
    let started = std::time::Instant::now();
    let mut send = |request: &SettleRequest| {
        let request: SettleRequest = serde_json::from_slice(&serde_json::to_vec(request).unwrap()).unwrap();
        let answer = answer_settle(&mut writer, &request, bounds, "now", KEPT_APART)?;
        Ok(serde_json::from_slice(&serde_json::to_vec(&answer).unwrap()).unwrap())
    };
    let settled = settle_with(&mut computer, &mut send, "computer", SettleState::default(), bounds, KEPT_APART, &mut |_| {}).unwrap();
    let took = started.elapsed();
    assert!(settled.equal, "{settled:?}");
    let megabytes = written as f64 / 1e6;
    eprintln!(
        "settle-measured records={index} values_mb={megabytes:.0} wire_mb={:.0} requests={} prefill_s={:.1} catch_up_s={:.1} catch_up_mb_per_s={:.1}",
        settled.bytes as f64 / 1e6,
        settled.requests,
        prefilled.as_secs_f64(),
        took.as_secs_f64(),
        megabytes / took.as_secs_f64()
    );
    // A one-record change after it costs one request each way.
    let changed = {
        writer.write(&[("record-000000000", "note", Some(fields(json!({ "payload": "changed" }))))], Actor::by("person")).unwrap();
        let mut send = |request: &SettleRequest| answer_settle(&mut writer, request, bounds, "now", KEPT_APART);
        settle_with(&mut computer, &mut send, "computer", settled.state.clone(), bounds, KEPT_APART, &mut |_| {}).unwrap()
    };
    assert!(changed.equal);
    eprintln!("settle-measured one_change_bytes={} requests={}", changed.bytes, changed.requests);
}

/// One owner of the field join (`crate::record_stamps`): the settle store's `merge`, `tie_by_content` and `stamp_after`
/// answer what the journal's do for the same states, UTF-16 order included (a supplementary character sorts below
/// U+FF61 by code unit, above it by code point), and merging in any order or twice changes nothing.
#[test]
fn the_settle_store_and_the_journal_run_one_field_join() {
    use super::stamps::{tie_by_content, Cell, State};
    let high = Cell { stamp: "0001".into(), value: Some(json!("\u{1F600}")) };
    let low = Cell { stamp: "0001".into(), value: Some(json!("\u{FF61}")) };
    let journal = |cell: &Cell| crate::record_stamps::Cell::live(cell.stamp.clone(), cell.value.clone().unwrap());
    let encode = |value: &Value| Ok::<_, std::convert::Infallible>(json_text(value));
    for (a, b) in [(&high, &low), (&low, &high)] {
        assert_eq!(tie_by_content(a, b), crate::record_stamps::tie_by_content(&journal(a), &journal(b), &encode).unwrap());
    }
    assert!(tie_by_content(&low, &high), "the supplementary character is the lower text by UTF-16 code unit");
    let state = |stamp: &str, field: &str, value: Value| State {
        floor: String::new(),
        kind: None,
        kind_of_record: Some("note".into()),
        type_at: stamp.into(),
        fields: [(field.to_string(), Cell { stamp: stamp.into(), value: Some(value) })].into_iter().collect(),
    };
    let (a, b, c) = (state("0001", "title", json!("a")), state("0002", "title", json!("b")), state("0001", "body", json!("c")));
    let one = merge(&merge(&a, &b), &c);
    assert_eq!(one, merge(&c, &merge(&b, &a)));
    assert_eq!(one, merge(&one, &b));
    assert_eq!(one.fields["title"].value, Some(json!("b")));
    for (fresh, held) in [("0002", "0001"), ("0001", "0002"), ("0001", ""), ("00020000abcdefg", "0002")] {
        assert_eq!(stamp_after(fresh, Some(held)), crate::record_stamps::stamp_after(fresh, held).unwrap());
    }
}

/// A store that keeps erasure keys and prepares its shared collections in steps, around a settle store (old trillion
/// record-log-store.mjs `erasureKeys`, `takeErasureKeys`, `shareFields`).
struct Keyed {
    log: RecordLog<Memory>,
    keys: std::collections::BTreeMap<String, Option<String>>,
    taken: Vec<std::collections::BTreeMap<String, Option<String>>>,
    preparing: usize,
}
impl SettleStore for Keyed {
    fn log_after(&self, position: Option<&str>, limit: usize) -> Result<LogPage, SyncError> { self.log.log_after(position, limit) }
    fn last_log_id(&self) -> Result<Option<String>, SyncError> { self.log.last_log_id() }
    fn checksum(&self) -> Result<Checksum, SyncError> { self.log.checksum() }
    fn apply_changes(&mut self, rows: &[ChangeRow], actor: Actor, keep_apart: Option<&str>) -> Result<Applied, SyncError> { self.log.apply_changes(rows, actor, keep_apart) }
    fn take_records(&mut self, records: &[BucketRecord], actor: Actor) -> Result<usize, SyncError> { self.log.take_records(records, actor) }
    fn records_in_buckets(&self, buckets: &[usize]) -> Result<Vec<BucketRecord>, SyncError> { self.log.records_in_buckets(buckets) }
    fn records_in_buckets_page(&self, buckets: &[usize], after: Option<&str>, limit: usize, bytes: usize) -> Result<(Vec<BucketRecord>, Option<String>), SyncError> {
        self.log.records_in_buckets_page(buckets, after, limit, bytes)
    }
    fn position(&self, copy: &str) -> Result<Option<String>, SyncError> { self.log.position(copy) }
    fn move_position(&mut self, copy: &str, took_through: Option<&str>, at: &str) -> Result<bool, SyncError> { self.log.move_position(copy, took_through, at) }
    fn forget_position(&mut self, copy: &str) -> Result<bool, SyncError> { self.log.forget_position(copy) }
    fn erasure_keys(&self, ids: &[String], _from_page: bool) -> Result<Option<ErasureKeys>, SyncError> {
        Ok(Some(ids.iter().filter_map(|id| self.keys.get(id).map(|key| (id.clone(), key.clone()))).collect()))
    }
    fn take_erasure_keys(&mut self, keys: &ErasureKeys) -> Result<Vec<String>, SyncError> {
        self.taken.push(keys.clone());
        Ok(keys.iter().filter(|(_, key)| key.is_none()).map(|(id, _)| id.clone()).collect())
    }
    fn share_fields(&mut self, _kind: &str) -> Result<bool, SyncError> {
        self.preparing = self.preparing.saturating_sub(1);
        Ok(self.preparing > 0)
    }
}

fn keyed(preparing: usize) -> Keyed {
    Keyed { log: RecordLog::new(Memory::open("record_store").unwrap(), "account", "own-records"), keys: Default::default(), taken: Vec::new(), preparing }
}

/// Old trillion record-sync.mjs:62 `keysBeside`, :266 `preparing` and :282 `apply`: the keys of erasable records cross
/// beside the rows and records that name them, both ways, and only those; a side still preparing its shared
/// collections answers `preparing` to a bounded asker, which asks again, and refuses (503) any other; the replying side's
/// own rule decides what a copy's rows change there.
#[test]
fn erasure_keys_cross_beside_their_rows_a_preparing_side_is_asked_again_and_the_answering_rule_decides() {
    let (mut here, mut there) = (keyed(0), keyed(3));
    here.log.write(&[("mine", "note", Some(fields(json!({ "text": "here" }))))], Actor::by("person")).unwrap();
    there.log.write(&[("theirs", "note", Some(fields(json!({ "text": "there" })))), ("other", "note", Some(fields(json!({ "text": "no key" }))))], Actor::by("person")).unwrap();
    here.keys.insert("mine".into(), Some("key-of-mine".into()));
    there.keys.insert("theirs".into(), None);
    let mut asked = Vec::new();
    let settled = {
        let there = std::cell::RefCell::new(&mut there);
        let mut send = |request: &SettleRequest| {
            asked.push(request.clone());
            answer_settle(&mut **there.borrow_mut(), request, Bounds::default(), "now", KEPT_APART)
        };
        settle_with(&mut here, &mut send, "here", SettleState::default(), Bounds::default(), KEPT_APART, &mut |_| {}).unwrap()
    };
    assert!(settled.equal, "{settled:?}");
    assert!(asked.iter().all(|request| request.bounded_shared_fields), "every request waits for preparation");
    let mine: ErasureKeys = [("mine".to_string(), Some("key-of-mine".to_string()))].into_iter().collect();
    let sent_keys: Vec<_> = asked.iter().filter_map(|request| request.keys.clone()).collect();
    // The first upload went three times: twice answered `preparing` (nothing taken), then taken.
    assert_eq!(sent_keys, vec![mine.clone(); 3], "only the key of the row sent, beside it, each time the request went");
    assert_eq!(there.taken, vec![mine], "taken once, by the request the prepared side answered");
    assert!(here.taken.iter().any(|keys| keys.get("theirs") == Some(&None) && !keys.contains_key("other")), "{:?}", here.taken);
    // A side still preparing refuses a request that does not wait.
    let mut busy = keyed(2);
    let request = SettleRequest { copy: "here".into(), rows: Some(Vec::new()), ..SettleRequest::default() };
    assert_eq!(answer_settle(&mut busy, &request, Bounds::default(), "now", KEPT_APART).unwrap_err().status, 503);
    // The replying side's own rule: here it takes nothing a copy sends.
    let mut strict = keyed(0);
    let rows = vec![ChangeRow { id: "row".into(), envelopes: vec![Envelope { id: "sent".into(), kind: Some("note".into()), value: Some(fields(json!({ "text": "x" }))), ..Envelope::default() }] }];
    let request = SettleRequest { copy: "here".into(), rows: Some(rows), ..SettleRequest::default() };
    let mut refuse = |_: &mut dyn SettleStore, _: &[ChangeRow], _: Actor| Ok(Applied::default());
    let answer = answer_settle_with(&mut strict, &request, Bounds::default(), "now", KEPT_APART, Some(&mut refuse)).unwrap();
    assert_eq!(answer.applied, 0);
    assert_eq!(strict.log.read("sent").unwrap(), None, "the rule took nothing");
}

/// A store whose records were written before every write kept its settle state (`settle_mirror` off then) is carried
/// into its settle store once (`RecordStore::fill_settle`, `carry.rs` `Versions` into `record_log.rs`), and then holds
/// exactly what a store that mirrored every write holds: the same root, live records and removals alike. A second fill
/// does nothing.
#[test]
fn a_store_written_before_its_settle_state_is_carried_into_it_once_and_then_equals_a_mirrored_store() {
    use super::{RecordStore, RealClock};
    use crate::records::{Mutation, Records};
    let limits = super::settings::Limits::fixed(1 << 20, 1 << 30);
    let mut unmirrored = super::settings::shipped().unwrap().clone();
    unmirrored.settle_mirror = false;
    let unmirrored: &'static super::settings::Settings = Box::leak(Box::new(unmirrored));
    let mut old = RecordStore::with_settings(Memory::open("record_store").unwrap(), Box::new(RealClock), unmirrored, limits).unwrap();
    let mut mirrored = RecordStore::new(Memory::open("record_store").unwrap(), Box::new(RealClock), limits).unwrap().mirrored(true);
    let (account, resource) = ("account", "own-records");
    let write = |store: &mut RecordStore<Memory>, id: &str, version: i64, deleted: bool, value: Value| {
        store.mutate(account, resource, Mutation { id: id.into(), expected_version: version, request_key: format!("{id}-{version}"), deleted, value }).unwrap().sequence
    };
    for n in 0..30 {
        write(&mut old, &format!("note-{n}"), 0, false, json!({ "kind": "note", "text": format!("text {n}") }));
    }
    write(&mut old, "note-3", 1, false, json!({ "kind": "note", "text": "changed" }));
    write(&mut old, "note-4", 1, true, Value::Null);
    let settle = |memory: &Memory| RecordLog::new(memory, account, resource).checksum().unwrap().root;
    assert_eq!(settle(old.storage()), Sums::new().root(), "nothing was kept while the mirror was off");
    // The same records, every write mirrored, at the same stamps: carried over by the changes the old store made.
    let mut after = 0;
    loop {
        let (carried, more) = old.carried_page(account, resource, after, 100, 0).unwrap();
        after = carried.last().map_or(after, |carried| carried.change.sequence);
        mirrored.apply_carried_at(account, resource, 1, 0, &carried).unwrap();
        if !more {
            break;
        }
    }
    // The same store opened as the copies open it, with the mirror on: its first settle carries it.
    let now = RecordStore::new(old.storage(), Box::new(RealClock), limits).unwrap().mirrored(true);
    let filled = now.fill_settle(account, resource).unwrap().expect("the first fill carries");
    assert!(filled.may_retire && filled.records == 30, "{filled:?}");
    assert_eq!(settle(old.storage()), settle(mirrored.storage()), "the carried settle state is the mirrored one");
    assert_ne!(settle(old.storage()), Sums::new().root());
    assert_eq!(RecordLog::new(old.storage(), account, resource).read("note-3").unwrap().and_then(|fields| fields.get("text").cloned()), Some(json!("changed")));
    assert_eq!(RecordLog::new(old.storage(), account, resource).read("note-4").unwrap(), None);
    assert!(now.fill_settle(account, resource).unwrap().is_none(), "a second seed does nothing");
}

/// Nested object key order: every copy that settles is this engine (no old trillion store settles with it, Principle
/// 1), and this engine keeps every object's members in one order (`serde_json::Map` is ordered by key), so two copies
/// that hold the same value hash it alike however its members arrived. Old trillion hashed `JSON.stringify` text in
/// insertion order; that is not matched and need not be.
#[test]
fn a_nested_value_hashes_alike_at_every_copy_whatever_order_its_members_came_in() {
    let one: Value = serde_json::from_str(r#"{"outer":{"b":1,"a":{"y":[1,{"q":2,"p":3}],"x":true}},"z":"last","c":0}"#).unwrap();
    let other: Value = serde_json::from_str(r#"{"c":0,"z":"last","outer":{"a":{"x":true,"y":[1,{"p":3,"q":2}]},"b":1}}"#).unwrap();
    assert_eq!(json_text(&one), json_text(&other));
    let sums = |value: &Value| {
        let mut sums = Sums::new();
        sums.add("note-1", "note", &fields(value.clone()));
        sums.root()
    };
    assert_eq!(sums(&one), sums(&other));
    let (mut here, mut there) = (keyed(0), keyed(0));
    here.log.write(&[("note-1", "note", Some(fields(one)))], Actor::by("person")).unwrap();
    there.log.write(&[("note-1", "note", Some(fields(other)))], Actor::by("person")).unwrap();
    let settled = {
        let mut send = |request: &SettleRequest| answer_settle(&mut there, request, Bounds::default(), "now", KEPT_APART);
        settle_with(&mut here, &mut send, "here", SettleState::default(), Bounds::default(), KEPT_APART, &mut |_| {}).unwrap()
    };
    assert!(settled.equal && settled.conflicts.is_empty(), "the same value, members in another order, is no conflict: {settled:?}");
}

// ---- a store that counts its reads and can move while read (for the table copy) ----

/// A store that counts its reads of kept states: point reads, and batched reads with how many keys they carry.
struct Counted {
    inner: Memory,
    point: std::cell::Cell<usize>,
    batched: std::cell::Cell<(usize, usize)>,
    /// At this scan, a write lands in the store (another writer while it is read).
    moves_at: std::cell::Cell<Option<usize>>,
    scans: std::cell::Cell<usize>,
}
impl crate::storage::Storage for Counted {
    fn schema(&self) -> &'static crate::storage::Schema { self.inner.schema() }
    fn get(&self, family: &str, key: &[crate::storage::Value], read: &[crate::storage::Read<'_>]) -> crate::storage::Result<Option<crate::storage::Row>> {
        if family == "settle_records" {
            self.point.set(self.point.get() + 1);
        }
        self.inner.get(family, key, read)
    }
    fn scan(&self, family: &str, range: &crate::storage::Range<'_>, read: &[crate::storage::Read<'_>]) -> crate::storage::Result<Vec<crate::storage::Row>> {
        self.scans.set(self.scans.get() + 1);
        if self.moves_at.get() == Some(self.scans.get()) {
            use crate::storage::Value as V;
            let row = [("account", V::from("account")), ("resource", V::from("own-records")), ("id", V::from("arrived-while-read")), ("valid_to", V::Integer(i64::MAX)),
                ("valid_from", V::Integer(1)), ("version", V::Integer(1)), ("deleted", V::Integer(0)), ("body", V::Blob(b"{}".to_vec())), ("ring", V::Null), ("kind", V::Null)];
            self.inner.put("versions", &row, crate::storage::When::Always)?;
        }
        self.inner.scan(family, range, read)
    }
    fn read_many(&self, queries: &[crate::storage::Query<'_>]) -> crate::storage::Result<Vec<crate::storage::Reply>> {
        let (calls, keys) = self.batched.get();
        self.batched.set((calls + 1, keys + queries.len()));
        self.inner.read_many(queries)
    }
    fn put(&self, family: &str, row: &[(&str, crate::storage::Value)], when: crate::storage::When<'_>) -> crate::storage::Result<u64> { self.inner.put(family, row, when) }
    fn write_many(&self, writes: &[crate::storage::Write<'_>]) -> crate::storage::Result<Vec<u64>> { self.inner.write_many(writes) }
    fn count(&self, family: &str, range: &crate::storage::Range<'_>) -> crate::storage::Result<u64> { self.inner.count(family, range) }
    fn erase(&self, family: &str, range: &crate::storage::Range<'_>) -> crate::storage::Result<u64> { self.inner.erase(family, range) }
    fn present(&self, family: &str) -> crate::storage::Result<bool> { self.inner.present(family) }
    fn custody(&self) -> crate::storage::Result<()> { self.inner.custody() }
    fn location(&self) -> Option<&str> { self.inner.location() }
    fn scoped(&self) -> bool { self.inner.scoped() }
    fn writing(&self) -> crate::storage::Result<bool> { self.inner.writing() }
    fn changes(&self) -> u64 { self.inner.changes() }
    fn mark(&self) -> crate::storage::Result<i64> { self.inner.mark() }
    fn schema_mark(&self) -> crate::storage::Result<i64> { self.inner.schema_mark() }
    fn allocated_bytes(&self) -> crate::storage::Result<u64> { self.inner.allocated_bytes() }
    fn open_scope(&self, intent: crate::storage::Intent) -> crate::storage::Result<()> { self.inner.open_scope(intent) }
    fn close_scope(&self, commit: bool) -> crate::storage::Result<()> { self.inner.close_scope(commit) }
}

fn counted() -> Counted {
    Counted { inner: Memory::open("record_store").unwrap(), point: Default::default(), batched: Default::default(), moves_at: Default::default(), scans: Default::default() }
}

// ---- the table copy: resource-state-carry.mjs keysetRows / readBackRows / bindSourceManifest ----

const SCOPE_FAMILIES: [&str; 6] = ["versions", "ordered", "order_state", "settle_log", "settle_records", "settle_sums"];

fn filled_store<S: crate::storage::Storage + Send>(storage: S, count: usize) -> super::RecordStore<S> {
    use crate::records::{Mutation, Records};
    let mut store = super::RecordStore::new(storage, Box::new(super::RealClock), super::settings::Limits::fixed(1 << 20, 1 << 30)).unwrap().mirrored(true);
    for at in 0..count {
        store.mutate("account", "own-records", Mutation { id: format!("r-{at:04}"), expected_version: 0, request_key: format!("k-{at}"), deleted: false, value: json!({"kind": "note", "text": "x".repeat(300), "n": at}) }).unwrap();
    }
    store
}

#[test]
fn carry_scope_carries_a_store_s_rows_of_one_scope_in_bounded_pages_each_read_back_and_the_whole_compared() {
    use crate::records::Records;
    use crate::storage::Value as V;
    let source = filled_store(Memory::open("record_store").unwrap(), 120);
    let destination = Memory::open("record_store").unwrap();
    let prefix = [V::from("account"), V::from("own-records")];
    let bounds = super::carry::CarryBounds { page_bytes: 8 * 1024, page_rows: 25, accept_bytes: 4 * 1024 * 1024, row_bytes: 1 << 20 };
    let carried = super::carry::carry_scope(source.storage(), &destination, &prefix, &SCOPE_FAMILIES, bounds).unwrap();
    assert!(carried.may_retire, "{carried:?}");
    assert!(carried.pages > 120 / 25, "pages are bounded by rows and bytes: {carried:?}");
    assert_eq!(carried.families[0], ("versions".to_string(), 120));
    // The destination is the same store: its records read as the source's, and its settle store holds one root.
    let copy = super::RecordStore::new(destination, Box::new(super::RealClock), super::settings::Limits::fixed(1 << 20, 1 << 30)).unwrap();
    for id in ["r-0000", "r-0119"] {
        assert_eq!(copy.get("account", "own-records", id).unwrap().record.map(|record| record.value), source.get("account", "own-records", id).unwrap().record.map(|record| record.value));
    }
    let root = |storage: &dyn crate::storage::Storage| RecordLog::new(storage, "account", "own-records").checksum().unwrap().root;
    assert_eq!(root(copy.storage()), root(source.storage()));
    // Carried again, nothing changes and it still may retire.
    let again = super::carry::carry_scope(source.storage(), copy.storage(), &prefix, &SCOPE_FAMILIES, bounds).unwrap();
    assert!(again.may_retire);
}

#[test]
fn carry_scope_refuses_a_row_past_its_bound_and_a_source_that_moved_while_carried() {
    use crate::storage::Value as V;
    let prefix = [V::from("account"), V::from("own-records")];
    let source = filled_store(Memory::open("record_store").unwrap(), 10);
    let tight = super::carry::CarryBounds { page_bytes: 64, page_rows: 4, accept_bytes: 64, row_bytes: 100 };
    let refused = super::carry::carry_scope(source.storage(), &Memory::open("record_store").unwrap(), &prefix, &["versions"], tight).unwrap_err();
    assert_eq!(refused.status, 413);
    // A write lands in the source while it is read: the carry is refused, and carried again it may retire.
    let moving = filled_store(counted(), 10);
    moving.storage().moves_at.set(Some(moving.storage().scans.get() + 4));
    let bounds = super::carry::CarryBounds { page_rows: 3, ..super::carry::CarryBounds::default() };
    let destination = Memory::open("record_store").unwrap();
    let moved = super::carry::carry_scope(moving.storage(), &destination, &prefix, &["versions"], bounds).unwrap_err();
    assert_eq!(moved.status, 409, "{moved:?}");
    moving.storage().moves_at.set(None);
    assert!(super::carry::carry_scope(moving.storage(), &destination, &prefix, &["versions"], bounds).unwrap().may_retire);
    // A family the store does not declare is refused.
    assert_eq!(super::carry::carry_scope(source.storage(), &destination, &prefix, &["no-such-family"], bounds).unwrap_err().status, 400);
}
