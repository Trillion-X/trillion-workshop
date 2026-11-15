//! Bounded span pages for files received through the generic account files writer.
//!
//! Existing migrated files keep their original single `@namespace/spans`
//! array. New uploads use one bounded record store span page per 256 fixed 32 KiB
//! pieces, keyed by their upload set. `read_range` can fetch only pages and
//! chunks that cross the requested range; it never loads a file-sized index.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::settings::settings;
use crate::records::Record;
use content_crypto::subtree::SUBTREE_BYTES;

/// The most spans one record carries: 256 × 32 KiB covers 8 MiB of file bytes.
pub const SPANS_PER_PAGE: u64 = 256;
pub const LAYOUT: &str = "pages-32k-v1";
/// A second, append-oriented layout for streams whose fragments are not aligned
/// to 32 KiB boundaries. Its pages use the same record and chunk owners.
pub const APPEND_LAYOUT: &str = "pages-append-v1";
/// A known-length file cut into chunks of at most `settings().chunks.bytes`: each chunk is one store object keyed by its
/// BLAKE3, and its pages are the variable-length pages of the append stream. Finish checks the spans and uses the
/// server checkpoint, so the file is never read back.
pub const CHUNKS_LAYOUT: &str = "chunks-v1";

/// Whether a layout keeps variable-length spans (each page's byte ranges exactly abut).
pub fn is_variable(layout: &str) -> bool {
    layout == APPEND_LAYOUT || layout == CHUNKS_LAYOUT
}

/// The most bytes one span of a layout may hold: a 32 KiB piece of the append stream, a chunk of `chunks-v1`.
pub fn most_span_bytes(layout: &str) -> u64 {
    if layout == CHUNKS_LAYOUT { settings().chunks.bytes } else { SUBTREE_BYTES as u64 }
}

