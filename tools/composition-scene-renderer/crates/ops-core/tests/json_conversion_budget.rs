use ops_core::{
    try_from_json_with_budget, try_to_json_with_budget, JsonConversionBudget, JsonConversionError,
};
use serde_json::Value;

fn nested_array(depth: usize) -> Value {
    let mut value = Value::Null;
    for _ in 0..depth {
        value = Value::Array(vec![value]);
    }
    value
}

fn forget_iteratively(mut value: Value) {
    loop {
        value = match value {
            Value::Array(mut values) if values.len() == 1 => values.pop().unwrap(),
            _ => break,
        };
    }
}

#[test]
fn ten_thousand_deep_json_is_typed_rejection() {
    let value = nested_array(10_000);
    let error = try_from_json_with_budget(&value, &JsonConversionBudget::default()).unwrap_err();
    assert!(matches!(error, JsonConversionError::TooDeep { .. }));
    assert!(error.to_string().starts_with("FE_PAYLOAD_TOO_DEEP:"));
    forget_iteratively(value);
}

#[test]
fn width_and_string_bytes_are_typed_rejections() {
    let wide = Value::Array((0..32).map(|_| Value::Null).collect());
    let error = try_from_json_with_budget(
        &wide,
        &JsonConversionBudget {
            max_nodes: 16,
            ..JsonConversionBudget::default()
        },
    )
    .unwrap_err();
    assert!(matches!(error, JsonConversionError::TooManyNodes { .. }));

    let text = Value::String("x".repeat(64));
    let error = try_from_json_with_budget(
        &text,
        &JsonConversionBudget {
            max_string_bytes: 32,
            ..JsonConversionBudget::default()
        },
    )
    .unwrap_err();
    assert!(matches!(error, JsonConversionError::TooLarge { .. }));

    let total = Value::Array((0..8).map(|_| Value::String("abcd".into())).collect());
    let error = try_from_json_with_budget(
        &total,
        &JsonConversionBudget {
            max_total_bytes: 64,
            ..JsonConversionBudget::default()
        },
    )
    .unwrap_err();
    assert!(matches!(error, JsonConversionError::TooLarge { .. }));
}

#[test]
fn ordinary_nested_json_round_trips() {
    let value = serde_json::json!({"a": [1, true, "ok"], "b": {"c": null}});
    let converted = try_from_json_with_budget(&value, &JsonConversionBudget::default()).unwrap();
    assert_eq!(converted.into_inner(), value);
}

#[test]
fn generated_depth_width_and_byte_matrix_never_panics() {
    for depth in 0..64 {
        for width in [0, 1, 2, 7, 31] {
            let mut value = Value::Array(
                (0..width)
                    .map(|index| Value::String("x".repeat(index + depth)))
                    .collect(),
            );
            for _ in 0..depth {
                value = Value::Array(vec![value]);
            }
            let budget = JsonConversionBudget {
                max_depth: 1 + depth / 2,
                max_nodes: 1 + width.saturating_mul(2),
                max_string_bytes: 1 + width.saturating_mul(depth + width),
                max_total_bytes: 64 + width.saturating_mul(48),
            };
            if let Ok(converted) = try_from_json_with_budget(&value, &budget) {
                let round_trip = try_to_json_with_budget(&converted, &budget).unwrap();
                assert_eq!(round_trip, value);
            }
            forget_iteratively(value);
        }
    }
}
