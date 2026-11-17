//! Byte ranges [start, end) of one version of one file, kept merged.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub start: u64,
    pub end: u64,
}

impl Span {
    pub fn new(start: u64, end: u64) -> Span {
        Span { start, end }
    }

    pub fn len(&self) -> u64 {
        self.end.saturating_sub(self.start)
    }

    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }

    /// The span widened to whole `alignment` units, inside [0, size).
    pub fn aligned(&self, alignment: u64, size: u64) -> Span {
        if alignment <= 1 {
            return Span::new(self.start, self.end.min(size));
        }
        let start = self.start - self.start % alignment;
        let end = self.end.div_ceil(alignment).saturating_mul(alignment).min(size);
        Span::new(start, end)
    }

    /// The span cut into pieces of at most `most` bytes, in order.
    pub fn pieces(&self, most: u64) -> Vec<Span> {
        let most = most.max(1);
        let mut pieces = Vec::new();
        let mut at = self.start;
        while at < self.end {
            let end = at.saturating_add(most).min(self.end);
            pieces.push(Span::new(at, end));
            at = end;
        }
        pieces
    }
}

/// Merged spans, keyed by start.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SpanSet {
    spans: BTreeMap<u64, u64>,
}

impl SpanSet {
    pub fn insert(&mut self, span: Span) {
        if span.is_empty() {
            return;
        }
        let (mut start, mut end) = (span.start, span.end);
        let touching: Vec<(u64, u64)> = self
            .spans
            .range(..=end)
            .rev()
            .take_while(|(_, held_end)| **held_end >= start)
            .map(|(held_start, held_end)| (*held_start, *held_end))
            .collect();
        for (held_start, held_end) in touching {
            self.spans.remove(&held_start);
            start = start.min(held_start);
            end = end.max(held_end);
        }
        self.spans.insert(start, end);
    }

    /// The parts of `span` not held, in order.
    pub fn missing(&self, span: Span) -> Vec<Span> {
        let mut missing = Vec::new();
        let mut at = span.start;
        let before = self.spans.range(..=span.start).next_back().map(|(start, end)| (*start, *end));
        let after = self.spans.range(span.start..span.end).map(|(start, end)| (*start, *end));
        for (held_start, held_end) in before.into_iter().chain(after) {
            if held_end <= at {
                continue;
            }
            if held_start > at {
                missing.push(Span::new(at, held_start.min(span.end)));
            }
            at = at.max(held_end);
            if at >= span.end {
                break;
            }
        }
        if at < span.end {
            missing.push(Span::new(at, span.end));
        }
        missing
    }

    pub fn holds(&self, span: Span) -> bool {
        span.is_empty() || self.missing(span).is_empty()
    }

    /// Where the held bytes from `from` on stop (`from` itself when the byte at `from` is not held).
    pub fn held_until(&self, from: u64) -> u64 {
        match self.spans.range(..=from).next_back() {
            Some((_, end)) if *end > from => *end,
            _ => from,
        }
    }

    pub fn total(&self) -> u64 {
        self.spans.iter().map(|(start, end)| end - start).sum()
    }
}