#[derive(Debug, Clone)]
pub enum Error {
    InvalidPage(crate::refusal_cause::Cause),
    WrongPage(crate::refusal_cause::Cause),
    Offset(crate::refusal_cause::Cause),
    Conflict(crate::refusal_cause::Cause),
    Overflow(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::InvalidPage(cause) => cause.clone(),
            Self::WrongPage(cause) => cause.clone(),
            Self::Offset(cause) => cause.clone(),
            Self::Conflict(cause) => cause.clone(),
            Self::Overflow(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);

impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Error {}


/// One file byte range whose bytes live in a content-addressed account files chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub ordinal: u64,
    pub offset: u64,
    pub length: u64,
    pub chunk: String,
}

/// The record id of one span page in the existing `@namespace/spans` scope.
pub fn page_id(set: &str, page: u64) -> String {
    format!("{set}:p{page:016x}")
}

/// The page number that owns a piece ordinal.
pub fn page_number(ordinal: u64) -> u64 {
    ordinal / SPANS_PER_PAGE
}

/// An empty page value for a newly appended span.
pub fn empty_page(set: &str, page: u64) -> Value {
    json!({ "kind": "namespace-spans", "layout": LAYOUT, "set": set, "page": page, "spans": [] })
}

pub fn empty_variable_page(set: &str, page: u64, start_offset: u64, layout: &str) -> Value {
    json!({ "kind": "namespace-spans", "layout": layout, "set": set, "page": page,
        "start_offset": start_offset, "end_offset": start_offset, "spans": [] })
}

/// Every span record id of a file, in order: its upload's pages (`span_set`), or its legacy single span array (the file).
pub fn page_ids(file: &Record) -> Vec<String> {
    let spans = file.value.get("spans").and_then(Value::as_u64).unwrap_or(0);
    if spans == 0 {
        return Vec::new();
    }
    match file.value.get("span_set").and_then(Value::as_str) {
        Some(set) => (0..spans.div_ceil(SPANS_PER_PAGE)).map(|page| page_id(set, page)).collect(),
        None => vec![file.id.clone()],
    }
}

/// Validate variable-length spans (`pages-append-v1` and `chunks-v1`). Ordinals are dense within the page and
/// byte ranges exactly abut, so neither holes nor overlapping fragments can be fetched as a file.
pub fn parse_variable_page(value: &Value, set: &str, page: u64) -> Result<Vec<Span>, Error> {
    let layout = value
        .get("layout")
        .and_then(Value::as_str)
        .filter(|layout| is_variable(layout))
        .ok_or(crate::cause!(Error::WrongPage))?;
    if value.get("kind").and_then(Value::as_str) != Some("namespace-spans")
        || value.get("set").and_then(Value::as_str) != Some(set)
        || value.get("page").and_then(Value::as_u64) != Some(page)
    {
        return Err(crate::cause!(Error::WrongPage));
    }
    let spans: Vec<Span> =
        serde_json::from_value(value.get("spans").cloned().ok_or(crate::cause!(Error::InvalidPage))?)
            .map_err(|error| crate::carry_cause!(Error::InvalidPage, error))?;
    if spans.len() > SPANS_PER_PAGE as usize {
        return Err(crate::cause!(Error::InvalidPage));
    }
    let first = page.checked_mul(SPANS_PER_PAGE).ok_or(crate::cause!(Error::Overflow))?;
    let start = value
        .get("start_offset")
        .and_then(Value::as_u64)
        .ok_or(crate::cause!(Error::InvalidPage))?;
    if spans.is_empty() {
        return if value.get("end_offset").and_then(Value::as_u64) == Some(start) {
            Ok(spans)
        } else {
            Err(crate::cause!(Error::InvalidPage))
        };
    }
    let mut next = start;
    for (index, span) in spans.iter().enumerate() {
        let ordinal = first.checked_add(index as u64).ok_or(crate::cause!(Error::Overflow))?;
        if span.ordinal != ordinal
            || span.offset != next
            || span.length == 0
            || span.length > most_span_bytes(layout)
            || span.chunk.len() != 67
            || !span.chunk.starts_with("1f:")
            || !span.chunk[3..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(crate::cause!(Error::InvalidPage));
        }
        next = next.checked_add(span.length).ok_or(crate::cause!(Error::Overflow))?;
    }
    if value.get("end_offset").and_then(Value::as_u64) != Some(next) {
        return Err(crate::cause!(Error::InvalidPage));
    }
    Ok(spans)
}

pub fn append_variable(
    value: &Value,
    set: &str,
    page: u64,
    span: Span,
) -> Result<(Value, bool), Error> {
    let layout = value
        .get("layout")
        .and_then(Value::as_str)
        .filter(|layout| is_variable(layout))
        .ok_or(crate::cause!(Error::WrongPage))?;
    if page_number(span.ordinal) != page || span.length == 0 || span.length > most_span_bytes(layout) {
        return Err(crate::cause!(Error::Offset));
    }
    let mut spans = parse_variable_page(value, set, page)?;
    let first = page.checked_mul(SPANS_PER_PAGE).ok_or(crate::cause!(Error::Overflow))?;
    let index = span.ordinal.checked_sub(first).ok_or(crate::cause!(Error::Offset))? as usize;
    if index < spans.len() {
        return if spans[index] == span {
            Ok((value.clone(), false))
        } else {
            Err(crate::cause!(Error::Conflict))
        };
    }
    let expected_offset = match spans.last() {
        Some(last) => last
            .offset
            .checked_add(last.length)
            .ok_or(crate::cause!(Error::Overflow))?,
        None => value
            .get("start_offset")
            .and_then(Value::as_u64)
            .ok_or(crate::cause!(Error::InvalidPage))?,
    };
    if index != spans.len() || expected_offset != span.offset {
        return Err(crate::cause!(Error::Offset));
    }
    spans.push(span);
    let start = value
        .get("start_offset")
        .and_then(Value::as_u64)
        .ok_or(crate::cause!(Error::InvalidPage))?;
    let mut updated = empty_variable_page(set, page, start, layout);
    updated["spans"] = serde_json::to_value(&spans).map_err(|error| crate::carry_cause!(Error::InvalidPage, error))?;
    let last = spans.last().ok_or(crate::cause!(Error::InvalidPage))?;
    updated["end_offset"] = json!(
        last.offset
            .checked_add(last.length)
            .ok_or(crate::cause!(Error::Overflow))?
    );
    parse_variable_page(&updated, set, page)?;
    Ok((updated, true))
}

/// Read and validate a page before either appending to it or using it for range reads.
pub fn parse_page(value: &Value, set: &str, page: u64) -> Result<Vec<Span>, Error> {
    if value.get("kind").and_then(Value::as_str) != Some("namespace-spans")
        || value.get("layout").and_then(Value::as_str) != Some(LAYOUT)
        || value.get("set").and_then(Value::as_str) != Some(set)
        || value.get("page").and_then(Value::as_u64) != Some(page)
    {
        return Err(crate::cause!(Error::WrongPage));
    }
    let spans: Vec<Span> =
        serde_json::from_value(value.get("spans").cloned().ok_or(crate::cause!(Error::InvalidPage))?)
            .map_err(|error| crate::carry_cause!(Error::InvalidPage, error))?;
    if spans.len() > SPANS_PER_PAGE as usize {
        return Err(crate::cause!(Error::InvalidPage));
    }
    let first = page.checked_mul(SPANS_PER_PAGE).ok_or(crate::cause!(Error::Overflow))?;
    for (index, span) in spans.iter().enumerate() {
        let ordinal = first.checked_add(index as u64).ok_or(crate::cause!(Error::Overflow))?;
        let offset = ordinal
            .checked_mul(SUBTREE_BYTES as u64)
            .ok_or(crate::cause!(Error::Overflow))?;
        if span.ordinal != ordinal
            || span.offset != offset
            || span.length == 0
            || span.length > SUBTREE_BYTES as u64
            || (span.length < SUBTREE_BYTES as u64 && index + 1 != spans.len())
            || span.chunk.len() != 67
            || !span.chunk.starts_with("1f:")
            || !span.chunk[3..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(crate::cause!(Error::InvalidPage));
        }
    }
    Ok(spans)
}

/// Append a span to its page. Repeating the identical span is idempotent; a
/// different span at an accepted ordinal is a conflict, never an overwrite.
pub fn append(value: &Value, set: &str, page: u64, span: Span) -> Result<(Value, bool), Error> {
    if page_number(span.ordinal) != page
        || span.offset
            != span
                .ordinal
                .checked_mul(SUBTREE_BYTES as u64)
                .ok_or(crate::cause!(Error::Overflow))?
    {
        return Err(crate::cause!(Error::Offset));
    }
    let mut spans = parse_page(value, set, page)?;
    let first = page.checked_mul(SPANS_PER_PAGE).ok_or(crate::cause!(Error::Overflow))?;
    let index = span.ordinal.checked_sub(first).ok_or(crate::cause!(Error::Offset))? as usize;
    if index < spans.len() {
        return if spans[index] == span {
            Ok((value.clone(), false))
        } else {
            Err(crate::cause!(Error::Conflict))
        };
    }
    if index != spans.len() {
        return Err(crate::cause!(Error::Offset));
    }
    if span.length == 0
        || span.length > SUBTREE_BYTES as u64
        || (span.length < SUBTREE_BYTES as u64 && index as u64 + 1 < SPANS_PER_PAGE)
    {
        // A short piece is valid only at the end of a file. Whether it is the
        // final file piece is checked against the declared length by the writer.
        if span.length == 0 || span.length > SUBTREE_BYTES as u64 {
            return Err(crate::cause!(Error::InvalidPage));
        }
    }
    spans.push(span);
    let mut updated = empty_page(set, page);
    updated["spans"] = serde_json::to_value(spans).map_err(|error| crate::carry_cause!(Error::InvalidPage, error))?;
    // A short piece is legal only at EOF. The caller supplies the declared
    // length, but validating the resulting page here also prevents appending
    // any later piece after a previously accepted short final span.
    parse_page(&updated, set, page)?;
    Ok((updated, true))
}

/// Ordinals crossed by one checked byte range; zero-length ranges have none.
pub fn crossed(offset: u64, length: u64, total: u64) -> Result<Vec<u64>, Error> {
    if length == 0 {
        return Ok(Vec::new());
    }
    let end = offset.checked_add(length).ok_or(crate::cause!(Error::Overflow))?;
    if end > total {
        return Err(crate::cause!(Error::Offset));
    }
    let first = offset / SUBTREE_BYTES as u64;
    let last = (end - 1) / SUBTREE_BYTES as u64;
    let count = last
        .checked_sub(first)
        .and_then(|n| n.checked_add(1))
        .ok_or(crate::cause!(Error::Overflow))?;
    if count > (length / SUBTREE_BYTES as u64).saturating_add(2) {
        return Err(crate::cause!(Error::Overflow));
    }
    Ok((first..=last).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(ordinal: u64, length: u64, chunk: &str) -> Span {
        Span {
            ordinal,
            offset: ordinal * SUBTREE_BYTES as u64,
            length,
            chunk: chunk.into(),
        }
    }

    #[test]
    fn pages_are_bounded_ordered_and_idempotent() {
        let set = "upload-session";
        let mut value = empty_page(set, 0);
        for ordinal in 0..SPANS_PER_PAGE {
            let next = span(
                ordinal,
                SUBTREE_BYTES as u64,
                &format!("1f:{:064x}", ordinal),
            );
            (value, _) = append(&value, set, 0, next).unwrap();
        }
        assert_eq!(parse_page(&value, set, 0).unwrap().len(), 256);
        assert_eq!(page_id(set, 0), "upload-session:p0000000000000000");
        assert_eq!(page_id(set, 1), "upload-session:p0000000000000001");
        let repeated = span(255, SUBTREE_BYTES as u64, &format!("1f:{:064x}", 255));
        let (same, changed) = append(&value, set, 0, repeated).unwrap();
        assert!(!changed);
        assert_eq!(same, value);
        let conflict = span(255, SUBTREE_BYTES as u64, &format!("1f:{:064x}", 999));
        assert_eq!(append(&value, set, 0, conflict), Err(crate::cause!(Error::Conflict)));
    }

    #[test]
    fn wrong_page_order_identity_and_partial_span_are_refused() {
        let set = "upload-session";
        let value = empty_page(set, 0);
        assert_eq!(
            append(
                &value,
                set,
                0,
                span(1, 10, &format!("1f:{}", "a".repeat(64)))
            ),
            Err(crate::cause!(Error::Offset))
        );
        let mut malformed = empty_page(set, 0);
        malformed["set"] = json!("other-session");
        assert_eq!(parse_page(&malformed, set, 0), Err(crate::cause!(Error::WrongPage)));
        let malformed = json!({"kind":"namespace-spans","layout":LAYOUT,"set":set,"page":0,
            "spans":[span(0, 1, &format!("1f:{}", "z".repeat(64)))]});
        assert_eq!(parse_page(&malformed, set, 0), Err(crate::cause!(Error::InvalidPage)));
    }

    #[test]
    fn a_piece_cannot_be_appended_after_a_short_span() {
        let set = "upload-session";
        let value = empty_page(set, 0);
        let (value, _) = append(
            &value,
            set,
            0,
            span(0, 10, &format!("1f:{}", "a".repeat(64))),
        )
        .unwrap();
        assert_eq!(
            append(
                &value,
                set,
                0,
                span(1, 10, &format!("1f:{}", "b".repeat(64)))
            ),
            Err(crate::cause!(Error::InvalidPage))
        );
    }

    #[test]
    fn range_mapping_crosses_only_the_requested_fixed_pieces() {
        assert_eq!(crossed(0, 1, 100).unwrap(), [0]);
        assert_eq!(crossed(32760, 20, 32780).unwrap(), [0, 1]);
        assert!(crossed(0, 0, 100).unwrap().is_empty());
        assert_eq!(crossed(u64::MAX, 2, u64::MAX), Err(crate::cause!(Error::Overflow)));
        assert_eq!(crossed(20, 10, 25), Err(crate::cause!(Error::Offset)));
    }

    #[test]
    fn chunks_pages_hold_whole_chunks_and_the_append_stream_keeps_its_32_kib_bound() {
        let set = "chunked-upload";
        let chunk = settings().chunks.bytes;
        let id = format!("1f:{}", "c".repeat(64));
        let page = empty_variable_page(set, 0, 0, CHUNKS_LAYOUT);
        let (page, _) = append_variable(&page, set, 0, Span { ordinal: 0, offset: 0, length: chunk, chunk: id.clone() }).unwrap();
        assert_eq!(parse_variable_page(&page, set, 0).unwrap()[0].length, chunk);
        assert_eq!(
            append_variable(&empty_variable_page(set, 0, 0, CHUNKS_LAYOUT), set, 0, Span { ordinal: 0, offset: 0, length: chunk + 1, chunk: id.clone() }),
            Err(crate::cause!(Error::Offset))
        );
        assert_eq!(
            append_variable(&empty_variable_page(set, 0, 0, APPEND_LAYOUT), set, 0, Span { ordinal: 0, offset: 0, length: chunk, chunk: id }),
            Err(crate::cause!(Error::Offset))
        );
    }

    #[test]
    fn append_pages_accept_arbitrary_fragments_and_reject_gaps_overlaps_and_replays() {
        let set = "growing-upload";
        let id = format!("1f:{}", "a".repeat(64));
        let mut page = empty_variable_page(set, 0, 0, APPEND_LAYOUT);
        let first = Span {
            ordinal: 0,
            offset: 0,
            length: 7,
            chunk: id.clone(),
        };
        (page, _) = append_variable(&page, set, 0, first.clone()).unwrap();
        let (same, changed) = append_variable(&page, set, 0, first).unwrap();
        assert!(!changed);
        assert_eq!(same, page);
        assert_eq!(parse_variable_page(&page, set, 0).unwrap().len(), 1);
        assert_eq!(
            append_variable(
                &page,
                set,
                0,
                Span {
                    ordinal: 1,
                    offset: 8,
                    length: 2,
                    chunk: id.clone()
                }
            ),
            Err(crate::cause!(Error::Offset))
        );
        assert_eq!(
            append_variable(
                &page,
                set,
                0,
                Span {
                    ordinal: 1,
                    offset: 6,
                    length: 2,
                    chunk: id.clone()
                }
            ),
            Err(crate::cause!(Error::Offset))
        );
        assert_eq!(
            append_variable(
                &page,
                set,
                0,
                Span {
                    ordinal: 0,
                    offset: 0,
                    length: 8,
                    chunk: id
                }
            ),
            Err(crate::cause!(Error::Conflict))
        );
    }
}
