// crates/workflow-core/src/executor/value_to_bytes.rs
//
// Purpose:
//   Encode data-declared value-to-bytes layouts for workflow write payloads.
//   Workflow remains a blind writer: this module knows rows, columns, paths,
//   predicates, and byte layouts, never product packages or UI vocabulary.
//
// Non-Negotiable Invariants:
//   1. The write step owns only byte production for its own PendingWrite.
//   2. Layout selection is data-declared via `value_to_bytes`.
//   3. No product labels, component names, app fields, or domain package
//      concepts may appear in this module.
//   4. Encoded bytes must match the canonical RTBL record-table format exactly.
//
// Key Concepts:
//   - `value_to_bytes`: Byte layout contract for the payload to be written.
//   - `rows`: Input JSON rows, either already decoded or byte-backed for
//     streaming from retained step response bytes.
//   - `columns`: Numeric cell projections from each row/group into RTBL cells.
//   - `group_by`: Optional row grouping before column extraction.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::sync::Arc;

use serde::de::{
    DeserializeSeed, Deserializer, Error as DeError, IgnoredAny, MapAccess, SeqAccess, Visitor,
};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::domain::errors::WorkflowError;
use crate::domain::types::ExecutionContext;

const HEADER_BYTE_LENGTH: usize = 16;
const CELL_INDEX_BYTE_LENGTH: usize = 8;
/// The most columns one cell table holds. Every row carries an index entry for every column up to the highest index
/// declared, so a single sparse index (column 4,000,000,000) would otherwise size the table, and the loops over it, by
/// that index rather than by what was declared.
const MOST_CELL_TABLE_COLUMNS: u32 = 4096;
const NULL_CELL_LENGTH: u32 = 0xffff_ffff;

#[derive(Debug)]
struct ColumnSpec {
    column: u32,
    source_path: Vec<String>,
    source_parse: Option<ParseSpec>,
    value_to_bytes: String,
    predicates: Vec<RowPredicate>,
}

#[derive(Debug)]
struct ParseSpec {
    format: String,
    after_parse_path: Vec<String>,
}

#[derive(Debug)]
struct RowPredicate {
    path: Vec<String>,
    comparison: PredicateComparison,
}

#[derive(Debug)]
enum PredicateComparison {
    Equals(PredicateKey),
    In(BTreeSet<PredicateKey>),
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
enum PredicateKey {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Compound(String),
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
enum JsonKey {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Compound(String),
}

pub(super) fn encode_declared_value_to_bytes(
    step_id: &str,
    payload: &Map<String, Value>,
    exec_ctx: &ExecutionContext,
) -> Result<Vec<u8>, WorkflowError> {
    if payload.contains_key("source_bytes") {
        return Err(value_to_bytes_error(
            step_id,
            "payload_bytes.source_bytes is obsolete",
            "Use payload_bytes.value_to_bytes to declare the value-to-bytes writer.",
        ));
    }

    let value_to_bytes = payload
        .get("value_to_bytes")
        .and_then(Value::as_str)
        .ok_or_else(|| value_to_bytes_error(
            step_id,
            "payload_bytes.value_to_bytes must be a string",
            "Declare payload_bytes.value_to_bytes so workflow can encode the requested byte layout.",
        ))?;

    match value_to_bytes {
        "cell_table" => encode_cell_table_value_to_bytes(step_id, payload, exec_ctx),
        other => Err(value_to_bytes_error(
            step_id,
            format!("payload_bytes.value_to_bytes '{other}' is not supported"),
            "Use a value-to-bytes writer implemented by workflow.",
        )),
    }
}

fn encode_cell_table_value_to_bytes(
    step_id: &str,
    payload: &Map<String, Value>,
    exec_ctx: &ExecutionContext,
) -> Result<Vec<u8>, WorkflowError> {
    let columns = read_columns(step_id, payload.get("columns"))?;
    let column_count = match columns.last_key_value() {
        Some((column, _)) => column.checked_add(1).ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table column count exceeds u32",
                "Use column indexes that fit in u32.",
            )
        })?,
        None => 0,
    };

    let Some(rows_value) = payload.get("rows") else {
        return Err(value_to_bytes_error(
            step_id,
            "cell_table payload_bytes.rows is required",
            "Provide rows as an array or as a declared byte-backed JSON row source.",
        ));
    };

    let group_by_path = read_group_by_path(step_id, payload.get("group_by"))?;

    if let Some(rows) = rows_value.as_array() {
        let grouped_rows = read_grouped_rows(step_id, group_by_path.as_deref(), rows)?;
        return encode_grouped_rows_cell_table(step_id, &grouped_rows, &columns, column_count);
    }

    let json_rows = read_json_rows_source(step_id, rows_value, exec_ctx)?;
    if let Some(group_by_path) = group_by_path {
        return encode_grouped_json_byte_rows_cell_table(
            step_id,
            &json_rows,
            &group_by_path,
            &columns,
            column_count,
        );
    }

    encode_json_byte_rows_cell_table(step_id, &json_rows, &columns, column_count)
}

fn encode_grouped_rows_cell_table(
    step_id: &str,
    grouped_rows: &[Vec<&Value>],
    columns: &BTreeMap<u32, ColumnSpec>,
    column_count: u32,
) -> Result<Vec<u8>, WorkflowError> {
    let output_row_count = u32::try_from(grouped_rows.len()).map_err(|_| {
        value_to_bytes_error(
            step_id,
            "cell_table row count exceeds u32",
            "Publish fewer rows per write or partition the feed.",
        )
    })?;
    let cell_count = grouped_rows
        .len()
        .checked_mul(column_count as usize)
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table cell count exceeds usize",
                "Reduce row or column count for this write.",
            )
        })?;
    let mut payload_len = 0usize;

    // Measure first, then write directly into the final RTBL buffer. This keeps
    // grouped rows from retaining one heap allocation per non-empty cell.
    for group in grouped_rows {
        for column_index in 0..column_count {
            if let Some(column) = columns.get(&column_index) {
                with_group_cell(step_id, group, column, |cell| {
                    add_cell_payload_len(step_id, &mut payload_len, cell)
                })?;
            }
        }
    }

    let index_len = cell_count
        .checked_mul(CELL_INDEX_BYTE_LENGTH)
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table index length exceeds usize",
                "Reduce row or column count for this write.",
            )
        })?;
    let total_len = HEADER_BYTE_LENGTH
        .checked_add(index_len)
        .and_then(|length| length.checked_add(payload_len))
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table byte length exceeds usize",
                "Reduce emitted payload size for this write.",
            )
        })?;

    let mut bytes = vec![0u8; total_len];
    bytes[0..4].copy_from_slice(b"RTBL");
    write_u32_le(&mut bytes, 8, output_row_count);
    write_u32_le(&mut bytes, 12, column_count);

    let payload_offset = HEADER_BYTE_LENGTH + index_len;
    let mut payload_cursor = 0usize;
    for (row_index, group) in grouped_rows.iter().enumerate() {
        for column_index in 0..column_count {
            let flat_index = row_index
                .checked_mul(column_count as usize)
                .and_then(|base| base.checked_add(column_index as usize))
                .ok_or_else(|| {
                    value_to_bytes_error(
                        step_id,
                        "cell_table cell index exceeds usize",
                        "Reduce row or column count for this write.",
                    )
                })?;
            let index_offset = HEADER_BYTE_LENGTH + flat_index * CELL_INDEX_BYTE_LENGTH;
            match columns.get(&column_index) {
                Some(column) => with_group_cell(step_id, group, column, |cell| {
                    write_cell_to_table(
                        step_id,
                        &mut bytes,
                        index_offset,
                        payload_offset,
                        &mut payload_cursor,
                        cell,
                    )
                })?,
                None => write_null_cell(&mut bytes, index_offset),
            }
        }
    }

    Ok(bytes)
}

