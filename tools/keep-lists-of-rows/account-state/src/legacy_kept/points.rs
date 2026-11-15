//! Several exact kept keys in one admitted snapshot. Candidate run order,
//! tombstones, packed-page decoding and multipart values remain the original
//! point semantics; only indexed boundary key/page transport is grouped.

use super::{batch, order, Entry, LegacyKept, Meter, PointBudget, Work};
use crate::{
    kept_runs::{self, PackedText, Settings},
    record_source::BoundedRecordSql,
};
use rusqlite::types::Value;
use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashSet},
    time::Instant,
};
use zeroize::Zeroize;

pub struct PointsRead {
    pub entries: Vec<Entry>,
    pub work: Work,
}
impl Drop for PointsRead {
    fn drop(&mut self) {
        for entry in &mut self.entries {
            if let Entry::Json(value) = entry {
                value.zeroize();
            }
        }
    }
}

impl LegacyKept {
    /// Exact ordered answers for up to 256 caller-selected keys. No range of
    /// unrelated keys is scanned and no body is fetched for an unselected page.
    pub fn points_with_budget<S: BoundedRecordSql + ?Sized>(
        &self,
        original: &mut S,
        keys: &[String],
        budget: PointBudget,
    ) -> super::Result<PointsRead> {
        let started = Instant::now();
        let mut limits = self.limits.clone();
        limits.statements = limits.statements.min(budget.statements);
        limits.rows = limits.rows.min(budget.rows);
        limits.source_bytes = limits.source_bytes.min(budget.source_bytes);
        let mut meter = Meter {
            limits: &limits,
            work: Work {
                source_timing_complete: true,
                ..Work::default()
            },
            start: started,
            deadline: budget.deadline.min(started + limits.elapsed),
        };
        if keys.len() > 256
            || keys.iter().any(|key| key.len() > self.limits.key_bytes)
            || keys.iter().map(String::len).sum::<usize>() > 1024 * 1024
        {
            return Err(meter.error("original kept batch keys exceed bound"));
        }
        if keys.is_empty() {
            return Ok(PointsRead {
                entries: Vec::new(),
                work: meter.snapshot_work(),
            });
        }
        let columns = meter.query(original, "PRAGMA table_info(record_keys_runs)", &[])?;
        if columns.rows.len() > 64 {
            return Err(meter.error("original kept catalogue column bound exceeded"));
        }
        let mut names = HashSet::new();
        for row in &columns.rows {
            if row.len() < 2 {
                return Err(meter.error("original kept catalogue schema invalid"));
            }
            names.insert(meter.text(&row[1])?.to_owned());
        }
        if ["run", "age", "pages", "last"]
            .iter()
            .any(|name| !names.contains(*name))
        {
            return Err(meter.error("original kept catalogue schema unsupported"));
        }
        let format = if names.contains("page_format") {
            "COALESCE(page_format,0)"
        } else {
            "0"
        };
        let layout = if names.contains("page_layout") {
            "COALESCE(page_layout,0)"
        } else {
            "0"
        };
        let has_filter = names.contains("filter_bits");
        let filter = if has_filter {
            ",CASE WHEN typeof(catalogue.filter_bits)='integer' THEN catalogue.filter_bits ELSE 0 END AS filter_bits"
        } else {
            ""
        };
        let mut answers: Vec<Option<Entry>> =
            std::iter::repeat_with(|| None).take(keys.len()).collect();
        let mut after = None;
        loop {
            meter.check()?;
            if answers.iter().all(Option::is_some) {
                break;
            }
            let window = 64usize.min(self.limits.runs.saturating_add(1)).min(
                meter
                    .limits
                    .rows
                    .saturating_sub(meter.work.rows_returned as usize),
            );
            if window == 0 {
                return Err(meter.budget_error("original kept batch row budget exhausted"));
            }
            let predicate = if after.is_some() {
                " WHERE catalogue.age<? OR (catalogue.age=? AND catalogue.run<?)"
            } else {
                ""
            };
            let sql = format!("SELECT catalogue.run AS run,CASE WHEN typeof(catalogue.age)='integer' THEN catalogue.age END AS age,CASE WHEN typeof(catalogue.pages)='integer' THEN catalogue.pages END AS pages,CASE WHEN length(CAST(catalogue.last AS BLOB))<=? THEN catalogue.last END AS last,CASE WHEN typeof({format})='integer' THEN {format} END AS page_format,CASE WHEN typeof({layout})='integer' THEN {layout} END AS page_layout{filter} FROM record_keys_runs AS catalogue{predicate} ORDER BY catalogue.age DESC,catalogue.run DESC LIMIT ?");
            let mut params = vec![Value::Integer((self.limits.key_bytes * 6 + 2) as i64)];
            if let Some((age, run)) = after {
                params.extend([
                    Value::Integer(age),
                    Value::Integer(age),
                    Value::Integer(run),
                ]);
            }
            params.push(Value::Integer(window as i64));
            let rows = meter.query(original, &sql, &params)?;
            for row in &rows.rows {
                if meter.work.runs_examined >= self.limits.runs as u64 {
                    return Err(meter.budget_error("original kept candidate-run budget exhausted"));
                }
                meter.work.runs_examined += 1;
                if row.len() != if has_filter { 7 } else { 6 } {
                    return Err(meter.error("original kept catalogue row invalid"));
                }
                let run = meter.integer(&row[0])?;
                let age = meter.integer(&row[1])?;
                let pages = meter.integer(&row[2])?;
                if run < 0 || age < 0 || pages < 0 || pages as usize > self.limits.pages_per_run {
                    return Err(meter.error("original kept run geometry invalid"));
                }
                after = Some((age, run));
                if pages == 0 {
                    continue;
                }
                let last = meter.key(&row[3])?;
                let mut candidates = keys
                    .iter()
                    .enumerate()
                    .filter(|(at, key)| {
                        answers[*at].is_none() && order(key, &last) != Ordering::Greater
                    })
                    .map(|(at, _)| at)
                    .collect::<Vec<_>>();
                if candidates.is_empty() {
                    continue;
                }
                if meter.integer(&row[4])? != 0 {
                    return Err(meter
                        .error("original sparse or unknown kept page format requires an adapter"));
                }
                if ![0, 1, 2].contains(&meter.integer(&row[5])?) {
                    return Err(meter.error("original kept page layout unsupported"));
                }
                // A requested catalogue-last key requires this run's sole
                // page regardless of the negative filter. The same page/boundary key
                // decoder validates it below, so a filter query cannot remove
                // any source page work in this case.
                let sole_page_required = pages == 1
                    && candidates.iter().any(|at| keys[*at] == last);
                if has_filter && !sole_page_required {
                    let absent = proven_filter_absences(
                        original, run, meter.integer(&row[6])?, keys, &candidates, &mut meter,
                    )?;
                    candidates.retain(|at| !absent.contains(at));
                    if candidates.is_empty() {
                        continue;
                    }
                }
                let wanted = candidates
                    .iter()
                    .map(|at| keys[*at].clone())
                    .collect::<Vec<_>>();
                let remaining_rows = meter.limits.rows.saturating_sub(meter.work.rows_returned as usize);
                let supplier = original.read_limits().ok_or_else(|| meter.error("original kept batch supplier ceilings unavailable"))?;
                let remaining_bytes = meter.limits.source_bytes.saturating_sub(meter.work.source_bytes as usize);
                let small_scan = pages <= batch::SMALL_RUN_BOUNDARY_KEY_PAGES
                    && remaining_bytes > 0 && supplier.result_bytes > 0
                    && usize::try_from(pages).is_ok_and(|count| {
                        count <= remaining_rows.min(supplier.rows)
                            && count <= wanted.len().saturating_mul(pages.ilog2() as usize + 1)
                    });
                let found = if small_scan {
                    batch::seek_small_run(original, run, pages, &wanted, &mut meter)?
                } else {
                    let mut found = Vec::with_capacity(wanted.len());
                    for chunk in wanted.chunks(255) {
                        found.extend(batch::seek_pages(original, run, pages, chunk, &mut meter)?);
                    }
                    found
                };
                if found.len() != wanted.len() {
                    return Err(meter.error("original kept batch page seek incomplete"));
                }
                let mut by_page = BTreeMap::<i64, Vec<usize>>::new();
                for (at, page) in candidates.into_iter().zip(found) {
                    if let Some(page) = page {
                        by_page.entry(page).or_default().push(at);
                    }
                }
                let selected = by_page.into_iter().collect::<Vec<_>>();
                let mut first = 0;
                while first < selected.len() {
                    let mut end = first + 1;
                    while end < selected.len()
                        && end - first < 8
                        && selected[end].0 == selected[end - 1].0 + 1
                    {
                        end += 1;
                    }
                    let raw_pages = batch::fetch_pages(
                        original,
                        run,
                        selected[first].0,
                        pages,
                        false,
                        end - first,
                        true,
                        self.limits.page_bytes,
                        &mut meter,
                    )?;
                    meter.work.page_bodies = meter
                        .work
                        .page_bodies
                        .saturating_add(raw_pages.len() as u64);
                    for (raw_page, (number, indices)) in
                        raw_pages.into_iter().zip(&selected[first..end])
                    {
                        if raw_page.page != *number || raw_page.cells.len() != 5 {
                            return Err(meter.error("original kept batch selected page changed"));
                        }
                        let length = meter.integer(&raw_page.cells[2])?;
                        if length < 0 || length as usize > self.limits.page_bytes {
                            return Err(
                                meter.budget_error("original kept selected page exceeds bound")
                            );
                        }
                        let raw = meter.text(&raw_page.cells[3])?;
                        if raw.len() != length as usize {
                            return Err(meter.error("original kept page length mismatch"));
                        }
                        let settings = Settings {
                            page_bytes: self.limits.page_bytes,
                            max_key_bytes: self.limits.key_bytes,
                            max_value_bytes: self.limits.value_bytes,
                            ..Settings::default()
                        };
                        let decode_started = Instant::now();
                        let page = kept_runs::packed_page_text(raw, &settings);
                        let parse_us = decode_started.elapsed().as_micros().min(u64::MAX as u128) as u64;
                        meter.work.page_decode_us = meter.work.page_decode_us.saturating_add(
                            parse_us,
                        );
                        let page = page.map_err(|_| {
                            meter.error("original kept selected page corrupt or unsupported")
                        })?;
                        let mut selected_us = 0u64;
                        for at in indices {
                            let start = Instant::now();
                            let selected = page.find_text(&keys[*at], &settings);
                            let elapsed = start.elapsed().as_micros().min(u64::MAX as u128) as u64;
                            selected_us = selected_us.saturating_add(elapsed);
                            meter.work.page_decode_us = meter.work.page_decode_us.saturating_add(elapsed);
                            let selected = selected.map_err(|_| {
                                meter.error("original kept selected page corrupt or unsupported")
                            })?;
                            meter.check()?;
                            answers[*at] = match selected {
                                PackedText::Absent => None,
                                PackedText::Tombstone => Some(Entry::Tombstone),
                                PackedText::Json(value) => Some(Entry::Json(value)),
                                PackedText::Big { reference, parts } => Some(Entry::Json(
                                    self.multipart(original, &reference, parts, &mut meter)?,
                                )),
                            };
                        }
                        if std::env::var_os("KEPT_PAGE_TIMING").is_some() {
                            crate::quiet_eprintln!("KEPT_PAGE_TIMING parse_us={parse_us} selected_us={selected_us} selected_keys={}", indices.len());
                        }
                    }
                    first = end;
                }
            }
            if rows.rows.len() < window {
                break;
            }
        }
        meter.check()?;
        Ok(PointsRead {
            entries: answers
                .into_iter()
                .map(|answer| answer.unwrap_or(Entry::Absent))
                .collect(),
            work: meter.snapshot_work(),
        })
    }
}

