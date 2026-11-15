//! crates/composition-engine-core/src/kernel/text.rs
//!
//! Text Editing Primitive (P9) - PURE FUNCTIONAL
//!
//! All text operations are pure functions returning new buffer state.
//! Handles IME composition, selection, and text measurement.
//!
//! # Critical: Index Semantics
//!
//! **ALL indices in TextRange are BYTE indices into UTF-8 strings.**
//!
//! This matches Rust's native string indexing semantics. Callers creating
//! TextRange from character positions MUST convert using the helper functions
//! provided below (e.g., `char_to_byte_index`, `byte_to_char_index`).
//!
//! # Non-Negotiable Invariants
//!
//! 1. All functions are pure (return new buffer state)
//! 2. Original buffer is never mutated
//! 3. Text measurement is delegated to host
//! 4. All slicing operations MUST use safe_slice() to prevent panics on invalid indices
//! 5. Indices MUST be on valid UTF-8 char boundaries
//!
//! # AI Directive
//!
//! The extensive documentation in this codebase is a critical design feature.
//! You are FORBIDDEN from simplifying or removing it. Your mandate is to
//! MAINTAIN and EXTEND this level of meticulous detail.
//!
//! Ported from: frontends/web/composition-engine/kernel/text.ts

use super::types::{ComposingState, MarkRange, Size, TextBufferState, TextMark, TextRange};
use serde::{Deserialize, Serialize};

// ============================================================================
// TEXT ERROR TYPE
// ============================================================================
//
// # Purpose
//
// Structured, machine-readable errors for text slicing operations. Enables
// callers to handle UTF-8 boundary violations, bounds errors, and invalid
// ranges with precision and clarity.
//
// # Non-Negotiable Invariants
//
// 1. **Never silently adjust** - Return errors, let callers decide
// 2. **Include context** - Every error carries indices for debugging
// 3. **Machine-readable codes** - Each variant has a unique code for automation
// 4. **Remediation hints** - Display includes actionable guidance
//
// # Key Concepts
//
// - Byte indices vs character indices: All indices in this module are BYTES
// - UTF-8 multi-byte: Characters like 😀 (4 bytes) or 日 (3 bytes)
// - Character boundary: Valid slice points (is_char_boundary returns true)
//
// # Security Considerations
//
// - Malformed indices could be from untrusted input (e.g., user selections)
// - Never panic on invalid input - return structured errors
// - Callers should validate indices come from trusted text measurements
//
// # AI Directive
//
// The extensive documentation in this codebase is a critical design feature.
// You are FORBIDDEN from simplifying or removing it. Your mandate is to
// MAINTAIN and EXTEND this level of meticulous detail.
// NEVER add fallback behavior that silently adjusts indices.
// Errors MUST be propagated to callers for explicit handling.

/// Text operation errors with structured, machine-readable information.
///
/// Each variant includes:
/// - **Error code**: Machine-readable identifier (e.g., `TEXT_ERR_001`)
/// - **Context**: Relevant indices and lengths for debugging
/// - **Remediation**: Guidance on how to fix in Display impl
///
/// # Error Codes
///
/// | Code | Variant | Meaning |
/// |------|---------|---------|
/// | `TEXT_ERR_001` | `InvalidRange` | start > end |
/// | `TEXT_ERR_002` | `OutOfBounds` | index > len |
/// | `TEXT_ERR_003` | `NotCharBoundary` | index splits multi-byte char |
///
/// # Example
///
/// ```
/// use composition_engine_core::kernel::text::{safe_slice, TextError};
///
/// let text = "a😀b";
/// match safe_slice(text, 0, 2) {
///     Err(TextError::NotCharBoundary { index }) => {
///         // Use floor_char_boundary or ceil_char_boundary to find valid index
///     }
///     _ => {}
/// }
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextError {
    /// Start index is greater than end index.
    ///
    /// **Code:** `TEXT_ERR_001`
    /// **Fix:** Swap start and end, or use `normalize_selection()`
    InvalidRange { start: usize, end: usize },
    /// Index exceeds string length.
    ///
    /// **Code:** `TEXT_ERR_002`
    /// **Fix:** Clamp index to `0..=text.len()`
    OutOfBounds { index: usize, len: usize },
    /// Index is not on a valid UTF-8 character boundary.
    ///
    /// **Code:** `TEXT_ERR_003`
    /// **Fix:** Use `floor_char_boundary()` or `ceil_char_boundary()` to find nearest valid index
    ///
    /// This happens when slicing in the middle of a multi-byte character
    /// (e.g., emoji is 4 bytes, CJK characters are 3 bytes).
    NotCharBoundary { index: usize },
}

impl std::fmt::Display for TextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TextError::InvalidRange { start, end } => {
                write!(
                    f,
                    "[TEXT_ERR_001] Invalid range: start {} > end {}. Fix: swap indices or use normalize_selection()",
                    start, end
                )
            }
            TextError::OutOfBounds { index, len } => {
                write!(
                    f,
                    "[TEXT_ERR_002] Index {} out of bounds (len={}). Fix: clamp to 0..={}",
                    index, len, len
                )
            }
            TextError::NotCharBoundary { index } => {
                write!(
                    f,
                    "[TEXT_ERR_003] Index {} is not a UTF-8 character boundary. Fix: use floor_char_boundary() or ceil_char_boundary()",
                    index
                )
            }
        }
    }
}

impl TextError {
    /// Get the machine-readable error code.
    ///
    /// Useful for logging, metrics, and automated error handling.
    pub fn code(&self) -> &'static str {
        match self {
            TextError::InvalidRange { .. } => "TEXT_ERR_001",
            TextError::OutOfBounds { .. } => "TEXT_ERR_002",
            TextError::NotCharBoundary { .. } => "TEXT_ERR_003",
        }
    }
}

impl std::error::Error for TextError {}

// ============================================================================
// SAFE STRING SLICING
// ============================================================================
//
// Rust panics if you slice a string at an invalid UTF-8 boundary.
// These functions return structured errors instead of panicking.

/// Safely slice a string by byte indices.
///
/// Returns a structured error if indices are invalid. This function NEVER
/// silently adjusts indices - invalid input MUST be handled by the caller.
///
/// # Arguments
/// * `text` - The string to slice
/// * `start` - Start byte index (inclusive)
/// * `end` - End byte index (exclusive)
///
/// # Returns
/// The slice, or a structured error if indices are invalid.
///
/// # Errors
/// - `TextError::InvalidRange` if start > end
/// - `TextError::OutOfBounds` if end > text.len()
/// - `TextError::NotCharBoundary` if start or end is not on a UTF-8 boundary
///
/// # Examples
///
/// ```
/// use composition_engine_core::kernel::text::safe_slice;
///
/// // Valid ASCII slice
/// assert_eq!(safe_slice("hello", 1, 4).unwrap(), "ell");
///
/// // Valid emoji slice (😀 is 4 bytes at indices 1-5)
/// let text = "a😀b";
/// assert_eq!(safe_slice(text, 0, 1).unwrap(), "a");
/// assert_eq!(safe_slice(text, 1, 5).unwrap(), "😀");
/// assert_eq!(safe_slice(text, 5, 6).unwrap(), "b");
///
/// // Invalid: slicing in middle of emoji
/// assert!(safe_slice(text, 0, 2).is_err());
/// ```
pub fn safe_slice(text: &str, start: usize, end: usize) -> Result<&str, TextError> {
    // Validate range order
    if start > end {
        return Err(TextError::InvalidRange { start, end });
    }

    // Validate bounds
    if end > text.len() {
        return Err(TextError::OutOfBounds {
            index: end,
            len: text.len(),
        });
    }

    // Validate UTF-8 boundaries
    if !text.is_char_boundary(start) {
        return Err(TextError::NotCharBoundary { index: start });
    }
    if !text.is_char_boundary(end) {
        return Err(TextError::NotCharBoundary { index: end });
    }

    Ok(&text[start..end])
}