fn write_cell_to_table(
    step_id: &str,
    table: &mut [u8],
    index_offset: usize,
    payload_offset: usize,
    payload_cursor: &mut usize,
    cell: Option<CellBytes<'_>>,
) -> Result<(), WorkflowError> {
    let Some(cell) = cell else {
        write_null_cell(table, index_offset);
        return Ok(());
    };
    let start = u32::try_from(*payload_cursor).map_err(|_| {
        value_to_bytes_error(
            step_id,
            "cell_table payload offset exceeds u32",
            "Reduce emitted payload size for this write.",
        )
    })?;
    let len = u32::try_from(cell.len()).map_err(|_| {
        value_to_bytes_error(
            step_id,
            "cell_table cell byte length exceeds u32",
            "Reduce emitted cell size for this write.",
        )
    })?;
    write_u32_le(table, index_offset, start);
    write_u32_le(table, index_offset + 4, len);
    let target = payload_offset + *payload_cursor;
    cell.copy_to(&mut table[target..target + cell.len()]);
    *payload_cursor += cell.len();
    Ok(())
}

fn write_null_cell(table: &mut [u8], index_offset: usize) {
    write_u32_le(table, index_offset, 0);
    write_u32_le(table, index_offset + 4, NULL_CELL_LENGTH);
}

fn add_cell_payload_len(
    step_id: &str,
    payload_len: &mut usize,
    cell: Option<CellBytes<'_>>,
) -> Result<(), WorkflowError> {
    if let Some(cell) = cell {
        *payload_len = payload_len.checked_add(cell.len()).ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table payload byte length exceeds usize",
                "Reduce the emitted cell payload size for this write.",
            )
        })?;
    }
    Ok(())
}

struct JsonRowsSource {
    bytes: Arc<[u8]>,
    path: Vec<String>,
}

enum ByteBackedRowProjection {
    Full,
    Roots(Vec<String>),
}

struct ByteBackedCellTablePlan<'a> {
    projection: ByteBackedRowProjection,
    group_by: Option<RowValueSelector<'a>>,
    columns: BTreeMap<u32, ProjectedColumnSpec<'a>>,
}

impl<'a> ByteBackedCellTablePlan<'a> {
    fn new(group_by_path: Option<&'a [String]>, columns: &'a BTreeMap<u32, ColumnSpec>) -> Self {
        let projection = ByteBackedRowProjection::from_columns(group_by_path, columns);
        let group_by = group_by_path.map(|path| row_value_selector(&projection, path));
        let columns = columns
            .iter()
            .map(|(column_index, column)| {
                (
                    *column_index,
                    ProjectedColumnSpec {
                        column,
                        source_path: row_value_selector(&projection, &column.source_path),
                        predicates: column
                            .predicates
                            .iter()
                            .map(|predicate| ProjectedRowPredicate {
                                path: row_value_selector(&projection, &predicate.path),
                                comparison: &predicate.comparison,
                            })
                            .collect(),
                    },
                )
            })
            .collect();
        Self {
            projection,
            group_by,
            columns,
        }
    }
}

struct ProjectedColumnSpec<'a> {
    column: &'a ColumnSpec,
    source_path: RowValueSelector<'a>,
    predicates: Vec<ProjectedRowPredicate<'a>>,
}

struct ProjectedRowPredicate<'a> {
    path: RowValueSelector<'a>,
    comparison: &'a PredicateComparison,
}

#[derive(Clone, Copy)]
enum RowValueSelector<'a> {
    Full(&'a [String]),
    Projected {
        root_index: usize,
        rest: &'a [String],
    },
}

impl ByteBackedRowProjection {
    fn from_columns(group_by_path: Option<&[String]>, columns: &BTreeMap<u32, ColumnSpec>) -> Self {
        let mut requires_full_row = false;
        let mut roots = Vec::new();
        if let Some(path) = group_by_path {
            push_projection_path(&mut requires_full_row, &mut roots, path);
        }
        for column in columns.values() {
            push_projection_path(&mut requires_full_row, &mut roots, &column.source_path);
            for predicate in &column.predicates {
                push_projection_path(&mut requires_full_row, &mut roots, &predicate.path);
            }
        }
        if requires_full_row {
            Self::Full
        } else {
            Self::Roots(roots)
        }
    }
}

fn row_value_selector<'a>(
    projection: &ByteBackedRowProjection,
    path: &'a [String],
) -> RowValueSelector<'a> {
    match projection {
        ByteBackedRowProjection::Full => RowValueSelector::Full(path),
        ByteBackedRowProjection::Roots(roots) => {
            let (root, rest) = path
                .split_first()
                .expect("projected row paths must have roots");
            let root_index = roots
                .iter()
                .position(|candidate| candidate == root)
                .expect("projected row path root must be declared by the projection");
            RowValueSelector::Projected { root_index, rest }
        }
    }
}

fn push_projection_path(requires_full_row: &mut bool, roots: &mut Vec<String>, path: &[String]) {
    let Some(root) = path.first() else {
        *requires_full_row = true;
        return;
    };
    if !roots.iter().any(|existing| existing == root) {
        roots.push(root.clone());
    }
}

struct ProjectedJsonRow {
    values: Vec<Option<Value>>,
}

impl ProjectedJsonRow {
    fn new(root_count: usize) -> Self {
        Self {
            values: (0..root_count).map(|_| None).collect(),
        }
    }

    fn insert_value(&mut self, root_index: usize, value: Value) {
        if let Some(slot) = self.values.get_mut(root_index) {
            *slot = Some(value);
        }
    }

    fn value_at<'a>(&'a self, root_index: usize, rest: &[String]) -> Option<&'a Value> {
        let value = self.values.get(root_index)?.as_ref()?;
        json_path(value, rest)
    }
}

#[derive(Clone, Copy)]
enum RowRef<'a> {
    Full(&'a Value),
    Projected(&'a ProjectedJsonRow),
}

impl<'a> RowRef<'a> {
    fn value_at(self, path: &[String]) -> Option<&'a Value> {
        match self {
            Self::Full(row) => json_path(row, path),
            Self::Projected(_) => None,
        }
    }

    fn value_for_selector(self, selector: RowValueSelector<'_>) -> Option<&'a Value> {
        match (self, selector) {
            (Self::Full(row), RowValueSelector::Full(path)) => json_path(row, path),
            (Self::Projected(row), RowValueSelector::Projected { root_index, rest }) => {
                row.value_at(root_index, rest)
            }
            _ => None,
        }
    }
}

fn read_json_rows_source(
    step_id: &str,
    value: &Value,
    exec_ctx: &ExecutionContext,
) -> Result<JsonRowsSource, WorkflowError> {
    let rows = value.as_object().ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            "cell_table payload_bytes.rows must be an array or object",
            "Use an array for already-decoded rows, or an object with source.kind=\"bytes\", source.ref, format=\"json\", and path.",
        )
    })?;
    let format = rows.get("format").and_then(Value::as_str).ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            "cell_table byte-backed rows require format=\"json\"",
            "Declare the byte format explicitly before workflow reads rows from bytes.",
        )
    })?;
    if format != "json" {
        return Err(value_to_bytes_error(
            step_id,
            format!("cell_table byte-backed rows format '{format}' is not supported"),
            "Use format=\"json\" for JSON byte-backed row sources.",
        ));
    }
    let source = rows
        .get("source")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table byte-backed rows require a source object",
                "Use source like {\"kind\":\"bytes\",\"ref\":\"step_id\"}.",
            )
        })?;
    match source.get("kind").and_then(Value::as_str) {
        Some("bytes") => {}
        Some(other) => {
            return Err(value_to_bytes_error(
                step_id,
                format!("cell_table byte-backed rows source.kind '{other}' is not supported"),
                "Use source.kind=\"bytes\" to reference raw bytes already held in the execution context.",
            ));
        }
        None => {
            return Err(value_to_bytes_error(
                step_id,
                "cell_table byte-backed rows source.kind is required",
                "Use source.kind=\"bytes\".",
            ));
        }
    }
    let reference = source.get("ref").and_then(Value::as_str).ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            "cell_table byte-backed rows source.ref is required",
            "Reference a prior step that produced raw bytes.",
        )
    })?;
    let bytes = exec_ctx.raw_step_bytes(reference).cloned().ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            format!("cell_table byte-backed rows source.ref '{reference}' is not available"),
            "Use source.ref with a prior step output whose bytes are still in execution context.",
        )
    })?;
    let path = read_path(
        step_id,
        rows.get("path"),
        "cell_table byte-backed rows path",
    )?;

    Ok(JsonRowsSource { bytes, path })
}

