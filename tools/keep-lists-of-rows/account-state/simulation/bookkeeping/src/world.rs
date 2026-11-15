//! The simulated world both protocols run in: one book (a RecordBook), the
//! account's gate and its quota owner, each a single-threaded object with
//! durable tables and memory that a crash, a restart or idle eviction loses;
//! clients that run each command through resolve, reserve, admit, invoke and
//! finish and retry a lost answer under the same request key; policy updates
//! that fence the gate and drain what is in flight; and the ghost record of
//! what really happened, which the oracles compare with what was kept.

use super::data::{CommandSpec, FaultExtras, PerAttempt, Plan, Prices, Protocol, Variant};
use super::store::{Db, Rng};
use serde_json::{json, Value};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap};

pub const HOUR: u64 = 3_600_000;
pub const DAY: u64 = 86_400_000;
/// The plan's daily spend cap (a stopping budget over every command's store work).
pub const PLAN_CAP_PER_DAY: f64 = 25.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum O {
    Book = 0,
    Gate = 1,
    Quota = 2,
}

impl O {
    pub fn name(self) -> &'static str {
        ["RecordBook", "AccountControl gate", "AccountControl quota"][self as usize]
    }
}

/// What a transaction's fault did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxEnd {
    /// Committed and the object lives on.
    Done,
    /// Committed, then the object died before it answered: the caller sees no answer.
    DoneLost,
    /// Rolled back (an interrupted statement); the object lives on.
    Interrupted,
    /// Rolled back and the object died.
    Crashed,
}

impl TxEnd {
    pub fn committed(self) -> bool {
        matches!(self, TxEnd::Done | TxEnd::DoneLost)
    }
}

/// What one client step answered.
#[derive(Clone, Debug)]
pub enum Step {
    Next,
    /// No answer: the client asks again under the same request key.
    Retry,
    Refused(&'static str, &'static str),
    Done(String),
    /// The command's outcome cannot be established; the client is told so and stops.
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Resolve,
    Reserve,
    Admit,
    Invoke,
    Commit,
    Finish,
    Read,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Running,
    Acked,
    Refused(&'static str, &'static str),
    Unknown,
}

#[derive(Clone, Debug)]
pub struct Cmd {
    pub shape: Option<usize>,
    /// A resend of an earlier acked command's request key.
    pub replay_of: Option<usize>,
    /// A refund of a paid run that failed after its charge.
    pub refund_of: Option<usize>,
    pub key: String,
    pub start: u64,
    pub tries: u32,
    pub phase: Phase,
    pub read_at: usize,
    pub admitted_epoch: Option<u64>,
    pub lease: Option<String>,
    pub status: Status,
    pub answer: Option<String>,
    pub expected: Option<String>,
    /// The unit of the attempt whose effect committed.
    pub unit: Option<usize>,
    /// Refused attempts before any effect (the gate's `~N` permits; the floor's aborted receipts).
    pub refused_attempts: u32,
    pub refund_spawned: bool,
    /// The attempt now dispatched, and the book generation running it.
    pub pending_unit: Option<usize>,
    pub begun_gen: Option<u64>,
}

