//! What a run kept against what happened: rows written per command by object and table, and the oracles for
//! money, authority and acknowledged answers.

use super::world::{Status, Violations, World, O};
use serde::Serialize;
use std::collections::BTreeMap;

const EPS: f64 = 1e-12;

#[derive(Default, Serialize)]
pub struct Money {
    /// A committed command charged other than exactly once at exactly what it measured.
    pub committed_charge_wrong: u64,
    /// A read whose measurement survived, charged other than exactly once at exactly what it measured.
    pub read_charge_wrong: u64,
    /// A read lost with its object that was charged anything, or counted against limits below its bound.
    pub lost_read_wrong: u64,
    /// Any piece of work charged more than it measured, or settled more than once.
    pub overcharged: u64,
    /// A paid run that failed after its charge and has no refund.
    pub refund_missing: u64,
    /// Dollars that should have been charged and were not, and charged beyond what was measured.
    pub dollars_missing: f64,
    pub dollars_extra: f64,
}

impl Money {
    pub fn discrepancies(&self) -> u64 {
        self.committed_charge_wrong + self.read_charge_wrong + self.lost_read_wrong + self.overcharged + self.refund_missing
    }
}

#[derive(Serialize)]
pub struct RunReport {
    pub variant: String,
    pub about: String,
    pub workload: String,
    pub faults: String,
    pub days: u64,
    pub seed: u64,
    pub evict: bool,
    pub commands: u64,
    pub acked: u64,
    pub refused: BTreeMap<String, u64>,
    pub unknown: u64,
    pub reads: u64,
    /// Rows written per command that are bookkeeping (not the command's own records).
    pub bookkeeping_per_command: f64,
    /// Rows the probe counts as bookkeeping that are the command's derived work (workshop facts, collection index).
    pub derived_per_command: f64,
    /// The command's own records.
    pub work_per_command: f64,
    /// Rows the policy updates themselves wrote (the gate's fence and epoch, the quota's policy), per update: a policy
    /// change is its own change, not a command's bookkeeping.
    pub policy_rows_per_update: f64,
    /// Rows a receipt prune writes per command over the receipt's whole life (deletes and stamps).
    pub prune_per_command: f64,
    pub tables: Vec<TableRows>,
    pub money: Money,
    pub authority_violations: u64,
    pub lost_acks: u64,
    pub violations: Violations,
    pub crashes: BTreeMap<&'static str, u64>,
    pub escrow_dollars: f64,
    pub updates_finished: u64,
    /// Days whose committed paid runs cost more than that day's highest paid ceiling: (day, spent, ceiling).
    pub over_ceiling_days: Vec<(u64, f64, f64)>,
    /// With a calibration schedule: rows per command between its two marks (bookkeeping, derived, and by table), as the code
    /// probe counts them.
    pub probe_window: Option<ProbeWindow>,
    pub drain_waits: u64,
}

#[derive(Serialize)]
pub struct ProbeWindow {
    pub bookkeeping: f64,
    pub derived: f64,
    pub tables: Vec<TableRows>,
}

#[derive(Serialize)]
pub struct TableRows {
    pub object: &'static str,
    pub table: String,
    pub per_command: f64,
}

impl World {
    pub fn report(&self, days: u64, seed: u64) -> RunReport {
        let originals = self.cmds.iter().filter(|c| c.shape.is_some() && c.replay_of.is_none() && c.refund_of.is_none()).count().max(1) as f64;
        let mut tables: Vec<TableRows> = Vec::new();
        let (mut bookkeeping, mut derived, mut work, mut policy) = (0.0, 0.0, 0.0, 0.0);
        for ((o, table), rows) in &self.rows {
            if table == "domain" {
                continue;
            }
            let per = *rows as f64 / originals;
            match table.as_str() {
                "account_control_state" | "resource_budget_policy" => {
                    policy += *rows as f64;
                    continue;
                }
                "record_log" => work += per,
                "derived" => derived += per,
                _ => bookkeeping += per,
            }
            tables.push(TableRows { object: o.name(), table: table.clone(), per_command: per });
        }
        tables.sort_by(|a, b| b.per_command.total_cmp(&a.per_command));
        let prune = self.prune_rows.values().sum::<u64>() as f64 / originals;
        let money = self.money();
        let mut violations = self.violations.clone();
        violations.paid_over_ceiling = self.over_ceiling_days().len() as u64;
        violations.lost_acks = self.lost_acks();
        let authority = violations.passed_in_flight + violations.admitted_while_fenced + violations.admitted_signed_out + violations.refusal_stage + violations.paid_over_ceiling;
        let lost_acks = violations.lost_acks + violations.replay_mismatch + violations.double_effect;
        let escrow = self.units.iter().filter(|u| u.lost && !u.void).map(|u| u.limits).sum();
        RunReport {
            variant: self.variant.id.clone(),
            about: self.variant.about.clone(),
            workload: self.plan.id.clone(),
            faults: self.profile.clone(),
            days,
            seed,
            evict: self.evicting,
            commands: originals as u64,
            acked: self.cmds.iter().filter(|c| c.status == Status::Acked && c.replay_of.is_none() && c.refund_of.is_none() && c.shape.is_some()).count() as u64,
            refused: self.refusals.clone(),
            unknown: self.cmds.iter().filter(|c| c.status == Status::Unknown).count() as u64,
            reads: self.units.iter().filter(|u| u.read && !u.void).count() as u64,
            bookkeeping_per_command: bookkeeping,
            derived_per_command: derived,
            work_per_command: work,
            policy_rows_per_update: policy / (self.ghost.epochs.len().max(1) as f64),
            prune_per_command: prune,
            tables,
            money,
            authority_violations: authority,
            lost_acks,
            violations,
            crashes: self.crashes.clone(),
            escrow_dollars: escrow,
            updates_finished: self.ghost.epochs.len() as u64,
            over_ceiling_days: self.over_ceiling_days(),
            probe_window: self.probe_window(),
            drain_waits: self.drain_waits,
        }
    }

