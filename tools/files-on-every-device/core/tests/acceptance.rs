//! The plan's acceptance, simulated (PLAN-files-on-every-device.md section 4): the person's own words were "every
//! asset openable by Premiere/Finder and by agents 24/7, only touched bytes move". The links, clip lengths and read
//! sizes below are this test's scenario, named where they are set; the core is handed none of them.
//!
//! What a simulation cannot prove: a real player's reads, Finder, and a measured month's cost. Those are walked on a
//! real shell (lane finder-folder).

mod sim;

use files_core::Command;
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
    let mut world = World::new(Linked::files(300, 12_500.0));
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
    let mut world = World::new(Linked::files(80, 12_500.0));
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
    let mut world = World::new(Linked::files(600, 12_500.0));
    world.store.put_file("/long.mov", Content::Made { seed: 28, size }, Some(1));
    world.list(1, "trillion");
    let consumes: u64 = 5_000;
    let piece: u64 = 1 << 20;
    let reads: u64 = 64;
    let buffered: u64 = 3;
    let idle_ms = sim::idle_ms();
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

/// A file the store keeps as 32 KiB objects, each costing the store 100 ms in turn (finder-folder's measured risk: a
/// single sequential reader gets about 0.3 MiB/s from such a file on B2), still plays at 40 Mbit/s: read-ahead is
/// sized from the measured read wait, so enough reads are in flight at once (Little's law) to carry the reader.
/// Scenario: 100 ms round trip at 100 Mbit/s, 1 MiB reads through 96 MiB, the player buffering its first reads.
/// It holds only if the store serves several reads at once; the store reading one read's objects in parallel would
/// shorten the start (tools/live-namespace read_range_inner reads them in order today).
#[test]
fn a_file_of_small_objects_on_a_slow_store_still_plays() {
    let size: u64 = 2_800_000_000;
    let mut link = Linked::files(100, 12_500.0);
    link.store_ms_per_object = 100;
    link.object_bytes = 32 << 10;
    let mut world = World::new(link);
    world.store.put_file("/long.mov", Content::Made { seed: 7, size }, Some(1));
    world.list(1, "trillion");
    let consumes: u64 = 5_000;
    let piece: u64 = 1 << 20;
    let reads: u64 = 96;
    let buffered: u64 = 3;
    let mut start = 0;
    let mut late = Vec::new();
    for index in 0..reads {
        let due = start + index * piece / consumes;
        if index >= buffered {
            world.until(due);
        }
        let (answer, _) = world.fetch(1000 + index, "/long.mov", index * piece, piece, 4096);
        assert!(matches!(answer, Command::Fetched { .. }));
        world.handed(1000 + index);
        if index + 1 == buffered {
            start = world.now;
        }
        if index >= buffered {
            late.push(world.now.saturating_sub(due));
        }
    }
    println!("small objects: playing from {start} ms, fetched {} bytes for {} touched", world.span_bytes_asked, reads * piece);
    assert!(late.iter().all(|late| *late == 0), "late reads: {late:?}");
    // Beyond the touched bytes: one read-ahead window, what the reader eats while one read waits and arrives, plus
    // two reads (link.rs `ahead_bytes`, rounded up to a whole read).
    let link = world.core.link();
    let window = consumes as f64 * (link.read_wait_ms().unwrap() as f64 + piece as f64 / link.file_rate().unwrap());
    assert!(world.span_bytes_asked - reads * piece <= window as u64 + 2 * piece, "{}", world.span_bytes_asked);
}
