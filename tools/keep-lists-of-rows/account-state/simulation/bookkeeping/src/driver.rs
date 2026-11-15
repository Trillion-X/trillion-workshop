//! The run loop, the client of each command, policy updates and the account
//! quota, the same for every protocol; each protocol answers the steps.

use super::data::Protocol;
use super::world::{Change, Ev, Phase, Status, Step, UpdatePhase, World, DAY, HOUR, O};
use serde_json::{json, Value};
use std::cmp::Reverse;

/// Where each refusal may happen: a budget refuses a command at its reserve (and a read at the read), never later.
const ALLOWED_REFUSALS: [(&str, &str); 6] = [("resolve", "sign_in_ended"), ("admit", "sign_in_ended"), ("admit", "changing"), ("begin", "changing"),
    ("reserve", "budget_reached"), ("read", "budget_reached")];

/// The stage a refusal happens at: the phase the client step was in, whatever owner raised it.
fn stage_of(phase: Phase) -> &'static str {
    match phase {
        Phase::Resolve => "resolve",
        Phase::Reserve => "reserve",
        Phase::Admit => "admit",
        Phase::Invoke => "begin",
        Phase::Commit => "commit",
        Phase::Finish => "finish",
        Phase::Read => "read",
    }
}

impl World {
    pub fn run(&mut self) {
        while let Some(Reverse((t, _, ev))) = self.events.pop() {
            self.now = t.max(self.now);
            match ev {
                Ev::Cmd(c) => self.step_cmd(c),
                Ev::Update(u) => self.step_update(u),
                Ev::Flush(gen) => self.timer(gen),
                Ev::Alarm => self.alarm(),
                Ev::Mark => self.marks.push(self.rows.clone()),
                Ev::Restart => {
                    for o in [O::Book, O::Gate, O::Quota] {
                        self.lose(o, "restart");
                    }
                }
            }
        }
        self.now = self.now.max(self.end) + HOUR;
        self.settle_everything();
    }

    // ---- client ---------------------------------------------------------------------------------------------

    fn step_cmd(&mut self, c: usize) {
        if self.cmds[c].status != Status::Running {
            return;
        }
        if self.cmds[c].replay_of == Some(usize::MAX) && !self.choose_replay(c) {
            self.cmds[c].status = Status::Refused("client", "nothing_to_replay");
            return;
        }
        let out = match self.cmds[c].phase {
            Phase::Resolve => self.resolve(c),
            Phase::Reserve => self.reserve(c),
            Phase::Admit => self.admit(c),
            Phase::Invoke => self.invoke(c),
            Phase::Commit => self.commit(c),
            Phase::Finish => self.finish(c),
            Phase::Read => self.read(c),
        };
        // A budget refusal is raised by the quota owner whichever step asked it; it happened at that step.
        let out = match out {
            Step::Refused(_, "budget_reached") => Step::Refused(stage_of(self.cmds[c].phase), "budget_reached"),
            other => other,
        };
        match out {
            Step::Next => {
                let reads = self.shape(c).map_or(0, |s| s.reads.len());
                let refund = self.cmds[c].refund_of.is_some();
                let next = match self.cmds[c].phase {
                    Phase::Resolve => Some(Phase::Reserve),
                    Phase::Reserve => Some(Phase::Admit),
                    Phase::Admit => Some(Phase::Invoke),
                    Phase::Invoke => Some(Phase::Commit),
                    Phase::Commit if self.protocol() == Protocol::LeaseBlocks => Some(Phase::Finish),
                    Phase::Commit | Phase::Finish => (reads > 0 && !refund).then_some(Phase::Read),
                    Phase::Read => (self.cmds[c].read_at < reads).then_some(Phase::Read),
                };
                match next {
                    Some(phase) => {
                        self.cmds[c].phase = phase;
                        let work = self.shape(c).map(|s| s.work_ms);
                        let t = self.now + self.stall() + match (phase, work) {
                            (Phase::Commit, Some(w)) => self.rng.between(w.min, w.max),
                            _ => self.rpc_ms(),
                        };
                        self.at(t, Ev::Cmd(c));
                    }
                    None => {
                        let answer = self.cmds[c].answer.clone().unwrap_or_default();
                        self.ack(c, answer);
                    }
                }
            }
            Step::Done(answer) => self.ack(c, answer),
            Step::Retry => {
                let cmd = &mut self.cmds[c];
                cmd.tries += 1;
                let most = if cmd.refund_of.is_some() { 64 } else { self.extras.client.attempts };
                if cmd.tries >= most {
                    cmd.status = Status::Unknown;
                    return;
                }
                cmd.phase = Phase::Resolve;
                cmd.read_at = 0;
                let wait = (self.extras.client.first_backoff_ms << (cmd.tries - 1).min(6)).min(60_000);
                self.at(self.now + wait, Ev::Cmd(c));
            }
            Step::Refused(stage, reason) => {
                *self.refusals.entry(format!("{stage}:{reason}")).or_default() += 1;
                if !ALLOWED_REFUSALS.contains(&(stage, reason)) {
                    self.violations.refusal_stage += 1;
                }
                self.cmds[c].status = Status::Refused(stage, reason);
            }
            Step::Unknown => self.cmds[c].status = Status::Unknown,
        }
    }

