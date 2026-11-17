// src/account_files/words.rs
//
// Purpose: The words of a question and of a file name, for the files' name search (`AccountFiles::search`): what the asked words are, and
// whether a name holds every one of them. The rows' store proposes the files whose names contain the words; these decide which of those a
// person would call a match.
//
// Non-Negotiable Invariants:
// - A word is a run of letters and digits, lowercased; apostrophes are dropped, not split on.
// - A name holds a question when every asked word starts a word of the name.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::collections::BTreeSet;

/// The lowercased words of a text (old trillion src/search.mjs `words`: letters and digits, apostrophes dropped).
pub fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .replace(['\'', '\u{2019}'], "")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The distinct asked words of a question: at most `question_chars` of it, words of at least `min_word_length`.
pub fn terms(question: &str, question_chars: usize, min_word_length: usize) -> (String, Vec<String>) {
    let question: String = question.trim().chars().take(question_chars).collect();
    let mut seen = BTreeSet::new();
    let terms = words(&question).into_iter().filter(|word| word.chars().count() >= min_word_length && seen.insert(word.clone())).collect();
    (question, terms)
}

/// Whether every asked word starts a word of `text` (old search.mjs `holdsEvery`).
pub fn holds_every(text: &str, terms: &[String]) -> bool {
    let said = words(text);
    terms.iter().all(|term| said.iter().any(|word| word.starts_with(term.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_question_is_its_distinct_long_enough_words() {
        let (question, found) = terms("  The the Smith's report!  ", 40, 3);
        assert_eq!(question, "The the Smith's report!");
        assert_eq!(found, ["the", "smiths", "report"]);
    }

    #[test]
    fn a_name_holds_a_question_when_each_word_starts_one_of_its_words() {
        let asked = vec!["rep".to_owned(), "2026".to_owned()];
        assert!(holds_every("Report-2026.pdf", &asked));
        assert!(!holds_every("Report-2025.pdf", &asked));
    }
}
