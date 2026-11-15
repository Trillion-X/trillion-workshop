//! Command bookkeeping as origin/main 050254ab91 writes it (variant protocol
//! `lease-blocks-per-basis`). Rows follow the code: the command record
//! (`resource_meter_commands`) reserved, begun, finished and its child part
//! cleared; the behavior journal (`resource_behavior_commands`) 'working' at
//! dispatch and 'committed' with the domain's own transaction; the gate
//! permit (`account_control_permits`) pending at admission and completed at
//! finish; per read a start and a release checkpoint on its read block's row
//! (`resource_quota_grants`); per block its row's acquiring, open, settling
//! and closed writes, a quota-credit cache row for a command block, and the
//! quota's reserve and settle.

use super::quota::{Ask, Settlement};
use super::world::{Step, TxEnd, World, DAY, HOUR, O};
use serde_json::{json, Value};

const METER: &str = "resource_meter_commands";
const BEHAVIOR: &str = "resource_behavior_commands";
const GRANTS: &str = "resource_quota_grants";
const PERMITS: &str = "account_control_permits";

impl World {
    fn lb_permit(&self, c: usize) -> String {
        format!("permit:{}~{}", self.cmds[c].key, self.cmds[c].refused_attempts + 1)
    }

    fn lb_lease(&self, c: usize) -> String {
        format!("lease:{}", self.lb_permit(c))
    }

    /// The dollars a command is admitted for: its heaviest read and its most records, and its price.
    pub fn command_bound(&self, c: usize) -> (f64, f64) {
        let Some(spec) = self.shape(c) else { return (0.0, 0.0) };
        let most_rows = spec.domain_rows.base + spec.domain_rows.extra.iter().map(|e| e.count).sum::<u64>();
        let price = if self.cmds[c].refund_of.is_some() { 0.0 } else { spec.paid.as_ref().map_or(0.0, |p| p.price) };
        (self.dollars(spec.rows_read.max, most_rows + 2), price)
    }

    pub fn lb_resolve(&mut self, c: usize) -> Step {
        let permit = self.lb_permit(c);
        let Some(row) = self.objects[O::Gate as usize].db.get(PERMITS, &permit).cloned() else { return Step::Next };
        if row["state"] != "completed" {
            return Step::Next;
        }
        if row["outcome"] == "committed" {
            self.touch(O::Book);
            return match self.objects[O::Book as usize].db.get(BEHAVIOR, &permit).and_then(|b| b["answer"].as_str()) {
                Some(answer) => Step::Done(answer.to_owned()),
                None => Step::Unknown,
            };
        }
        Step::Unknown
    }

    pub fn lb_reserve(&mut self, c: usize) -> Step {
        self.touch(O::Book);
        let (permit, lease) = (self.lb_permit(c), self.lb_lease(c));
        let book = &self.objects[O::Book as usize].db;
        if book.get(METER, &permit).is_some() || book.get(METER, &lease).is_some() {
            return Step::Next;
        }
        let purpose = self.shape(c).map(|s| s.purpose.clone()).unwrap_or_default();
        let (need, price) = self.command_bound(c);
        let grant = match self.lb_open_with_room(&purpose, need, price, true) {
            Ok(grant) => grant,
            Err(step) => return step,
        };
        self.objects[O::Book as usize].db.put(METER, &lease, json!({"state": "reserved", "grant": grant, "need": need, "price": price}));
        match self.end_tx(O::Book) {
            TxEnd::Done => Step::Next,
            _ => Step::Retry,
        }
    }

    /// An open block of `basis` with room for `need`, or a new one.
    fn lb_open_with_room(&mut self, basis: &str, need: f64, price: f64, command: bool) -> Result<String, Step> {
        let now = self.now;
        let open: Vec<String> = self.objects[O::Book as usize].db.rows(GRANTS)
            .filter(|(_, g)| g["basis"] == basis && g["state"] == "open" && g["ends"].as_u64().unwrap_or(0) > now)
            .map(|(id, _)| id.clone()).collect();
        for id in open {
            if self.lb_room(&id, need, price) {
                return Ok(id);
            }
        }
        self.lb_upkeep();
        self.lb_open(basis, need, price, command)
    }