/// A zero bit in a valid canonical filter proves absence. Missing, malformed,
/// or unsupported filter data admits the key. All selected probes for a run
/// share one indexed SQL call, and no filter body crosses the source boundary.
fn proven_filter_absences<S: BoundedRecordSql + ?Sized>(
    original: &mut S,
    run: i64,
    bits: i64,
    keys: &[String],
    candidates: &[usize],
    meter: &mut Meter<'_>,
) -> super::Result<HashSet<usize>> {
    // A large positive filter requires a full base64 validity scan inside
    // SQLite before any zero bit can safely exclude a key. On copied data
    // that scan used the page deadline. Retain the exact page path for it.
    if bits > 32 * 1024 {
        return Ok(HashSet::new());
    }
    // The source allows at most 256 bound parameters and returns every row
    // under its actual row ceiling. A larger batch retains the exact boundary key
    // path rather than spending that ceiling on filter-result rows.
    if candidates.len() > 32 {
        return Ok(HashSet::new());
    }
    let mut probes = Vec::with_capacity(candidates.len().saturating_mul(7));
    for &at in candidates {
        let Some(key_probes) = kept_runs::filter_probes(&keys[at], bits) else {
            return Ok(HashSet::new());
        };
        for (page, byte, mask, bytes) in key_probes {
            probes.push((at, page, byte, mask, bytes));
        }
    }
    if probes.is_empty() {
        return Ok(HashSet::new());
    }
    let values = probes.iter().map(|(at, page, byte, mask, bytes)| {
        format!("({at},{page},{byte},{mask},{bytes})")
    }).collect::<Vec<_>>().join(",");
    if values.len() > 32 * 1024 {
        return Ok(HashSet::new());
    }

    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let digit = |n| format!("(instr('{alphabet}',substr(v.body,(CAST(p.byte/3 AS INTEGER)*4)+{n},1))-1)");
    let (d1, d2, d3, d4) = (digit(1), digit(2), digit(3), digit(4));
    let text_byte = format!("CASE p.byte%3 WHEN 0 THEN {d1}*4+CAST({d2}/16 AS INTEGER) WHEN 1 THEN ({d2}%16)*16+CAST({d3}/4 AS INTEGER) ELSE ({d3}%4)*64+{d4} END");
    let hex_digit = |n| format!("(instr('0123456789ABCDEF',substr(hex(substr(v.body,p.byte+1,1)),{n},1))-1)");
    let blob_byte = format!("({}*16+{})", hex_digit(1), hex_digit(2));
    let valid_text = format!("length(c.body)=CAST((c.bytes+2)/3 AS INTEGER)*4 AND substr(c.body,1,length(c.body)-CASE c.bytes%3 WHEN 0 THEN 0 WHEN 1 THEN 2 ELSE 1 END) NOT GLOB '*[^A-Za-z0-9+/]*' AND CASE c.bytes%3 WHEN 0 THEN 1 WHEN 1 THEN substr(c.body,-2)='==' AND (instr('{alphabet}',substr(c.body,-3,1))-1)%16=0 WHEN 2 THEN substr(c.body,-1)='=' AND (instr('{alphabet}',substr(c.body,-2,1))-1)%4=0 END");
    let sql = format!("WITH requested(key_index,page,byte,mask,bytes) AS MATERIALIZED (VALUES {values}),needed AS MATERIALIZED (SELECT DISTINCT page,bytes FROM requested),chunks AS MATERIALIZED (SELECT n.page,n.bytes,CASE WHEN COUNT(f.page)=1 THEN MAX(f.body) END AS body FROM needed AS n LEFT JOIN record_keys_run_{run} AS f ON f.page=n.page GROUP BY n.page,n.bytes),valid AS MATERIALIZED (SELECT c.page,c.bytes,c.body,CASE WHEN typeof(c.body)='blob' AND length(c.body)=c.bytes THEN 1 WHEN typeof(c.body)='text' AND ({valid_text}) THEN 1 ELSE 0 END AS ok FROM chunks AS c),probed AS (SELECT p.key_index,CASE WHEN v.ok=1 AND ((CASE WHEN typeof(v.body)='blob' THEN {blob_byte} ELSE {text_byte} END)&p.mask)=0 THEN 1 ELSE 0 END AS absent_bit FROM requested AS p JOIN valid AS v ON v.page=p.page AND v.bytes=p.bytes) SELECT key_index FROM probed GROUP BY key_index HAVING MAX(absent_bit)=1");
    let result = meter.query(original, &sql, &[])?;
    let indices = result.rows.iter().map(|row| {
        if row.len() != 1 { return Err(meter.error("original kept filter result invalid")); }
        usize::try_from(meter.integer(&row[0])?)
            .map_err(|_| meter.error("original kept filter result invalid"))
    }).collect::<super::Result<Vec<_>>>()?;
    if indices.iter().any(|at| !candidates.contains(at)) {
        return Err(meter.error("original kept filter result invalid"));
    }
    Ok(indices.into_iter().collect())
}
