//! The deterministic world: one seeded owner of the clock, the randomness, the disk, the network and the identities a
//! scenario runs in. Every change to the world is one line of its trace, so a seed names one run and the trace's
//! BLAKE3 names what that run did. A scenario reaches time, disk, network and identity only through this owner.

pub(crate) mod corpus;
pub(crate) mod disk;
pub(crate) mod faults;
pub(crate) mod identity;
pub(crate) mod network;
pub(crate) mod properties;
pub(crate) mod rng;
pub(crate) mod scenario_rows;
#[cfg(test)]
mod proofs;

use disk::{Disk, DiskError};
use identity::{Identities, IdentityError};
use network::{Message, Network};
use crate::storage::time_source::Clock;
use rng::Rng;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{atomic::{AtomicI64, Ordering}, Arc},
};

/// The world's clock: one shared virtual time, read through the crate's one `Clock` trait. A wait advances it, so a waiting
/// owner never sleeps in real time.
pub struct WorldClock(Arc<AtomicI64>);

impl Clock for WorldClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Acquire)
    }

    fn wait(&self, duration: std::time::Duration) {
        self.0.fetch_add(duration.as_millis() as i64, Ordering::AcqRel);
    }
}

pub struct World {
    now: Arc<AtomicI64>,
    rng: Rng,
    disk: Disk,
    network: Network,
    identities: Identities,
    versions: BTreeMap<String, u32>,
    broken_config: BTreeSet<String>,
    trace: Vec<String>,
}

impl World {
    pub fn new(seed: u64) -> Self {
        Self {
            now: Arc::new(AtomicI64::new(1_000_000)),
            rng: Rng::new(seed),
            disk: Disk::default(),
            network: Network::default(),
            identities: Identities::default(),
            versions: BTreeMap::new(),
            broken_config: BTreeSet::new(),
            trace: Vec::new(),
        }
    }

    /// The world's clock, for an owner built on the crate's `Clock` trait.
    pub fn clock(&self) -> WorldClock {
        WorldClock(self.now.clone())
    }

    pub fn now_ms(&self) -> i64 {
        self.now.load(Ordering::Acquire)
    }

    /// Moves the clock forward by `ms`.
    pub fn advance(&mut self, ms: i64) {
        self.now.fetch_add(ms, Ordering::AcqRel);
        self.log(format!("advance {ms}"));
    }

    /// A seeded value in `low..=high`, for a scenario's own choices.
    pub fn random(&mut self, low: i64, high: i64) -> i64 {
        self.rng.between(low, high)
    }

    pub fn write(&mut self, path: &str, bytes: &[u8]) -> Result<(), DiskError> {
        let outcome = self.disk.write(path, bytes);
        self.log(format!("write {path} {} bytes {}", bytes.len(), if outcome.is_ok() { "ok" } else { "enospc" }));
        outcome
    }

    pub fn fsync(&mut self, path: &str) {
        self.disk.fsync(path);
        self.log(format!("fsync {path}"));
    }

    pub fn read(&self, path: &str) -> Option<&[u8]> {
        self.disk.read(path)
    }

    pub fn send(&mut self, from: &str, to: &str, body: &str) -> bool {
        let message = Message { from: from.to_string(), to: to.to_string(), body: body.to_string() };
        let queued = self.network.send(self.now_ms(), &mut self.rng, message);
        self.log(format!("send {from}->{to} {body} {}", if queued { "queued" } else { "from-killed" }));
        queued
    }

    /// The messages that arrive by now. Each is traced.
    pub fn deliver(&mut self) -> Vec<Message> {
        let delivered = self.network.deliver(self.now_ms());
        for message in &delivered {
            self.log(format!("deliver {}->{} {}", message.from, message.to, message.body));
        }
        delivered
    }

    pub fn open_identity(&mut self, identity: &str) -> Result<u64, IdentityError> {
        let outcome = self.identities.open(identity);
        self.log(format!("open {identity} {}", if outcome.is_ok() { "ok" } else { "duplicate" }));
        outcome
    }

    /// Every fact the scenario can read back: the time, the release a node runs, whether its config loads.
    pub fn version(&self, node: &str) -> u32 {
        self.versions.get(node).copied().unwrap_or(1)
    }

    pub fn config_loads(&self, node: &str) -> bool {
        !self.broken_config.contains(node)
    }

    /// The trace of every change so far, one line each.
    pub fn trace(&self) -> &[String] {
        &self.trace
    }

    pub fn trace_blake3(&self) -> String {
        corpus::trace_blake3(&self.trace)
    }

    fn log(&mut self, line: String) {
        self.trace.push(format!("t={} {line}", self.now_ms()));
    }

    fn jump(&mut self, ms: i64) {
        self.now.fetch_add(ms, Ordering::AcqRel);
        self.log(format!("clock-bump {ms}"));
    }

    fn partition(&mut self, a: &str, b: &str) {
        self.network.partition(a, b);
        self.log(format!("partition {a} {b}"));
    }

    fn heal(&mut self, a: &str, b: &str) {
        self.network.heal(a, b);
        self.log(format!("heal {a} {b}"));
    }

    fn kill(&mut self, node: &str) {
        self.network.kill(node);
        self.identities.close(node);
        self.log(format!("kill {node}"));
    }

    fn pause(&mut self, node: &str) {
        self.network.pause(node);
        self.log(format!("pause {node}"));
    }

    fn resume(&mut self, node: &str) {
        let released = self.network.resume(node);
        self.log(format!("resume {node} released {}", released.len()));
    }

    fn limit_disk(&mut self, capacity_bytes: usize) {
        self.disk.set_capacity(capacity_bytes);
        self.log(format!("enospc capacity {capacity_bytes}"));
    }

    fn power_cut(&mut self) {
        self.disk.power_cut();
        self.log("power-cut".to_string());
    }

    fn duplicate_identity(&mut self, node: &str) {
        let outcome = self.open_identity(node);
        self.log(format!("duplicate-identity {node} {}", if outcome.is_ok() { "admitted" } else { "refused" }));
    }

    fn break_config(&mut self, node: &str) {
        self.broken_config.insert(node.to_string());
        self.log(format!("config-load-failure {node}"));
    }

    fn set_version(&mut self, node: &str, version: u32) {
        self.versions.insert(node.to_string(), version);
        self.log(format!("version {node} {version}"));
    }
}

/// The incident scenario rows (`../scenarios.json`), read by the proofs and by each scenario's verdict.
pub const SCENARIOS: &str = include_str!("../scenarios.json");

/// Runs one scenario and checks its outcome against its row's `expect`. An owner's test module calls this from its own
/// `#[test]`, and names the same scenario its row names in `test`: a scenario that finds what its row does not expect
/// fails the suite, so a fix flips its row and a regression cannot hide behind a stale one.
pub(crate) fn verdict(scenario: &str, body: impl FnOnce() -> Result<(), String>) {
    let expect = scenario_rows::named(SCENARIOS, scenario).expect;
    let outcome = body();
    eprintln!("{scenario} found {outcome:?}");
    match (expect.as_str(), &outcome) {
        ("pass", Ok(())) => {}
        ("fail", Err(_)) => {}
        (expect, outcome) => panic!("{scenario}: its row expects {expect}, the scenario found {outcome:?}"),
    }
}