    fn lb_children(&self, grant: &str) -> Vec<(String, Value)> {
        let book = &self.objects[O::Book as usize].db;
        book.keys_by(METER, "grant", grant).into_iter().filter_map(|k| book.get(METER, &k).cloned().map(|v| (k, v))).collect()
    }

    fn lb_room(&self, grant: &str, need: f64, price: f64) -> bool {
        let g = self.objects[O::Book as usize].db.get(GRANTS, grant).cloned().unwrap_or(Value::Null);
        let (cap, paid_cap, size) = (g["cap"].as_f64().unwrap_or(0.0), g["paid_cap"].as_f64().unwrap_or(0.0), g["size"].as_u64().unwrap_or(1));
        if g["kind"] == "read" {
            let held = self.objects[O::Book as usize].mem.ledgers.get(grant).map_or(0, |s| s.len()) as u64;
            let admitted = g["admitted"].as_u64().unwrap_or(0) + held;
            let used: f64 = g["used"].as_array().map_or(0.0, |a| a.iter().map(|i| i[2].as_f64().unwrap_or(0.0)).sum());
            let started: f64 = g["started"].as_array().map_or(0, |a| a.len()) as f64 * need;
            return admitted < size && used + started + need <= cap + 1e-12;
        }
        let children = self.lb_children(grant);
        let held: f64 = children.iter().map(|(_, m)| if m["state"] == "finished" { m["used"].as_f64().unwrap_or(0.0) } else { m["need"].as_f64().unwrap_or(0.0) }).sum();
        let paid: f64 = children.iter().map(|(_, m)| m["price"].as_f64().unwrap_or(0.0)).sum();
        (children.len() as u64) < size && held + need <= cap + 1e-12 && paid + price <= paid_cap + 1e-12
    }

    /// The size a new block of `basis` takes: 1 cold, doubling while the last block filled, kept while it did not.
    fn lb_size(&self, basis: &str) -> u64 {
        let now = self.now;
        let growth = self.variant.params.grant_growth_window_ms;
        let last = self.objects[O::Book as usize].db.rows(GRANTS)
            .filter(|(_, g)| g["basis"] == basis && g["state"] != "acquiring" && g["state"] != "refused")
            .max_by_key(|(_, g)| g["ends"].as_u64().unwrap_or(0)).map(|(id, g)| (id.clone(), g.clone()));
        match last {
            Some((id, g)) if g["ends"].as_u64().unwrap_or(0) + growth > now => {
                let size = g["size"].as_u64().unwrap_or(1);
                let admitted = if g["kind"] == "read" { g["admitted"].as_u64().unwrap_or(0) } else { g["admitted"].as_u64().unwrap_or(0).max(self.lb_children(&id).len() as u64) };
                if admitted >= size { (size * 2).min(u64::from(self.variant.params.most_commands)) } else { size }
            }
            _ => 1,
        }
    }

    fn lb_open(&mut self, basis: &str, need: f64, price: f64, command: bool) -> Result<String, Step> {
        let resumed = self.objects[O::Book as usize].db.rows(GRANTS).find(|(_, g)| g["basis"] == basis && g["state"] == "acquiring").map(|(id, g)| (id.clone(), g["size"].as_u64().unwrap_or(1)));
        let (id, mut size) = match resumed {
            Some(found) => found,
            None => {
                let id = format!("grant:{:016x}", self.rng.next());
                let size = self.lb_size(basis);
                self.objects[O::Book as usize].db.put(GRANTS, &id, json!({"basis": basis, "kind": if command {"command"} else {"read"}, "state": "acquiring", "size": size, "admitted": 0, "started": [], "used": []}));
                if !self.end_tx(O::Book).committed() {
                    return Err(Step::Retry);
                }
                (id, size)
            }
        };
        loop {
            let asks = [Ask { subject: basis.to_owned(), amount: need * size as f64, paid: price * size as f64, store_work: command }];
            match self.quota_reserve(&id, &asks, size > 1) {
                Ok(end) if end.committed() => break,
                Ok(_) => return Err(Step::Retry),
                Err(Step::Refused(..)) if size > 1 => {
                    size = (size / 2).max(1);
                    self.objects[O::Book as usize].db.update(GRANTS, &id, |g| g["size"] = json!(size));
                    if !self.end_tx(O::Book).committed() {
                        return Err(Step::Retry);
                    }
                }
                Err(refusal) => {
                    self.objects[O::Book as usize].db.update(GRANTS, &id, |g| g["state"] = json!("refused"));
                    let _ = self.end_tx(O::Book);
                    return Err(refusal);
                }
            }
        }
        let ends = (self.now + self.variant.params.block_age_ms).min((self.now / HOUR + 1) * HOUR);
        self.objects[O::Book as usize].db.update(GRANTS, &id, |g| {
            g["state"] = json!("open");
            g["ends"] = json!(ends);
            g["cap"] = json!(need * size as f64);
            g["paid_cap"] = json!(price * size as f64);
        });
        if !self.end_tx(O::Book).committed() {
            return Err(Step::Retry);
        }
        if command {
            self.touch(O::Gate);
            self.objects[O::Gate as usize].db.put("policy_directory", &format!("quota-credit:{id}"), json!({"grant": id}));
            let _ = self.end_tx(O::Gate);
        }
        self.wake_at(ends);
        Ok(id)
    }