    /// How long the client holds its next step before sending it: usually nothing, sometimes a stall.
    fn stall(&mut self) -> u64 {
        let stall = self.extras.profiles.get(&self.profile).and_then(|p| p.client_stall);
        match stall {
            Some(s) if self.rng.chance(s.chance) => self.rng.between(s.min_ms, s.max_ms),
            _ => 0,
        }
    }

    /// A replay resends the request key of an acked command still inside its receipt's life.
    fn choose_replay(&mut self, c: usize) -> bool {
        let horizon = self.variant.params.receipt_days.saturating_sub(1) * DAY;
        let candidates: Vec<usize> = self.cmds.iter().enumerate()
            .filter(|(_, x)| x.status == Status::Acked && x.replay_of.is_none() && x.refund_of.is_none() && x.unit.is_some()
                && x.start + horizon > self.now && x.start < self.now)
            .map(|(i, _)| i).collect();
        if candidates.is_empty() {
            return false;
        }
        let target = candidates[(self.rng.next() % candidates.len() as u64) as usize];
        let (key, expected) = (self.cmds[target].key.clone(), self.cmds[target].answer.clone());
        let cmd = &mut self.cmds[c];
        cmd.replay_of = Some(target);
        cmd.key = key;
        cmd.expected = expected;
        true
    }

    fn ack(&mut self, c: usize, answer: String) {
        if let Some(expected) = self.cmds[c].expected.clone() {
            if expected != answer {
                self.violations.replay_mismatch += 1;
            }
        }
        let cmd = &mut self.cmds[c];
        cmd.status = Status::Acked;
        cmd.answer = Some(answer);
        if let Some(unit) = cmd.unit {
            self.units[unit].acked = true;
        }
        let fails = self.shape(c).and_then(|s| s.paid.as_ref()).is_some_and(|p| p.fails);
        let cmd = &self.cmds[c];
        if fails && cmd.replay_of.is_none() && cmd.refund_of.is_none() && !cmd.refund_spawned {
            self.cmds[c].refund_spawned = true;
            let i = self.cmds.len();
            let key = format!("refund:{}", self.cmds[c].key);
            self.cmds.push(super::world::Cmd::new(None, None, Some(c), key, self.now));
            let t = self.now + self.rpc_ms();
            self.at(t, Ev::Cmd(i));
        }
    }

    fn resolve(&mut self, c: usize) -> Step {
        self.touch(O::Gate);
        if let Some(refusal) = self.rights("resolve") {
            return refusal;
        }
        match self.protocol() {
            Protocol::LeaseBlocks => self.lb_resolve(c),
            Protocol::Envelope => Step::Next,
        }
    }

    fn reserve(&mut self, c: usize) -> Step {
        match self.protocol() {
            Protocol::LeaseBlocks => self.lb_reserve(c),
            Protocol::Envelope => self.env_reserve(c),
        }
    }

    fn admit(&mut self, c: usize) -> Step {
        self.touch(O::Gate);
        if let Some(refusal) = self.rights("admit") {
            return refusal;
        }
        match self.protocol() {
            Protocol::LeaseBlocks => self.lb_admit(c),
            Protocol::Envelope => self.env_admit(c),
        }
    }

    fn invoke(&mut self, c: usize) -> Step {
        match self.protocol() {
            Protocol::LeaseBlocks => self.lb_begin(c),
            Protocol::Envelope => self.env_begin(c),
        }
    }

    /// The command's work ends: its effect commits, if the book generation that began it still runs it.
    fn commit(&mut self, c: usize) -> Step {
        self.touch(O::Book);
        let alive = self.cmds[c].begun_gen == Some(self.objects[O::Book as usize].gen);
        if !alive {
            // The invocation died with its isolate: its caller saw no answer.
            self.cmds[c].pending_unit = None;
            return Step::Retry;
        }
        match self.protocol() {
            Protocol::LeaseBlocks => self.lb_commit(c),
            Protocol::Envelope => self.env_commit(c),
        }
    }

    fn finish(&mut self, c: usize) -> Step {
        self.lb_finish(c)
    }