fn encode_json_byte_rows_cell_table(
    step_id: &str,
    source: &JsonRowsSource,
    columns: &BTreeMap<u32, ColumnSpec>,
    column_count: u32,
) -> Result<Vec<u8>, WorkflowError> {
    let plan = ByteBackedCellTablePlan::new(None, columns);
    let mut payload_len = 0usize;
    let mut row_count = 0usize;

    // First pass: measure the final RTBL shape without retaining cell payloads.
    // Byte-backed sources can be large; keeping every cell in memory before
    // allocating the final table doubles peak memory and can trap inside WASM.
    stream_json_rows_for_projection(step_id, source, &plan.projection, |row| {
        row_count = row_count.checked_add(1).ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table row count exceeds usize",
                "Publish fewer rows per write or partition the feed.",
            )
        })?;
        for column in plan.columns.values() {
            with_projected_row_cell(step_id, row, column, |cell| {
                add_cell_payload_len(step_id, &mut payload_len, cell)
            })?;
        }
        Ok(())
    })?;
    let output_row_count = u32::try_from(row_count).map_err(|_| {
        value_to_bytes_error(
            step_id,
            "cell_table row count exceeds u32",
            "Publish fewer rows per write or partition the feed.",
        )
    })?;

    let cell_count = row_count
        .checked_mul(column_count as usize)
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table cell count exceeds usize",
                "Reduce row or column count for this write.",
            )
        })?;
    let index_len = cell_count
        .checked_mul(CELL_INDEX_BYTE_LENGTH)
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table index length exceeds usize",
                "Reduce row or column count for this write.",
            )
        })?;
    let total_len = HEADER_BYTE_LENGTH
        .checked_add(index_len)
        .and_then(|length| length.checked_add(payload_len))
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table byte length exceeds usize",
                "Reduce emitted payload size for this write.",
            )
        })?;

    let mut bytes = vec![0u8; total_len];
    bytes[0..4].copy_from_slice(b"RTBL");
    write_u32_le(&mut bytes, 8, output_row_count);
    write_u32_le(&mut bytes, 12, column_count);

    let payload_offset = HEADER_BYTE_LENGTH + index_len;
    let mut payload_cursor = 0usize;
    let mut row_index = 0usize;

    // Second pass: fill the final table directly. No cell payload survives
    // longer than the current row, while the output bytes remain canonical.
    stream_json_rows_for_projection(step_id, source, &plan.projection, |row| {
        for column_index in 0..column_count {
            let flat_index = row_index
                .checked_mul(column_count as usize)
                .and_then(|base| base.checked_add(column_index as usize))
                .ok_or_else(|| {
                    value_to_bytes_error(
                        step_id,
                        "cell_table cell index exceeds usize",
                        "Reduce row or column count for this write.",
                    )
                })?;
            let index_offset = HEADER_BYTE_LENGTH + flat_index * CELL_INDEX_BYTE_LENGTH;
            match plan.columns.get(&column_index) {
                Some(column) => with_projected_row_cell(step_id, row, column, |cell| {
                    write_cell_to_table(
                        step_id,
                        &mut bytes,
                        index_offset,
                        payload_offset,
                        &mut payload_cursor,
                        cell,
                    )
                })?,
                None => write_null_cell(&mut bytes, index_offset),
            }
        }
        row_index += 1;
        Ok(())
    })?;

    Ok(bytes)
}

struct GroupedByteRowsState {
    selected_columns: ColumnSelectionSet,
    cells: Vec<Option<Vec<u8>>>,
}

impl GroupedByteRowsState {
    fn new(column_count: u32) -> Self {
        Self {
            selected_columns: ColumnSelectionSet::new(column_count),
            cells: (0..column_count).map(|_| None).collect(),
        }
    }

    fn select_cell(
        &mut self,
        column: u32,
        cell: Option<CellBytes<'_>>,
    ) -> Result<Option<usize>, WorkflowError> {
        self.selected_columns.insert(column);
        let Some(cell) = cell else {
            return Ok(None);
        };
        let bytes = cell.into_owned_bytes();
        let byte_len = bytes.len();
        if let Some(slot) = self.cells.get_mut(column as usize) {
            *slot = Some(bytes);
        }
        Ok(Some(byte_len))
    }
}

struct IndexedGroup<T> {
    key: JsonKey,
    value: T,
}

struct IndexedGroups<T> {
    groups: Vec<IndexedGroup<T>>,
    index_by_key: HashMap<JsonKey, usize>,
}

impl<T> IndexedGroups<T> {
    fn new() -> Self {
        Self {
            groups: Vec::new(),
            index_by_key: HashMap::new(),
        }
    }

    fn get_or_insert_with<F>(&mut self, key: JsonKey, make_value: F) -> &mut T
    where
        F: FnOnce() -> T,
    {
        if let Some(index) = self.index_by_key.get(&key).copied() {
            return &mut self.groups[index].value;
        }
        let index = self.groups.len();
        self.index_by_key.insert(key.clone(), index);
        self.groups.push(IndexedGroup {
            key,
            value: make_value(),
        });
        &mut self.groups[index].value
    }

    fn len(&self) -> usize {
        self.groups.len()
    }

    fn sorted_indexes(&self) -> Vec<usize> {
        let mut indexes: Vec<usize> = (0..self.groups.len()).collect();
        indexes.sort_by(|left, right| self.groups[*left].key.cmp(&self.groups[*right].key));
        indexes
    }

    fn into_values_sorted(mut self) -> Vec<T> {
        self.groups.sort_by(|left, right| left.key.cmp(&right.key));
        self.groups.into_iter().map(|group| group.value).collect()
    }
}

struct ColumnSelectionSet {
    words: Vec<u64>,
}

impl ColumnSelectionSet {
    fn new(column_count: u32) -> Self {
        Self {
            words: vec![0; (column_count as usize).div_ceil(u64::BITS as usize)],
        }
    }

    fn contains(&self, column: u32) -> bool {
        let word_index = (column / u64::BITS) as usize;
        let bit = 1u64 << (column % u64::BITS);
        self.words
            .get(word_index)
            .is_some_and(|word| (*word & bit) != 0)
    }

    fn insert(&mut self, column: u32) {
        let word_index = (column / u64::BITS) as usize;
        let bit = 1u64 << (column % u64::BITS);
        if let Some(word) = self.words.get_mut(word_index) {
            *word |= bit;
        }
    }
}

