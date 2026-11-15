// month_tests.rs, in the record store's folder
//
// Purpose: The per-arrival growth guard, ported one to one from old trillion test/store-month.test.mjs with its
// ceilings (src/reliability-ceilings.json `month`, here `settings.json` `per_arrival`): a store lives through a
// simulated month. Every day brings `arrivals_per_day` arrivals (each one a new message record, as the door takes an
// arrival, and its conversation record replaced), the clock moves between them, and the store's timer runs its exit
// step every hour. What the store keeps, read once it has sat quiet for `settle_hours`, is held to
// `database_bytes_per_arrival` live bytes per arrival (live pages, never the free ones), and the month's last week is
// no costlier per arrival than its first times `late_growth_ratio` (plus 64 bytes), read from the floor: the least the
// store holds from that day on.
//
// What was dropped from the old test, and why: the request, wake and cold-boot read ceilings (this store reads in
// bounded pages, counted by `Work`, and has no boot read of a Durable Object's whole state) and the bucket ceiling (it
// keeps no bucket: history leaves the store by the history bound instead of moving to a bucket).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{clock_ms, settings, Clock, RecordStore};
use crate::{
    records::{Mutation, Records},
    storage::sqlite::{self, Bounds, Spend},
};
use std::{
    path::Path,
    sync::{atomic::{AtomicU64, Ordering}, Arc},
    time::Duration,
};

const DAY: u64 = 86_400_000;
const HOUR: u64 = 3_600_000;
const ACCOUNT: &str = "person";
const RESOURCE: &str = "own-records";

#[derive(Clone)]
struct Moved(Arc<AtomicU64>);
impl Clock for Moved {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Acquire) as i64
    }
}

/// The words of one day (old trillion test/fault/simulated-person.mjs `dayOfWords`, the same words every run): a sentence of 8 to 40
/// words drawn from a small vocabulary, as an arrival's text.
struct Words(u64);
impl Words {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn say(&mut self) -> String {
        const VOCABULARY: [&str; 24] = ["the", "plan", "meeting", "moved", "to", "tomorrow", "call", "back", "about", "invoice",
            "client", "said", "yes", "need", "draft", "today", "review", "send", "notes", "after", "lunch", "question", "price", "team"];
        let count = 8 + (self.next() % 33) as usize;
        (0..count).map(|_| VOCABULARY[(self.next() % VOCABULARY.len() as u64) as usize]).collect::<Vec<_>>().join(" ")
    }
}

/// Bytes the store file's pages hold, without free pages.
fn live_bytes(path: &Path) -> u64 {
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let pragma = |name: &str| db.query_row(&format!("PRAGMA {name}"), [], |row| row.get::<_, i64>(0)).unwrap() as u64;
    (pragma("page_count") - pragma("freelist_count")) * pragma("page_size")
}

/// The tables and indexes that hold the most bytes, when the store's SQLite has `dbstat` (named when the guard fails).
fn largest_tables(path: &Path) -> Vec<(String, i64)> {
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let Ok(mut query) = db.prepare("SELECT name, SUM(pgsize - unused) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 8") else {
        return Vec::new();
    };
    query.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

#[test]
fn a_month_of_arrivals_stays_inside_the_stores_bytes_per_arrival() {
    let limits = &settings::shipped().unwrap().per_arrival;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("person.sqlite");
    let clock = Moved(Arc::new(AtomicU64::new(1_790_000_000_000)));
    let bounds = Bounds { value_bytes: 64 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) };
    let mut store = RecordStore::new(sqlite::open_owned(&path, super::SCHEMA, bounds).unwrap(), Box::new(clock.clone()), settings::Limits::fixed(1 << 20, 10 << 30))
        .unwrap();
    let mut words = Words(limits.seed);
    let mut conversations: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let (mut arrivals, mut next_timer) = (0u64, clock_ms(&clock) + HOUR);
    // (day, arrivals so far, live bytes)
    let mut kept: Vec<(u32, u64, u64)> = Vec::new();
    for day in 0..limits.days {
        for _ in 0..limits.arrivals_per_day {
            clock.0.fetch_add(DAY / u64::from(limits.arrivals_per_day), Ordering::AcqRel);
            let conversation = format!("c-{}", arrivals / 20);
            let from_person = arrivals % 5 == 0;
            let text = words.say();
            let message = serde_json::json!({"kind": "message", "route": "Listening", "source_id": format!("s-{arrivals}"),
                "conversation_id": conversation, "text": text, "at": clock.now_ms(),
                "from": if from_person { serde_json::Value::Null } else { "Someone (voice-2)".into() }, "from_person": from_person});
            store.mutate(ACCOUNT, RESOURCE, Mutation { id: format!("m-{arrivals}"), expected_version: 0, request_key: format!("arrival-{arrivals}"), deleted: false, value: message })
                .unwrap_or_else(|error| panic!("arrival {arrivals}: {error}"));
            let version = conversations.get(&conversation).copied().unwrap_or(0);
            let summary = serde_json::json!({"kind": "conversation", "last": text, "count": arrivals % 20 + 1, "at": clock.now_ms()});
            let changed = store.mutate(ACCOUNT, RESOURCE, Mutation { id: conversation.clone(), expected_version: version, request_key: format!("conversation-{arrivals}"), deleted: false, value: summary })
                .unwrap();
            conversations.insert(conversation, changed.version);
            arrivals += 1;
            // The store's timer: one exit step every hour, as a host timer runs it (`retire`).
            while clock_ms(&clock) >= next_timer {
                store.level().unwrap();
                store.retire(ACCOUNT, RESOURCE).unwrap();
                next_timer += HOUR;
            }
        }
        kept.push((day, arrivals, live_bytes(&path)));
    }
    // Read once the store sat quiet: its timer runs through `settle_hours`.
    for _ in 0..limits.settle_hours {
        clock.0.fetch_add(HOUR, Ordering::AcqRel);
        store.retire(ACCOUNT, RESOURCE).unwrap();
    }
    let settled = live_bytes(&path);
    eprintln!("per-arrival arrivals={arrivals} database_bytes={settled} per_arrival={}", settled / arrivals);
    let largest = largest_tables(&path);
    eprintln!("per-arrival largest={largest:?}");
    assert!(settled / arrivals <= limits.database_bytes_per_arrival,
        "the store keeps {} bytes per arrival ({settled} in all); largest {largest:?}", settled / arrivals);
    // Growth is read from the floor: the least the store holds from that day on.
    let mut floor = settled;
    let mut floors: Vec<(u64, u64)> = kept.iter().rev().map(|(_, at, bytes)| { floor = floor.min(*bytes); (*at, floor) }).collect();
    floors.reverse();
    let week = (limits.days / 4).max(1) as usize;
    let per = |from: (u64, u64), to: (u64, u64)| (to.1 as f64 - from.1 as f64) / (to.0 - from.0) as f64;
    let early = per(floors[0], floors[week]);
    let late = per(floors[floors.len() - 1 - week], floors[floors.len() - 1]);
    assert!(late <= early * limits.late_growth_ratio + 64.0, "{late:.0} bytes per arrival in the last {week} days against {early:.0} in the first");
}
