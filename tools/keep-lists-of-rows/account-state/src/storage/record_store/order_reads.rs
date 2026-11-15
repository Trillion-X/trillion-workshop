// src/storage/record_store/order_reads.rs
//
// Purpose: The reads of a declared order beyond a plain page: a bounded range of the order (fixed leading values, a
// start, an end, values that start with a text, past an entry), the first entry under each of several leading values
// (the newest record per group), and the entries under several selected values after a fixed prefix, each with its own
// limit; any of them answering the order's carried fields without reading the records.
//
// Ported one to one from old trillion `parts/record-log/do-work/record-log-store.mjs` (tag
// old-trillion-before-worker-retire): `scan` :2733 (`equal`, `from`, `to`, `after`, `before`, `startsWith`, `reverse`,
// `limit`, `carried`), `scanFirstValues` :2797, `scanSelectedValues` :2822, `newestPerGroup` :3051, `idsWhere` :3058.
// The old keys were `value SEP value SEP id` texts; an order row here holds one value: the ECMA JSON text, as UTF-16BE
// code units, of the field, or of `[field, then...]` for an order with `then` (`orders.rs`). So a fixed leading value is a
// prefix of that array text (`[` and each value followed by `,`), and a bound on the next value is that prefix followed
// by the bound's own JSON text and the separator after it (`,` when more fields follow, `]` after the last). The order
// of entries is the same as the old keys': JSON text compared by code unit, then the id.
// Dropped, and why: the old reads' budgets of pages and entries (`selected_scan_budget`) bounded kept-runs page reads;
// here each selected value is one bounded range scan, at most `MAX_PAGE_ITEMS` entries each. `idFrom`/`idTo` (an id range
// under a fully fixed value) are `after` with the record id, which the cursor already is.
//
// Non-Negotiable Invariants:
// - An order is answered only once it is filled under its current declaration (`order_filled`), as `ordered_page`.
// - Every read is bounded: at most `MAX_PAGE_ITEMS` entries per range, and a page of records within `MAX_PAGE_BYTES`.
// - Carried fields come from the order's own carry rows, written in the same write as the order row (`index_derived`),
//   so a carried answer is the record's current value.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{orders, text, unavailable, validate, Bound, Field, OrderCursor, Order, Range, RecordStore, Storage, Value, ORDERED, ORDER_CARRY};
use crate::records::{Error, MAX_PAGE_ITEMS};

/// A bounded range of one declared order (old `scan` options).
#[derive(Clone, Debug, Default)]
pub struct OrderScan {
    /// The leading values held fixed (an order with `then` has one per field; all of them fix the whole value).
    pub equal: Vec<serde_json::Value>,
    /// The next value starts at this one (included).
    pub from: Option<serde_json::Value>,
    /// The next value ends at this one (included).
    pub to: Option<serde_json::Value>,
    /// The next value ends before this one (excluded).
    pub before: Option<serde_json::Value>,
    /// The next value is text that starts with this.
    pub starts_with: Option<String>,
    /// Continue past this entry (the last one a page answered).
    pub after: Option<OrderCursor>,
    pub reverse: bool,
    pub limit: usize,
    /// Answer each entry's carried fields from the order's carry rows.
    pub carried: bool,
}

/// One entry of an order: its record id, its order values (the field, or the array of fields), the cursor that
/// continues past it, and its carried fields when asked.
#[derive(Clone, Debug, PartialEq)]
pub struct OrderEntry {
    pub id: String,
    pub values: serde_json::Value,
    pub cursor: OrderCursor,
    pub carried: Option<serde_json::Value>,
}

/// The next code unit after `bytes` as a prefix: every value that starts with `bytes` sorts below it.
fn after_prefix(bytes: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    let n = out.len();
    let unit = u16::from_be_bytes([out[n - 2], out[n - 1]]).saturating_add(1);
    out[n - 2..].copy_from_slice(&unit.to_be_bytes());
    out
}