    fn read(&mut self, c: usize) -> Step {
        let at = self.cmds[c].read_at;
        let out = match self.protocol() {
            Protocol::LeaseBlocks => self.lb_read(c, at),
            Protocol::Envelope => self.env_read(c, at),
        };
        if matches!(out, Step::Next) {
            self.cmds[c].read_at += 1;
        }
        out
    }

    fn timer(&mut self, gen: u64) {
        if self.objects[O::Book as usize].gen != gen {
            return;
        }
        self.objects[O::Book as usize].timer_at = None;
        self.objects[O::Book as usize].last_active = self.now;
        if self.protocol() == Protocol::Envelope {
            self.env_flush();
        }
    }

    fn alarm(&mut self) {
        self.alarm_at = None;
        self.touch(O::Book);
        if self.protocol() == Protocol::LeaseBlocks {
            self.lb_upkeep();
        }
    }

    pub fn wake_at(&mut self, t: u64) {
        if self.alarm_at.is_none_or(|at| t < at) {
            self.alarm_at = Some(t);
            self.at(t, Ev::Alarm);
        }
    }

    // ---- policy updates -------------------------------------------------------------------------------------

    fn step_update(&mut self, u: usize) {
        let id = self.updates[u].id.clone();
        match self.updates[u].phase {
            UpdatePhase::Begin => {
                self.touch(O::Gate);
                let state = self.gate_state();
                if !state["updating"].is_null() && state["updating"] != json!(id) {
                    self.at(self.now + 5_000, Ev::Update(u));
                    return;
                }
                self.objects[O::Gate as usize].db.update("account_control_state", "1", |s| s["updating"] = json!(id));
                if self.end_tx(O::Gate).committed() {
                    self.updates[u].phase = UpdatePhase::Drain;
                }
                let t = self.now + self.rpc_ms();
                self.at(t, Ev::Update(u));
            }
            UpdatePhase::Drain => {
                self.touch(O::Gate);
                let drained = match self.protocol() {
                    Protocol::LeaseBlocks => self.lb_drain(),
                    Protocol::Envelope => self.env_drain(),
                };
                if drained {
                    self.updates[u].phase = UpdatePhase::Finish;
                }
                let t = self.now + if drained { self.rpc_ms() } else { 1_000 };
                self.at(t, Ev::Update(u));
            }
            UpdatePhase::Finish => {
                self.touch(O::Gate);
                let change = self.updates[u].change;
                let now = self.now;
                let revoke_ms = self.extras.policy_update.revoke_minutes * 60_000;
                self.objects[O::Gate as usize].db.update("account_control_state", "1", |s| {
                    s["epoch"] = json!(s["epoch"].as_u64().unwrap_or(1) + 1);
                    s["updating"] = Value::Null;
                    match change {
                        Change::Revoke => s["ended_until"] = json!(now + revoke_ms),
                        Change::Restore => s["ended_until"] = json!(0),
                        Change::Plain | Change::Ceiling(_) => {}
                    }
                });
                if !self.end_tx(O::Gate).committed() {
                    self.at(self.now + 1_000, Ev::Update(u));
                    return;
                }
                let epoch = self.epoch();
                self.ghost.epochs.push((epoch, self.now));
                self.updates[u].phase = UpdatePhase::Done;
                match change {
                    Change::Revoke => self.add_update(self.now + revoke_ms, Change::Restore),
                    Change::Ceiling(micros) => self.set_ceiling(micros as f64 / 1e6),
                    Change::Plain | Change::Restore => {}
                }
            }
            UpdatePhase::Done => {}
        }
    }

    fn set_ceiling(&mut self, ceiling: f64) {
        loop {
            self.touch(O::Quota);
            self.objects[O::Quota as usize].db.update("resource_budget_policy", "1", |p| p["paid_ceiling"] = json!(ceiling));
            if self.end_tx(O::Quota).committed() {
                break;
            }
        }
        let day = self.now / DAY;
        let most = self.ghost.max_ceiling_by_day.range(..=day).next_back().map_or(0.0, |(_, v)| *v).max(ceiling);
        self.ghost.max_ceiling_by_day.insert(day, most);
        self.ghost.max_ceiling_by_day.insert(day + 1, ceiling);
    }

}

impl World {
    /// After the last event: no more faults or evictions, and everything kept settles, so the oracles read a settled world.
    fn settle_everything(&mut self) {
        self.chances = super::data::PerAttempt::default();
        self.evict = false;
        match self.protocol() {
            Protocol::LeaseBlocks => self.lb_settle_everything(),
            Protocol::Envelope => self.env_settle_everything(),
        }
    }
}
