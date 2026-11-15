// src/storage/record_store_resources/book_directory.rs
//
// Purpose: which store of an account's volume holds each record id. A volume is a sorted key space cut into spans; each
// span names the store that holds its records. A point read asks the span owner only, never every store. A split adds a
// span at a boundary and publishes the next generation, so a caller that read an older generation is refused, not served.
//
// Where it lives: one row in the account's primary book, changed only by a split or a merge that publishes a new generation.
// Records are never written through it. Its shape follows CockroachDB's range descriptors and meta ranges (a lookup asks the
// span owner, a split publishes the next descriptor) and Bigtable's tablet location (a tablet's owner is found from a
// sorted boundary, not by asking every tablet).
//
// Non-Negotiable Invariants:
// - The first span starts at no key and always exists: every id has exactly one owner.
// - A span covers ids from its `from` up to the next span's `from`, so an id is owned by the last span whose `from` it
//   reaches.
// - A split publishes exactly one new generation and names the generation it was made from; a stale one is refused.
// - A boundary that already exists is refused, never moved.
// - No number lives here. Split thresholds are DATA and the caller decides when to split.

use crate::refusal_cause::Cause;

/// One span of the key space: ids from `from` (None: from the start) up to the next span's `from`, held by `store`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Span {
    pub from: Option<String>,
    pub store: usize,
}

/// The spans of one volume at one generation, sorted by `from`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Directory {
    generation: u64,
    spans: Vec<Span>,
}

/// A split that was not published.
#[derive(Debug)]
pub enum Refused {
    /// The caller made its split from an older generation than the directory now holds.
    StaleGeneration(Cause),
    /// The boundary already starts a span.
    BoundaryExists(Cause),
}

impl Directory {
    /// One span over the whole key space, held by store 0, at generation 0.
    pub fn new() -> Self {
        Self { generation: 0, spans: vec![Span { from: None, store: 0 }] }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn spans(&self) -> &[Span] {
        &self.spans
    }

    /// The store that holds the record `id`.
    pub fn owner(&self, id: &str) -> usize {
        self.spans
            .iter()
            .rev()
            .find(|span| span.from.as_deref().is_none_or(|from| from <= id))
            .map_or(0, |span| span.store)
    }

    /// Starts a new span at `at`, held by `to_store`, and publishes the next generation. `expected` is the generation the
    /// caller decided the split from.
    pub fn split(&self, expected: u64, at: &str, to_store: usize) -> Result<Directory, Refused> {
        if expected != self.generation {
            return Err(Refused::StaleGeneration(crate::cause!(directory stale_generation)));
        }
        if self.spans.iter().any(|span| span.from.as_deref() == Some(at)) {
            return Err(Refused::BoundaryExists(crate::cause!(directory boundary_exists)));
        }
        let mut spans = self.spans.clone();
        let at_index = spans.partition_point(|span| span.from.as_deref().is_none_or(|from| from < at));
        spans.insert(at_index, Span { from: Some(at.to_owned()), store: to_store });
        Ok(Directory { generation: self.generation + 1, spans })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_directory_gives_every_id_to_store_zero_at_generation_zero() {
        let directory = Directory::new();
        assert_eq!(directory.generation(), 0);
        assert_eq!(directory.owner("apple"), 0);
        assert_eq!(directory.owner("zebra"), 0);
    }

    #[test]
    fn a_split_moves_only_the_ids_from_its_boundary_up_and_publishes_the_next_generation() {
        let split = Directory::new().split(0, "m", 1).unwrap();
        assert_eq!(split.generation(), 1);
        assert_eq!(split.owner("apple"), 0, "ids before the boundary stay where they were");
        assert_eq!(split.owner("m"), 1, "the boundary itself starts the new span");
        assert_eq!(split.owner("zebra"), 1);
    }

    #[test]
    fn a_second_split_inside_the_first_span_keeps_the_spans_sorted_by_their_start() {
        let first = Directory::new().split(0, "m", 1).unwrap();
        let second = first.split(1, "f", 2).unwrap();
        let starts: Vec<Option<&str>> = second.spans().iter().map(|span| span.from.as_deref()).collect();
        assert_eq!(starts, vec![None, Some("f"), Some("m")]);
        assert_eq!(second.owner("c"), 0);
        assert_eq!(second.owner("f"), 2);
        assert_eq!(second.owner("p"), 1);
    }

    #[test]
    fn a_split_made_from_an_older_generation_is_refused_not_published() {
        let first = Directory::new().split(0, "m", 1).unwrap();
        assert!(matches!(first.split(0, "f", 2), Err(Refused::StaleGeneration(_))));
    }

    #[test]
    fn a_boundary_that_already_starts_a_span_is_refused() {
        let first = Directory::new().split(0, "m", 1).unwrap();
        assert!(matches!(first.split(1, "m", 2), Err(Refused::BoundaryExists(_))));
    }
}
