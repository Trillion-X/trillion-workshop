//! JSON transport must retain the same binary64 value as the original numeric token.
#[test]
fn json_transport_preserves_binary64_values_at_rounding_boundaries() {
    for token in ["1.3499999999999999", "1.35", "0.10000000000000002", "2.2250738585072014e-308", "9007199254740991", "1.7976931348623157e308"] {
        let expected: f64 = token.parse().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(token).unwrap();
        assert_eq!(parsed.as_f64().unwrap().to_bits(), expected.to_bits(), "input token {token}");
        let serialized = serde_json::to_string(&parsed).unwrap();
        let reparsed: f64 = serialized.parse().unwrap();
        assert_eq!(reparsed.to_bits(), expected.to_bits(), "serialized token {token}");
    }
}
