//! Request receipts every candidate shares: a bounded ring kept inside the
//! row the request changed, so a retry is answered by the one key lookup it
//! already needs (the record's current row) and never by a scan that grows
//! with history or time.
//!
//! The rule (applied to every candidate that answers retries):
//! - a change stores its request key and commit time in the ring of the row
//!   it wrote; a deleted record keeps a tombstone row holding its ring, so a
//!   retried create or delete is still answered after the record is gone;
//! - entries leave the ring when they are older than `window_ms` or when the
//!   ring holds more than `max_entries`; the ring's `horizon_ms` is the newest
//!   commit time that left it;
//! - a retry is a duplicate when its request key is in the ring of the row it
//!   addresses; it is new when the key is absent and its first attempt is
//!   newer than the horizon; otherwise its outcome can no longer be known and
//!   it is refused (never applied twice, never silently dropped). A retry
//!   older than the window is refused the same way.
//!
//! Reads per retry: the addressed row only (1 row), flat from day 1 to any day.
//! Rows written: 0 (the ring travels inside the row the change writes).

use serde::{Deserialize, Serialize};
use workload_simulation::{Intent, Operation, StoreError};

use crate::meter::err;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptParams {
    /// How long a request can be retried and still be answered.
    pub window_ms: u64,
    /// Most receipts one row keeps (a hot row's ring stays bounded).
    pub max_entries: usize,
}

impl ReceiptParams {
    pub fn check(&self) -> Result<(), StoreError> {
        if self.window_ms == 0 || self.max_entries == 0 {
            return Err(StoreError(
                "receipts need window_ms >= 1 and max_entries >= 1".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Receipt {
    pub request: String,
    pub at_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Ring {
    /// Oldest first; the last entry is the request that wrote the row.
    pub entries: Vec<Receipt>,
    /// Newest commit time of a receipt that left the ring (0 = none left).
    pub horizon_ms: u64,
}

/// What a retry gets.
#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    Duplicate,
    Apply,
}

impl Ring {
    pub fn parse(text: Option<&str>) -> Result<Self, StoreError> {
        text.map(serde_json::from_str)
            .transpose()
            .map_err(err)
            .map(Option::unwrap_or_default)
    }

    pub fn text(&self) -> Result<String, StoreError> {
        serde_json::to_string(self).map_err(err)
    }

    /// The request that wrote this row (its newest receipt).
    pub fn newest(&self) -> Option<&Receipt> {
        self.entries.last()
    }

    /// The ring after `request` committed a change to this row at `at_ms`.
    pub fn after(&self, request: &str, at_ms: u64, p: &ReceiptParams) -> Self {
        let mut next = self.clone();
        next.entries.push(Receipt {
            request: request.to_owned(),
            at_ms,
        });
        let oldest_kept = at_ms.saturating_sub(p.window_ms);
        let expired = next
            .entries
            .iter()
            .take_while(|e| e.at_ms < oldest_kept)
            .count();
        let over = next.entries.len().saturating_sub(p.max_entries);
        let leave = expired.max(over);
        for e in next.entries.drain(..leave) {
            next.horizon_ms = next.horizon_ms.max(e.at_ms);
        }
        next
    }
}

/// The record key a retry addresses (None: the intent keeps no receipt).
pub fn addressed(intent: &Intent) -> Option<&str> {
    match intent {
        Intent::Create { key, .. }
        | Intent::Update { key, .. }
        | Intent::WriteMember { key, .. }
        | Intent::Delete { key } => Some(key),
        _ => None,
    }
}

/// Answer a retry from the ring of the row it addresses (`None`: no row).
pub fn answer(
    ring: Option<&Ring>,
    op: &Operation,
    now_ms: u64,
    p: &ReceiptParams,
) -> Result<Answer, StoreError> {
    let first_ms = op.at.0;
    if now_ms.saturating_sub(first_ms) > p.window_ms {
        return Err(StoreError(
            "retry is older than the receipt window; its outcome is unknown".into(),
        ));
    }
    let Some(ring) = ring else {
        return Ok(Answer::Apply);
    };
    if ring.entries.iter().any(|e| e.request == op.request_key) {
        return Ok(Answer::Duplicate);
    }
    if first_ms <= ring.horizon_ms {
        return Err(StoreError(
            "the retry's receipt left the ring; its outcome is unknown".into(),
        ));
    }
    Ok(Answer::Apply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use workload_simulation::SimTime;

    fn op(key: &str, at: u64) -> Operation {
        Operation {
            request_key: key.into(),
            attempt: 2,
            at: SimTime(at),
            actor: "a".into(),
            sequence: 1,
            intent: Intent::Delete { key: "r".into() },
        }
    }

    #[test]
    fn ring_stays_bounded_and_answers_or_refuses() {
        let p = ReceiptParams {
            window_ms: 1_000,
            max_entries: 2,
        };
        let r = Ring::default()
            .after("a", 10, &p)
            .after("b", 20, &p)
            .after("c", 30, &p);
        assert_eq!(r.entries.len(), 2, "max_entries bounds the ring");
        assert_eq!(r.horizon_ms, 10);
        assert_eq!(
            answer(Some(&r), &op("c", 30), 30, &p).unwrap(),
            Answer::Duplicate
        );
        assert!(
            answer(Some(&r), &op("a", 5), 30, &p).is_err(),
            "left the ring"
        );
        assert_eq!(
            answer(Some(&r), &op("z", 31), 31, &p).unwrap(),
            Answer::Apply
        );
        assert_eq!(answer(None, &op("z", 31), 31, &p).unwrap(), Answer::Apply);
        let late = r.after("d", 5_000, &p);
        assert_eq!(late.entries.len(), 1, "window expiry");
        assert_eq!(late.horizon_ms, 30);
        assert!(
            answer(Some(&late), &op("q", 10), 5_000, &p).is_err(),
            "older than window"
        );
        let text = late.text().unwrap();
        assert_eq!(Ring::parse(Some(&text)).unwrap(), late);
    }
}