    pub fn lb_admit(&mut self, c: usize) -> Step {
        let permit = self.lb_permit(c);
        if let Some(row) = self.objects[O::Gate as usize].db.get(PERMITS, &permit) {
            self.cmds[c].admitted_epoch = row["epoch"].as_u64();
            return Step::Next;
        }
        let epoch = self.epoch();
        self.objects[O::Gate as usize].db.put(PERMITS, &permit, json!({"state": "pending", "epoch": epoch}));
        let end = self.end_tx(O::Gate);
        if end.committed() {
            self.note_admitted(c);
        }
        if end == TxEnd::Done { Step::Next } else { Step::Retry }
    }

    pub fn lb_begin(&mut self, c: usize) -> Step {
        self.touch(O::Book);
        let (permit, lease) = (self.lb_permit(c), self.lb_lease(c));
        let book = &self.objects[O::Book as usize];
        if let Some(answer) = book.db.get(BEHAVIOR, &permit).filter(|b| b["state"] == "committed").and_then(|b| b["answer"].as_str()) {
            return Step::Done(answer.to_owned());
        }
        if book.db.get(METER, &permit).is_some() {
            // Begun before and not running here now: its outcome waits for the meter's recovery.
            return if book.mem.inflight.contains_key(&permit) { Step::Retry } else { Step::Unknown };
        }
        if book.db.get(METER, &lease).is_none_or(|m| m["state"] != "reserved") {
            return self.refused("begin", "changing");
        }
        let (rows_read, price, purpose) = match self.shape(c) {
            Some(s) => ((s.rows_read.min, s.rows_read.max), if self.cmds[c].refund_of.is_some() { 0.0 } else { s.paid.as_ref().map_or(0.0, |p| p.price) }, s.purpose.clone()),
            None => return Step::Unknown,
        };
        let unit = self.new_unit(false, &purpose, rows_read, 0, price);
        let grant = self.objects[O::Book as usize].db.get(METER, &lease).and_then(|m| m["grant"].as_str()).map(str::to_owned);
        if let Some(day) = grant.and_then(|g| self.hold_day(&g)) {
            self.units[unit].day = day;
        }
        self.objects[O::Book as usize].db.rekey(METER, &lease, &permit, |m| {
            m["state"] = json!("running");
            m["unit"] = json!(unit);
        });
        if self.end_tx(O::Book) != TxEnd::Done {
            return Step::Retry;
        }
        self.book().mem.inflight.insert(permit.clone(), None);
        self.objects[O::Book as usize].db.put(BEHAVIOR, &permit, json!({"state": "working", "unit": unit}));
        if self.end_tx(O::Book) != TxEnd::Done {
            self.book().mem.inflight.remove(&permit);
            return Step::Retry;
        }
        self.cmds[c].pending_unit = Some(unit);
        self.cmds[c].begun_gen = Some(self.objects[O::Book as usize].gen);
        Step::Next
    }

