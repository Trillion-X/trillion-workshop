//! Command bookkeeping at the floor (variant protocol `envelope-commit-receipts`).
//!
//! Per command one durable row: its receipt (`resource_meter_commands`), written in the domain's own transaction.
//! Per book and budget window one envelope row (`resource_use_envelope`) and one quota permit, rolled once a window;
//! a top-up between rolls changes only the quota permit (a book that lost its memory reads it back from the quota).
//! Per book and policy epoch one admission lease row on the gate (`account_control_admission_leases`).
//! Native reads and other work with no receipt of its own are tallied in memory and written once on the envelope row
//! when the book goes idle (a pending timer keeps it in memory until then); a generation that holds such work is
//! registered first, in the receipt it writes anyway or on the envelope row, so a generation lost with its tally is
//! counted at its allowance against limits (escrow) and charged nothing.

use super::quota::{asks_json, asks_of, Ask, Settlement};
use super::world::{Ev, Step, TxEnd, World, DAY, HOUR, O};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const RECEIPTS: &str = "resource_meter_commands";
const ENVELOPE: &str = "resource_use_envelope";
const LEASES: &str = "account_control_admission_leases";
const PERMIT: &str = "envelope:book";

impl World {
    fn env_permit(&self, c: usize) -> String {
        format!("permit:{}~{}", self.cmds[c].key, self.cmds[c].refused_attempts + 1)
    }

    fn env_row(&self) -> Option<Value> {
        self.objects[O::Book as usize].db.get(ENVELOPE, "1").cloned()
    }

    /// The most a generation may hold unrecorded: its allowance of the heaviest read of this workload.
    fn allowance(&self) -> f64 {
        let heaviest = self.plan.commands.iter().flat_map(|(c, _)| c.reads.iter()).map(|r| r.rows_read.max).max().unwrap_or(0);
        f64::from(self.variant.params.generation_allowance_reads) * self.dollars(heaviest, 0)
    }

    /// The envelope of this window, rolled first when the window turned (or at the end, `force`). `exact` are the asks of
    /// the command waiting on it: a roll reserves them with the window, so the roll is that command's top-up. Answers
    /// whether a roll reserved `exact`.
    fn env_ensure(&mut self, force: bool, exact: &[Ask]) -> Result<bool, Step> {
        let hour = self.now / HOUR;
        let Some(env) = self.env_row() else {
            match self.quota_reserve(PERMIT, exact, false) {
                Ok(end) if end.committed() => {}
                Ok(_) => return Err(Step::Retry),
                Err(step) => return Err(step),
            }
            self.touch(O::Book);
            let seq = self.receipt_seq;
            self.objects[O::Book as usize].db.put(ENVELOPE, "1", json!({"hour": hour, "reserved": asks_json(exact), "base_seq": seq, "tally": [],
                "registered": [], "clean": [], "settling": null}));
            if self.end_tx(O::Book) != TxEnd::Done {
                return Err(Step::Retry);
            }
            self.book().mem.reserved_live = Some(exact.to_vec());
            return Ok(true);
        };
        if !env["settling"].is_null() && self.objects[O::Book as usize].mem.envelope_active != env["settling"]["marker_hour"].as_u64() {
            self.env_send_roll(&env["settling"])?;
        }
        if env["hour"].as_u64().unwrap_or(0) >= hour && !force {
            return Ok(false);
        }
        self.env_roll(&env, force, exact)?;
        Ok(true)
    }

