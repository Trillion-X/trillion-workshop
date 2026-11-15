//! The deterministic world's own proofs: one seed names one trace, every owner (disk, network, identity, clock) keeps
//! its promise, every fault row applies by its kind, every property kind has one check, and every seed in the corpus
//! replays to the trace BLAKE3 it was recorded with.

use super::corpus::{self, CorpusRow};
use super::faults::{self, Fault};
use super::properties::{self, Evidence, Kind, Property};
use super::World;

const FAULTS: &str = include_str!("../faults.json");
const PROPERTIES: &str = include_str!("../properties.json");
const SEED_CORPUS: &str = include_str!("../seed-corpus.json");
use super::SCENARIOS;

/// The scenarios the corpus can name. A row whose scenario is not here fails the replay, so no seed silently stops
/// running.
fn run_scenario(name: &str, seed: u64) -> Option<Vec<String>> {
    match name {
        "fault-rows-apply" => {
            let mut world = World::new(seed);
            world.open_identity("a").expect("the first session opens");
            world.send("a", "b", "hello");
            world.write("records/one", b"first").expect("the disk has room");
            world.fsync("records/one");
            world.write("records/two", b"unsynced").expect("the disk has room");
            for row in faults::load(FAULTS) {
                world.apply(&row.fault);
                let gap_ms = world.random(1, 500);
                world.advance(gap_ms);
            }
            world.deliver();
            Some(world.trace().to_vec())
        }
        _ => None,
    }
}

fn replay(row: &CorpusRow) -> Result<(), String> {
    let trace = run_scenario(&row.scenario, row.seed).ok_or_else(|| format!("unknown scenario {}", row.scenario))?;
    let actual = corpus::trace_blake3(&trace);
    if actual == row.trace_blake3 {
        Ok(())
    } else {
        Err(format!("{} seed {} replayed to {actual}, recorded {}", row.scenario, row.seed, row.trace_blake3))
    }
}

fn property(id: &str) -> Property {
    properties::load(PROPERTIES).into_iter().find(|row| row.id == id).expect("the property row exists")
}

#[test]
fn one_seed_names_one_trace() {
    let mut first = World::new(7);
    let mut second = World::new(7);
    let mut other = World::new(8);
    for world in [&mut first, &mut second, &mut other] {
        world.send("a", "b", "x");
        let step = world.random(1, 1000);
        world.advance(step);
        world.deliver();
    }
    assert_eq!(first.now_ms(), second.now_ms());
    assert_eq!(first.trace(), second.trace());
    assert_eq!(first.trace_blake3(), second.trace_blake3());
    assert_ne!(first.trace_blake3(), other.trace_blake3());
}

#[test]
fn a_full_disk_refuses_the_write_and_changes_nothing() {
    let mut world = World::new(1);
    world.write("records/a", &[0; 100]).expect("room for 100 bytes");
    world.apply(&Fault::Enospc { capacity_bytes: 150 });
    assert!(world.write("records/b", &[0; 100]).is_err(), "100 more bytes are past 150");
    assert!(world.read("records/b").is_none(), "a refused write leaves nothing behind");
    world.write("records/a", &[0; 150]).expect("replacing a file counts its old bytes once");
}

#[test]
fn a_power_cut_keeps_fsynced_bytes_and_drops_the_rest() {
    let mut world = World::new(1);
    world.write("records/synced", b"kept").unwrap();
    world.fsync("records/synced");
    world.write("records/pending", b"lost").unwrap();
    world.apply(&Fault::PowerCut);
    assert_eq!(world.read("records/synced"), Some(&b"kept"[..]));
    assert_eq!(world.read("records/pending"), None);
}

#[test]
fn a_partition_drops_and_a_heal_restores_delivery() {
    let mut world = World::new(3);
    world.apply(&Fault::Partition { a: "a".into(), b: "b".into() });
    world.send("a", "b", "cut");
    world.advance(100);
    assert!(world.deliver().is_empty(), "a partition drops the message");
    world.apply(&Fault::Heal { a: "b".into(), b: "a".into() });
    world.send("a", "b", "back");
    world.advance(100);
    let delivered: Vec<String> = world.deliver().into_iter().map(|message| message.body).collect();
    assert_eq!(delivered, ["back"]);
}

#[test]
fn a_paused_node_holds_its_messages_until_it_resumes() {
    let mut world = World::new(4);
    world.apply(&Fault::Pause { node: "a".into() });
    world.send("b", "a", "held");
    world.advance(100);
    assert!(world.deliver().is_empty(), "a paused node receives nothing");
    world.apply(&Fault::Resume { node: "a".into() });
    assert!(world.trace().last().unwrap().contains("released 1"), "the held message is released on resume");
}

#[test]
fn a_killed_node_sends_and_receives_nothing() {
    let mut world = World::new(5);
    world.apply(&Fault::Kill { node: "a".into() });
    assert!(!world.send("a", "b", "from the dead"));
    assert!(world.send("b", "a", "to the dead"));
    world.advance(100);
    assert!(world.deliver().is_empty());
}

#[test]
fn a_live_identity_admits_one_session() {
    let mut world = World::new(6);
    world.open_identity("computer-a").expect("the first session opens");
    world.apply(&Fault::DuplicateIdentity { node: "computer-a".into() });
    assert!(world.trace().last().unwrap().ends_with("refused"), "a second process under a live identity is refused");
    world.apply(&Fault::Kill { node: "computer-a".into() });
    world.open_identity("computer-a").expect("a killed node frees its identity");
}

