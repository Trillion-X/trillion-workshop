//! The plan's acceptance, simulated (PLAN-files-on-every-device.md section 4): the person's own words were "every
//! asset openable by Premiere/Finder and by agents 24/7, only touched bytes move". The links, clip lengths and read
//! sizes below are this test's scenario, named where they are set; the core is handed none of them.
//!
//! What a simulation cannot prove: a real player's reads, Finder, and a measured month's cost. Those are walked on a
//! real shell (lane finder-folder).

mod sim;

use files_core::Command;
use serde_json::json;
use sim::{Content, Linked, World};

/// One read of a player: when it asks (ms after opening), where and how much.
struct Read {
    at: u64,
    offset: u64,
    length: u64,
}

/// Plays reads in order, each no earlier than its time and after the one before was handed; answers each read's
/// wait for its bytes.
fn play(world: &mut World, name: &str, reads: &[Read], alignment: u64) -> Vec<u64> {
    let opened = world.now;
    let mut waits = Vec::new();
    for (index, read) in reads.iter().enumerate() {
        world.until(opened + read.at);
        let demand = 1000 + index as u64;
        let (answer, waited) = world.fetch(demand, name, read.offset, read.length, alignment);
        assert!(matches!(answer, Command::Fetched { .. }), "read {index}: {answer:?}");
        world.handed(demand);
        waits.push(waited);
    }
    waits
}

/// A 33 GB MP4 shows at full size and plays with about 17 MB fetched (old baseline, commit 40696f077e), at high
/// latency. Scenario: a three-hour clip (so its bitrate is 33 GB over 10,800 s), a satellite-like link of 300 ms
/// round trip at 100 Mbit/s, a player that reads the header, the index at the end, then two seconds of picture in
/// 256 KiB reads at the clip's bitrate, at the OS's 4 KiB alignment.
#[test]
fn a_33_gb_file_plays_with_only_touched_bytes_moved() {
    let size: u64 = 33_000_000_000;
    let mut world = World::new(vec![Linked { round_trip_ms: 300, bytes_per_ms: 12_500.0, down: false, silent: false }]);
    world.store.put_file("/clip.mp4", Content::Made { seed: 33, size }, Some(1));
    let Command::Items { items, .. } = world.list(1, "trillion") else { panic!() };
    assert_eq!(items[0].size, Some(size), "full size, nothing fetched");
    assert_eq!(world.span_bytes_asked, 0);

    let bytes_per_ms = size / 10_800_000;
    let piece: u64 = 256 << 10;
    let header = 64 << 10;
    let index = 1 << 20;
    let mut reads = vec![Read { at: 0, offset: 0, length: header }, Read { at: 0, offset: size - index, length: index }];
    let playing = 2_000 * bytes_per_ms;
    let mut offset = header;
    while offset < header + playing {
        reads.push(Read { at: (offset - header) / bytes_per_ms, offset, length: piece });
        offset += piece;
    }
    let touched: u64 = reads.iter().map(|read| read.length).sum();
    play(&mut world, "/clip.mp4", &reads, 4096);
    world.settle();
    let fetched = world.span_bytes_asked;
    println!("33 GB clip: touched {touched} bytes, fetched {fetched} bytes (old baseline 17 MB)");
    assert!(fetched >= touched);
    assert!(fetched <= 17_000_000, "fetched {fetched}");
    // The only bytes beyond those touched are one read-ahead window: at most one round trip of the link's bytes and
    // two of the player's reads (link.rs `ahead_bytes`), rounded up to a whole read (core.rs `handed`), plus the OS's 4 KiB alignment at both ends of each of the
    // three runs of reads.
    let link = world.core.link();
    let window = link.bytes_per_round_trip().unwrap() + 3 * piece + 2 * 4096 * 3;
    assert!(fetched - touched <= window, "{} beyond the touched bytes, window {window}", fetched - touched);
    // Every byte handed over is the file's.
    assert_eq!(world.held("/clip.mp4", size - index, index).unwrap(), Content::Made { seed: 33, size }.range(size - index, index));
}

/// A 40.54 GB video opens in place (commit 2e78646015): its first frame needs only its first bytes, and no byte of
/// the rest moves.
#[test]
fn a_40_gb_video_opens_in_place() {
    let size: u64 = 40_540_000_000;
    let mut world = World::new(vec![Linked { round_trip_ms: 80, bytes_per_ms: 12_500.0, down: false, silent: false }]);
    world.store.put_file("/long.mov", Content::Made { seed: 40, size }, Some(1));
    world.list(1, "trillion");
    let (answer, _) = world.fetch(2, "/long.mov", 0, 1 << 20, 4096);
    assert!(matches!(answer, Command::Fetched { .. }));
    assert_eq!(world.span_bytes_asked, 1 << 20);
}

