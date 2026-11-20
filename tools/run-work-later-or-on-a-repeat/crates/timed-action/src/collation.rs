//! crates/timed-action/src/collation.rs
//!
//! Purpose
//!   The order `a.localeCompare(b)` gives, which the TypeScript uses to sort schedules and occurrences. For printable
//!   ASCII this module reproduces that order: the ICU root collation, read off Node's ICU (77.1) once, the punctuation
//!   and symbols first, then digits, then letters with a lower-case letter before its upper-case form at the tertiary
//!   level. Text with a character past ASCII is ordered after all ASCII by code point; that is the one place this
//!   order differs from ICU, and it is reported rather than decided here.
//!
//! Non-negotiable invariants
//!   - Control characters other than tab, line feed, vertical tab, form feed and carriage return are ignorable, as ICU
//!     treats them; those five are whitespace, ordered before the space.
//!   - Comparison is primary strength first over the whole text, then tertiary (case) over the whole text, as UCA does.

use std::cmp::Ordering;

/// The primary order of ASCII: whitespace, then punctuation and symbols, then digits, then letters (lower-case form).
const PRIMARY_ORDER: &str = "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

/// One collation element: a primary weight and a tertiary weight (0 lower case or non-letter, 1 upper case).
type Element = (u32, u8);

fn elements(text: &str) -> Vec<Element> {
    text.chars()
        .filter_map(|character| {
            if character.is_ascii() {
                let byte = character as u8;
                let lower = byte.to_ascii_lowercase() as char;
                let primary = PRIMARY_ORDER.find(lower)?;
                let tertiary = u8::from(byte.is_ascii_uppercase());
                Some((primary as u32, tertiary))
            } else {
                Some((1_000 + character as u32, 0))
            }
        })
        .collect()
}

/// `a.localeCompare(b)` for the orders this engine sorts by: -1, 0 or 1 as the Ordering of a against b.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let left = elements(a);
    let right = elements(b);
    left.iter()
        .map(|element| element.0)
        .cmp(right.iter().map(|element| element.0))
        .then_with(|| left.iter().map(|element| element.1).cmp(right.iter().map(|element| element.1)))
}