fn encode_grouped_json_byte_rows_cell_table(
    step_id: &str,
    source: &JsonRowsSource,
    group_by_path: &[String],
    columns: &BTreeMap<u32, ColumnSpec>,
    column_count: u32,
) -> Result<Vec<u8>, WorkflowError> {
    let plan = ByteBackedCellTablePlan::new(Some(group_by_path), columns);
    let group_by = plan
        .group_by
        .expect("grouped byte-backed cell table requires a group selector");
    let mut groups = IndexedGroups::<GroupedByteRowsState>::new();
    let mut payload_len = 0usize;

    // One pass: identify one selected row per group/column and retain only the
    // selected cell bytes. This avoids replaying borrowed projected rows through
    // the JSON deserializer while still avoiding materializing the whole row set.
    stream_json_rows_for_projection(step_id, source, &plan.projection, |row| {
        let key = row_ref_group_key_for_selector(step_id, row, group_by)?;
        let group = groups.get_or_insert_with(key, || GroupedByteRowsState::new(column_count));
        for column in plan.columns.values() {
            if group.selected_columns.contains(column.column.column)
                || !projected_predicates_match(row, &column.predicates)
            {
                continue;
            }
            with_projected_row_cell(step_id, row, column, |cell| {
                if let Some(byte_len) = group.select_cell(column.column.column, cell)? {
                    payload_len = payload_len.checked_add(byte_len).ok_or_else(|| {
                        value_to_bytes_error(
                            step_id,
                            "cell_table payload byte length exceeds usize",
                            "Reduce the emitted cell payload size for this write.",
                        )
                    })?;
                }
                Ok(())
            })?;
        }
        Ok(())
    })?;

    let output_row_count = u32::try_from(groups.len()).map_err(|_| {
        value_to_bytes_error(
            step_id,
            "cell_table row count exceeds u32",
            "Publish fewer rows per write or partition the feed.",
        )
    })?;
    let cell_count = groups
        .len()
        .checked_mul(column_count as usize)
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table cell count exceeds usize",
                "Reduce row or column count for this write.",
            )
        })?;
    let index_len = cell_count
        .checked_mul(CELL_INDEX_BYTE_LENGTH)
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table index length exceeds usize",
                "Reduce row or column count for this write.",
            )
        })?;
    let total_len = HEADER_BYTE_LENGTH
        .checked_add(index_len)
        .and_then(|length| length.checked_add(payload_len))
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table byte length exceeds usize",
                "Reduce emitted payload size for this write.",
            )
        })?;

    let mut bytes = vec![0u8; total_len];
    bytes[0..4].copy_from_slice(b"RTBL");
    write_u32_le(&mut bytes, 8, output_row_count);
    write_u32_le(&mut bytes, 12, column_count);

    for flat_index in 0..cell_count {
        write_null_cell(
            &mut bytes,
            HEADER_BYTE_LENGTH + flat_index * CELL_INDEX_BYTE_LENGTH,
        );
    }

    let payload_offset = HEADER_BYTE_LENGTH + index_len;
    let mut payload_cursor = 0usize;

    for (row_index, group_index) in groups.sorted_indexes().into_iter().enumerate() {
        let group = &groups.groups[group_index].value;
        for column_index in 0..column_count {
            let flat_index = row_index
                .checked_mul(column_count as usize)
                .and_then(|base| base.checked_add(column_index as usize))
                .ok_or_else(|| {
                    value_to_bytes_error(
                        step_id,
                        "cell_table cell index exceeds usize",
                        "Reduce row or column count for this write.",
                    )
                })?;
            let index_offset = HEADER_BYTE_LENGTH + flat_index * CELL_INDEX_BYTE_LENGTH;
            let cell = group
                .cells
                .get(column_index as usize)
                .and_then(Option::as_deref)
                .map(CellBytes::Borrowed);
            write_cell_to_table(
                step_id,
                &mut bytes,
                index_offset,
                payload_offset,
                &mut payload_cursor,
                cell,
            )?;
        }
    }

    Ok(bytes)
}

fn stream_json_rows_from_bytes<F>(
    step_id: &str,
    bytes: &[u8],
    path: &[String],
    mut on_row: F,
) -> Result<(), WorkflowError>
where
    F: FnMut(&Value) -> Result<(), WorkflowError>,
{
    fn run<F>(
        step_id: &str,
        bytes: &[u8],
        path: &[String],
        on_row: &mut F,
    ) -> Result<(), WorkflowError>
    where
        F: FnMut(&Value) -> Result<(), WorkflowError>,
    {
        let mut deserializer = serde_json::Deserializer::from_slice(bytes);
        JsonRowsAtPathSeed {
            step_id,
            path,
            on_row,
        }
        .deserialize(&mut deserializer)
        .map_err(|e| {
            value_to_bytes_error(
                step_id,
                format!("cell_table byte-backed rows JSON decode failed: {e}"),
                "Ensure the referenced bytes contain one JSON object with an array at the declared path.",
            )
        })?;
        deserializer.end().map_err(|e| {
            value_to_bytes_error(
                step_id,
                format!("cell_table byte-backed rows JSON trailing bytes: {e}"),
                "Ensure the referenced bytes contain exactly one JSON value.",
            )
        })
    }

    run(step_id, bytes, path, &mut on_row)
}

fn stream_json_rows_for_projection<F>(
    step_id: &str,
    source: &JsonRowsSource,
    projection: &ByteBackedRowProjection,
    mut on_row: F,
) -> Result<(), WorkflowError>
where
    F: for<'row> FnMut(RowRef<'row>) -> Result<(), WorkflowError>,
{
    match projection {
        ByteBackedRowProjection::Full => {
            stream_json_rows_from_bytes(step_id, &source.bytes, &source.path, |row| {
                on_row(RowRef::Full(row))
            })
        }
        ByteBackedRowProjection::Roots(roots) => stream_projected_json_rows_from_bytes(
            step_id,
            &source.bytes,
            &source.path,
            roots,
            |row| on_row(RowRef::Projected(row)),
        ),
    }
}

fn stream_projected_json_rows_from_bytes<F>(
    step_id: &str,
    bytes: &[u8],
    path: &[String],
    roots: &[String],
    mut on_row: F,
) -> Result<(), WorkflowError>
where
    F: FnMut(&ProjectedJsonRow) -> Result<(), WorkflowError>,
{
    fn run<F>(
        step_id: &str,
        bytes: &[u8],
        path: &[String],
        roots: &[String],
        on_row: &mut F,
    ) -> Result<(), WorkflowError>
    where
        F: FnMut(&ProjectedJsonRow) -> Result<(), WorkflowError>,
    {
        let mut deserializer = serde_json::Deserializer::from_slice(bytes);
        ProjectedJsonRowsAtPathSeed {
            step_id,
            path,
            roots,
            on_row,
        }
        .deserialize(&mut deserializer)
        .map_err(|e| {
            value_to_bytes_error(
                step_id,
                format!("cell_table byte-backed rows JSON decode failed: {e}"),
                "Ensure the referenced bytes contain one JSON object with an array at the declared path.",
            )
        })?;
        deserializer.end().map_err(|e| {
            value_to_bytes_error(
                step_id,
                format!("cell_table byte-backed rows JSON trailing bytes: {e}"),
                "Ensure the referenced bytes contain exactly one JSON value.",
            )
        })
    }

    run(step_id, bytes, path, roots, &mut on_row)
}

struct ProjectedJsonRowsAtPathSeed<'a, F> {
    step_id: &'a str,
    path: &'a [String],
    roots: &'a [String],
    on_row: &'a mut F,
}