    fn probe_window(&self) -> Option<ProbeWindow> {
        let ([from, to], Some(s)) = (self.marks.as_slice(), self.plan.schedule) else { return None };
        let n = (s.count - s.warmup).max(1) as f64;
        let (mut bookkeeping, mut derived, mut tables) = (0.0, 0.0, Vec::new());
        for ((o, table), rows) in to {
            let per = (rows - from.get(&(*o, table.clone())).copied().unwrap_or(0)) as f64 / n;
            match table.as_str() {
                "domain" | "record_log" | "account_control_state" | "resource_budget_policy" => continue,
                "derived" => derived += per,
                _ => bookkeeping += per,
            }
            if per > 0.0 {
                tables.push(TableRows { object: o.name(), table: table.clone(), per_command: per });
            }
        }
        tables.sort_by(|a, b| b.per_command.total_cmp(&a.per_command));
        Some(ProbeWindow { bookkeeping, derived, tables })
    }

    fn money(&self) -> Money {
        let mut m = Money::default();
        for u in self.units.iter().filter(|u| !u.void) {
            if u.charged > u.measured + EPS || u.settled > 1 {
                m.overcharged += 1;
                m.dollars_extra += (u.charged - u.measured).max(0.0);
            }
            if u.read {
                if u.lost {
                    if u.charged > EPS || u.limits + EPS < u.bound {
                        m.lost_read_wrong += 1;
                    }
                } else if u.acked && (u.settled != 1 || (u.charged - u.measured).abs() > EPS) {
                    m.read_charge_wrong += 1;
                    m.dollars_missing += (u.measured - u.charged).max(0.0);
                }
            } else if u.committed && (u.settled != 1 || (u.charged - u.measured).abs() > EPS) {
                m.committed_charge_wrong += 1;
                m.dollars_missing += (u.measured - u.charged).max(0.0);
            }
        }
        // Every paid run that failed after its charge, and was told so, is refunded once.
        for (i, c) in self.cmds.iter().enumerate() {
            let fails = self.shape(i).and_then(|s| s.paid.as_ref()).is_some_and(|p| p.fails);
            if fails && c.replay_of.is_none() && c.refund_of.is_none() && c.unit.is_some() {
                let refunded = self.ghost_effects.get(&format!("refund:{}", c.key)).copied().unwrap_or(0);
                if refunded != 1 {
                    m.refund_missing += 1;
                }
            }
        }
        m
    }

    /// Days whose committed paid runs cost more than the highest paid ceiling that day.
    fn over_ceiling_days(&self) -> Vec<(u64, f64, f64)> {
        let mut by_day: BTreeMap<u64, f64> = BTreeMap::new();
        for u in self.units.iter().filter(|u| u.committed && !u.read && u.price > 0.0) {
            *by_day.entry(u.day).or_default() += u.price;
        }
        by_day.into_iter().filter_map(|(day, spent)| {
            let ceiling = self.ghost.max_ceiling_by_day.range(..=day).next_back().map_or(0.0, |(_, v)| *v);
            (spent > ceiling + 1e-9).then_some((day, spent, ceiling))
        }).collect()
    }

    /// Acked answers whose effect is not kept exactly as answered.
    fn lost_acks(&self) -> u64 {
        let book = &self.objects[O::Book as usize].db;
        self.cmds.iter().filter(|c| c.status == Status::Acked && c.replay_of.is_none() && c.shape.is_some() || c.status == Status::Acked && c.refund_of.is_some())
            .filter(|c| {
                let kept = book.get("domain", &c.key).and_then(|d| d["answer"].as_str()).map(str::to_owned);
                kept != c.answer || self.ghost_effects.get(&c.key).copied().unwrap_or(0) != 1
            })
            .count() as u64
    }
}