    /// Send a roll the envelope row keeps (idempotent by its marker). When the window's speculative reservation does not
    /// fit, the roll keeps only the waiting command's exact asks; when those do not fit either, it reserves nothing and
    /// that command is refused here, at its reserve, with the budget's evidence.
    fn env_send_roll(&mut self, settling: &Value) -> Result<(), Step> {
        let payload = Settlement::from_json(&settling["payload"]);
        let marker = settling["marker"].as_str().unwrap_or("").to_owned();
        let (spec, exact) = (asks_of(&settling["spec"]), asks_of(&settling["exact"]));
        let mut refused = None;
        let mut kept = spec.iter().chain(exact.iter()).cloned().collect::<Vec<_>>();
        let mut end = self.quota_settle(PERMIT, &payload, Some((&spec, &exact, &marker)));
        if let Err(Step::Refused(..)) = end {
            kept = exact.clone();
            end = self.quota_settle(PERMIT, &payload, Some((&[], &exact, &marker)));
        }
        if let Err(Step::Refused(stage, reason)) = end {
            refused = Some(Step::Refused(stage, reason));
            kept = Vec::new();
            end = self.quota_settle(PERMIT, &payload, Some((&[], &[], &marker)));
        }
        if end? != TxEnd::Done {
            return Err(Step::Retry);
        }
        self.touch(O::Book);
        if kept.len() != spec.len() + exact.len() {
            // The quota reserved less than the envelope row says: the row says so too.
            let kept_json = asks_json(&kept);
            self.objects[O::Book as usize].db.update(ENVELOPE, "1", |e| {
                e["reserved"] = kept_json.clone();
                e["settling"]["spec"] = json!([]);
                e["settling"]["exact"] = kept_json;
            });
            if self.end_tx(O::Book) != TxEnd::Done {
                return Err(Step::Retry);
            }
        }
        let mem = &mut self.book().mem;
        mem.envelope_active = settling["marker_hour"].as_u64();
        mem.reserved_live = Some(kept);
        refused.map_or(Ok(()), Err)
    }

    /// Settle the window the envelope holds and reserve the next, in one envelope write and one quota transaction.
    fn env_roll(&mut self, env: &Value, force: bool, exact: &[Ask]) -> Result<(), Step> {
        self.touch(O::Book);
        let hour = self.now / HOUR;
        let base = env["base_seq"].as_u64().unwrap_or(0);
        let gen = self.objects[O::Book as usize].gen;
        let mut s = Settlement { event: format!("roll:{}", env["hour"]), ..Settlement::default() };
        for i in env["tally"].as_array().cloned().unwrap_or_default() {
            s.items.push((i[0].as_u64().unwrap_or(0) as usize, i[1].as_f64().unwrap_or(0.0), i[2].as_f64().unwrap_or(0.0)));
        }
        let mut regs: BTreeSet<(u64, u64)> = pairs(&env["registered"]);
        let mut clean: BTreeSet<(u64, u64)> = pairs(&env["clean"]);
        let book = &self.objects[O::Book as usize].db;
        for r in book.keys_above(RECEIPTS, "seq", base).iter().filter_map(|k| book.get(RECEIPTS, k)) {
            if r["state"] == "committed" {
                let unit = r["unit"].as_u64().unwrap_or(0) as usize;
                let used = r["used"].as_f64().unwrap_or(0.0);
                s.items.push((unit, used, used));
                if let Some(reg) = r["reg"].as_array() {
                    regs.insert((reg[0].as_u64().unwrap_or(0), reg[1].as_u64().unwrap_or(0)));
                }
            }
        }
        // This generation's own unrecorded work goes into the settlement now; its registration is then clean.
        let unrecorded = std::mem::take(&mut self.book().mem.unrecorded);
        for &unit in &unrecorded {
            let u = &self.units[unit];
            s.items.push((unit, u.measured, u.measured));
        }
        if let Some(reg) = self.objects[O::Book as usize].mem.registered {
            clean.insert((gen, reg));
        }
        // A registered generation that never wrote its tally died with it: its allowance is escrow, counted and never
        // charged. (The ghost names the reads it held, so the oracle can check each one's bound is inside it.)
        let allowance = self.allowance();
        let mut seen: BTreeSet<u64> = BTreeSet::new();
        for (dead, _) in regs.difference(&clean) {
            let mut held = 0.0;
            if seen.insert(*dead) {
                for &unit in self.ghost.dead_gens.get(dead).map(Vec::as_slice).unwrap_or(&[]) {
                    held += self.units[unit].bound;
                    s.items.push((unit, 0.0, self.units[unit].bound));
                }
            }
            if allowance > held {
                s.escrow.push(("read:escrow".to_owned(), allowance - held));
            }
        }
        let spec = if force { Vec::new() } else { self.env_demand(&s) };
        let marker = format!("roll:{}", env["hour"]);
        let seq = self.receipt_seq;
        let reserved: Vec<Ask> = spec.iter().chain(exact.iter()).cloned().collect();
        let settling = json!({"payload": s.to_json(), "marker": marker, "spec": asks_json(&spec), "exact": asks_json(exact), "marker_hour": hour});
        self.objects[O::Book as usize].db.put(ENVELOPE, "1", json!({"hour": hour, "reserved": asks_json(&reserved), "base_seq": seq, "tally": [],
            "registered": [], "clean": [], "settling": settling.clone()}));
        let end = self.end_tx(O::Book);
        if end != TxEnd::Done {
            self.after_write(end, gen, unrecorded, |mem, units| mem.unrecorded.extend(units));
            return Err(Step::Retry);
        }
        self.book().mem.registered = None;
        self.env_prune();
        self.env_send_roll(&settling)
    }