impl<'de, F> DeserializeSeed<'de> for ProjectedJsonRowsAtPathSeed<'_, F>
where
    F: FnMut(&ProjectedJsonRow) -> Result<(), WorkflowError>,
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<(), D::Error>
    where
        D: Deserializer<'de>,
    {
        if self.path.is_empty() {
            return deserializer.deserialize_seq(ProjectedJsonRowsArrayVisitor {
                step_id: self.step_id,
                roots: self.roots,
                on_row: self.on_row,
            });
        }
        deserializer.deserialize_map(ProjectedJsonRowsPathVisitor {
            step_id: self.step_id,
            path: self.path,
            roots: self.roots,
            on_row: self.on_row,
        })
    }
}

struct ProjectedJsonRowsPathVisitor<'a, F> {
    step_id: &'a str,
    path: &'a [String],
    roots: &'a [String],
    on_row: &'a mut F,
}

impl<'de, F> Visitor<'de> for ProjectedJsonRowsPathVisitor<'_, F>
where
    F: FnMut(&ProjectedJsonRow) -> Result<(), WorkflowError>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON object containing the declared row path")
    }

    fn visit_map<A>(self, mut map: A) -> Result<(), A::Error>
    where
        A: MapAccess<'de>,
    {
        let segment = &self.path[0];
        let rest = &self.path[1..];
        let mut found = false;
        while let Some(key) = map.next_key::<String>()? {
            if key == *segment {
                if found {
                    return Err(A::Error::custom(format!(
                        "cell_table byte-backed rows path segment '{segment}' appeared more than once"
                    )));
                }
                found = true;
                map.next_value_seed(ProjectedJsonRowsAtPathSeed {
                    step_id: self.step_id,
                    path: rest,
                    roots: self.roots,
                    on_row: self.on_row,
                })?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        if found {
            Ok(())
        } else {
            Err(A::Error::custom(format!(
                "cell_table byte-backed rows path segment '{segment}' was not found"
            )))
        }
    }
}

struct ProjectedJsonRowsArrayVisitor<'a, F> {
    step_id: &'a str,
    roots: &'a [String],
    on_row: &'a mut F,
}

impl<'de, F> Visitor<'de> for ProjectedJsonRowsArrayVisitor<'_, F>
where
    F: FnMut(&ProjectedJsonRow) -> Result<(), WorkflowError>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON array of rows")
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<(), A::Error>
    where
        A: SeqAccess<'de>,
    {
        while let Some(row) = seq.next_element_seed(ProjectedJsonRowSeed { roots: self.roots })? {
            (self.on_row)(&row).map_err(|e| {
                A::Error::custom(format!(
                    "cell_table byte-backed row handling failed in {}: {e}",
                    self.step_id
                ))
            })?;
        }
        Ok(())
    }
}

struct ProjectedJsonRowSeed<'a> {
    roots: &'a [String],
}

impl<'de> DeserializeSeed<'de> for ProjectedJsonRowSeed<'_> {
    type Value = ProjectedJsonRow;

    fn deserialize<D>(self, deserializer: D) -> Result<ProjectedJsonRow, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(ProjectedJsonRowVisitor { roots: self.roots })
    }
}

struct ProjectedJsonRowVisitor<'a> {
    roots: &'a [String],
}

impl<'de> Visitor<'de> for ProjectedJsonRowVisitor<'_> {
    type Value = ProjectedJsonRow;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON row object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<ProjectedJsonRow, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut row = ProjectedJsonRow::new(self.roots.len());
        while let Some(key) = map.next_key::<String>()? {
            if let Some(root_index) = projected_root_index(self.roots, &key) {
                let value = map.next_value::<Value>()?;
                row.insert_value(root_index, value);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(row)
    }
}

fn projected_root_index(roots: &[String], key: &str) -> Option<usize> {
    roots.iter().position(|root| root == key)
}

struct JsonRowsAtPathSeed<'a, F> {
    step_id: &'a str,
    path: &'a [String],
    on_row: &'a mut F,
}

impl<'de, F> DeserializeSeed<'de> for JsonRowsAtPathSeed<'_, F>
where
    F: FnMut(&Value) -> Result<(), WorkflowError>,
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<(), D::Error>
    where
        D: Deserializer<'de>,
    {
        if self.path.is_empty() {
            return deserializer.deserialize_seq(JsonRowsArrayVisitor {
                step_id: self.step_id,
                on_row: self.on_row,
            });
        }
        deserializer.deserialize_map(JsonRowsPathVisitor {
            step_id: self.step_id,
            path: self.path,
            on_row: self.on_row,
        })
    }
}

struct JsonRowsPathVisitor<'a, F> {
    step_id: &'a str,
    path: &'a [String],
    on_row: &'a mut F,
}

impl<'de, F> Visitor<'de> for JsonRowsPathVisitor<'_, F>
where
    F: FnMut(&Value) -> Result<(), WorkflowError>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON object containing the declared row path")
    }

    fn visit_map<A>(self, mut map: A) -> Result<(), A::Error>
    where
        A: MapAccess<'de>,
    {
        let segment = &self.path[0];
        let rest = &self.path[1..];
        let mut found = false;
        while let Some(key) = map.next_key::<String>()? {
            if key == *segment {
                if found {
                    return Err(A::Error::custom(format!(
                        "cell_table byte-backed rows path segment '{segment}' appeared more than once"
                    )));
                }
                found = true;
                map.next_value_seed(JsonRowsAtPathSeed {
                    step_id: self.step_id,
                    path: rest,
                    on_row: self.on_row,
                })?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        if found {
            Ok(())
        } else {
            Err(A::Error::custom(format!(
                "cell_table byte-backed rows path segment '{segment}' was not found"
            )))
        }
    }
}

struct JsonRowsArrayVisitor<'a, F> {
    step_id: &'a str,
    on_row: &'a mut F,
}

impl<'de, F> Visitor<'de> for JsonRowsArrayVisitor<'_, F>
where
    F: FnMut(&Value) -> Result<(), WorkflowError>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON array of rows")
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<(), A::Error>
    where
        A: SeqAccess<'de>,
    {
        while let Some(row) = seq.next_element::<Value>()? {
            (self.on_row)(&row).map_err(|e| {
                A::Error::custom(format!(
                    "cell_table byte-backed row handling failed in {}: {e}",
                    self.step_id
                ))
            })?;
        }
        Ok(())
    }
}

fn read_columns(
    step_id: &str,
    value: Option<&Value>,
) -> Result<BTreeMap<u32, ColumnSpec>, WorkflowError> {
    let columns = value.and_then(Value::as_array).ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            "cell_table payload_bytes.columns must be an array",
            "Declare one column object per projected RTBL column.",
        )
    })?;
    let mut output = BTreeMap::new();
    let mut seen = BTreeSet::new();

    for (index, column_value) in columns.iter().enumerate() {
        let column = column_value.as_object().ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                format!("cell_table column at index {index} must be an object"),
                "Each column must declare column, source, and value.value_to_bytes.",
            )
        })?;
        let column_index = column
            .get("column")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| {
                value_to_bytes_error(
                    step_id,
                    format!("cell_table column at index {index} must fit in u32"),
                    "Use a non-negative integer column index within u32 range.",
                )
            })?;
        if column_index >= MOST_CELL_TABLE_COLUMNS {
            return Err(value_to_bytes_error(
                step_id,
                format!("cell_table column {column_index} is past the last column a table holds ({})", MOST_CELL_TABLE_COLUMNS - 1),
                "Number the projected columns from 0, without large gaps.",
            ));
        }
        if !seen.insert(column_index) {
            return Err(value_to_bytes_error(
                step_id,
                format!("cell_table column {column_index} is declared more than once"),
                "Each projected column index must have exactly one source declaration.",
            ));
        }

        let source = column
            .get("source")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                value_to_bytes_error(
                    step_id,
                    format!("cell_table column {column_index} requires a source object"),
                    "Declare source.path so workflow can extract the cell value from each row.",
                )
            })?;
        let source_path = read_path(step_id, source.get("path"), "cell_table column source.path")?;
        let source_parse = read_parse_spec(step_id, source.get("parse"))?;
        let value_to_bytes = read_column_value_to_bytes(step_id, column, column_index)?;
        let predicates = read_predicates(step_id, column.get("match"), column_index)?;

        output.insert(
            column_index,
            ColumnSpec {
                column: column_index,
                source_path,
                source_parse,
                value_to_bytes,
                predicates,
            },
        );
    }

    Ok(output)
}