/// Sequential reads never stall (f2 failure 1: a 2.8 GB file read straight through timed out at high latency).
/// Scenario: 600 ms round trip at 100 Mbit/s, a player consuming 40 Mbit/s in 1 MiB reads through the first 64 MiB
/// of a 2.8 GB file, which buffers its first three reads (0.6 s of clip) before its clock starts, as players do;
/// from then on every read is due at its place in the clip. Three is the fewest that holds (two lets three reads be
/// late) because read-ahead is trained only by the second handed copy and its first bytes need one round trip. No read ever waits as long as the contract's idle
/// bound, and no read after the start is late.
#[test]
fn sequential_reads_never_stall() {
    let size: u64 = 2_800_000_000;
    let mut world = World::new(vec![Linked { round_trip_ms: 600, bytes_per_ms: 12_500.0, down: false, silent: false }]);
    world.store.put_file("/long.mov", Content::Made { seed: 28, size }, Some(1));
    world.list(1, "trillion");
    let consumes: u64 = 5_000;
    let piece: u64 = 1 << 20;
    let reads: u64 = 64;
    let buffered: u64 = 3;
    let idle_ms = sim::contract_bounds()["idle_ms"].as_u64().unwrap();
    let mut start = 0;
    let mut late = Vec::new();
    for index in 0..reads {
        // Playback starts at the clip's first byte once its buffered reads are in; read k is due when playback reaches it.
        let due = start + index * piece / consumes;
        if index >= buffered {
            world.until(due);
        }
        let (answer, waited) = world.fetch(1000 + index, "/long.mov", index * piece, piece, 4096);
        assert!(matches!(answer, Command::Fetched { .. }));
        assert!(waited < idle_ms, "read {index} waited {waited} ms");
        world.handed(1000 + index);
        if index + 1 == buffered {
            start = world.now;
        }
        if index >= buffered {
            late.push(world.now.saturating_sub(due));
        }
    }
    assert!(late.iter().all(|late| *late == 0), "late reads: {late:?}");
    world.settle();
    // Only touched bytes and one read-ahead window beyond them moved.
    let link = world.core.link();
    assert!(world.span_bytes_asked <= reads * piece + link.bytes_per_round_trip().unwrap() + 3 * piece);
}

/// With this Mac's engine off, the folder is served by the next computer in the account's order (acceptance 5).
#[test]
fn the_next_computer_serves_when_one_is_off() {
    let mut world = World::fast(3);
    world.links[0].down = true;
    world.links[1].down = true;
    world.store.put_file("/a.txt", Content::Kept(b"abc".to_vec()), Some(1));
    assert!(matches!(world.list(1, "trillion"), Command::Items { .. }));
    let (answer, _) = world.fetch(2, "/a.txt", 0, 3, 1);
    assert!(matches!(answer, Command::Fetched { .. }));
    assert!(world.sends.iter().any(|(_, operation, _)| operation == "read_file_span"));
}

/// Ignore rules are the person's rows: names they cover are never shown and never sent.
#[test]
fn ignored_names_stay_on_this_device() {
    let mut world = World::fast(1);
    let ignore = json!([{"id": "finder-litter", "when": {"kind": "group", "combinator": "and", "negate": false, "rules": [{"kind": "rule", "field": "name", "operator": "matches_any_glob", "params": {"values": ["._*", ".DS_Store", ".Spotlight-V100*"]}}]}}]);
    world.event(json!({"rules": {"ignore": ignore}}));
    world.store.put_file("/.DS_Store", Content::Kept(b"x".to_vec()), Some(1));
    world.store.put_file("/kept.txt", Content::Kept(b"x".to_vec()), Some(1));
    let Command::Items { items, .. } = world.list(1, "trillion") else { panic!() };
    assert_eq!(items.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(), vec!["kept.txt"]);
    let sends = world.sends.len();
    let done = world.create_file(2, "trillion", "._kept.txt", b"resource fork");
    assert!(matches!(done, Command::Done { ignored: true, .. }));
    assert_eq!(world.sends.len(), sends, "nothing sent");
}

/// An ignore rule row with an unfinished condition is refused and never broadens to every item.
#[test]
fn an_unfinished_rule_is_refused() {
    let mut world = World::fast(1);
    let from = world.log.len();
    world.event(json!({"rules": {"ignore": [{"id": "half", "when": {"kind": "group", "combinator": "and", "negate": false, "rules": [{"kind": "rule", "field": "path", "operator": "starts_with", "params": {"text": ""}}]}}]}}));
    assert!(world.commands(from).iter().any(|command| matches!(command, Command::RulesRefused { refused } if refused[0].id == "half")));
    world.store.put_file("/a.txt", Content::Kept(b"a".to_vec()), Some(1));
    let Command::Items { items, .. } = world.list(1, "trillion") else { panic!() };
    assert_eq!(items.len(), 1, "nothing hidden");
}
