//! The world's network: messages arrive at a seeded latency. A partition drops every message between two nodes while it
//! holds, a killed node receives nothing, and a paused node's messages wait until it resumes.

use super::rng::Rng;
use std::{
    cmp::Reverse,
    collections::{BTreeMap, BTreeSet, BinaryHeap},
};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Message {
    pub from: String,
    pub to: String,
    pub body: String,
}

#[derive(Default)]
pub struct Network {
    in_flight: BinaryHeap<Reverse<(i64, u64, Message)>>,
    sequence: u64,
    partitions: BTreeSet<(String, String)>,
    paused: BTreeSet<String>,
    killed: BTreeSet<String>,
    held: BTreeMap<String, Vec<Message>>,
}

fn pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

impl Network {
    /// Queues `message` for delivery after a seeded latency. A killed sender sends nothing.
    pub fn send(&mut self, now: i64, rng: &mut Rng, message: Message) -> bool {
        if self.killed.contains(&message.from) {
            return false;
        }
        let arrives = now + rng.between(1, 20);
        self.sequence += 1;
        self.in_flight.push(Reverse((arrives, self.sequence, message)));
        true
    }

    /// The messages that arrive by `now`, in arrival order. A message is dropped when a partition or a kill stands at
    /// its arrival; a paused receiver holds it until resumed.
    pub fn deliver(&mut self, now: i64) -> Vec<Message> {
        let mut delivered = Vec::new();
        while self.in_flight.peek().is_some_and(|Reverse((at, _, _))| *at <= now) {
            let Reverse((_, _, message)) = self.in_flight.pop().expect("peeked");
            if self.killed.contains(&message.to) || self.partitions.contains(&pair(&message.from, &message.to)) {
                continue;
            }
            if self.paused.contains(&message.to) {
                self.held.entry(message.to.clone()).or_default().push(message);
            } else {
                delivered.push(message);
            }
        }
        delivered
    }

    pub fn partition(&mut self, a: &str, b: &str) {
        self.partitions.insert(pair(a, b));
    }

    pub fn heal(&mut self, a: &str, b: &str) {
        self.partitions.remove(&pair(a, b));
    }

    pub fn kill(&mut self, node: &str) {
        self.killed.insert(node.to_string());
        self.held.remove(node);
    }

    pub fn pause(&mut self, node: &str) {
        self.paused.insert(node.to_string());
    }

    /// Resumes a paused node; the messages it was held are returned for delivery to it.
    pub fn resume(&mut self, node: &str) -> Vec<Message> {
        self.paused.remove(node);
        self.held.remove(node).unwrap_or_default()
    }
}