impl<S: Storage> RecordStore<S> {
    fn declared(&self, order: &str) -> Result<&'static orders::Declared, Error> {
        let settings = self.settings;
        settings.orders.iter().find(|declared| declared.order == order).ok_or(Error::Invalid("the order is not declared", crate::cause!()))
    }

    /// The value bounds of a scan over `declared`, as blobs of the order row's value (lower, upper).
    fn scan_bounds(declared: &orders::Declared, scan: &OrderScan) -> Result<(Option<(Vec<u8>, bool)>, Option<(Vec<u8>, bool)>), Error> {
        let fields = 1 + declared.then.len();
        if scan.equal.len() > fields {
            return Err(Error::Invalid("an order scan fixes at most every field of its order", crate::cause!()));
        }
        let bounded = scan.from.is_some() || scan.to.is_some() || scan.before.is_some() || scan.starts_with.is_some();
        if bounded && scan.equal.len() == fields {
            return Err(Error::Invalid("an order scan has no field after its fixed values to bound", crate::cause!()));
        }
        let json = |value: &serde_json::Value| orders::field_value(value);
        if fields == 1 {
            if let Some(value) = scan.equal.first() {
                let exact = json(value)?;
                return Ok((Some((exact.clone(), true)), Some((exact, true))));
            }
            let lower = match (&scan.from, &scan.starts_with) {
                (_, Some(prefix)) => Some((orders::units(&format!("\"{}", serde_json::to_string(prefix).map_err(|_| Error::Invalid("invalid prefix", crate::cause!()))?.trim_matches('"'))), true)),
                (Some(from), None) => Some((json(from)?, true)),
                (None, None) => None,
            };
            let upper = match (&scan.to, &scan.before, &scan.starts_with) {
                (_, _, Some(_)) => lower.as_ref().map(|(lower, _)| (after_prefix(lower), false)),
                (_, Some(before), None) => Some((json(before)?, false)),
                (Some(to), None, None) => Some((json(to)?, true)),
                (None, None, None) => None,
            };
            return Ok((lower, upper));
        }
        // An order with `then`: its value is the array text `[v1,v2,...]`.
        let mut base = orders::units("[");
        for value in &scan.equal {
            base.extend(json(value)?);
            base.extend(orders::units(","));
        }
        if scan.equal.len() == fields {
            // Every field fixed: the exact array text (the last `,` is its closing `]`).
            base.truncate(base.len() - 2);
            base.extend(orders::units("]"));
            return Ok((Some((base.clone(), true)), Some((base, true))));
        }
        let sep = orders::units(if scan.equal.len() + 1 == fields { "]" } else { "," });
        let at = |value: &serde_json::Value| -> Result<Vec<u8>, Error> { Ok([base.clone(), json(value)?, sep.clone()].concat()) };
        let lower = match (&scan.from, &scan.starts_with) {
            (_, Some(prefix)) => {
                let quoted = serde_json::to_string(prefix).map_err(|_| Error::Invalid("invalid prefix", crate::cause!()))?;
                Some(([base.clone(), orders::units(&quoted[..quoted.len() - 1])].concat(), true))
            }
            (Some(from), None) => Some((at(from)?, true)),
            (None, None) => Some((base.clone(), true)),
        };
        let upper = match (&scan.to, &scan.before, &scan.starts_with) {
            (_, _, Some(_)) => lower.as_ref().map(|(lower, _)| (after_prefix(lower), false)),
            (_, Some(before), None) => Some((at(before)?, false)),
            (Some(to), None, None) => Some((after_prefix(&at(to)?), false)),
            (None, None, None) => (!scan.equal.is_empty()).then(|| (after_prefix(&base[..base.len() - 2]), false)),
        };
        Ok((lower, upper))
    }

    /// A bounded range of one declared order (old `scan`): entries in (value, id) order, highest first when `reverse`.
    pub fn ordered_scan(&self, account: &str, resource: &str, order: &str, scan: &OrderScan) -> Result<Vec<OrderEntry>, Error> {
        validate(account, resource, order)?;
        let declared = self.declared(order)?;
        if !(1..=MAX_PAGE_ITEMS).contains(&scan.limit) {
            return Err(Error::Invalid("invalid page size", crate::cause!()));
        }
        if !self.order_filled(account, resource, order)? {
            return Err(Error::Invalid("the order is not filled for this scope yet (fill_order)", crate::cause!()));
        }
        let (lower, upper) = Self::scan_bounds(declared, scan)?;
        let scope = vec![text(account), text(resource), text(order)];
        let with = |blob: Vec<u8>| [scope.as_slice(), &[Value::Blob(blob)]].concat();
        let mut low = match lower {
            Some((blob, true)) => Bound::Included(with(blob)),
            Some((blob, false)) => Bound::Excluded(with(blob)),
            None => Bound::Included(scope.clone()),
        };
        let mut high = match upper {
            Some((blob, true)) => Bound::Included(with(blob)),
            Some((blob, false)) => Bound::Excluded(with(blob)),
            None => Bound::Included(scope.clone()),
        };
        if let Some(cursor) = &scan.after {
            let past = Bound::Excluded([scope.as_slice(), &[Value::Blob(cursor.value.clone()), text(&cursor.id)]].concat());
            if scan.reverse {
                high = past;
            } else {
                low = past;
            }
        }
        let (from, to) = if scan.reverse { (high, low) } else { (low, high) };
        let range = Range { order: Order::Key, from, to, reverse: scan.reverse, limit: Some(scan.limit) };
        let rows = self.scan_rows(ORDERED, &range, &[Field::whole("value"), Field::whole("id")]).map_err(unavailable)?;
        let mut entries = Vec::with_capacity(rows.len());
        for mut row in rows {
            let (Value::Blob(value), Value::Text(id)) = (row.take(0), row.take(1)) else { return Err(crate::cause!(Error::Unavailable)) };
            let values = orders::decode(&value).ok_or(crate::cause!(Error::Unavailable))?;
            let carried = if scan.carried && !declared.carry.is_empty() {
                let key = [scope.as_slice(), &[Value::Blob(value.clone()), text(&id)]].concat();
                let row = self.storage.get(ORDER_CARRY, &key, &[Field::whole("carried")]).map_err(unavailable)?;
                self.count(1, usize::from(row.is_some()));
                match row.map(|mut row| row.take(0)) {
                    Some(Value::Blob(body)) => Some(serde_json::from_slice(&body).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?),
                    _ => None,
                }
            } else {
                None
            };
            entries.push(OrderEntry { id: id.clone(), values, cursor: OrderCursor { value, id }, carried });
        }
        Ok(entries)
    }

    /// The first entry under each distinct leading value (old `scanFirstValues`), in the order asked; a value with no
    /// entry answers nothing. `reverse` takes each value's last entry instead: the newest per group when the order is
    /// `[group, time]` (old `newestPerGroup`).
    pub fn ordered_first_per_value(&self, account: &str, resource: &str, order: &str, values: &[serde_json::Value], reverse: bool) -> Result<Vec<OrderEntry>, Error> {
        if values.len() > MAX_PAGE_ITEMS {
            return Err(Error::Invalid("too many values", crate::cause!()));
        }
        let mut seen: Vec<&serde_json::Value> = Vec::new();
        let mut out = Vec::new();
        for value in values {
            if seen.contains(&value) {
                continue;
            }
            seen.push(value);
            let scan = OrderScan { equal: vec![value.clone()], reverse, limit: 1, ..OrderScan::default() };
            out.extend(self.ordered_scan(account, resource, order, &scan)?);
        }
        Ok(out)
    }

    /// Entries under each distinct selected value after the fixed `scan.equal` prefix, at most `scan.limit` each, the
    /// scan's bounds applying to the field after the selected one (old `scanSelectedValues`). The answer is in the
    /// order's own order (reversed when `scan.reverse`), as one scan of the union would give it.
    pub fn ordered_selected(&self, account: &str, resource: &str, order: &str, scan: &OrderScan, values: &[serde_json::Value]) -> Result<Vec<OrderEntry>, Error> {
        if values.len() > MAX_PAGE_ITEMS {
            return Err(Error::Invalid("too many values", crate::cause!()));
        }
        let mut seen: Vec<&serde_json::Value> = Vec::new();
        let mut out = Vec::new();
        for value in values {
            if seen.contains(&value) {
                continue;
            }
            seen.push(value);
            let mut one = scan.clone();
            one.equal.push(value.clone());
            out.extend(self.ordered_scan(account, resource, order, &one)?);
        }
        out.sort_by(|a, b| (&a.cursor.value, &a.cursor.id).cmp(&(&b.cursor.value, &b.cursor.id)));
        if scan.reverse {
            out.reverse();
        }
        Ok(out)
    }

    /// The ids of the records whose field holds exactly `value` (old `idsWhere`), along a one-field order on it.
    pub fn ids_where(&self, account: &str, resource: &str, order: &str, value: &serde_json::Value, limit: usize) -> Result<Vec<String>, Error> {
        let scan = OrderScan { equal: vec![value.clone()], limit, ..OrderScan::default() };
        Ok(self.ordered_scan(account, resource, order, &scan)?.into_iter().map(|entry| entry.id).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::after_prefix;
    #[test]
    fn a_prefix_upper_bound_is_past_every_value_that_starts_with_it() {
        let a = crate::storage::record_store::orders::units("[\"r1\",");
        let up = after_prefix(&a);
        assert!(up > a && up > crate::storage::record_store::orders::units("[\"r1\",\"zzz\"]") && up == crate::storage::record_store::orders::units("[\"r1\"-"));
    }
}