fn read_column_value_to_bytes(
    step_id: &str,
    column: &Map<String, Value>,
    column_index: u32,
) -> Result<String, WorkflowError> {
    let value = column
        .get("value")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                format!("cell_table column {column_index} requires a value object"),
                "Declare value.value_to_bytes for each projected column.",
            )
        })?;
    if value.contains_key("source_bytes") {
        return Err(value_to_bytes_error(
            step_id,
            format!("cell_table column {column_index} value.source_bytes is obsolete"),
            "Use value.value_to_bytes to declare the cell value-to-bytes writer.",
        ));
    }
    value
        .get("value_to_bytes")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                format!("cell_table column {column_index} requires value.value_to_bytes"),
                "Declare the value-to-bytes writer for each projected column.",
            )
        })
}

fn read_parse_spec(
    step_id: &str,
    value: Option<&Value>,
) -> Result<Option<ParseSpec>, WorkflowError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let parse = value.as_object().ok_or_else(|| {
        value_to_bytes_error(
        step_id,
        "source.parse must be an object",
        "Use source.parse like {\"format\":\"json\"} when a source field contains serialized data.",
    )
    })?;
    let format = parse.get("format").and_then(Value::as_str).ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            "source.parse.format must be a string",
            "Declare the serialized source format explicitly.",
        )
    })?;
    let after_parse_path = match parse.get("after_parse_path") {
        Some(path) => read_path(step_id, Some(path), "source.parse.after_parse_path")?,
        None => Vec::new(),
    };
    Ok(Some(ParseSpec {
        format: format.to_string(),
        after_parse_path,
    }))
}

fn read_predicates(
    step_id: &str,
    value: Option<&Value>,
    column_index: u32,
) -> Result<Vec<RowPredicate>, WorkflowError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let predicates = value.as_array().ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            format!("cell_table column {column_index} match must be an array"),
            "Use match as an array of {path, equals} predicates.",
        )
    })?;
    predicates
        .iter()
        .enumerate()
        .map(|(index, predicate)| {
            let predicate = predicate.as_object().ok_or_else(|| value_to_bytes_error(
                step_id,
                format!("cell_table column {column_index} match predicate {index} must be an object"),
                "Use each predicate as {path:[...], equals:<value>}.",
            ))?;
            let path = read_path(step_id, predicate.get("path"), "match predicate path")?;
            let comparison = match (predicate.get("equals"), predicate.get("in")) {
                (Some(equals), None) => PredicateComparison::Equals(owned_predicate_key(equals)),
                (None, Some(values)) => {
                    let values = values.as_array().ok_or_else(|| {
                        value_to_bytes_error(
                            step_id,
                            format!(
                                "cell_table column {column_index} match predicate {index} in must be an array"
                            ),
                            "Use in as a machine-readable array of accepted values.",
                        )
                    })?;
                    PredicateComparison::In(values.iter().map(owned_predicate_key).collect())
                }
                (None, None) => {
                    return Err(value_to_bytes_error(
                        step_id,
                        format!(
                            "cell_table column {column_index} match predicate {index} requires equals or in"
                        ),
                        "Declare either an exact equals value or an in array for each predicate.",
                    ));
                }
                (Some(_), Some(_)) => {
                    return Err(value_to_bytes_error(
                        step_id,
                        format!(
                            "cell_table column {column_index} match predicate {index} cannot declare both equals and in"
                        ),
                        "Use exactly one comparison operator per predicate.",
                    ));
                }
            };
            Ok(RowPredicate { path, comparison })
        })
        .collect()
}

fn read_grouped_rows<'a>(
    step_id: &str,
    group_by_path: Option<&[String]>,
    rows: &'a [Value],
) -> Result<Vec<Vec<&'a Value>>, WorkflowError> {
    let Some(path) = group_by_path else {
        return Ok(rows.iter().map(|row| vec![row]).collect());
    };
    let mut groups = IndexedGroups::<Vec<&Value>>::new();
    for row in rows {
        let key = row_group_key(step_id, row, path)?;
        groups.get_or_insert_with(key, Vec::new).push(row);
    }
    Ok(groups.into_values_sorted())
}

fn read_group_by_path(
    step_id: &str,
    group_by: Option<&Value>,
) -> Result<Option<Vec<String>>, WorkflowError> {
    let Some(group_by) = group_by else {
        return Ok(None);
    };
    let group_by = group_by.as_object().ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            "cell_table group_by must be an object",
            "Use group_by like {\"path\":[\"stable_key\"]}.",
        )
    })?;
    read_path(step_id, group_by.get("path"), "cell_table group_by.path").map(Some)
}

fn row_group_key(
    step_id: &str,
    row: &Value,
    group_by_path: &[String],
) -> Result<JsonKey, WorkflowError> {
    row_ref_group_key(step_id, RowRef::Full(row), group_by_path)
}

fn row_ref_group_key(
    step_id: &str,
    row: RowRef<'_>,
    group_by_path: &[String],
) -> Result<JsonKey, WorkflowError> {
    row.value_at(group_by_path).map(json_key).ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            "cell_table group_by.path did not resolve for a row",
            "Every grouped source row must contain the group key path.",
        )
    })
}

fn row_ref_group_key_for_selector(
    step_id: &str,
    row: RowRef<'_>,
    group_by_path: RowValueSelector<'_>,
) -> Result<JsonKey, WorkflowError> {
    row.value_for_selector(group_by_path)
        .map(json_key)
        .ok_or_else(|| {
            value_to_bytes_error(
                step_id,
                "cell_table group_by.path did not resolve for a row",
                "Every grouped source row must contain the group key path.",
            )
        })
}

fn with_group_cell<R, F>(
    step_id: &str,
    group: &[&Value],
    column: &ColumnSpec,
    on_cell: F,
) -> Result<R, WorkflowError>
where
    F: for<'cell> FnOnce(Option<CellBytes<'cell>>) -> Result<R, WorkflowError>,
{
    let Some(row) = select_group_row(group, &column.predicates) else {
        return on_cell(None);
    };
    with_row_cell(step_id, row, column, on_cell)
}

fn with_row_cell<R, F>(
    step_id: &str,
    row: &Value,
    column: &ColumnSpec,
    on_cell: F,
) -> Result<R, WorkflowError>
where
    F: for<'cell> FnOnce(Option<CellBytes<'cell>>) -> Result<R, WorkflowError>,
{
    with_row_ref_cell(step_id, RowRef::Full(row), column, on_cell)
}