#[test]
fn every_fault_row_applies_by_its_kind() {
    let rows = faults::load(FAULTS);
    let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(ids.len(), 11, "the eleven fault kinds are rows: {ids:?}");
    let mut world = World::new(9);
    for row in &rows {
        world.apply(&row.fault);
    }
    assert!(!world.config_loads("a"), "the config-load failure row broke node a");
    assert_eq!(world.version("a"), 39, "the version-skew row set node a to release 39");
}

#[test]
fn each_property_kind_has_one_check_that_passes_and_one_that_fails() {
    let always = Property { id: "always".into(), kind: Kind::Always, bound: None };
    assert!(properties::check(&always, &Evidence::Always(true)).is_ok());
    assert!(properties::check(&always, &Evidence::Always(false)).is_err());

    let liveness = property("writer_found_after_heal");
    let within = Evidence::Liveness { started_at: 0, reached_at: Some(liveness.bound.unwrap()) };
    assert!(properties::check(&liveness, &within).is_ok());
    let late = Evidence::Liveness { started_at: 0, reached_at: Some(liveness.bound.unwrap() + 1) };
    assert!(properties::check(&liveness, &late).is_err());
    assert!(properties::check(&liveness, &Evidence::Liveness { started_at: 0, reached_at: None }).is_err());

    let bounded = property("store_bytes_bounded_after_compaction");
    assert!(properties::check(&bounded, &Evidence::Bounded(4096)).is_ok());
    assert!(properties::check(&bounded, &Evidence::Bounded(4097)).is_err());

    let compat = property("release_fixtures_decode");
    assert!(properties::check(&compat, &Evidence::Compat(true)).is_ok());
    assert!(properties::check(&compat, &Evidence::Compat(false)).is_err());

    let equality = property("deployed_bytes_match_data");
    let same = Evidence::Equality { left: "x".into(), right: "x".into() };
    assert!(properties::check(&equality, &same).is_ok());
    let differ = Evidence::Equality { left: "x".into(), right: "y".into() };
    assert!(properties::check(&equality, &differ).is_err());
}

#[test]
fn a_property_checked_with_another_kinds_evidence_fails() {
    let bounded = property("store_bytes_bounded_after_compaction");
    assert!(properties::check(&bounded, &Evidence::Compat(true)).is_err(), "a mismatched kind never passes");
}

#[test]
fn every_seed_in_the_corpus_replays_to_its_recorded_trace() {
    let rows = corpus::load(SEED_CORPUS);
    for row in &rows {
        replay(row).unwrap_or_else(|why| panic!("{why}"));
    }
}

#[test]
fn a_planted_failure_is_replayed_and_caught() {
    let planted = CorpusRow { scenario: "fault-rows-apply".into(), seed: 11, trace_blake3: "1e:00".into() };
    let why = replay(&planted).expect_err("a wrong recorded trace fails the replay");
    assert!(why.contains("replayed to"), "the failure names the actual trace: {why}");
    let unknown = CorpusRow { scenario: "no-such-scenario".into(), seed: 1, trace_blake3: String::new() };
    assert!(replay(&unknown).is_err(), "a corpus row with no scenario fails");
}

#[test]
fn every_incident_has_a_scenario_row_with_an_owner_and_a_verdict() {
    let rows = super::scenario_rows::load(SCENARIOS);
    let mut incidents: Vec<u32> = rows.iter().map(|row| row.incident).collect();
    incidents.sort_unstable();
    incidents.dedup();
    assert_eq!(incidents, (1..=25).collect::<Vec<u32>>(), "every incident has a row");
    for row in &rows {
        assert!(!row.owner.is_empty() && !row.plan.is_empty(), "incident {} names its owner and plan rows", row.incident);
        assert!(["partial", "open", "done"].contains(&row.status_on_main.as_str()), "incident {} status", row.incident);
        assert!(["pass", "fail", "unwritten"].contains(&row.expect.as_str()), "{} expect", row.scenario);
    }
}

#[test]
fn every_scenario_with_a_verdict_names_a_test_fn_its_owner_file_has() {
    let rows = super::scenario_rows::load(SCENARIOS);
    for row in rows.iter().filter(|row| row.expect != "unwritten") {
        let named = row.test.as_deref().unwrap_or_else(|| panic!("{} has a verdict and names no test", row.scenario));
        let (file, function) = named.split_once("::").unwrap_or_else(|| panic!("{named} is not file::fn"));
        let source = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file))
            .unwrap_or_else(|error| panic!("{file}: {error}"));
        assert!(source.contains(&format!("fn {function}(")), "{file} has no fn {function}, which {} names", row.scenario);
    }
}

#[test]
fn the_world_clock_is_the_crate_clock_and_a_wait_advances_it() {
    use crate::storage::time_source::Clock;
    let mut world = World::new(12);
    let clock = world.clock();
    let start = clock.now_ms();
    world.advance(250);
    assert_eq!(clock.now_ms(), start + 250, "advance moves the clock the owners read");
    clock.wait(std::time::Duration::from_millis(100));
    assert_eq!(world.now_ms(), start + 350, "a wait is virtual: it moves time, it does not sleep");
    world.apply(&Fault::ClockBump { ms: 1_000 });
    assert_eq!(clock.now_ms(), start + 1_350, "a clock bump is seen through the trait");
}