    /// The next window's speculative reservation: each purpose's use this window times envelope_demand_times. Paid
    /// prices are never held speculatively: a paid run holds its exact price when it asks.
    fn env_demand(&self, s: &Settlement) -> Vec<Ask> {
        let mut by: BTreeMap<String, (f64, bool)> = BTreeMap::new();
        for &(unit, _, limit) in &s.items {
            let u = &self.units[unit];
            by.entry(u.subject.clone()).or_insert((0.0, !u.read)).0 += limit;
        }
        let times = self.variant.params.envelope_demand_times;
        by.into_iter().filter(|(_, (amount, _))| *amount > 0.0)
            .map(|(subject, (amount, store_work))| Ask { subject, amount: amount * times, paid: 0.0, store_work }).collect()
    }

    /// What this book's quota permit holds now: in memory, or read back from the quota after a reset (no write).
    fn env_reserved(&mut self) -> Vec<Ask> {
        if let Some(live) = self.objects[O::Book as usize].mem.reserved_live.clone() {
            return live;
        }
        let asks = self.quota_asks(PERMIT);
        self.touch(O::Book);
        self.book().mem.reserved_live = Some(asks.clone());
        asks
    }

    /// What `subject` has used and holds in this window: its receipts, the envelope's tally, unrecorded work and places.
    fn env_used(&self, subject: &str) -> (f64, f64) {
        let Some(env) = self.env_row() else { return (0.0, 0.0) };
        let base = env["base_seq"].as_u64().unwrap_or(0);
        let (mut amount, mut paid) = (0.0, 0.0);
        for i in env["tally"].as_array().cloned().unwrap_or_default() {
            let unit = i[0].as_u64().unwrap_or(0) as usize;
            if self.units[unit].subject == subject {
                amount += i[2].as_f64().unwrap_or(0.0);
            }
        }
        let book = &self.objects[O::Book as usize].db;
        for r in book.keys_above(RECEIPTS, "seq", base).iter().filter_map(|k| book.get(RECEIPTS, k)) {
            if r["subject"] == subject {
                amount += r["used"].as_f64().unwrap_or(0.0);
                paid += r["price"].as_f64().unwrap_or(0.0);
            }
        }
        let mem = &self.objects[O::Book as usize].mem;
        amount += mem.unrecorded.iter().filter(|&&u| self.units[u].subject == subject).map(|&u| self.units[u].measured).sum::<f64>();
        for (s, need, price) in mem.places.values() {
            if s == subject {
                amount += need;
                paid += price;
            }
        }
        (amount, paid)
    }

    /// Room in this window's envelope for `need` dollars (and `price`) of `subject`: from the roll that this window turn
    /// makes, or what the envelope holds, or a top-up at the quota (speculative for use, exact for a price).
    fn env_place(&mut self, subject: &str, need: f64, price: f64, store_work: bool) -> Result<(), Step> {
        let exact = Ask { subject: subject.to_owned(), amount: need, paid: price, store_work };
        if self.env_ensure(false, std::slice::from_ref(&exact))? {
            return Ok(());
        }
        let reserved = self.env_reserved();
        let (amount, paid) = reserved.iter().filter(|a| a.subject == subject).fold((0.0, 0.0), |(x, y), a| (x + a.amount, y + a.paid));
        let (used, used_paid) = self.env_used(subject);
        if used + need <= amount + 1e-12 && used_paid + price <= paid + 1e-12 {
            return Ok(());
        }
        let speculative = Ask { subject: subject.to_owned(), amount: need * self.variant.params.envelope_demand_times * 2.0, paid: 0.0, store_work };
        // A price is held exactly; use may be held for the window's demand, or exactly when that does not fit.
        let ask = match price > 0.0 {
            true => self.env_top_up(exact, false)?,
            false => match self.env_top_up(speculative, true) {
                Err(Step::Refused(..)) => self.env_top_up(exact, false)?,
                other => other?,
            },
        };
        self.touch(O::Book);
        if let Some(live) = self.book().mem.reserved_live.as_mut() {
            live.push(ask);
        }
        Ok(())
    }

