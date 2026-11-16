//! The caller-owned product word behind every process wire identity.
//!
//! Schema ids and owner-reserved environment names carry a product
//! product word. This crate owns their shape; the host owns the word and passes
//! it in, so the generic contract names no product.

use crate::ExecutionError;

/// Every product-word process wire identity, derived once from one word.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductWordIds {
    source_archive_format: String,
    containment_receipt_schema: String,
    external_provider_capability_statement_schema: String,
    sequence_environment_keys: [String; 3],
}

impl ProductWordIds {
    /// Build the identities for `word`: a lowercase ASCII letter followed by
    /// lowercase ASCII letters, digits, or `_`, so the same word is valid in a
    /// dotted schema id and, uppercased, in an environment variable name.
    pub fn new(word: &str) -> Result<Self, ExecutionError> {
        let mut bytes = word.bytes();
        if !bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
            || !bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(ExecutionError::InvalidDescriptor {
                field: "execution_namespace".into(),
                reason: "must start with a lowercase ASCII letter and contain only lowercase \
                         ASCII letters, digits, or '_'"
                    .into(),
            });
        }
        let env = word.to_ascii_uppercase();
        Ok(Self {
            source_archive_format: format!("{word}.process-source-archive/v1"),
            containment_receipt_schema: format!("{word}.process_containment_receipt.v1"),
            external_provider_capability_statement_schema: format!(
                "{word}.process_external_provider_capability_statement.v1"
            ),
            sequence_environment_keys: [
                format!("{env}_PROCESS_SEQUENCE_REQUEST_SHA256"),
                format!("{env}_PROCESS_SEQUENCE_PREDECESSOR_RESULT_SHA256"),
                format!("{env}_PROCESS_SEQUENCE_REQUIRED_OUTPUTS_JSON"),
            ],
        })
    }

    /// Wire format of a portable source-tree archive.
    pub fn source_archive_format(&self) -> &str {
        &self.source_archive_format
    }

    /// Wire schema of a process-containment receipt.
    pub fn containment_receipt_schema(&self) -> &str {
        &self.containment_receipt_schema
    }

    /// Schema of the hashed external-provider capability statement.
    pub fn external_provider_capability_statement_schema(&self) -> &str {
        &self.external_provider_capability_statement_schema
    }

    /// Owner-injected SHA-256 of the canonical sequence descriptor.
    pub fn sequence_request_sha256_env(&self) -> &str {
        &self.sequence_environment_keys[0]
    }

    /// Owner-injected SHA-256 of the immediately preceding canonical process result.
    pub fn sequence_predecessor_result_sha256_env(&self) -> &str {
        &self.sequence_environment_keys[1]
    }

    /// Owner-injected canonical JSON array of required predecessor-output evidence.
    pub fn sequence_required_outputs_json_env(&self) -> &str {
        &self.sequence_environment_keys[2]
    }

    /// The three owner-reserved sequence environment names.
    pub fn sequence_environment_keys(&self) -> &[String; 3] {
        &self.sequence_environment_keys
    }
}

/// The neutral product word every in-crate test uses.
#[cfg(test)]
pub(crate) fn example_product_word_ids() -> ProductWordIds {
    ProductWordIds::new("example").expect("valid product word")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_builds_every_identity_and_bad_words_are_refused() {
        let word_ids = ProductWordIds::new("example_2").expect("valid word");
        assert_eq!(
            word_ids.source_archive_format(),
            "example_2.process-source-archive/v1"
        );
        assert_eq!(
            word_ids.containment_receipt_schema(),
            "example_2.process_containment_receipt.v1"
        );
        assert_eq!(
            word_ids.external_provider_capability_statement_schema(),
            "example_2.process_external_provider_capability_statement.v1"
        );
        assert_eq!(
            word_ids.sequence_environment_keys(),
            &[
                "EXAMPLE_2_PROCESS_SEQUENCE_REQUEST_SHA256".to_string(),
                "EXAMPLE_2_PROCESS_SEQUENCE_PREDECESSOR_RESULT_SHA256".to_string(),
                "EXAMPLE_2_PROCESS_SEQUENCE_REQUIRED_OUTPUTS_JSON".to_string(),
            ]
        );
        for word in [
            "", "Example", "2example", "_example", "ex-ample", "ex.ample", "éx",
        ] {
            assert!(ProductWordIds::new(word).is_err(), "{word:?}");
        }
    }
}