fn with_row_ref_cell<R, F>(
    step_id: &str,
    row: RowRef<'_>,
    column: &ColumnSpec,
    on_cell: F,
) -> Result<R, WorkflowError>
where
    F: for<'cell> FnOnce(Option<CellBytes<'cell>>) -> Result<R, WorkflowError>,
{
    let value = match row.value_at(&column.source_path) {
        Some(Value::Null) | None => None,
        Some(value) => Some(value),
    };
    if let (Some(value), Some(parse)) = (value, &column.source_parse) {
        return with_parsed_source_value(step_id, value, parse, column.column, |parsed_value| {
            let cell = encode_cell(step_id, Some(parsed_value), &column.value_to_bytes)?;
            on_cell(cell)
        });
    }
    let cell = match value {
        Some(value) => encode_cell(step_id, Some(value), &column.value_to_bytes)?,
        None => None,
    };
    on_cell(cell)
}

fn with_projected_row_cell<R, F>(
    step_id: &str,
    row: RowRef<'_>,
    column: &ProjectedColumnSpec<'_>,
    on_cell: F,
) -> Result<R, WorkflowError>
where
    F: for<'cell> FnOnce(Option<CellBytes<'cell>>) -> Result<R, WorkflowError>,
{
    let value = match row.value_for_selector(column.source_path) {
        Some(Value::Null) | None => None,
        Some(value) => Some(value),
    };
    if let (Some(value), Some(parse)) = (value, &column.column.source_parse) {
        return with_parsed_source_value(
            step_id,
            value,
            parse,
            column.column.column,
            |parsed_value| {
                let cell = encode_cell(step_id, Some(parsed_value), &column.column.value_to_bytes)?;
                on_cell(cell)
            },
        );
    }
    let cell = match value {
        Some(value) => encode_cell(step_id, Some(value), &column.column.value_to_bytes)?,
        None => None,
    };
    on_cell(cell)
}

fn select_group_row<'a>(group: &[&'a Value], predicates: &[RowPredicate]) -> Option<&'a Value> {
    if predicates.is_empty() {
        return group.first().copied();
    }
    group
        .iter()
        .copied()
        .find(|row| predicates_match(row, predicates))
}

fn predicates_match(row: &Value, predicates: &[RowPredicate]) -> bool {
    predicates_match_row_ref(RowRef::Full(row), predicates)
}

fn predicates_match_row_ref(row: RowRef<'_>, predicates: &[RowPredicate]) -> bool {
    predicates.iter().all(|predicate| {
        let Some(value) = row.value_at(&predicate.path) else {
            return false;
        };
        match &predicate.comparison {
            PredicateComparison::Equals(expected) => predicate_key_matches_value(expected, value),
            PredicateComparison::In(values) => values
                .iter()
                .any(|expected| predicate_key_matches_value(expected, value)),
        }
    })
}

fn projected_predicates_match(row: RowRef<'_>, predicates: &[ProjectedRowPredicate<'_>]) -> bool {
    predicates.iter().all(|predicate| {
        let Some(value) = row.value_for_selector(predicate.path) else {
            return false;
        };
        match predicate.comparison {
            PredicateComparison::Equals(expected) => predicate_key_matches_value(expected, value),
            PredicateComparison::In(values) => values
                .iter()
                .any(|expected| predicate_key_matches_value(expected, value)),
        }
    })
}

fn owned_predicate_key(value: &Value) -> PredicateKey {
    match value {
        Value::Null => PredicateKey::Null,
        Value::Bool(value) => PredicateKey::Bool(*value),
        Value::Number(value) => PredicateKey::Number(value.to_string()),
        Value::String(value) => PredicateKey::String(value.clone()),
        Value::Array(_) | Value::Object(_) => PredicateKey::Compound(stable_json_key(value)),
    }
}

fn predicate_key_matches_value(expected: &PredicateKey, value: &Value) -> bool {
    match (expected, value) {
        (PredicateKey::Null, Value::Null) => true,
        (PredicateKey::Bool(expected), Value::Bool(value)) => expected == value,
        (PredicateKey::Number(expected), Value::Number(value)) => expected == &value.to_string(),
        (PredicateKey::String(expected), Value::String(value)) => expected == value,
        (PredicateKey::Compound(expected), Value::Array(_) | Value::Object(_)) => {
            expected == &stable_json_key(value)
        }
        _ => false,
    }
}

fn json_key(value: &Value) -> JsonKey {
    match value {
        Value::Null => JsonKey::Null,
        Value::Bool(value) => JsonKey::Bool(*value),
        Value::Number(value) => JsonKey::Number(value.to_string()),
        Value::String(value) => JsonKey::String(value.clone()),
        Value::Array(_) | Value::Object(_) => JsonKey::Compound(stable_json_key(value)),
    }
}

fn with_parsed_source_value<R, F>(
    step_id: &str,
    value: &Value,
    parse: &ParseSpec,
    column_index: u32,
    on_value: F,
) -> Result<R, WorkflowError>
where
    F: FnOnce(&Value) -> Result<R, WorkflowError>,
{
    let parsed_value;
    let parsed_root = match parse.format.as_str() {
        "json" => match value {
            Value::String(text) => {
                parsed_value = serde_json::from_str(text).map_err(|e| {
                    value_to_bytes_error(
                        step_id,
                        format!("cell_table column {column_index} JSON parse failed: {e}"),
                        "Ensure the source field contains valid JSON text.",
                    )
                })?;
                &parsed_value
            }
            already_json => already_json,
        },
        other => Err(value_to_bytes_error(
            step_id,
            format!(
                "cell_table column {column_index} source.parse format '{other}' is not supported"
            ),
            "Use a source parse format implemented by the workflow value-to-bytes writer.",
        ))?,
    };
    let parsed = json_path(parsed_root, &parse.after_parse_path).ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            format!(
                "cell_table column {column_index} source.parse.after_parse_path did not resolve"
            ),
            "Use after_parse_path only for fields present inside the parsed source value.",
        )
    })?;
    on_value(parsed)
}

enum CellBytes<'a> {
    Borrowed(&'a [u8]),
    Owned(Vec<u8>),
    One([u8; 1]),
}

impl CellBytes<'_> {
    fn len(&self) -> usize {
        match self {
            Self::Borrowed(bytes) => bytes.len(),
            Self::Owned(bytes) => bytes.len(),
            Self::One(bytes) => bytes.len(),
        }
    }

    fn copy_to(&self, target: &mut [u8]) {
        match self {
            Self::Borrowed(bytes) => target.copy_from_slice(bytes),
            Self::Owned(bytes) => target.copy_from_slice(bytes),
            Self::One(bytes) => target.copy_from_slice(bytes),
        }
    }

    fn into_owned_bytes(self) -> Vec<u8> {
        match self {
            Self::Borrowed(bytes) => bytes.to_vec(),
            Self::Owned(bytes) => bytes,
            Self::One(bytes) => bytes.to_vec(),
        }
    }
}

fn encode_cell<'a>(
    step_id: &str,
    value: Option<&'a Value>,
    value_to_bytes: &str,
) -> Result<Option<CellBytes<'a>>, WorkflowError> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value_to_bytes {
        "text" | "non_empty_text" => encode_text_cell(step_id, value, value_to_bytes),
        "json" => encode_json_cell(step_id, value),
        "json_text" => encode_json_text_cell(step_id, value),
        "byte" => value
            .as_u64()
            .filter(|value| *value <= u8::MAX as u64)
            .map(|value| Some(CellBytes::One([value as u8])))
            .ok_or_else(|| {
                value_to_bytes_error(
                    step_id,
                    "cell_table byte source value must fit in u8",
                    "Use byte only for integer values from 0 through 255.",
                )
            }),
        "byte_boolean" => value
            .as_bool()
            .map(|value| Some(CellBytes::One([u8::from(value)])))
            .ok_or_else(|| {
                value_to_bytes_error(
                    step_id,
                    "cell_table boolean source value must be boolean",
                    "Use byte_boolean only for boolean source values.",
                )
            }),
        other => Err(value_to_bytes_error(
            step_id,
            format!("cell_table cell value_to_bytes '{other}' is not supported"),
            "Use a cell value-to-bytes writer implemented by workflow.",
        )),
    }
}

