//! The seed regression corpus: each row (`src/account/computers/simulation/seed-corpus.json`) is a scenario, a seed and
//! the BLAKE3 of the trace that run produced. Replaying a row must give the same trace, so a seed that once failed is
//! run again on every CI pass.

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CorpusRow {
    pub scenario: String,
    pub seed: u64,
    pub trace_blake3: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Corpus {
    format: String,
    about: String,
    rows: Vec<CorpusRow>,
}

pub fn load(json: &str) -> Vec<CorpusRow> {
    let corpus: Corpus = serde_json::from_str(json).expect("seed corpus parses");
    assert_eq!(corpus.format, "deterministic-world-seed-corpus/1", "unknown seed corpus format");
    assert!(!corpus.about.is_empty(), "the seed corpus names its purpose");
    corpus.rows
}

/// The BLAKE3 identity of a trace, through the one content-identity owner.
pub fn trace_blake3(trace: &[String]) -> String {
    content_crypto::Multihash::blake3(trace.join("\n").as_bytes()).to_code_hex()
}