/// Safely slice from start of string to byte index.
///
/// Convenience wrapper around `safe_slice(text, 0, end)`.
fn safe_slice_to(text: &str, end: usize) -> Result<&str, TextError> {
    safe_slice(text, 0, end)
}

/// Safely slice from byte index to end of string.
///
/// Convenience wrapper around `safe_slice(text, start, text.len())`.
fn safe_slice_from(text: &str, start: usize) -> Result<&str, TextError> {
    safe_slice(text, start, text.len())
}

/// Find the largest valid char boundary <= index.
///
/// This is a stable implementation of the nightly `floor_char_boundary`.
/// Used for internal boundary calculations, NOT for silent adjustment.
#[inline]
pub fn floor_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut idx = index;
    while idx > 0 && !text.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// Find the smallest valid char boundary >= index.
///
/// This is a stable implementation of the nightly `ceil_char_boundary`.
/// Used for internal boundary calculations, NOT for silent adjustment.
#[inline]
pub fn ceil_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut idx = index;
    while idx < text.len() && !text.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

// ============================================================================
// INDEX CONVERSION HELPERS
// ============================================================================

/// Convert a character index to a byte index.
///
/// Returns the byte index of the start of the nth character.
/// If char_idx is beyond the string, returns string length.
pub fn char_to_byte_index(text: &str, char_idx: usize) -> usize {
    text.char_indices()
        .nth(char_idx)
        .map(|(byte_idx, _)| byte_idx)
        .unwrap_or(text.len())
}

/// Convert a byte index to a character index.
///
/// Returns the character index for the character containing byte_idx.
/// If byte_idx is beyond the string, returns character count.
pub fn byte_to_char_index(text: &str, byte_idx: usize) -> usize {
    text.char_indices()
        .take_while(|(idx, _)| *idx < byte_idx)
        .count()
}

// ============================================================================
// Basic Text Operations
// ============================================================================

/// Insert text at range - PURE FUNCTION
///
/// # Arguments
///
/// * `buffer` - Current buffer state
/// * `range` - TextRange with **byte indices** for start/end of replacement
/// * `text` - Text to insert
///
/// # Returns
///
/// New buffer state with text inserted and cursor positioned after insertion.
/// If indices are invalid, returns buffer unchanged.
pub fn insert_text(buffer: &TextBufferState, range: &TextRange, text: &str) -> TextBufferState {
    let before = match safe_slice_to(&buffer.text, range.start) {
        Ok(s) => s,
        Err(_) => return buffer.clone(),
    };
    let after = match safe_slice_from(&buffer.text, range.end) {
        Ok(s) => s,
        Err(_) => return buffer.clone(),
    };

    let new_text = format!("{}{}{}", before, text, after);
    let new_position = before.len() + text.len();
    let adjusted_marks = adjust_marks_for_insertion(&buffer.marks, range.start, text.len());

    TextBufferState {
        text: new_text,
        selection: TextRange::new(new_position, new_position),
        composing: None, // Clear composition
        marks: adjusted_marks,
    }
}

/// Adjust marks when text is deleted.
/// Delete text in range - PURE FUNCTION
///
/// # Arguments
///
/// * `buffer` - Current buffer state
/// * `range` - TextRange with **byte indices** for deletion boundaries
///
/// # Returns
///
/// New buffer state with text deleted and cursor at deletion point.
/// If indices are invalid, returns buffer unchanged.
pub fn delete_text(buffer: &TextBufferState, range: &TextRange) -> TextBufferState {
    let before = match safe_slice_to(&buffer.text, range.start) {
        Ok(s) => s,
        Err(_) => return buffer.clone(),
    };
    let after = match safe_slice_from(&buffer.text, range.end) {
        Ok(s) => s,
        Err(_) => return buffer.clone(),
    };

    let new_text = format!("{}{}", before, after);

    let adjusted_marks = adjust_marks_for_deletion(&buffer.marks, range.start, range.end);

    TextBufferState {
        text: new_text,
        selection: TextRange::new(before.len(), before.len()),
        composing: None,
        marks: adjusted_marks,
    }
}