fn encode_text_cell<'a>(
    step_id: &str,
    value: &'a Value,
    value_to_bytes: &str,
) -> Result<Option<CellBytes<'a>>, WorkflowError> {
    let text = match value {
        Value::Null => return Ok(None),
        Value::String(text) => return encode_text_bytes(text.as_bytes(), value_to_bytes),
        Value::Number(number) => number.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => {
            return Err(value_to_bytes_error(
                step_id,
                "cell_table text source value must be a JSON scalar",
                "Use text/non_empty_text for strings, numbers, or booleans; use a dedicated byte layout for structured values.",
            ));
        }
    };

    let bytes = text.into_bytes();
    if value_to_bytes == "non_empty_text" && bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(CellBytes::Owned(bytes)))
}

fn encode_text_bytes<'a>(
    bytes: &'a [u8],
    value_to_bytes: &str,
) -> Result<Option<CellBytes<'a>>, WorkflowError> {
    if value_to_bytes == "non_empty_text" && bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(CellBytes::Borrowed(bytes)))
}

fn encode_json_cell(
    step_id: &str,
    value: &Value,
) -> Result<Option<CellBytes<'static>>, WorkflowError> {
    if value.is_null() {
        return Ok(None);
    }
    serde_json::to_vec(value)
        .map(|bytes| Some(CellBytes::Owned(bytes)))
        .map_err(|e| {
            value_to_bytes_error(
                step_id,
                format!("cell_table JSON source value serialization failed: {e}"),
                "Use json cells only for values that can be serialized as canonical JSON bytes.",
            )
        })
}

fn encode_json_text_cell<'a>(
    step_id: &str,
    value: &'a Value,
) -> Result<Option<CellBytes<'a>>, WorkflowError> {
    if value.is_null() {
        return Ok(None);
    }
    let text = value.as_str().ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            "cell_table json_text source value must be a string",
            "Use json_text only when the source field already contains valid JSON text.",
        )
    })?;
    let mut deserializer = serde_json::Deserializer::from_str(text);
    IgnoredAny::deserialize(&mut deserializer).map_err(|e| {
        value_to_bytes_error(
            step_id,
            format!("cell_table json_text source value is not valid JSON: {e}"),
            "Ensure the source field contains exactly one valid JSON value encoded as text.",
        )
    })?;
    deserializer.end().map_err(|e| {
        value_to_bytes_error(
            step_id,
            format!("cell_table json_text source value has trailing bytes: {e}"),
            "Ensure the source field contains exactly one valid JSON value encoded as text.",
        )
    })?;
    Ok(Some(CellBytes::Borrowed(text.as_bytes())))
}

fn read_path(
    step_id: &str,
    value: Option<&Value>,
    label: &str,
) -> Result<Vec<String>, WorkflowError> {
    let parts = value.and_then(Value::as_array).ok_or_else(|| {
        value_to_bytes_error(
            step_id,
            format!("{label} must be an array of strings"),
            "Declare paths as machine-readable arrays, not dot-separated strings.",
        )
    })?;
    parts
        .iter()
        .enumerate()
        .map(|(index, part)| {
            part.as_str().map(str::to_string).ok_or_else(|| {
                value_to_bytes_error(
                    step_id,
                    format!("{label} entry {index} must be a string"),
                    "Use string path segments.",
                )
            })
        })
        .collect()
}

fn json_path<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut current = value;
    for segment in path {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

fn stable_json_key(value: &Value) -> String {
    let mut key = String::new();
    append_stable_json_key(value, &mut key);
    key
}

fn append_stable_json_key(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null;"),
        Value::Bool(value) => {
            if *value {
                output.push_str("bool:true;");
            } else {
                output.push_str("bool:false;");
            }
        }
        Value::Number(value) => {
            output.push_str("number:");
            append_length_prefixed(value.to_string().as_str(), output);
        }
        Value::String(value) => {
            output.push_str("string:");
            append_length_prefixed(value, output);
        }
        Value::Array(values) => {
            output.push_str("array:");
            output.push_str(values.len().to_string().as_str());
            output.push('[');
            for value in values {
                append_stable_json_key(value, output);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push_str("object:");
            output.push_str(values.len().to_string().as_str());
            output.push('{');
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (field, value) in entries {
                append_length_prefixed(field, output);
                append_stable_json_key(value, output);
            }
            output.push('}');
        }
    }
}

fn append_length_prefixed(value: &str, output: &mut String) {
    output.push_str(value.len().to_string().as_str());
    output.push(':');
    output.push_str(value);
    output.push(';');
}

fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn value_to_bytes_error(
    step_id: &str,
    reason: impl Into<String>,
    hint: impl Into<String>,
) -> WorkflowError {
    WorkflowError::StepExecutionFailed {
        step_id: step_id.to_string(),
        reason: reason.into(),
        hint: hint.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{stable_json_key, stream_projected_json_rows_from_bytes};
    use serde_json::json;

    fn path(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| (*part).to_string()).collect()
    }

    #[test]
    fn projected_json_rows_stream_only_declared_roots() {
        let bytes = br#"{
            "output": {
                "items": [
                    {
                        "id": "item:one",
                        "payload": {"rank": 1},
                        "ignored": {
                            "deep": {
                                "unused": ["this", "subtree", "must", "not", "be", "row", "state"]
                            }
                        }
                    }
                ]
            }
        }"#;
        let roots = path(&["id", "payload"]);
        let mut observed = Vec::new();

        stream_projected_json_rows_from_bytes(
            "test_projected_rows",
            bytes,
            &path(&["output", "items"]),
            &roots,
            |row| {
                observed.push((
                    row.value_at(0, &[])
                        .and_then(|value| value.as_str())
                        .unwrap()
                        .to_string(),
                    row.value_at(1, &path(&["rank"]))
                        .and_then(|value| value.as_u64())
                        .unwrap(),
                    row.value_at(2, &[]).is_none(),
                ));
                Ok(())
            },
        )
        .expect("projected row streaming should decode declared roots");

        assert_eq!(observed, vec![("item:one".to_string(), 1, true)]);
    }

    #[test]
    fn a_column_past_the_last_a_table_holds_is_refused_before_any_table_is_sized() {
        let column = |index: u64| json!([{ "column": index, "source": { "path": ["id"] }, "value": { "value_to_bytes": "text" } }]);
        let refused = super::read_columns("sparse", Some(&column(4_000_000_000))).expect_err("a sparse index is refused");
        assert!(refused.to_string().contains("past the last column"), "{refused}");
        assert!(super::read_columns("last", Some(&column(u64::from(super::MOST_CELL_TABLE_COLUMNS) - 1))).is_ok());
    }

    #[test]
    fn stable_json_key_keeps_json_types_distinct_without_serializing() {
        assert_ne!(stable_json_key(&json!("1")), stable_json_key(&json!(1)));
        assert_ne!(
            stable_json_key(&json!(true)),
            stable_json_key(&json!("true"))
        );
        assert_eq!(
            stable_json_key(&json!("quote \" slash \\ newline \n")),
            stable_json_key(&json!("quote \" slash \\ newline \n")),
        );
    }

    #[test]
    fn stable_json_key_sorts_object_fields_structurally() {
        let left = json!({"z": [2, {"b": false, "a": null}], "a": "same"});
        let right = json!({"a": "same", "z": [2, {"a": null, "b": false}]});

        assert_eq!(stable_json_key(&left), stable_json_key(&right));
    }
}