    /// The work ends: the domain's transaction with the journal's 'committed', then the command's finish.
    pub fn lb_commit(&mut self, c: usize) -> Step {
        let permit = self.lb_permit(c);
        let Some(unit) = self.cmds[c].pending_unit.take() else { return Step::Retry };
        self.domain_effect(c, unit);
        let answer = format!("{}#{unit}", self.cmds[c].key);
        self.objects[O::Book as usize].db.update(BEHAVIOR, &permit, |b| {
            b["state"] = json!("committed");
            b["answer"] = json!(answer);
        });
        let end = self.end_tx(O::Book);
        if end.committed() {
            self.domain_committed(c, unit);
            self.cmds[c].answer = Some(answer);
        }
        match end {
            TxEnd::Done => {}
            TxEnd::Interrupted => {
                // Dispatched and rolled back: the journal says unknown, and so does the answer.
                self.objects[O::Book as usize].db.update(BEHAVIOR, &permit, |b| b["state"] = json!("unknown"));
                let _ = self.end_tx(O::Book);
                self.book().mem.inflight.remove(&permit);
                return Step::Unknown;
            }
            _ => return Step::Retry,
        }
        // The finish: the command's record finished with what it used, its block child closed, in one write.
        let used = self.units[unit].measured;
        for _ in 0..3 {
            self.objects[O::Book as usize].db.update(METER, &permit, |m| {
                m["state"] = json!("finished");
                m["outcome"] = json!("committed");
                m["used"] = json!(used);
                m["finished_at"] = json!(self.now);
            });
            match self.end_tx(O::Book) {
                TxEnd::Done => break,
                TxEnd::Interrupted => continue,
                _ => return Step::Retry,
            }
        }
        self.book().mem.inflight.remove(&permit);
        let interval = self.variant.params.metered_use_interval_ms;
        let last = self.objects[O::Book as usize].db.get("metered_use_days", "last").and_then(Value::as_u64);
        if last.is_none_or(|t| self.now >= t + interval) {
            self.objects[O::Book as usize].db.put("metered_use_days", "last", json!(self.now));
            let _ = self.end_tx(O::Book);
        }
        Step::Next
    }

    pub fn lb_finish(&mut self, c: usize) -> Step {
        self.touch(O::Gate);
        let permit = self.lb_permit(c);
        if self.objects[O::Gate as usize].db.get(PERMITS, &permit).is_some_and(|p| p["state"] == "completed") {
            return Step::Next;
        }
        self.objects[O::Gate as usize].db.update(PERMITS, &permit, |p| {
            p["state"] = json!("completed");
            p["outcome"] = json!("committed");
        });
        if self.end_tx(O::Gate) == TxEnd::Done { Step::Next } else { Step::Retry }
    }