/// Set selection - PURE FUNCTION
pub fn set_selection(buffer: &TextBufferState, selection: TextRange) -> TextBufferState {
    TextBufferState {
        text: buffer.text.clone(),
        selection,
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

// ============================================================================
// IME Composition
// ============================================================================

/// Start IME composition - PURE FUNCTION
pub fn start_composition(buffer: &TextBufferState, range: TextRange) -> TextBufferState {
    TextBufferState {
        text: buffer.text.clone(),
        selection: buffer.selection,
        composing: Some(ComposingState {
            range,
            text: String::new(),
        }),
        marks: buffer.marks.clone(),
    }
}

/// Update IME composition - PURE FUNCTION
pub fn update_composition(buffer: &TextBufferState, text: &str) -> TextBufferState {
    match &buffer.composing {
        None => buffer.clone(),
        Some(composing) => TextBufferState {
            text: buffer.text.clone(),
            selection: buffer.selection,
            composing: Some(ComposingState {
                range: composing.range,
                text: text.to_string(),
            }),
            marks: buffer.marks.clone(),
        },
    }
}

/// Commit IME composition - PURE FUNCTION
pub fn commit_composition(buffer: &TextBufferState) -> TextBufferState {
    match &buffer.composing {
        None => buffer.clone(),
        Some(composing) => insert_text(buffer, &composing.range, &composing.text),
    }
}

/// Cancel IME composition - PURE FUNCTION
pub fn cancel_composition(buffer: &TextBufferState) -> TextBufferState {
    TextBufferState {
        text: buffer.text.clone(),
        selection: buffer.selection,
        composing: None,
        marks: buffer.marks.clone(),
    }
}

// ============================================================================
// Selection Operations
// ============================================================================

/// Select word at position - PURE FUNCTION
///
/// # Arguments
///
/// * `buffer` - Current buffer state
/// * `position` - Byte index position in text
///
/// # Returns
///
/// New buffer state with word selected. Word boundaries are alphanumeric + underscore.
/// Returns byte indices for the selection.
/// If position is invalid, returns buffer unchanged.
pub fn select_word(buffer: &TextBufferState, position: usize) -> TextBufferState {
    let text = &buffer.text;

    // Ensure position is on a valid char boundary
    let pos = if text.is_char_boundary(position.min(text.len())) {
        position.min(text.len())
    } else {
        floor_char_boundary(text, position.min(text.len()))
    };

    // Find word boundary before cursor (working with byte indices)
    let before_slice = match safe_slice_to(text, pos) {
        Ok(s) => s,
        Err(_) => return buffer.clone(),
    };
    let mut start = pos;
    for (byte_idx, ch) in before_slice.char_indices().rev() {
        if ch.is_alphanumeric() || ch == '_' {
            start = byte_idx;
        } else {
            break;
        }
    }

    // Find word boundary after cursor (working with byte indices)
    let after_slice = match safe_slice_from(text, pos) {
        Ok(s) => s,
        Err(_) => return buffer.clone(),
    };
    let mut end = pos;
    for (byte_offset, ch) in after_slice.char_indices() {
        if ch.is_alphanumeric() || ch == '_' {
            end = pos + byte_offset + ch.len_utf8();
        } else {
            break;
        }
    }

    TextBufferState {
        text: buffer.text.clone(),
        selection: TextRange::new(start, end),
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

/// Select line at position - PURE FUNCTION
///
/// # Arguments
///
/// * `buffer` - Current buffer state
/// * `position` - Byte index position in text
///
/// # Returns
///
/// New buffer state with line selected. Returns byte indices for the selection.
/// If position is invalid, returns buffer unchanged.
pub fn select_line(buffer: &TextBufferState, position: usize) -> TextBufferState {
    let text = &buffer.text;

    // Ensure position is on a valid char boundary
    let pos = if text.is_char_boundary(position.min(text.len())) {
        position.min(text.len())
    } else {
        floor_char_boundary(text, position.min(text.len()))
    };

    // Find line start (newline before cursor or start of text)
    // rfind returns byte index, which is correct
    let before_slice = match safe_slice_to(text, pos) {
        Ok(s) => s,
        Err(_) => return buffer.clone(),
    };
    let line_start = before_slice
        .rfind('\n')
        .map(|i| i + 1) // +1 is safe because '\n' is 1 byte
        .unwrap_or(0);

    // Find line end (newline after cursor or end of text)
    // find returns byte offset into the slice
    let after_slice = match safe_slice_from(text, pos) {
        Ok(s) => s,
        Err(_) => return buffer.clone(),
    };
    let line_end = after_slice
        .find('\n')
        .map(|i| pos + i)
        .unwrap_or(text.len());

    TextBufferState {
        text: buffer.text.clone(),
        selection: TextRange::new(line_start, line_end),
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

/// Select all text - PURE FUNCTION
pub fn select_all(buffer: &TextBufferState) -> TextBufferState {
    TextBufferState {
        text: buffer.text.clone(),
        selection: TextRange::new(0, buffer.text.len()),
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

/// Move cursor by offset - PURE FUNCTION
pub fn move_cursor(buffer: &TextBufferState, offset: isize, extend: bool) -> TextBufferState {
    let current_pos = if extend {
        buffer.selection.end
    } else {
        buffer.selection.start
    };

    let new_pos = if offset >= 0 {
        (current_pos as isize + offset).min(buffer.text.len() as isize) as usize
    } else {
        (current_pos as isize + offset).max(0) as usize
    };

    let new_selection = if extend {
        TextRange::new(buffer.selection.start, new_pos)
    } else {
        TextRange::new(new_pos, new_pos)
    };

    TextBufferState {
        text: buffer.text.clone(),
        selection: new_selection,
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

/// Get selected text - PURE FUNCTION
///
/// Returns the text within the current selection range.
/// Returns empty string if selection indices are invalid.
pub fn get_selected_text(buffer: &TextBufferState) -> String {
    match safe_slice(&buffer.text, buffer.selection.start, buffer.selection.end) {
        Ok(s) => s.to_string(),
        Err(_) => String::new(),
    }
}

/// Replace selected text - PURE FUNCTION
pub fn replace_selection(buffer: &TextBufferState, text: &str) -> TextBufferState {
    insert_text(buffer, &buffer.selection, text)
}

/// Initialize empty text buffer - PURE FUNCTION
pub fn init_text_buffer(initial_text: &str) -> TextBufferState {
    TextBufferState {
        text: initial_text.to_string(),
        selection: TextRange::new(0, 0),
        composing: None,
        marks: Vec::new(),
    }
}

/// Estimate text size (fallback) - PURE FUNCTION
pub fn estimate_text_size(text: &str, font_size: Option<f64>) -> Size {
    let size = font_size.unwrap_or(16.0);
    let lines: Vec<&str> = text.split('\n').collect();
    let max_line_length = lines.iter().map(|l| l.len()).max().unwrap_or(0);

    Size {
        w: max_line_length as f64 * size * 0.6,
        h: lines.len() as f64 * size * 1.2,
    }
}

// ============================================================================
// Word Navigation
// ============================================================================

/// Check if character is a word character (alphanumeric or underscore)
#[inline]
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Find next word start position - PURE FUNCTION
pub fn find_next_word_start(text: &str, position: usize) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut pos = position.min(chars.len());

    // Skip current word if in one
    while pos < chars.len() && is_word_char(chars[pos]) {
        pos += 1;
    }

    // Skip non-word characters
    while pos < chars.len() && !is_word_char(chars[pos]) {
        pos += 1;
    }

    pos
}

/// Find previous word start position - PURE FUNCTION
pub fn find_prev_word_start(text: &str, position: usize) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut pos = position.min(chars.len());

    // Skip non-word characters behind cursor
    while pos > 0 && !is_word_char(chars[pos - 1]) {
        pos -= 1;
    }

    // Find start of current word
    while pos > 0 && is_word_char(chars[pos - 1]) {
        pos -= 1;
    }

    pos
}

/// Find word end position - PURE FUNCTION
pub fn find_word_end(text: &str, position: usize) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut pos = position.min(chars.len());

    // Skip to end of current word
    while pos < chars.len() && is_word_char(chars[pos]) {
        pos += 1;
    }

    pos
}

/// Move cursor to next word - PURE FUNCTION
pub fn move_to_next_word(buffer: &TextBufferState, extend: bool) -> TextBufferState {
    let current_pos = if extend {
        buffer.selection.end
    } else {
        buffer.selection.start
    };

    let new_pos = find_next_word_start(&buffer.text, current_pos);

    let new_selection = if extend {
        TextRange::new(buffer.selection.start, new_pos)
    } else {
        TextRange::new(new_pos, new_pos)
    };

    TextBufferState {
        text: buffer.text.clone(),
        selection: new_selection,
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

/// Move cursor to previous word - PURE FUNCTION
pub fn move_to_prev_word(buffer: &TextBufferState, extend: bool) -> TextBufferState {
    let current_pos = if extend {
        buffer.selection.end
    } else {
        buffer.selection.start
    };

    let new_pos = find_prev_word_start(&buffer.text, current_pos);

    let new_selection = if extend {
        TextRange::new(buffer.selection.start, new_pos)
    } else {
        TextRange::new(new_pos, new_pos)
    };

    TextBufferState {
        text: buffer.text.clone(),
        selection: new_selection,
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

// ============================================================================
// Line Navigation
// ============================================================================

/// Line information
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineInfo {
    pub line_index: usize,
    pub line_start: usize,
    pub line_end: usize,
    pub line_text: String,
    pub column_index: usize,
}

/// Split text into lines - PURE FUNCTION
pub fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n').collect()
}

/// Get line at position - PURE FUNCTION
pub fn get_line_at_position(text: &str, position: usize) -> LineInfo {
    let lines = split_lines(text);
    let mut offset = 0;

    for (i, line) in lines.iter().enumerate() {
        let line_end = offset + line.len();

        if position <= line_end || i == lines.len() - 1 {
            return LineInfo {
                line_index: i,
                line_start: offset,
                line_end,
                line_text: line.to_string(),
                column_index: (position - offset).min(line.len()),
            };
        }

        offset = line_end + 1; // +1 for newline
    }

    // Fallback (should not reach here)
    let last_line = lines.last().unwrap_or(&"");
    LineInfo {
        line_index: lines.len().saturating_sub(1),
        line_start: text.len() - last_line.len(),
        line_end: text.len(),
        line_text: last_line.to_string(),
        column_index: last_line.len(),
    }
}

/// Get position from line and column - PURE FUNCTION
pub fn get_position_from_line_column(text: &str, line_index: usize, column_index: usize) -> usize {
    let lines = split_lines(text);
    let mut offset = 0;

    for (i, line) in lines.iter().enumerate() {
        if i >= line_index {
            break;
        }
        offset += line.len() + 1; // +1 for newline
    }

    let target_line = lines
        .get(line_index.min(lines.len().saturating_sub(1)))
        .unwrap_or(&"");
    offset + column_index.min(target_line.len())
}

/// Move to line start - PURE FUNCTION
pub fn move_to_line_start(buffer: &TextBufferState, extend: bool) -> TextBufferState {
    let current_pos = if extend {
        buffer.selection.end
    } else {
        buffer.selection.start
    };

    let line_info = get_line_at_position(&buffer.text, current_pos);
    let new_pos = line_info.line_start;

    let new_selection = if extend {
        TextRange::new(buffer.selection.start, new_pos)
    } else {
        TextRange::new(new_pos, new_pos)
    };

    TextBufferState {
        text: buffer.text.clone(),
        selection: new_selection,
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

/// Move to line end - PURE FUNCTION
pub fn move_to_line_end(buffer: &TextBufferState, extend: bool) -> TextBufferState {
    let current_pos = if extend {
        buffer.selection.end
    } else {
        buffer.selection.start
    };

    let line_info = get_line_at_position(&buffer.text, current_pos);
    let new_pos = line_info.line_end;

    let new_selection = if extend {
        TextRange::new(buffer.selection.start, new_pos)
    } else {
        TextRange::new(new_pos, new_pos)
    };

    TextBufferState {
        text: buffer.text.clone(),
        selection: new_selection,
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

/// Move up one line (preserve column) - PURE FUNCTION
pub fn move_up(buffer: &TextBufferState, extend: bool) -> TextBufferState {
    let current_pos = if extend {
        buffer.selection.end
    } else {
        buffer.selection.start
    };

    let line_info = get_line_at_position(&buffer.text, current_pos);

    let new_pos = if line_info.line_index == 0 {
        // Already on first line, move to start
        0
    } else {
        get_position_from_line_column(
            &buffer.text,
            line_info.line_index - 1,
            line_info.column_index,
        )
    };

    let new_selection = if extend {
        TextRange::new(buffer.selection.start, new_pos)
    } else {
        TextRange::new(new_pos, new_pos)
    };

    TextBufferState {
        text: buffer.text.clone(),
        selection: new_selection,
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

/// Move down one line (preserve column) - PURE FUNCTION
pub fn move_down(buffer: &TextBufferState, extend: bool) -> TextBufferState {
    let current_pos = if extend {
        buffer.selection.end
    } else {
        buffer.selection.start
    };

    let line_info = get_line_at_position(&buffer.text, current_pos);
    let lines = split_lines(&buffer.text);

    let new_pos = if line_info.line_index >= lines.len().saturating_sub(1) {
        // Already on last line, move to end
        buffer.text.len()
    } else {
        get_position_from_line_column(
            &buffer.text,
            line_info.line_index + 1,
            line_info.column_index,
        )
    };

    let new_selection = if extend {
        TextRange::new(buffer.selection.start, new_pos)
    } else {
        TextRange::new(new_pos, new_pos)
    };

    TextBufferState {
        text: buffer.text.clone(),
        selection: new_selection,
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

// ============================================================================
// Text Utilities
// ============================================================================

/// Count words in text - PURE FUNCTION
pub fn count_words(text: &str) -> usize {
    text.split_whitespace()
        .filter(|word| word.chars().any(|c| c.is_alphanumeric()))
        .count()
}

/// Count lines in text - PURE FUNCTION
pub fn count_lines(text: &str) -> usize {
    split_lines(text).len()
}

/// Count characters - PURE FUNCTION
pub fn count_chars(text: &str, exclude_whitespace: bool) -> usize {
    if exclude_whitespace {
        text.chars().filter(|c| !c.is_whitespace()).count()
    } else {
        text.len()
    }
}

/// Check if buffer has selection (not just cursor) - PURE FUNCTION
pub fn has_selection(buffer: &TextBufferState) -> bool {
    buffer.selection.start != buffer.selection.end
}

/// Get selection length - PURE FUNCTION
pub fn get_selection_length(buffer: &TextBufferState) -> usize {
    buffer.selection.end.saturating_sub(buffer.selection.start)
}

/// Normalize selection (ensure start <= end) - PURE FUNCTION
pub fn normalize_selection(range: &TextRange) -> TextRange {
    if range.start <= range.end {
        *range
    } else {
        TextRange::new(range.end, range.start)
    }
}

/// Collapse selection to start or end - PURE FUNCTION
pub fn collapse_selection(buffer: &TextBufferState, to_end: bool) -> TextBufferState {
    let pos = if to_end {
        buffer.selection.end
    } else {
        buffer.selection.start
    };

    TextBufferState {
        text: buffer.text.clone(),
        selection: TextRange::new(pos, pos),
        composing: buffer.composing.clone(),
        marks: buffer.marks.clone(),
    }
}

// ============================================================================
// Rich Text Marks
// ============================================================================

/// Helper: adjust marks when text is deleted
fn adjust_marks_for_deletion(
    marks: &[MarkRange],
    delete_start: usize,
    delete_end: usize,
) -> Vec<MarkRange> {
    let delete_len = delete_end.saturating_sub(delete_start);
    marks
        .iter()
        .filter_map(|mark| {
            if mark.end <= delete_start {
                // Mark is entirely before deletion — unchanged
                Some(mark.clone())
            } else if mark.start >= delete_end {
                // Mark is entirely after deletion — shift backward
                Some(MarkRange {
                    mark: mark.mark.clone(),
                    start: mark.start.saturating_sub(delete_len),
                    end: mark.end.saturating_sub(delete_len),
                })
            } else if mark.start >= delete_start && mark.end <= delete_end {
                // Mark is entirely within deletion — remove it
                None
            } else if mark.start < delete_start && mark.end > delete_end {
                // Mark spans the entire deletion — shrink it
                Some(MarkRange {
                    mark: mark.mark.clone(),
                    start: mark.start,
                    end: mark.end.saturating_sub(delete_len),
                })
            } else if mark.start < delete_start && mark.end > delete_start && mark.end <= delete_end
            {
                // Mark starts before, ends within — shrink end
                Some(MarkRange {
                    mark: mark.mark.clone(),
                    start: mark.start,
                    end: delete_start,
                })
            } else {
                // Mark starts within, ends after — shrink and shift
                Some(MarkRange {
                    mark: mark.mark.clone(),
                    start: delete_start,
                    end: mark.end.saturating_sub(delete_len),
                })
            }
        })
        .collect()
}

/// Helper: adjust marks when text is inserted
fn adjust_marks_for_insertion(
    marks: &[MarkRange],
    insert_pos: usize,
    insert_len: usize,
) -> Vec<MarkRange> {
    marks
        .iter()
        .map(|mark| {
            if mark.end <= insert_pos {
                // Mark is entirely before insertion — unchanged
                mark.clone()
            } else if mark.start >= insert_pos {
                // Mark is entirely after insertion — shift forward
                MarkRange {
                    mark: mark.mark.clone(),
                    start: mark.start + insert_len,
                    end: mark.end + insert_len,
                }
            } else {
                // Mark spans insertion point — expand to include inserted text
                MarkRange {
                    mark: mark.mark.clone(),
                    start: mark.start,
                    end: mark.end + insert_len,
                }
            }
        })
        .collect()
}

/// Toggle a mark on a selection range
///
/// If ANY part of the range has the mark, remove it entirely.
/// If NO part of the range has the mark, apply it to the entire range.
///
/// Returns new buffer with updated marks.
pub fn toggle_mark(
    buffer: &TextBufferState,
    range: &TextRange,
    mark_name: &str,
) -> TextBufferState {
    let mark = TextMark(mark_name.to_string());

    // Check if any part of the range already has this mark
    let has_mark = buffer
        .marks
        .iter()
        .any(|m| m.mark == mark && m.end > range.start && m.start < range.end);

    if has_mark {
        remove_mark(buffer, range, mark_name)
    } else {
        apply_mark(buffer, range, mark_name)
    }
}

/// Apply a mark to a range
///
/// Adds the mark to the given range and merges overlapping marks with the same name.
/// Returns new buffer with updated marks.
pub fn apply_mark(buffer: &TextBufferState, range: &TextRange, mark_name: &str) -> TextBufferState {
    let mark = TextMark(mark_name.to_string());
    let mut new_marks = buffer.marks.clone();

    // Add the new mark
    new_marks.push(MarkRange {
        mark: mark.clone(),
        start: range.start,
        end: range.end,
    });

    // Merge overlapping marks with the same name
    new_marks.sort_by_key(|m| m.start);
    let mut merged: Vec<MarkRange> = Vec::new();
    for m in new_marks {
        if let Some(last) = merged.last_mut() {
            if last.mark == m.mark && last.end >= m.start {
                // Merge overlapping/adjacent marks
                last.end = last.end.max(m.end);
            } else {
                merged.push(m);
            }
        } else {
            merged.push(m);
        }
    }

    TextBufferState {
        text: buffer.text.clone(),
        selection: buffer.selection,
        composing: buffer.composing.clone(),
        marks: merged,
    }
}

/// Remove a mark from a range
///
/// If a mark partially overlaps the range, it is split into non-overlapping parts.
/// Empty marks (start == end) are removed entirely.
/// Returns new buffer with updated marks.
pub fn remove_mark(
    buffer: &TextBufferState,
    range: &TextRange,
    mark_name: &str,
) -> TextBufferState {
    let mark = TextMark(mark_name.to_string());
    let new_marks: Vec<MarkRange> = buffer
        .marks
        .iter()
        .flat_map(|m| {
            if m.mark != mark {
                // Different mark type — keep unchanged
                return vec![m.clone()];
            }

            if m.end <= range.start || m.start >= range.end {
                // No overlap — keep unchanged
                vec![m.clone()]
            } else if m.start >= range.start && m.end <= range.end {
                // Entirely within removal range — remove
                vec![]
            } else if m.start < range.start && m.end > range.end {
                // Spans the removal range — split into before and after parts
                vec![
                    MarkRange {
                        mark: m.mark.clone(),
                        start: m.start,
                        end: range.start,
                    },
                    MarkRange {
                        mark: m.mark.clone(),
                        start: range.end,
                        end: m.end,
                    },
                ]
            } else if m.start < range.start {
                // Starts before, ends within — keep start part
                vec![MarkRange {
                    mark: m.mark.clone(),
                    start: m.start,
                    end: range.start,
                }]
            } else {
                // Starts within, ends after — keep end part
                vec![MarkRange {
                    mark: m.mark.clone(),
                    start: range.end,
                    end: m.end,
                }]
            }
        })
        .filter(|m| m.start < m.end)
        .collect();

    TextBufferState {
        text: buffer.text.clone(),
        selection: buffer.selection,
        composing: buffer.composing.clone(),
        marks: new_marks,
    }
}

/// Split a text buffer at the cursor (selection.start) position.
///
/// Returns two new `TextBufferState` values: `(before_cursor, after_cursor)`.
///
/// Text splitting rules:
/// - `before_cursor.text` = text[0..cursor_pos]
/// - `after_cursor.text`  = text[cursor_pos..]
/// - `before_cursor.selection` = cursor at end (cursor_pos, cursor_pos)
/// - `after_cursor.selection`  = cursor at start (0, 0)
///
/// Mark splitting rules:
/// - Mark entirely before cursor (end <= cursor_pos) → stays in `before_cursor` unchanged
/// - Mark entirely after cursor (start >= cursor_pos) → moved to `after_cursor` with offsets
///   shifted by `-cursor_pos` so they remain relative to the new buffer start
/// - Mark spanning cursor (start < cursor_pos && end > cursor_pos) → split into two:
///   `[start, cursor_pos]` in `before_cursor` and `[0, end - cursor_pos]` in `after_cursor`
///
/// The cursor_pos MUST be a valid UTF-8 character boundary. All offsets produced by
/// `insert_text`, `delete_text`, and `set_selection` are guaranteed to be char boundaries.
pub fn split_at_cursor(buffer: &TextBufferState) -> (TextBufferState, TextBufferState) {
    let cursor_pos = buffer.selection.start.min(buffer.text.len());

    // Find the nearest valid UTF-8 boundary at or before cursor_pos
    let split_byte = (0..=cursor_pos)
        .rev()
        .find(|&i| buffer.text.is_char_boundary(i))
        .unwrap_or(0);

    let text_before = &buffer.text[..split_byte];
    let text_after = &buffer.text[split_byte..];

    let mut marks_before: Vec<MarkRange> = Vec::new();
    let mut marks_after: Vec<MarkRange> = Vec::new();

    for m in &buffer.marks {
        if m.end <= split_byte {
            // Entirely before split point — stays in first buffer unchanged
            marks_before.push(m.clone());
        } else if m.start >= split_byte {
            // Entirely after split point — move to second buffer, shift offsets
            marks_after.push(MarkRange {
                mark: m.mark.clone(),
                start: m.start - split_byte,
                end: m.end - split_byte,
            });
        } else {
            // Spans the split point — divide into two parts
            if m.start < split_byte {
                marks_before.push(MarkRange {
                    mark: m.mark.clone(),
                    start: m.start,
                    end: split_byte,
                });
            }
            if m.end > split_byte {
                marks_after.push(MarkRange {
                    mark: m.mark.clone(),
                    start: 0,
                    end: m.end - split_byte,
                });
            }
        }
    }

    let before = TextBufferState {
        text: text_before.to_string(),
        selection: TextRange::new(split_byte, split_byte),
        composing: None,
        marks: marks_before,
    };
    let after = TextBufferState {
        text: text_after.to_string(),
        selection: TextRange::new(0, 0),
        composing: None,
        marks: marks_after,
    };
    (before, after)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_text_buffer() {
        let buffer = init_text_buffer("hello");
        assert_eq!(buffer.text, "hello");
        assert_eq!(buffer.selection, TextRange::new(0, 0));
        assert!(buffer.composing.is_none());
    }

    #[test]
    fn test_insert_text() {
        let buffer = init_text_buffer("hello world");
        let result = insert_text(&buffer, &TextRange::new(5, 5), " beautiful");
        assert_eq!(result.text, "hello beautiful world");
        assert_eq!(result.selection, TextRange::new(15, 15));
    }

    #[test]
    fn test_delete_text() {
        let buffer = init_text_buffer("hello world");
        let result = delete_text(&buffer, &TextRange::new(5, 11));
        assert_eq!(result.text, "hello");
        assert_eq!(result.selection, TextRange::new(5, 5));
    }

    #[test]
    fn test_select_word() {
        let buffer = TextBufferState {
            text: "hello world".to_string(),
            selection: TextRange::new(7, 7), // cursor in "world"
            composing: None,
            marks: Vec::new(),
        };
        let result = select_word(&buffer, 7);
        assert_eq!(result.selection, TextRange::new(6, 11)); // "world"
    }

    #[test]
    fn test_select_line() {
        let buffer = init_text_buffer("line1\nline2\nline3");
        let result = select_line(&buffer, 8); // cursor in "line2"
        assert_eq!(result.selection, TextRange::new(6, 11)); // "line2"
    }

    #[test]
    fn test_select_all() {
        let buffer = init_text_buffer("hello world");
        let result = select_all(&buffer);
        assert_eq!(result.selection, TextRange::new(0, 11));
    }

    #[test]
    fn test_move_cursor() {
        let buffer = TextBufferState {
            text: "hello".to_string(),
            selection: TextRange::new(2, 2),
            composing: None,
            marks: Vec::new(),
        };

        let result = move_cursor(&buffer, 2, false);
        assert_eq!(result.selection, TextRange::new(4, 4));

        let result = move_cursor(&buffer, -1, false);
        assert_eq!(result.selection, TextRange::new(1, 1));

        // Extend selection
        let result = move_cursor(&buffer, 2, true);
        assert_eq!(result.selection, TextRange::new(2, 4));
    }

    #[test]
    fn test_word_navigation() {
        let text = "hello world test";

        assert_eq!(find_next_word_start(text, 0), 6); // After "hello ", at "world"
        assert_eq!(find_next_word_start(text, 6), 12); // After "world ", at "test"

        assert_eq!(find_prev_word_start(text, 11), 6); // Start of "world"
        assert_eq!(find_prev_word_start(text, 6), 0); // Start of "hello"

        assert_eq!(find_word_end(text, 0), 5); // End of "hello"
    }

    #[test]
    fn test_line_navigation() {
        let text = "line1\nline2\nline3";

        let info = get_line_at_position(text, 8); // In "line2"
        assert_eq!(info.line_index, 1);
        assert_eq!(info.line_start, 6);
        assert_eq!(info.line_end, 11);
        assert_eq!(info.line_text, "line2");
        assert_eq!(info.column_index, 2);

        assert_eq!(get_position_from_line_column(text, 0, 3), 3);
        assert_eq!(get_position_from_line_column(text, 1, 2), 8);
    }

    #[test]
    fn test_move_up_down() {
        let buffer = TextBufferState {
            text: "line1\nline2\nline3".to_string(),
            selection: TextRange::new(8, 8), // In "line2", column 2
            composing: None,
            marks: Vec::new(),
        };

        let up = move_up(&buffer, false);
        assert_eq!(up.selection.start, 2); // Same column in line1

        let down = move_down(&buffer, false);
        assert_eq!(down.selection.start, 14); // Same column in line3
    }

    #[test]
    fn test_count_functions() {
        let text = "hello world\ntest line";

        assert_eq!(count_words(text), 4);
        assert_eq!(count_lines(text), 2);
        assert_eq!(count_chars(text, false), 21);
        // Excluding whitespace: "helloworld" (10) + "testline" (8) = 18
        assert_eq!(count_chars(text, true), 18);
    }

    #[test]
    fn test_has_selection() {
        let collapsed = TextBufferState {
            text: "test".to_string(),
            selection: TextRange::new(2, 2),
            composing: None,
            marks: Vec::new(),
        };
        assert!(!has_selection(&collapsed));

        let selected = TextBufferState {
            text: "test".to_string(),
            selection: TextRange::new(1, 3),
            composing: None,
            marks: Vec::new(),
        };
        assert!(has_selection(&selected));
    }

    #[test]
    fn test_normalize_selection() {
        let normal = TextRange::new(1, 5);
        assert_eq!(normalize_selection(&normal), TextRange::new(1, 5));

        let reversed = TextRange::new(5, 1);
        assert_eq!(normalize_selection(&reversed), TextRange::new(1, 5));
    }

    #[test]
    fn test_ime_composition() {
        let buffer = init_text_buffer("hello");

        let started = start_composition(&buffer, TextRange::new(5, 5));
        assert!(started.composing.is_some());
        assert_eq!(started.composing.as_ref().unwrap().text, "");

        let updated = update_composition(&started, " world");
        assert_eq!(updated.composing.as_ref().unwrap().text, " world");

        let committed = commit_composition(&updated);
        assert_eq!(committed.text, "hello world");
        assert!(committed.composing.is_none());
    }

    #[test]
    fn test_estimate_text_size() {
        let size = estimate_text_size("hello\nworld", Some(16.0));
        assert!(size.w > 0.0);
        assert!(size.h > 0.0);
    }

    // ========================================================================
    // UNICODE CONFORMANCE TESTS
    // ========================================================================
    //
    // These tests verify correct handling of multi-byte UTF-8 characters.
    // All indices in this module are BYTE indices, not character indices.

    #[test]
    fn test_unicode_insert_text_japanese() {
        // "日本語" is 3 characters, 9 bytes (3 bytes per character)
        let buffer = init_text_buffer("日本語");
        assert_eq!(buffer.text.len(), 9); // Verify byte count

        // Insert "X" after first character (at byte index 3)
        let result = insert_text(&buffer, &TextRange::new(3, 3), "X");
        assert_eq!(result.text, "日X本語");
        assert_eq!(result.selection, TextRange::new(4, 4)); // After "X"
    }

    #[test]
    fn test_unicode_delete_text_japanese() {
        let buffer = init_text_buffer("日本語");

        // Delete the middle character "本" (bytes 3-6)
        let result = delete_text(&buffer, &TextRange::new(3, 6));
        assert_eq!(result.text, "日語");
    }

    #[test]
    fn test_unicode_insert_text_emoji() {
        // "👨‍👩‍👧" is a family emoji (ZWJ sequence), complex multi-byte
        let buffer = init_text_buffer("Hello 👨‍👩‍👧 World");

        // Insert after "Hello " (6 bytes)
        let result = insert_text(&buffer, &TextRange::new(6, 6), "!");
        assert!(result.text.starts_with("Hello !"));
    }

    #[test]
    fn test_unicode_select_word_japanese() {
        // Japanese text: "こんにちは世界" (Hello World)
        let buffer = init_text_buffer("こんにちは世界");

        // Position in the middle - should select all (no spaces in Japanese)
        let result = select_word(&buffer, 9); // In the middle
                                              // Japanese characters are alphanumeric, so should select whole word
        assert!(result.selection.end > result.selection.start);
    }

    #[test]
    fn test_unicode_mixed_ascii_and_cjk() {
        let buffer = init_text_buffer("Hello世界World");

        // Insert at boundary between ASCII and CJK
        let result = insert_text(&buffer, &TextRange::new(5, 5), "!");
        assert_eq!(result.text, "Hello!世界World");
    }

    #[test]
    fn test_unicode_safe_slice_invalid_boundary() {
        // Test that safe_slice returns error for invalid byte boundaries
        let text = "日本語"; // 9 bytes

        // Trying to slice at byte 1 (middle of first character) should error
        let result = safe_slice(text, 1, 4);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            TextError::NotCharBoundary { index: 1 }
        ));

        // Valid boundaries work
        let result = safe_slice(text, 0, 3);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "日");
    }

    #[test]
    fn test_unicode_char_to_byte_index() {
        let text = "日本語"; // 3 chars, 9 bytes

        assert_eq!(char_to_byte_index(text, 0), 0);
        assert_eq!(char_to_byte_index(text, 1), 3);
        assert_eq!(char_to_byte_index(text, 2), 6);
        assert_eq!(char_to_byte_index(text, 3), 9); // End
        assert_eq!(char_to_byte_index(text, 100), 9); // Beyond end
    }

    #[test]
    fn test_unicode_byte_to_char_index() {
        let text = "日本語"; // 3 chars, 9 bytes

        assert_eq!(byte_to_char_index(text, 0), 0);
        assert_eq!(byte_to_char_index(text, 3), 1);
        assert_eq!(byte_to_char_index(text, 6), 2);
        assert_eq!(byte_to_char_index(text, 9), 3);
    }

    #[test]
    fn test_unicode_get_selected_text() {
        let buffer = TextBufferState {
            text: "日本語".to_string(),
            selection: TextRange::new(3, 6), // Middle character
            composing: None,
            marks: Vec::new(),
        };

        let selected = get_selected_text(&buffer);
        assert_eq!(selected, "本");
    }

    #[test]
    fn test_unicode_select_line_with_cjk() {
        let buffer = init_text_buffer("Hello世界\n日本語\nWorld");

        // Select line containing Japanese
        let result = select_line(&buffer, 15); // In "日本語" line
        let selected = get_selected_text(&result);
        assert_eq!(selected, "日本語");
    }

    // ========================================================================
    // UTF-8 SAFETY TESTS - Structured Error Handling
    // ========================================================================
    //
    // These tests verify that safe_slice returns proper errors instead of
    // silently adjusting or panicking.

    #[test]
    fn test_safe_slice_valid_ascii() {
        let text = "hello";
        assert_eq!(safe_slice(text, 0, 5).unwrap(), "hello");
        assert_eq!(safe_slice(text, 1, 4).unwrap(), "ell");
        assert_eq!(safe_slice(text, 0, 0).unwrap(), "");
        assert_eq!(safe_slice(text, 5, 5).unwrap(), "");
    }

    #[test]
    fn test_safe_slice_emoji_valid_boundary() {
        let text = "a😀b"; // 😀 is 4 bytes: 'a' at 0, 😀 at 1-5, 'b' at 5
        assert_eq!(safe_slice(text, 0, 1).unwrap(), "a");
        assert_eq!(safe_slice(text, 1, 5).unwrap(), "😀");
        assert_eq!(safe_slice(text, 5, 6).unwrap(), "b");
        assert_eq!(safe_slice(text, 0, 6).unwrap(), "a😀b");
    }

    #[test]
    fn test_safe_slice_emoji_invalid_boundary() {
        let text = "a😀b";
        // Index 2, 3, 4 are in the middle of 😀
        let result = safe_slice(text, 0, 2);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            TextError::NotCharBoundary { index: 2 }
        ));

        let result = safe_slice(text, 0, 3);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            TextError::NotCharBoundary { index: 3 }
        ));

        let result = safe_slice(text, 2, 6);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            TextError::NotCharBoundary { index: 2 }
        ));
    }

    #[test]
    fn test_safe_slice_out_of_bounds() {
        let text = "abc";
        let result = safe_slice(text, 0, 10);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            TextError::OutOfBounds { index: 10, len: 3 }
        ));
    }

    #[test]
    fn test_safe_slice_invalid_range() {
        let text = "abc";
        let result = safe_slice(text, 3, 1); // start > end
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            TextError::InvalidRange { start: 3, end: 1 }
        ));
    }

    #[test]
    fn test_safe_slice_zwj_family_emoji() {
        // 👨‍👩‍👧‍👦 is a ZWJ sequence: multiple codepoints joined
        // It's 25 bytes total
        let text = "👨‍👩‍👧‍👦";
        let len = text.len();
        assert_eq!(len, 25);

        // Full slice works
        assert!(safe_slice(text, 0, len).is_ok());

        // Slicing at byte 1 (middle of first emoji) should fail
        let result = safe_slice(text, 0, 1);
        assert!(result.is_err());
    }

    #[test]
    fn test_safe_slice_cjk_characters() {
        // Each CJK character is 3 bytes
        let text = "中文字"; // 9 bytes
        assert_eq!(safe_slice(text, 0, 3).unwrap(), "中");
        assert_eq!(safe_slice(text, 3, 6).unwrap(), "文");
        assert_eq!(safe_slice(text, 6, 9).unwrap(), "字");

        // Invalid boundary
        let result = safe_slice(text, 0, 2);
        assert!(result.is_err());
    }

    #[test]
    fn test_safe_slice_accented_characters() {
        // é (e + combining accent) vs é (precomposed) can have different byte lengths
        let precomposed = "café"; // 5 chars but é is 2 bytes
        assert_eq!(precomposed.len(), 5);

        // Valid slice up to 'f'
        assert_eq!(safe_slice(precomposed, 0, 3).unwrap(), "caf");

        // The é is at byte 3-4
        assert_eq!(safe_slice(precomposed, 3, 5).unwrap(), "é");
    }

    #[test]
    fn test_text_error_display_and_codes() {
        let err = TextError::InvalidRange { start: 5, end: 2 };
        assert_eq!(err.code(), "TEXT_ERR_001");
        assert!(format!("{}", err).contains("[TEXT_ERR_001]"));
        assert!(format!("{}", err).contains("start 5 > end 2"));
        assert!(format!("{}", err).contains("Fix:"));

        let err = TextError::OutOfBounds { index: 10, len: 5 };
        assert_eq!(err.code(), "TEXT_ERR_002");
        assert!(format!("{}", err).contains("[TEXT_ERR_002]"));
        assert!(format!("{}", err).contains("out of bounds"));

        let err = TextError::NotCharBoundary { index: 3 };
        assert_eq!(err.code(), "TEXT_ERR_003");
        assert!(format!("{}", err).contains("[TEXT_ERR_003]"));
        assert!(format!("{}", err).contains("floor_char_boundary"));
    }

    #[test]
    fn test_floor_ceil_char_boundary() {
        let text = "a😀b"; // 'a' at 0, 😀 at 1-5, 'b' at 5

        // floor_char_boundary finds boundary <= index
        assert_eq!(floor_char_boundary(text, 0), 0);
        assert_eq!(floor_char_boundary(text, 1), 1);
        assert_eq!(floor_char_boundary(text, 2), 1); // rounds down to emoji start
        assert_eq!(floor_char_boundary(text, 3), 1);
        assert_eq!(floor_char_boundary(text, 4), 1);
        assert_eq!(floor_char_boundary(text, 5), 5);
        assert_eq!(floor_char_boundary(text, 6), 6);
        assert_eq!(floor_char_boundary(text, 100), 6); // beyond end

        // ceil_char_boundary finds boundary >= index
        assert_eq!(ceil_char_boundary(text, 0), 0);
        assert_eq!(ceil_char_boundary(text, 1), 1);
        assert_eq!(ceil_char_boundary(text, 2), 5); // rounds up to emoji end
        assert_eq!(ceil_char_boundary(text, 3), 5);
        assert_eq!(ceil_char_boundary(text, 4), 5);
        assert_eq!(ceil_char_boundary(text, 5), 5);
        assert_eq!(ceil_char_boundary(text, 6), 6);
        assert_eq!(ceil_char_boundary(text, 100), 6); // beyond end
    }

    // ========================================================================
    // Rich Text Mark Tests
    // ========================================================================

    #[test]
    fn test_toggle_mark_applies_to_selection() {
        let buffer = init_text_buffer("hello");
        let result = toggle_mark(&buffer, &TextRange::new(0, 5), "x");
        assert_eq!(result.marks.len(), 1);
        assert_eq!(result.marks[0].mark.0, "x");
        assert_eq!(result.marks[0].start, 0);
        assert_eq!(result.marks[0].end, 5);
    }

    #[test]
    fn test_toggle_mark_removes_existing() {
        let buffer = init_text_buffer("hello");
        let marked = toggle_mark(&buffer, &TextRange::new(0, 5), "x");
        assert_eq!(marked.marks.len(), 1);

        let unmarked = toggle_mark(&marked, &TextRange::new(0, 5), "x");
        assert!(unmarked.marks.is_empty());
    }

    #[test]
    fn test_apply_mark_merges_adjacent() {
        let buffer = init_text_buffer("hello world");
        let result1 = apply_mark(&buffer, &TextRange::new(0, 3), "x");
        let result2 = apply_mark(&result1, &TextRange::new(3, 5), "x");
        assert_eq!(result2.marks.len(), 1);
        assert_eq!(result2.marks[0].start, 0);
        assert_eq!(result2.marks[0].end, 5);
    }

    #[test]
    fn test_remove_mark_splits_range() {
        let buffer = init_text_buffer("hello world");
        let marked = apply_mark(&buffer, &TextRange::new(0, 10), "x");
        let result = remove_mark(&marked, &TextRange::new(3, 7), "x");
        assert_eq!(result.marks.len(), 2);
        assert_eq!(result.marks[0].start, 0);
        assert_eq!(result.marks[0].end, 3);
        assert_eq!(result.marks[1].start, 7);
        assert_eq!(result.marks[1].end, 10);
    }

    #[test]
    fn test_insert_inherits_mark() {
        let buffer = init_text_buffer("hello");
        let marked = apply_mark(&buffer, &TextRange::new(0, 5), "x");
        let result = insert_text(&marked, &TextRange::new(3, 3), "X");
        assert_eq!(result.marks.len(), 1);
        assert_eq!(result.marks[0].start, 0);
        assert_eq!(result.marks[0].end, 6); // Mark expanded
    }

    #[test]
    fn test_delete_adjusts_marks() {
        let buffer = init_text_buffer("hello world");
        let marked = apply_mark(&buffer, &TextRange::new(5, 11), "x");
        let result = delete_text(&marked, &TextRange::new(0, 3));
        assert_eq!(result.marks.len(), 1);
        assert_eq!(result.marks[0].start, 2);
        assert_eq!(result.marks[0].end, 8); // Shifted backward
    }

    #[test]
    fn test_delete_shrinks_overlapping_mark() {
        let buffer = init_text_buffer("hello world");
        let marked = apply_mark(&buffer, &TextRange::new(0, 10), "x");
        let result = delete_text(&marked, &TextRange::new(3, 7));
        assert_eq!(result.marks.len(), 1);
        assert_eq!(result.marks[0].start, 0);
        assert_eq!(result.marks[0].end, 6); // Shrunk
    }

    #[test]
    fn test_multiple_marks_overlap() {
        let buffer = init_text_buffer("hello world");
        let result1 = apply_mark(&buffer, &TextRange::new(0, 5), "x");
        let result2 = apply_mark(&result1, &TextRange::new(2, 8), "y");
        assert_eq!(result2.marks.len(), 2);

        let mark_x = result2.marks.iter().find(|m| m.mark.0 == "x").unwrap();
        let mark_y = result2.marks.iter().find(|m| m.mark.0 == "y").unwrap();
        assert_eq!(mark_x.start, 0);
        assert_eq!(mark_x.end, 5);
        assert_eq!(mark_y.start, 2);
        assert_eq!(mark_y.end, 8);
    }

    #[test]
    fn test_mark_name_agnostic() {
        let buffer = init_text_buffer("hello");
        let result = toggle_mark(&buffer, &TextRange::new(0, 5), "test_custom_mark_xyz");
        assert_eq!(result.marks.len(), 1);
        assert_eq!(result.marks[0].mark.0, "test_custom_mark_xyz");
    }

    #[test]
    fn test_empty_mark_range_removed() {
        let buffer = init_text_buffer("hello");
        let marked = apply_mark(&buffer, &TextRange::new(0, 5), "x");
        let result = remove_mark(&marked, &TextRange::new(0, 5), "x");
        assert!(result.marks.is_empty());
    }

    // ========================================================================
    // Task 0558: J-00c — split_at_cursor tests
    // ========================================================================

    #[test]
    fn test_split_at_cursor_middle() {
        // "hello world" split at byte 5 → "hello" and " world"
        let buffer = set_selection(&init_text_buffer("hello world"), TextRange::new(5, 5));
        let (before, after) = split_at_cursor(&buffer);
        assert_eq!(before.text, "hello");
        assert_eq!(after.text, " world");
        assert_eq!(before.selection, TextRange::new(5, 5));
        assert_eq!(after.selection, TextRange::new(0, 0));
    }

    #[test]
    fn test_split_at_cursor_start() {
        // cursor at 0 → "" and full text
        let buffer = set_selection(&init_text_buffer("hello"), TextRange::new(0, 0));
        let (before, after) = split_at_cursor(&buffer);
        assert_eq!(before.text, "");
        assert_eq!(after.text, "hello");
    }

    #[test]
    fn test_split_at_cursor_end() {
        // cursor at end → full text and ""
        let buffer = set_selection(&init_text_buffer("hello"), TextRange::new(5, 5));
        let (before, after) = split_at_cursor(&buffer);
        assert_eq!(before.text, "hello");
        assert_eq!(after.text, "");
    }

    #[test]
    fn test_split_preserves_marks_before() {
        // Mark [0,3] on "hello world", split at 5 → mark stays in before buffer
        let buffer = set_selection(
            &apply_mark(&init_text_buffer("hello world"), &TextRange::new(0, 3), "x"),
            TextRange::new(5, 5),
        );
        let (before, after) = split_at_cursor(&buffer);
        assert_eq!(before.marks.len(), 1);
        assert_eq!(before.marks[0].start, 0);
        assert_eq!(before.marks[0].end, 3);
        assert!(after.marks.is_empty());
    }

    #[test]
    fn test_split_preserves_marks_after() {
        // Mark [6,11] on "hello world", split at 5 → mark shifts to [1,6] in after buffer
        let buffer = set_selection(
            &apply_mark(
                &init_text_buffer("hello world"),
                &TextRange::new(6, 11),
                "y",
            ),
            TextRange::new(5, 5),
        );
        let (before, after) = split_at_cursor(&buffer);
        assert!(before.marks.is_empty());
        assert_eq!(after.marks.len(), 1);
        assert_eq!(after.marks[0].start, 1);
        assert_eq!(after.marks[0].end, 6);
    }

    #[test]
    fn test_split_divides_spanning_mark() {
        // Mark [2,8] on "hello world", split at 5 → [2,5] in before, [0,3] in after
        let buffer = set_selection(
            &apply_mark(&init_text_buffer("hello world"), &TextRange::new(2, 8), "x"),
            TextRange::new(5, 5),
        );
        let (before, after) = split_at_cursor(&buffer);
        assert_eq!(before.marks.len(), 1);
        assert_eq!(before.marks[0].start, 2);
        assert_eq!(before.marks[0].end, 5);
        assert_eq!(after.marks.len(), 1);
        assert_eq!(after.marks[0].start, 0);
        assert_eq!(after.marks[0].end, 3);
    }

    #[test]
    fn test_split_unicode() {
        // "hé" is 3 bytes (h=1, é=2). Split after 'h' at byte 1.
        // "hé" → "h" and "é"
        let s = "hé";
        assert_eq!(s.len(), 3); // confirm byte length
        let buffer = set_selection(&init_text_buffer(s), TextRange::new(1, 1));
        let (before, after) = split_at_cursor(&buffer);
        assert_eq!(before.text, "h");
        assert_eq!(after.text, "é");
    }
}