    fn env_top_up(&mut self, ask: Ask, speculative: bool) -> Result<Ask, Step> {
        let marker = format!("top:{:016x}", self.rng.next());
        match self.quota_top_up(PERMIT, std::slice::from_ref(&ask), &marker, speculative)? {
            end if end.committed() => Ok(ask),
            _ => Err(Step::Retry),
        }
    }

    pub fn env_reserve(&mut self, c: usize) -> Step {
        self.touch(O::Book);
        let permit = self.env_permit(c);
        if let Some(answer) = self.receipt_answer(&permit) {
            return Step::Done(answer);
        }
        let mem = &self.objects[O::Book as usize].mem;
        if mem.inflight.contains_key(&permit) {
            return Step::Retry;
        }
        if mem.places.contains_key(&permit) {
            return Step::Next;
        }
        match self.env_hold(c) {
            Ok(()) => Step::Next,
            Err(step) => step,
        }
    }

    fn receipt_answer(&self, permit: &str) -> Option<String> {
        self.objects[O::Book as usize].db.get(RECEIPTS, permit).filter(|r| r["state"] == "committed").and_then(|r| r["answer"].as_str()).map(str::to_owned)
    }

    fn env_hold(&mut self, c: usize) -> Result<(), Step> {
        let permit = self.env_permit(c);
        let subject = self.shape(c).map(|s| s.purpose.clone()).unwrap_or_default();
        let (need, price) = self.command_bound(c);
        self.env_place(&subject, need, price, true)?;
        self.book().mem.places.insert(permit, (subject, need, price));
        Ok(())
    }

    pub fn env_admit(&mut self, c: usize) -> Step {
        let epoch = self.epoch();
        let lease = format!("lease:{epoch}");
        // One row per book: the newest epoch it was admitted under, written by the first admission of that epoch. A lease
        // ends when the epoch moves on or an update fences the gate (the gate's own state says so): no row closes it.
        if self.objects[O::Gate as usize].db.get(LEASES, "book").and_then(|l| l["epoch"].as_u64()) != Some(epoch) {
            self.objects[O::Gate as usize].db.put(LEASES, "book", json!({"epoch": epoch}));
            if self.end_tx(O::Gate) != TxEnd::Done {
                return Step::Retry;
            }
        }
        self.note_admitted(c);
        self.cmds[c].lease = Some(lease);
        Step::Next
    }

    /// The command begins: nothing is written. Its lease must still stand (a book that lost its memory asks the gate),
    /// and its place in the envelope is held in memory (placed again after a reset).
    pub fn env_begin(&mut self, c: usize) -> Step {
        self.touch(O::Book);
        let permit = self.env_permit(c);
        if let Some(answer) = self.receipt_answer(&permit) {
            return Step::Done(answer);
        }
        let Some(lease) = self.cmds[c].lease.clone() else { return Step::Retry };
        if self.objects[O::Book as usize].mem.leases_fenced.contains(&lease) {
            return self.refused("begin", "changing");
        }
        if !self.objects[O::Book as usize].mem.leases_live.contains(&lease) {
            if !self.variant.params.skip_lease_confirm {
                self.touch(O::Gate);
                let state = self.gate_state();
                if format!("lease:{}", self.epoch()) != lease || !state["updating"].is_null() {
                    return self.refused("begin", "changing");
                }
                self.touch(O::Book);
            }
            self.book().mem.leases_live.insert(lease.clone());
        }
        if !self.objects[O::Book as usize].mem.places.contains_key(&permit) {
            if let Err(step) = self.env_hold(c) {
                return step;
            }
        }
        let Some(spec) = self.shape(c).cloned() else { return Step::Unknown };
        let price = if self.cmds[c].refund_of.is_some() { 0.0 } else { spec.paid.as_ref().map_or(0.0, |p| p.price) };
        let unit = self.new_unit(false, &spec.purpose, (spec.rows_read.min, spec.rows_read.max), 0, price);
        if let Some(day) = self.hold_day(PERMIT) {
            self.units[unit].day = day;
        }
        self.book().mem.inflight.insert(permit, Some(lease));
        self.cmds[c].pending_unit = Some(unit);
        self.cmds[c].begun_gen = Some(self.objects[O::Book as usize].gen);
        Step::Next
    }