/// One piece of measured work: a command attempt that dispatched, or a read.
#[derive(Clone, Debug, Default)]
pub struct Unit {
    pub read: bool,
    pub subject: String,
    /// Dollars it was measured to use.
    pub measured: f64,
    /// Dollars it was admitted for.
    pub bound: f64,
    /// A paid run's price (charged by its domain record, not by the meter).
    pub price: f64,
    pub committed: bool,
    pub settled: u32,
    pub charged: f64,
    pub limits: f64,
    /// Its measurement died with its object before anything durable held it.
    pub lost: bool,
    pub acked: bool,
    pub day: u64,
    /// It never ran (its start rolled back).
    pub void: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Plain,
    Revoke,
    Restore,
    Ceiling(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdatePhase {
    Begin,
    Drain,
    Finish,
    Done,
}

#[derive(Clone, Debug)]
pub struct Update {
    pub id: String,
    pub change: Change,
    pub phase: UpdatePhase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Ev {
    Cmd(usize),
    Update(usize),
    Flush(u64),
    Alarm,
    Restart,
    /// Keep the rows written so far (a calibration schedule's measuring window).
    Mark,
}

/// Memory of one object, lost with its isolate. The book's fields serve both protocols.
#[derive(Default)]
pub struct Mem {
    // lease-blocks: read blocks held in memory (grant id -> started read units).
    pub ledgers: BTreeMap<String, BTreeSet<usize>>,
    pub inflight: BTreeMap<String, Option<String>>,
    // envelope: places, use not yet durable, registration, leases.
    pub places: BTreeMap<String, (String, f64, f64)>,
    pub unrecorded: Vec<usize>,
    pub registered: Option<u64>,
    pub registrations: u64,
    pub leases_live: BTreeSet<String>,
    pub leases_fenced: BTreeSet<String>,
    pub envelope_active: Option<u64>,
    // envelope: what its quota permit holds (its reservation and top-ups), read from the quota after a reset.
    pub reserved_live: Option<Vec<super::quota::Ask>>,
}

pub struct Object {
    pub db: Db,
    pub mem: Mem,
    pub gen: u64,
    pub last_active: u64,
    pub evict_after: u64,
    pub timer_at: Option<u64>,
}

pub struct Ghost {
    /// Units that died unrecorded with each lost generation of the book.
    pub dead_gens: HashMap<u64, Vec<usize>>,
    /// (epoch, time) at which each update finished and raised the epoch.
    pub epochs: Vec<(u64, u64)>,
    pub max_ceiling_by_day: BTreeMap<u64, f64>,
}

#[derive(Default, Clone, Debug, serde::Serialize)]
pub struct Violations {
    pub passed_in_flight: u64,
    pub admitted_while_fenced: u64,
    pub admitted_signed_out: u64,
    pub refusal_stage: u64,
    pub paid_over_ceiling: u64,
    pub double_effect: u64,
    pub lost_acks: u64,
    pub replay_mismatch: u64,
}

pub struct World {
    pub variant: Variant,
    pub plan: Plan,
    pub prices: Prices,
    pub extras: FaultExtras,
    pub chances: PerAttempt,
    pub profile: String,
    pub evict: bool,
    pub rng: Rng,
    pub now: u64,
    pub end: u64,
    pub events: BinaryHeap<Reverse<(u64, u64, Ev)>>,
    seq: u64,
    pub objects: [Object; 3],
    pub cmds: Vec<Cmd>,
    pub units: Vec<Unit>,
    pub updates: Vec<Update>,
    pub ghost: Ghost,
    pub violations: Violations,
    pub rows: BTreeMap<(O, String), u64>,
    /// Rows a receipt prune wrote, kept apart (a command's whole lifetime, not its first hour).
    pub prune_rows: BTreeMap<(O, String), u64>,
    pub pruning: bool,
    pub crashes: BTreeMap<&'static str, u64>,
    pub refusals: BTreeMap<String, u64>,
    pub alarm_at: Option<u64>,
    pub receipt_seq: u64,
    /// How many times each request key's effect committed (ghost).
    pub ghost_effects: HashMap<String, u32>,
    /// Times a policy drain found work still running under what it drains, and waited.
    pub drain_waits: u64,
    /// Whether idle objects are evicted in this run (the final settlement turns it off).
    pub evicting: bool,
    /// When the receipt prune last walked (it runs at most every five minutes, as metered-use.json receipt_prune.every_ms).
    pub pruned_at: u64,
    /// Rows written at each mark.
    pub marks: Vec<BTreeMap<(O, String), u64>>,
}

pub fn domain_rows(spec: &super::data::RowsSpec, rng: &mut Rng) -> u64 {
    spec.base + spec.extra.iter().map(|e| (0..e.count).filter(|_| rng.chance(e.chance)).count() as u64).sum::<u64>()
}

/// One run of the grid: how many days, which seed, and whether idle objects are evicted.
pub struct Run {
    pub days: u64,
    pub seed: u64,
    pub evict: bool,
}

impl World {
    pub fn new(variant: Variant, plan: Plan, prices: Prices, extras: FaultExtras, faults: (String, PerAttempt), run: Run) -> Self {
        let Run { days, seed, evict } = run;
        let mut rng = Rng::new(seed);
        let evict_range = extras.evict_idle_ms;
        let object = |rng: &mut Rng| Object { db: Db::default(), mem: Mem::default(), gen: rng.next(), last_active: 0,
            evict_after: rng.between(evict_range.min, evict_range.max), timer_at: None };
        let objects = [object(&mut rng), object(&mut rng), object(&mut rng)];
        let mut world = World { variant, plan, prices, extras, chances: faults.1, profile: faults.0, evict, rng, now: 0, end: days * DAY,
            events: BinaryHeap::new(), seq: 0, objects, cmds: Vec::new(), units: Vec::new(), updates: Vec::new(),
            ghost: Ghost { dead_gens: HashMap::new(), epochs: Vec::new(), max_ceiling_by_day: BTreeMap::new() },
            violations: Violations::default(), rows: BTreeMap::new(), prune_rows: BTreeMap::new(), pruning: false,
            crashes: BTreeMap::new(), refusals: BTreeMap::new(), alarm_at: None, receipt_seq: 0, ghost_effects: HashMap::new(), drain_waits: 0, evicting: evict, pruned_at: 0, marks: Vec::new() };
        world.bootstrap();
        world.schedule_all();
        world
    }

    fn bootstrap(&mut self) {
        let ceiling = self.plan.paid_ceiling_per_day.unwrap_or(0.0);
        // The model's own lookups: a block's children (main), a window's receipts in commit order (floor).
        match self.variant.protocol {
            Protocol::LeaseBlocks => {
                self.objects[O::Book as usize].db.index_on("resource_meter_commands", "grant");
                self.objects[O::Book as usize].db.index_on("resource_meter_commands", "state");
                self.objects[O::Gate as usize].db.index_on("account_control_permits", "state");
            }
            Protocol::Envelope => self.objects[O::Book as usize].db.index_on("resource_meter_commands", "seq"),
        }
        let gate = &mut self.objects[O::Gate as usize].db;
        gate.put("account_control_state", "1", json!({"epoch": 1, "updating": null, "ended_until": 0}));
        gate.commit();
        let quota = &mut self.objects[O::Quota as usize].db;
        quota.put("resource_budget_policy", "1", json!({"epoch": 1, "paid_ceiling": ceiling}));
        quota.commit();
        self.ghost.max_ceiling_by_day.insert(0, ceiling);
    }

    pub fn at(&mut self, t: u64, ev: Ev) {
        self.seq += 1;
        self.events.push(Reverse((t, self.seq, ev)));
    }

    /// Every arrival of the run: commands at their rate, replays, policy updates and restarts.
    fn schedule_all(&mut self) {
        if let Some(s) = self.plan.schedule {
            for n in 0..s.count {
                let i = self.cmds.len();
                let t = s.start_ms + n * s.every_ms;
                self.cmds.push(Cmd::new(Some(0), None, None, format!("{}-{i}", self.plan.id), t));
                self.at(t, Ev::Cmd(i));
            }
            // The rows written between these two marks are what the probe counts: after the warm-up, before any later settle.
            self.at(s.start_ms + s.warmup * s.every_ms - s.every_ms / 2, Ev::Mark);
            self.at(s.start_ms + s.count * s.every_ms - s.every_ms / 2, Ev::Mark);
            return;
        }
        let days = self.end / DAY;
        let shapes: Vec<(usize, f64)> = self.plan.commands.iter().enumerate().map(|(i, (_, rate))| (i, *rate)).collect();
        for day in 0..days {
            for &(shape, rate) in &shapes {
                let n = self.count_of(rate);
                for _ in 0..n {
                    let t = day * DAY + self.rng.between(0, DAY - 1);
                    let i = self.cmds.len();
                    self.cmds.push(Cmd::new(Some(shape), None, None, format!("{}-{i}", self.plan.id), t));
                    self.at(t, Ev::Cmd(i));
                }
            }
            let replays = self.count_of(self.plan.replays_per_day);
            for _ in 0..replays {
                let t = day * DAY + self.rng.between(0, DAY - 1);
                let i = self.cmds.len();
                self.cmds.push(Cmd::new(None, Some(usize::MAX), None, String::new(), t));
                self.at(t, Ev::Cmd(i));
            }
            let profile = self.extras.profiles.get(&self.profile).cloned();
            if let Some(profile) = profile {
                for _ in 0..self.count_of(profile.restarts_per_day) {
                    let t = day * DAY + self.rng.between(0, DAY - 1);
                    self.at(t, Ev::Restart);
                }
                for _ in 0..self.count_of(profile.policy_updates_per_day) {
                    let t = day * DAY + self.rng.between(0, DAY - 1);
                    let rule = self.extras.policy_update.clone();
                    let change = if self.rng.chance(rule.revoke_chance) {
                        Change::Revoke
                    } else if self.plan.paid_ceiling_per_day.is_some() && self.rng.chance(rule.ceiling_change_chance) {
                        let high = self.plan.paid_ceiling_per_day.unwrap_or(0.0);
                        let next = if self.rng.chance(0.5) { rule.low_ceiling_per_day } else { high };
                        Change::Ceiling((next * 1e6) as u64)
                    } else {
                        Change::Plain
                    };
                    self.add_update(t, change);
                }
            }
        }
    }

    pub fn add_update(&mut self, t: u64, change: Change) {
        let i = self.updates.len();
        self.updates.push(Update { id: format!("update-{i}"), change, phase: UpdatePhase::Begin });
        self.at(t, Ev::Update(i));
    }

    fn count_of(&mut self, rate: f64) -> u64 {
        let whole = rate.floor() as u64;
        whole + u64::from(self.rng.chance(rate - rate.floor()))
    }

    pub fn shape(&self, cmd: usize) -> Option<&CommandSpec> {
        let c = &self.cmds[cmd];
        let shape = c.shape.or_else(|| c.refund_of.and_then(|of| self.cmds[of].shape))?;
        Some(&self.plan.commands[shape].0)
    }

    pub fn protocol(&self) -> Protocol {
        self.variant.protocol
    }

    // ---- objects ----------------------------------------------------------------------------------------------

    /// A request reaches object `o`: an object idle past its eviction window with no pending timer was evicted first.
    pub fn touch(&mut self, o: O) {
        let now = self.now;
        let evicted = {
            let object = &self.objects[o as usize];
            self.evict && object.timer_at.is_none() && now.saturating_sub(object.last_active) >= object.evict_after
        };
        if evicted {
            self.lose(o, "idle eviction");
        }
        self.objects[o as usize].last_active = now;
    }

    /// Object `o` loses its memory (a crash, a restart or an eviction) and starts a new generation.
    pub fn lose(&mut self, o: O, why: &'static str) {
        *self.crashes.entry(why).or_default() += 1;
        let gen = self.rng.next();
        let evict_after = self.rng.between(self.extras.evict_idle_ms.min, self.extras.evict_idle_ms.max);
        let object = &mut self.objects[o as usize];
        let old = std::mem::take(&mut object.mem);
        let old_gen = object.gen;
        object.gen = gen;
        object.evict_after = evict_after;
        object.timer_at = None;
        object.last_active = self.now;
        if o == O::Book {
            let mut lost: Vec<usize> = old.unrecorded.clone();
            for started in old.ledgers.values() {
                lost.extend(started.iter().copied());
            }
            for &unit in &lost {
                self.units[unit].lost = true;
            }
            self.ghost.dead_gens.insert(old_gen, old.unrecorded);
        }
    }

    /// End object `o`'s open transaction with whatever fault the profile draws for it.
    pub fn end_tx(&mut self, o: O) -> TxEnd {
        if self.objects[o as usize].db.is_clean() {
            return TxEnd::Done;
        }
        let roll = self.rng.unit();
        let c = &self.chances;
        let end = if roll < c.crash_before_commit {
            TxEnd::Crashed
        } else if roll < c.crash_before_commit + c.crash_after_commit {
            TxEnd::DoneLost
        } else if roll < c.crash_before_commit + c.crash_after_commit + c.interrupt_mid_statement {
            TxEnd::Interrupted
        } else {
            TxEnd::Done
        };
        if end.committed() {
            let changed = self.objects[o as usize].db.commit();
            let into = if self.pruning { &mut self.prune_rows } else { &mut self.rows };
            for (table, n) in changed {
                *into.entry((o, table.to_owned())).or_default() += n;
            }
        } else {
            self.objects[o as usize].db.rollback();
        }
        if matches!(end, TxEnd::Crashed | TxEnd::DoneLost) {
            self.lose(o, "crash in a transaction");
        }
        end
    }

    pub fn book(&mut self) -> &mut Object {
        &mut self.objects[O::Book as usize]
    }

    pub fn gate_state(&self) -> Value {
        self.objects[O::Gate as usize].db.get("account_control_state", "1").cloned().unwrap_or(Value::Null)
    }

    pub fn epoch(&self) -> u64 {
        self.gate_state()["epoch"].as_u64().unwrap_or(1)
    }

    pub fn rpc_ms(&mut self) -> u64 {
        self.rng.between(self.extras.rpc_ms.min, self.extras.rpc_ms.max)
    }

    pub fn dollars(&self, rows_read: u64, rows_written: u64) -> f64 {
        rows_read as f64 * self.prices.rows_read_dollars + rows_written as f64 * self.prices.rows_written_dollars
    }

    pub fn new_unit(&mut self, read: bool, subject: &str, rows_read: (u64, u64), rows_written: u64, price: f64) -> usize {
        let measured_rows = self.rng.between(rows_read.0, rows_read.1);
        let measured = self.dollars(measured_rows, rows_written);
        let bound = self.dollars(rows_read.1, rows_written);
        // Its day is the day it was admitted in: a period that ends stops admission, and work admitted inside it settles to it.
        let day = self.now / DAY;
        self.units.push(Unit { read, subject: subject.to_owned(), measured, bound, price, day, ..Unit::default() });
        self.units.len() - 1
    }

    pub fn refused(&self, stage: &'static str, reason: &'static str) -> Step {
        Step::Refused(stage, reason)
    }

    /// Units taken out of memory for a write that may not commit: back in memory when it rolled back and the object lives,
    /// lost with the generation when it died, durable otherwise.
    pub fn after_write(&mut self, end: TxEnd, gen: u64, units: Vec<usize>, back: impl FnOnce(&mut Mem, Vec<usize>)) {
        match end {
            TxEnd::Done | TxEnd::DoneLost => {}
            TxEnd::Interrupted => back(&mut self.objects[O::Book as usize].mem, units),
            TxEnd::Crashed => {
                for &unit in &units {
                    self.units[unit].lost = true;
                }
                self.ghost.dead_gens.entry(gen).or_default().extend(units);
            }
        }
    }

    // ---- gate --------------------------------------------------------------------------------------------------

    /// The gate's rights check, as resolve and admit make it: reads only.
    pub fn rights(&mut self, stage: &'static str) -> Option<Step> {
        let state = self.gate_state();
        if state["ended_until"].as_u64().unwrap_or(0) > self.now {
            return Some(self.refused(stage, "sign_in_ended"));
        }
        if stage == "admit" && !state["updating"].is_null() {
            return Some(self.refused(stage, "changing"));
        }
        None
    }

    /// An admission the gate accepted: checked against what the gate's durable state said at that moment.
    pub fn note_admitted(&mut self, cmd: usize) {
        let state = self.gate_state();
        if !state["updating"].is_null() {
            self.violations.admitted_while_fenced += 1;
        }
        if state["ended_until"].as_u64().unwrap_or(0) > self.now {
            self.violations.admitted_signed_out += 1;
        }
        self.cmds[cmd].admitted_epoch = Some(self.epoch());
    }

    // ---- the domain's own transaction -------------------------------------------------------------------------

    /// The domain's effect for `cmd` inside the book's open transaction: its records, a paid run's charge or a
    /// refund, and the ghost checks that an effect is applied once and never after an update passed its admission.
    pub fn domain_effect(&mut self, cmd: usize, unit: usize) {
        let mut rng = Rng::new(self.rng.next());
        let (records, derived) = match self.shape(cmd) {
            Some(spec) if self.cmds[cmd].refund_of.is_some() => (spec.paid.as_ref().map_or(0, |p| p.refund_rows), 0),
            Some(spec) => (domain_rows(&spec.domain_rows, &mut rng), domain_rows(&spec.derived_rows, &mut rng)),
            None => (0, 0),
        };
        let key = self.cmds[cmd].key.clone();
        let book = &mut self.objects[O::Book as usize].db;
        let answer = format!("{key}#{unit}");
        book.put("domain", &key, json!({"unit": unit, "answer": answer, "at": self.now}));
        book.written("record_log", records);
        book.written("derived", derived);
    }

    /// After the domain's transaction committed.
    pub fn domain_committed(&mut self, cmd: usize, unit: usize) {
        let key = self.cmds[cmd].key.clone();
        let seen = self.ghost_effects.entry(key).or_default();
        *seen += 1;
        if *seen > 1 {
            self.violations.double_effect += 1;
        }
        self.units[unit].committed = true;
        self.cmds[cmd].unit = Some(unit);
        if let Some(admitted) = self.cmds[cmd].admitted_epoch {
            if self.ghost.epochs.iter().any(|&(epoch, _)| epoch > admitted) {
                self.violations.passed_in_flight += 1;
            }
        }
    }
}

impl Cmd {
    pub fn new(shape: Option<usize>, replay_of: Option<usize>, refund_of: Option<usize>, key: String, start: u64) -> Self {
        Cmd { shape, replay_of, refund_of, key, start, tries: 0, phase: Phase::Resolve, read_at: 0, admitted_epoch: None, lease: None,
            status: Status::Running, answer: None, expected: None, unit: None, refused_attempts: 0, refund_spawned: false, pending_unit: None, begun_gen: None }
    }
}