    pub fn lb_read(&mut self, c: usize, at: usize) -> Step {
        self.touch(O::Book);
        let Some(spec) = self.shape(c).and_then(|s| s.reads.get(at)).cloned() else { return Step::Next };
        let basis = format!("read:{}", spec.purpose);
        let need = self.dollars(spec.rows_read.max, 0);
        let now = self.now;
        let held: Vec<String> = self.objects[O::Book as usize].mem.ledgers.keys().cloned().collect();
        let mut grant = held.into_iter().find(|id| {
            let g = self.objects[O::Book as usize].db.get(GRANTS, id);
            g.is_some_and(|g| g["basis"] == basis.as_str() && g["state"] == "open" && g["ends"].as_u64().unwrap_or(0) > now) && self.lb_room(id, need, 0.0)
        });
        if grant.is_none() {
            // An open read block an earlier isolate held is adopted, writing nothing: what it still holds is escrow.
            let adoptable: Vec<String> = self.objects[O::Book as usize].db.rows(GRANTS)
                .filter(|(id, g)| g["basis"] == basis.as_str() && g["state"] == "open" && g["ends"].as_u64().unwrap_or(0) > now
                    && !self.objects[O::Book as usize].mem.ledgers.contains_key(*id))
                .map(|(id, _)| id.clone()).collect();
            for id in adoptable {
                if self.lb_room(&id, need, 0.0) {
                    self.book().mem.ledgers.insert(id.clone(), Default::default());
                    grant = Some(id);
                    break;
                }
            }
        }
        let grant = match grant {
            Some(g) => g,
            None => match self.lb_open(&basis, need, 0.0, false) {
                Ok(g) => {
                    self.book().mem.ledgers.insert(g.clone(), Default::default());
                    g
                }
                Err(step) => return step,
            },
        };
        let unit = self.new_unit(true, &basis, (spec.rows_read.min, spec.rows_read.max), 0, 0.0);
        self.objects[O::Book as usize].db.update(GRANTS, &grant, |g| {
            let mut started = g["started"].as_array().cloned().unwrap_or_default();
            started.push(json!(unit));
            g["started"] = Value::Array(started);
            g["admitted"] = json!(g["admitted"].as_u64().unwrap_or(0) + 1);
        });
        match self.end_tx(O::Book) {
            TxEnd::Done => {}
            TxEnd::DoneLost => {
                self.units[unit].lost = true;
                return Step::Retry;
            }
            TxEnd::Interrupted | TxEnd::Crashed => {
                self.units[unit].void = true;
                return Step::Retry;
            }
        }
        if let Some(ledger) = self.book().mem.ledgers.get_mut(&grant) {
            ledger.insert(unit);
        }
        let measured = self.units[unit].measured;
        let gen = self.objects[O::Book as usize].gen;
        for _ in 0..3 {
            if let Some(ledger) = self.book().mem.ledgers.get_mut(&grant) {
                ledger.remove(&unit);
            }
            self.objects[O::Book as usize].db.update(GRANTS, &grant, |g| {
                let started: Vec<Value> = g["started"].as_array().cloned().unwrap_or_default().into_iter().filter(|u| u != &json!(unit)).collect();
                g["started"] = Value::Array(started);
                let mut used = g["used"].as_array().cloned().unwrap_or_default();
                used.push(json!([unit, measured, measured]));
                g["used"] = Value::Array(used);
            });
            let end = self.end_tx(O::Book);
            self.after_write(end, gen, vec![unit], |mem, units| {
                if let Some(ledger) = mem.ledgers.get_mut(&grant) {
                    ledger.extend(units);
                }
            });
            match end {
                TxEnd::Done => {
                    self.units[unit].acked = true;
                    return Step::Next;
                }
                TxEnd::Interrupted => continue,
                TxEnd::DoneLost | TxEnd::Crashed => return Step::Retry,
            }
        }
        Step::Retry
    }

    /// The gate's drain of a policy update: every pending permit reconciled with its book. True once none is pending.
    pub fn lb_drain(&mut self) -> bool {
        let pending: Vec<String> = self.objects[O::Gate as usize].db.keys_by(PERMITS, "state", "pending").into_iter().take(100).collect();
        let mut busy = false;
        for permit in pending {
            self.touch(O::Book);
            if self.objects[O::Book as usize].mem.inflight.contains_key(&permit) {
                busy = true;
                self.drain_waits += 1;
                continue;
            }
            let lease = format!("lease:{permit}");
            let outcome = self.lb_settle_command(&permit, &lease, true);
            self.touch(O::Gate);
            self.objects[O::Gate as usize].db.update(PERMITS, &permit, |p| {
                p["state"] = json!("completed");
                p["outcome"] = json!(outcome);
            });
            if !self.end_tx(O::Gate).committed() {
                busy = true;
            }
        }
        !busy && self.objects[O::Gate as usize].db.keys_by(PERMITS, "state", "pending").is_empty()
    }

