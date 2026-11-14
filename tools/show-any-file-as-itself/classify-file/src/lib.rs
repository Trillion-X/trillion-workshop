// The file-classification rule table, moved byte for byte as src/classify_file.rs; this file only names it.

pub mod classify_file;

pub use classify_file::{classify_file, classify_file_bytes, FileClassification, FileClassificationRequest};
