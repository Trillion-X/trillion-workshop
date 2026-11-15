//! Static OpValue constants for operator variants.
//!
//! This module provides OnceLock-based static OpValue constants for variant names
//! (format names, encoding names, algorithm names, etc.). Using these prevents
//! per-call heap allocation when passing variant identifiers to generic operators.
//!
//! # Example
//!
//! ```ignore
//! use ops_core::constants::*;
//! use ops_core::serialization;
//!
//! let input = OpValue::string(r#"{"a": 1}"#);
//! let result = serialization::parse(&input, &JSON_VARIANT, ctx);
//! ```

use crate::value::OpValue;
use once_cell::sync::Lazy;

// ============================================================================
// Serialization Format Variants
// ============================================================================

/// Format variant constant for JSON serialization.
pub static JSON_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("json"));

/// Format variant constant for YAML serialization.
pub static YAML_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("yaml"));

/// Format variant constant for TOML serialization.
pub static TOML_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("toml"));

/// Format variant constant for CBOR serialization.
pub static CBOR_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("cbor"));

// ============================================================================
// Hash Algorithm Variants
// ============================================================================

/// Algorithm variant constant for SHA-256 hashing.
pub static SHA256_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("sha256"));

/// Algorithm variant constant for MD5 hashing.
pub static MD5_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("md5"));

/// Algorithm variant constant for fast hashing (blake3).
pub static FAST_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("fast"));

// ============================================================================
// Encoding Variants
// ============================================================================

/// Encoding variant constant for base64 encoding.
pub static BASE64_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("base64"));

/// Encoding variant constant for base64url encoding.
pub static BASE64URL_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("base64url"));

/// Encoding variant constant for hex encoding.
pub static HEX_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("hex"));

// ============================================================================
// DateTime Extract Unit Variants
// ============================================================================

/// DateTime unit constant for extracting the year.
pub static YEAR_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("year"));

/// DateTime unit constant for extracting the month.
pub static MONTH_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("month"));

/// DateTime unit constant for extracting the day.
pub static DAY_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("day"));

/// DateTime unit constant for extracting the hour.
pub static HOUR_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("hour"));

/// DateTime unit constant for extracting the minute.
pub static MINUTE_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("minute"));

/// DateTime unit constant for extracting the second.
pub static SECOND_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("second"));

/// DateTime unit constant for extracting the weekday (0=Sunday, 6=Saturday).
pub static WEEKDAY_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("weekday"));

/// DateTime unit constant for extracting the Unix timestamp (seconds since epoch).
pub static TIMESTAMP_VARIANT: Lazy<OpValue> = Lazy::new(|| OpValue::string("timestamp"));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_constants() {
        assert_eq!(JSON_VARIANT.as_str("json").unwrap(), "json");
        assert_eq!(YAML_VARIANT.as_str("yaml").unwrap(), "yaml");
        assert_eq!(TOML_VARIANT.as_str("toml").unwrap(), "toml");
        assert_eq!(CBOR_VARIANT.as_str("cbor").unwrap(), "cbor");
    }

    #[test]
    fn test_hash_constants() {
        assert_eq!(SHA256_VARIANT.as_str("sha256").unwrap(), "sha256");
        assert_eq!(MD5_VARIANT.as_str("md5").unwrap(), "md5");
        assert_eq!(FAST_VARIANT.as_str("fast").unwrap(), "fast");
    }

    #[test]
    fn test_encoding_constants() {
        assert_eq!(BASE64_VARIANT.as_str("base64").unwrap(), "base64");
        assert_eq!(BASE64URL_VARIANT.as_str("base64url").unwrap(), "base64url");
        assert_eq!(HEX_VARIANT.as_str("hex").unwrap(), "hex");
    }

    #[test]
    fn test_datetime_constants() {
        assert_eq!(YEAR_VARIANT.as_str("year").unwrap(), "year");
        assert_eq!(MONTH_VARIANT.as_str("month").unwrap(), "month");
        assert_eq!(DAY_VARIANT.as_str("day").unwrap(), "day");
        assert_eq!(HOUR_VARIANT.as_str("hour").unwrap(), "hour");
        assert_eq!(MINUTE_VARIANT.as_str("minute").unwrap(), "minute");
        assert_eq!(SECOND_VARIANT.as_str("second").unwrap(), "second");
        assert_eq!(WEEKDAY_VARIANT.as_str("weekday").unwrap(), "weekday");
        assert_eq!(TIMESTAMP_VARIANT.as_str("timestamp").unwrap(), "timestamp");
    }
}