    /// Settle one command nothing runs here now, from its durable state: a committed one finishes by its effect at what
    /// was observed (a reset lost it: 0), a begun one without an effect finishes aborted, a place never begun is released.
    fn lb_settle_command(&mut self, permit: &str, lease: &str, now: bool) -> &'static str {
        let book = &self.objects[O::Book as usize].db;
        let committed = book.get(BEHAVIOR, permit).is_some_and(|b| b["state"] == "committed");
        if let Some(m) = book.get(METER, permit).cloned() {
            if m["state"] == "finished" {
                return if m["outcome"] == "committed" { "committed" } else { "aborted" };
            }
            let ended = m["grant"].as_str().and_then(|g| book.get(GRANTS, g)).is_none_or(|g| g["ends"].as_u64().unwrap_or(0) <= self.now);
            if !now && !ended {
                return "pending";
            }
            self.objects[O::Book as usize].db.update(METER, permit, |row| {
                row["state"] = json!("finished");
                row["outcome"] = json!(if committed { "committed" } else { "aborted" });
                row["used"] = json!(0.0);
                row["finished_at"] = json!(self.now);
            });
            let _ = self.end_tx(O::Book);
            return if committed { "committed" } else { "aborted" };
        }
        if book.get(METER, lease).is_some() {
            self.objects[O::Book as usize].db.delete(METER, lease);
            let _ = self.end_tx(O::Book);
        }
        "aborted"
    }

    /// The book's alarm: commands a reset left running settle by their effect, places never begun are released, ended
    /// or full blocks settle at the quota and close, closed blocks forget their children, and receipts age out.
    pub fn lb_upkeep(&mut self) {
        let now = self.now;
        let running: Vec<String> = self.objects[O::Book as usize].db.keys_by(METER, "state", "running");
        for permit in running {
            if !self.objects[O::Book as usize].mem.inflight.contains_key(&permit) {
                self.lb_settle_command(&permit, "", false);
            }
        }
        let release_after = self.variant.params.unexecuted_release_after_ms;
        let book = &self.objects[O::Book as usize].db;
        let stale: Vec<String> = book.keys_by(METER, "state", "reserved").into_iter().filter_map(|k| book.get(METER, &k).cloned().map(|m| (k, m))).filter(|(_, m)| {
            m["grant"].as_str().and_then(|g| self.objects[O::Book as usize].db.get(GRANTS, g)).is_none_or(|g| g["ends"].as_u64().unwrap_or(0) + release_after <= now)
        }).map(|(k, _)| k).collect();
        for lease in stale {
            self.objects[O::Book as usize].db.delete(METER, &lease);
            let _ = self.end_tx(O::Book);
        }
        let due: Vec<String> = self.objects[O::Book as usize].db.rows(GRANTS).filter(|(_, g)| {
            g["state"] == "settling" || g["state"] == "open" && g["ends"].as_u64().unwrap_or(0) <= now
        }).map(|(k, _)| k.clone()).collect();
        for id in due {
            self.lb_settle_grant(&id);
        }
        self.lb_forget();
        self.lb_prune();
        let next = self.objects[O::Book as usize].db.rows(GRANTS).filter(|(_, g)| g["state"] == "open").filter_map(|(_, g)| g["ends"].as_u64()).min();
        if let Some(t) = next {
            self.wake_at(t.max(now + 1));
        } else if self.objects[O::Book as usize].db.rows(GRANTS).any(|(_, g)| g["state"] == "closed") {
            self.wake_at(now + self.variant.params.forget_after_ms.max(300_000));
        }
    }

    fn lb_settle_grant(&mut self, id: &str) {
        let Some(g) = self.objects[O::Book as usize].db.get(GRANTS, id).cloned() else { return };
        if g["kind"] == "read" && self.objects[O::Book as usize].mem.ledgers.get(id).is_some_and(|l| !l.is_empty()) {
            return;
        }
        let payload = if g["state"] == "settling" {
            Settlement::from_json(&g["payload"])
        } else {
            let mut s = Settlement { event: format!("settle:{id}"), ..Settlement::default() };
            if g["kind"] == "read" {
                for i in g["used"].as_array().cloned().unwrap_or_default() {
                    s.items.push((i[0].as_u64().unwrap_or(0) as usize, i[1].as_f64().unwrap_or(0.0), i[2].as_f64().unwrap_or(0.0)));
                }
                // Reads started and never released: lost with their isolate, counted at their bound, never charged.
                for u in g["started"].as_array().cloned().unwrap_or_default() {
                    let unit = u.as_u64().unwrap_or(0) as usize;
                    s.items.push((unit, 0.0, self.units[unit].bound));
                }
            } else {
                let children = self.lb_children(id);
                if children.iter().any(|(_, m)| m["state"] == "running" || m["state"] == "reserved") {
                    return;
                }
                for (_, m) in children {
                    if let Some(unit) = m["unit"].as_u64() {
                        let used = m["used"].as_f64().unwrap_or(0.0);
                        s.items.push((unit as usize, used, used));
                    }
                }
            }
            let admitted = if g["kind"] == "read" { g["admitted"].as_u64().unwrap_or(0) } else { self.lb_children(id).len() as u64 };
            let payload = s.to_json();
            self.objects[O::Book as usize].db.update(GRANTS, id, |row| {
                row["state"] = json!("settling");
                row["payload"] = payload;
                row["admitted"] = json!(admitted);
                row["ends"] = json!(row["ends"].as_u64().unwrap_or(0).min(self.now));
            });
            if !self.end_tx(O::Book).committed() {
                return;
            }
            s
        };
        match self.quota_settle(id, &payload, None) {
            Ok(end) if end.committed() => {}
            _ => return,
        }
        self.touch(O::Book);
        let now = self.now;
        self.objects[O::Book as usize].db.update(GRANTS, id, |row| {
            row["state"] = json!("closed");
            row["closed_at"] = json!(now);
        });
        let _ = self.end_tx(O::Book);
        self.book().mem.ledgers.remove(id);
    }

    /// A block closed forget_after_ms ago clears each child's part of its command record; its own row goes once
    /// grant_growth_window_ms has passed (its size is read until then).
    fn lb_forget(&mut self) {
        let now = self.now;
        let (forget, growth) = (self.variant.params.forget_after_ms, self.variant.params.grant_growth_window_ms);
        let closed: Vec<(String, Value)> = self.objects[O::Book as usize].db.rows(GRANTS).filter(|(_, g)| g["state"] == "closed")
            .map(|(k, v)| (k.clone(), v.clone())).collect();
        for (id, g) in closed {
            let closed_at = g["closed_at"].as_u64().unwrap_or(0);
            if closed_at + forget > now {
                continue;
            }
            for (key, _) in self.lb_children(&id) {
                self.objects[O::Book as usize].db.update(METER, &key, |m| m["grant"] = Value::Null);
            }
            let _ = self.end_tx(O::Book);
            if closed_at + growth <= now {
                self.objects[O::Book as usize].db.delete(GRANTS, &id);
                let _ = self.end_tx(O::Book);
            }
        }
    }

    /// The receipt prune: a finished command is stamped when the prune first sees it and deleted with its stamp after
    /// receipt_days.
    fn lb_prune(&mut self) {
        let now = self.now;
        if now < self.pruned_at + 300_000 {
            return;
        }
        self.pruned_at = now;
        let keep = self.variant.params.receipt_days * DAY;
        self.pruning = true;
        let finished: Vec<String> = self.objects[O::Book as usize].db.keys_by(METER, "state", "finished");
        for permit in finished {
            match self.objects[O::Book as usize].db.get("resource_meter_command_ages", &permit).and_then(Value::as_u64) {
                None => {
                    self.objects[O::Book as usize].db.put("resource_meter_command_ages", &permit, json!(now));
                    let _ = self.end_tx(O::Book);
                }
                Some(seen) if seen + keep <= now => {
                    self.objects[O::Book as usize].db.delete(METER, &permit);
                    self.objects[O::Book as usize].db.delete("resource_meter_command_ages", &permit);
                    self.objects[O::Book as usize].db.delete(BEHAVIOR, &permit);
                    let _ = self.end_tx(O::Book);
                }
                Some(_) => {}
            }
        }
        self.pruning = false;
    }

    /// After the run: every command left settles, every block closes, every pending permit completes.
    pub fn lb_settle_everything(&mut self) {
        self.touch(O::Book);
        let now = self.now;
        let open: Vec<String> = self.objects[O::Book as usize].db.rows(GRANTS).filter(|(_, g)| g["state"] == "open").map(|(k, _)| k.clone()).collect();
        for id in open {
            self.objects[O::Book as usize].db.update(GRANTS, &id, |g| g["ends"] = json!(now));
            let _ = self.end_tx(O::Book);
        }
        self.book().mem.ledgers.clear();
        while !self.lb_drain() {}
        let running: Vec<String> = self.objects[O::Book as usize].db.keys_by(METER, "state", "running");
        for permit in running {
            self.lb_settle_command(&permit, "", true);
        }
        let reserved: Vec<String> = self.objects[O::Book as usize].db.keys_by(METER, "state", "reserved");
        for lease in reserved {
            self.objects[O::Book as usize].db.delete(METER, &lease);
            let _ = self.end_tx(O::Book);
        }
        let due: Vec<String> = self.objects[O::Book as usize].db.rows(GRANTS).filter(|(_, g)| g["state"] == "open" || g["state"] == "settling").map(|(k, _)| k.clone()).collect();
        for id in due {
            self.lb_settle_grant(&id);
        }
    }
}