    /// The work ends: the domain's own transaction, and in it the command's receipt (its outcome, its answer, what it used).
    pub fn env_commit(&mut self, c: usize) -> Step {
        let permit = self.env_permit(c);
        let Some(unit) = self.cmds[c].pending_unit.take() else { return Step::Retry };
        let Some(spec) = self.shape(c).cloned() else { return Step::Unknown };
        let params = self.variant.params.clone();
        let price = self.units[unit].price;
        self.domain_effect(c, unit);
        let answer = format!("{}#{unit}", self.cmds[c].key);
        let registers = !spec.reads.is_empty() && self.cmds[c].refund_of.is_none() && !params.skip_registration;
        let gen = self.objects[O::Book as usize].gen;
        let mem = &self.objects[O::Book as usize].mem;
        let reg = registers.then(|| mem.registered.unwrap_or(mem.registrations + 1));
        self.receipt_seq += 1;
        let receipt = json!({"state": "committed", "answer": answer, "unit": unit, "used": self.units[unit].measured, "subject": spec.purpose,
            "price": price, "hour": self.now / HOUR, "seq": self.receipt_seq, "finished_at": self.now, "reg": reg.map(|r| json!([gen, r]))});
        let mut end = if params.receipt_after_commit {
            self.end_tx(O::Book)
        } else {
            self.objects[O::Book as usize].db.put(RECEIPTS, &permit, receipt.clone());
            self.end_tx(O::Book)
        };
        if end.committed() {
            self.domain_committed(c, unit);
            self.cmds[c].answer = Some(answer);
        }
        if params.receipt_after_commit && end == TxEnd::Done {
            self.objects[O::Book as usize].db.put(RECEIPTS, &permit, receipt);
            end = self.end_tx(O::Book);
        }
        let mem = &mut self.book().mem;
        mem.inflight.remove(&permit);
        if end != TxEnd::Done {
            return Step::Retry;
        }
        mem.places.remove(&permit);
        if let Some(r) = reg {
            mem.registered = Some(r);
            mem.registrations = mem.registrations.max(r);
        }
        Step::Next
    }

    pub fn env_read(&mut self, c: usize, at: usize) -> Step {
        self.touch(O::Book);
        let Some(spec) = self.shape(c).and_then(|s| s.reads.get(at)).cloned() else { return Step::Next };
        if let Err(step) = self.env_ensure(false, &[]) {
            return step;
        }
        if self.objects[O::Book as usize].mem.registered.is_none() && !self.variant.params.skip_registration {
            let gen = self.objects[O::Book as usize].gen;
            let reg = self.objects[O::Book as usize].mem.registrations + 1;
            self.objects[O::Book as usize].db.update(ENVELOPE, "1", |e| {
                let mut all = e["registered"].as_array().cloned().unwrap_or_default();
                all.push(json!([gen, reg]));
                e["registered"] = Value::Array(all);
            });
            if self.end_tx(O::Book) != TxEnd::Done {
                return Step::Retry;
            }
            let mem = &mut self.book().mem;
            mem.registered = Some(reg);
            mem.registrations = reg;
        }
        let need = self.dollars(spec.rows_read.max, 0);
        if let Err(step) = self.env_place(&spec.purpose, need, 0.0, false) {
            return step;
        }
        let unit = self.new_unit(true, &spec.purpose, (spec.rows_read.min, spec.rows_read.max), 0, 0.0);
        self.book().mem.unrecorded.push(unit);
        self.units[unit].acked = true;
        let allowance = self.variant.params.generation_allowance_reads as usize;
        if self.objects[O::Book as usize].mem.unrecorded.len() >= allowance {
            self.env_flush();
        } else {
            let t = self.now + self.variant.params.idle_flush_ms;
            let gen = self.objects[O::Book as usize].gen;
            self.book().timer_at = Some(t);
            self.at(t, Ev::Flush(gen));
        }
        Step::Next
    }

