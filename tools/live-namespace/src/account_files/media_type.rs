// src/account_files/media_type.rs
//
// Purpose: What type a file is. This module is the one owner of that decision: the write path records the type it decides (a
// whole file's write, and a pieced upload's finish), the backfill corrects the records that kept none (`retype_files`), and the
// share route reads the name's ending through here, so no caller keeps a guess of its own. The rules are DATA (settings.json
// `media_type`): the type the first bytes say (`types_by_content`), else the type of the name's ending (`types_by_ending`), else
// application/octet-stream.
//
// Non-Negotiable Invariants:
// - A type is decided from the file's own first bytes and name only. A caller's type is kept when it says something; only a
//   missing type or application/octet-stream is decided here.
// - A decided type is a plain type: a whole type with a slash and no control characters.
// - Shipped rules are checked by `MediaTypes::valid` at the first read of the settings: a rule with no bytes, odd hex, bytes past
//   the head that is read, or a type without a slash stops the process, so no bad rule can answer a type.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::settings::settings;
use serde::Deserialize;
use std::collections::BTreeMap;

/// The type of a file whose bytes and name say nothing.
pub const UNKNOWN: &str = "application/octet-stream";

/// `settings.json` `media_type`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaTypes {
    #[serde(rename = "_what")]
    _what: String,
    /// How much of a file's start is read to decide its type.
    pub head_bytes: usize,
    /// How many file records one `retype_files` page reads.
    pub retype_page: usize,
    /// The type a file's first bytes say, in order: the first rule that matches answers.
    pub types_by_content: Vec<Signature>,
    /// The type of a name's ending (`.mp4` → `video/mp4`), matched without regard to case; the longest ending that matches wins.
    pub types_by_ending: BTreeMap<String, String>,
}

/// One rule of the first bytes: `hex` at `offset` (or anywhere in the head with `find`) names `type`, unless one of its `refine`
/// rules matches first, which names that rule's type. A rule with no `type` answers only through its refinements.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signature {
    pub offset: usize,
    pub hex: String,
    #[serde(default)]
    pub find: bool,
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub refine: Vec<Signature>,
}

impl Signature {
    /// The type this rule and its refinements give the head, when the head holds its bytes.
    fn kind_of(&self, head: &[u8]) -> Option<String> {
        let bytes = bytes_of(&self.hex)?;
        let found = if self.find {
            head.windows(bytes.len()).any(|window| window == bytes.as_slice())
        } else {
            head.get(self.offset..self.offset + bytes.len()) == Some(bytes.as_slice())
        };
        if !found {
            return None;
        }
        self.refine.iter().find_map(|refinement| refinement.kind_of(head)).or_else(|| self.kind.clone())
    }

    /// Whether every rule of this one (and its refinements) is well formed.
    fn valid(&self, head_bytes: usize) -> bool {
        let Some(bytes) = bytes_of(&self.hex) else { return false };
        let reach_ok = self.find || self.offset + bytes.len() <= head_bytes;
        reach_ok && self.kind.as_deref().is_none_or(plain)
            && (self.kind.is_some() || !self.refine.is_empty())
            && self.refine.iter().all(|refinement| refinement.valid(head_bytes))
    }
}

impl MediaTypes {
    /// Whether the shipped rules are well formed (checked at the first read of the settings).
    pub fn valid(&self) -> bool {
        (16..=4096).contains(&self.head_bytes)
            && (1..=crate::store::MAX_PAGE_ITEMS).contains(&self.retype_page)
            && self.types_by_content.iter().all(|rule| rule.valid(self.head_bytes))
            && endings_valid(&self.types_by_ending)
    }
}

/// The shipped rules.
fn shipped() -> &'static MediaTypes {
    &settings().media_type
}

/// The bytes of a hex text (even length, hex digits only), or None.
fn bytes_of(hex: &str) -> Option<Vec<u8>> {
    if hex.is_empty() || !hex.is_ascii() || hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).ok()).collect()
}

/// A whole media type: a type and a subtype with one slash between them, and no control characters or spaces.
fn plain(kind: &str) -> bool {
    kind.split_once('/').is_some_and(|(top, sub)| !top.is_empty() && !sub.is_empty() && !sub.contains('/'))
        && kind.chars().all(|c| !c.is_control() && c != ' ')
}

/// Whether a stored type says nothing: missing, empty, or application/octet-stream (its parameters aside).
pub fn is_unknown(media_type: &str) -> bool {
    let bare = media_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    bare.is_empty() || bare == UNKNOWN
}

/// The type a name's ending gives (the shared `types_by_ending`); None when no ending is known.
pub fn by_ending(name: &str) -> Option<String> {
    by_ending_in(&shipped().types_by_ending, name)
}

/// The type a name's ending gives in `types` (a map of endings to types, such as a computer's own override), the longest ending
/// that matches, without regard to case; None when no ending matches.
pub fn by_ending_in(types: &BTreeMap<String, String>, name: &str) -> Option<String> {
    let leaf = name.rsplit('/').next().unwrap_or_default().to_ascii_lowercase();
    types.iter().filter(|(ending, _)| leaf.ends_with(&ending.to_ascii_lowercase()))
        .max_by_key(|(ending, _)| ending.len()).map(|(_, kind)| kind.to_ascii_lowercase())
}

/// Whether a map of endings to types is well formed: each ending a dot and at least one more character, with no control characters,
/// spaces or slashes; each type a plain media type.
pub fn endings_valid(types: &BTreeMap<String, String>) -> bool {
    types.iter().all(|(ending, kind)| ending.starts_with('.') && ending.len() >= 2 && ending.is_ascii()
        && !ending.chars().any(|c| c.is_control() || c.is_whitespace() || c == '/') && plain(kind))
}