    /// Write the generation's unrecorded work onto the envelope row, once, and mark its registration clean.
    pub fn env_flush(&mut self) {
        if self.objects[O::Book as usize].mem.unrecorded.is_empty() {
            return;
        }
        let unrecorded = std::mem::take(&mut self.book().mem.unrecorded);
        let gen = self.objects[O::Book as usize].gen;
        let reg = self.objects[O::Book as usize].mem.registered;
        let items: Vec<Value> = unrecorded.iter().map(|&u| json!([u, self.units[u].measured, self.units[u].measured])).collect();
        let confirmed = self.objects[O::Book as usize].mem.envelope_active;
        self.objects[O::Book as usize].db.update(ENVELOPE, "1", |e| {
            let mut tally = e["tally"].as_array().cloned().unwrap_or_default();
            tally.extend(items);
            e["tally"] = Value::Array(tally);
            if let Some(r) = reg {
                let mut clean = e["clean"].as_array().cloned().unwrap_or_default();
                clean.push(json!([gen, r]));
                e["clean"] = Value::Array(clean);
            }
            if !e["settling"].is_null() && confirmed == e["settling"]["marker_hour"].as_u64() {
                e["settling"] = Value::Null;
            }
        });
        let end = self.end_tx(O::Book);
        match end {
            TxEnd::Done => self.book().mem.registered = None,
            TxEnd::Interrupted => {
                let t = self.now + 1_000;
                self.book().timer_at = Some(t);
                self.at(t, Ev::Flush(gen));
            }
            TxEnd::DoneLost | TxEnd::Crashed => {}
        }
        self.after_write(end, gen, unrecorded, |mem, units| mem.unrecorded.extend(units));
    }

    /// A policy update's drain: each open lease is fenced on its book, and closed once nothing runs under it.
    pub fn env_drain(&mut self) -> bool {
        let epoch = self.epoch();
        let held = self.objects[O::Gate as usize].db.get(LEASES, "book").and_then(|l| l["epoch"].as_u64()) == Some(epoch);
        let mut busy = false;
        if held {
            let lease = format!("lease:{epoch}");
            self.touch(O::Book);
            let wait = !self.variant.params.skip_drain_wait;
            let mem = &mut self.book().mem;
            mem.leases_fenced.insert(lease.clone());
            mem.leases_live.remove(&lease);
            if wait && mem.inflight.values().any(|l| l.as_deref() == Some(lease.as_str())) {
                busy = true;
                self.drain_waits += 1;
            }
        }
        !busy
    }

    /// Receipts older than receipt_days go, one row each; no stamp is needed, a receipt carries its finish time.
    fn env_prune(&mut self) {
        let cut = self.now.saturating_sub(self.variant.params.receipt_days * DAY);
        // Receipts in commit order: the old ones are a prefix.
        let book = &self.objects[O::Book as usize].db;
        let old: Vec<String> = book.keys_above(RECEIPTS, "seq", 0).into_iter()
            .take_while(|k| book.get(RECEIPTS, k).and_then(|r| r["finished_at"].as_u64()).is_some_and(|t| t < cut)).collect();
        if old.is_empty() {
            return;
        }
        self.pruning = true;
        for key in old {
            self.objects[O::Book as usize].db.delete(RECEIPTS, &key);
        }
        let _ = self.end_tx(O::Book);
        self.pruning = false;
    }

    /// After the run: the last generation's tally is written and the envelope settles everything it holds.
    pub fn env_settle_everything(&mut self) {
        self.touch(O::Book);
        self.env_flush();
        while self.env_ensure(true, &[]).is_err() {}
    }
}

fn pairs(value: &Value) -> BTreeSet<(u64, u64)> {
    value.as_array().map(|a| a.iter().map(|p| (p[0].as_u64().unwrap_or(0), p[1].as_u64().unwrap_or(0))).collect()).unwrap_or_default()
}