/// The type of a file from its first bytes (`head`, read up to `head_bytes`), else its name's ending, else `UNKNOWN`.
pub fn decide(name: &str, head: &[u8]) -> String {
    let head = head_of(head);
    shipped().types_by_content.iter().find_map(|rule| rule.kind_of(head))
        .or_else(|| by_ending(name))
        .unwrap_or_else(|| UNKNOWN.to_owned())
}

/// The type a write records: the caller's type when it says something, else the type decided from the file's bytes and name.
pub fn recorded(name: &str, bytes: &[u8], given: &str) -> String {
    if is_unknown(given) { decide(name, bytes) } else { given.to_owned() }
}

/// How many bytes of a file's start decide its type (`head_bytes`).
pub fn head_length() -> usize {
    shipped().head_bytes
}

/// The most bytes of a file's start a decision reads: the first `head_bytes`.
pub fn head_of(bytes: &[u8]) -> &[u8] {
    &bytes[..bytes.len().min(shipped().head_bytes)]
}

/// The head as the hex text an upload row keeps it in.
pub fn head_hex(head: &[u8]) -> String {
    head.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The head an upload row keeps (`head_hex`); empty when it keeps none.
pub fn head_from_hex(hex: &str) -> Vec<u8> {
    bytes_of(hex).unwrap_or_default()
}

/// How many file records one `retype_files` page reads (DATA `media_type.retype_page`).
pub fn retype_page() -> usize {
    shipped().retype_page
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An ISO-BMFF head: a size, `ftyp`, the major brand, and a minor version.
    fn ftyp(brand: &str) -> Vec<u8> {
        let mut head = vec![0, 0, 0, 0x18];
        head.extend_from_slice(b"ftyp");
        head.extend_from_slice(brand.as_bytes());
        head.extend_from_slice(&[0, 0, 0, 0]);
        head
    }

    #[test]
    fn the_shipped_rules_read_and_hold() {
        assert!(settings().media_type.valid());
    }

    #[test]
    fn a_quicktime_brand_answers_quicktime_and_any_other_mp4_brand_answers_mp4() {
        assert_eq!(decide("", &ftyp("qt  ")), "video/quicktime");
        assert_eq!(decide("", &ftyp("isom")), "video/mp4");
        assert_eq!(decide("", &ftyp("M4A ")), "audio/mp4");
        assert_eq!(decide("", &ftyp("heic")), "image/heic");
    }

    #[test]
    fn a_container_with_a_second_word_answers_that_word_or_nothing_by_content() {
        let mut wave = b"RIFF\x24\x00\x00\x00WAVE".to_vec();
        wave.extend_from_slice(&[0; 8]);
        assert_eq!(decide("", &wave), "audio/wav");
        let webp = b"RIFF\x00\x00\x00\x00WEBPVP8 ".to_vec();
        assert_eq!(decide("", &webp), "image/webp");
        assert_eq!(decide("/x.bin", b"RIFF\x00\x00\x00\x00ZZZZ"), UNKNOWN, "a RIFF with no word the rules name is unknown");
    }

    #[test]
    fn a_matroska_head_is_webm_when_its_doctype_says_so() {
        let mut webm = vec![0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84];
        webm.extend_from_slice(b"webm");
        assert_eq!(decide("", &webm), "video/webm");
        let mkv = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88, b'm', b'a', b't', b'r', b'o', b's', b'k', b'a'];
        assert_eq!(decide("", &mkv), "video/x-matroska");
    }

    #[test]
    fn content_decides_before_the_ending_and_the_ending_decides_an_unknown_head() {
        let jpeg = [0xff, 0xd8, 0xff, 0xe0];
        assert_eq!(decide("/Photos/a.mp4", &jpeg), "image/jpeg");
        assert_eq!(decide("/Recordings/C9058.MP4", b"original camera bytes"), "video/mp4", "the ending is matched without regard to case");
        assert_eq!(decide("/Shared/blob.qqq", b"\x00\x01\x02"), UNKNOWN);
        assert_eq!(decide("/Notes/readme.txt", b""), "text/plain");
    }

    #[test]
    fn only_a_missing_or_octet_stream_type_is_decided_and_a_stated_one_is_kept() {
        assert!(is_unknown(""));
        assert!(is_unknown("application/octet-stream; charset=binary"));
        assert!(!is_unknown("video/mp4"));
        assert_eq!(recorded("/a.bin", &ftyp("qt  "), "video/mp4"), "video/mp4", "a stated type is kept");
        assert_eq!(recorded("/a.bin", &ftyp("qt  "), UNKNOWN), "video/quicktime");
    }

    #[test]
    fn a_rule_that_is_not_well_formed_is_refused() {
        let good = |hex: &str, kind: Option<&str>| Signature { offset: 0, hex: hex.to_owned(), find: false, kind: kind.map(str::to_owned), refine: Vec::new() };
        assert!(good("ffd8ff", Some("image/jpeg")).valid(64));
        assert!(!good("ffd", Some("image/jpeg")).valid(64), "odd hex");
        assert!(!good("", Some("image/jpeg")).valid(64), "no bytes");
        assert!(!good("ffd8ff", Some("jpeg")).valid(64), "a type with no slash");
        assert!(!good("ffd8ff", None).valid(64), "a rule that names no type and no refinement answers nothing");
        assert!(!Signature { offset: 62, hex: "ffd8ff".into(), find: false, kind: Some("image/jpeg".into()), refine: Vec::new() }.valid(64), "bytes past the head");
    }
}
