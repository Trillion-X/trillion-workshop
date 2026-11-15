#![no_main]

use libfuzzer_sys::fuzz_target;
use ops_core::{try_from_json_with_budget, try_to_json_with_budget, JsonConversionBudget};
use serde_json::Value;

fuzz_target!(|data: &[u8]| {
    let depth = data.first().copied().unwrap_or(0) as usize;
    let width = data.get(1).copied().unwrap_or(0) as usize;
    let text_len = data.get(2).copied().unwrap_or(0) as usize;
    let mut value = Value::Array(
        (0..width)
            .map(|index| {
                Value::String(
                    char::from(b'a' + (index % 26) as u8)
                        .to_string()
                        .repeat(text_len),
                )
            })
            .collect(),
    );
    for _ in 0..depth {
        value = Value::Array(vec![value]);
    }

    let budget = JsonConversionBudget {
        max_depth: data.get(3).copied().unwrap_or(1).max(1) as usize,
        max_nodes: data.get(4).copied().unwrap_or(1).max(1) as usize,
        max_string_bytes: data.get(5).copied().unwrap_or(1).max(1) as usize * 16,
        max_total_bytes: data.get(6).copied().unwrap_or(1).max(1) as usize * 64,
    };
    if let Ok(converted) = try_from_json_with_budget(&value, &budget) {
        let _ = try_to_json_with_budget(&converted, &budget).unwrap();
    }

    while let Value::Array(mut values) = value {
        if values.len() != 1 {
            break;
        }
        value = values.pop().unwrap();
    }
});
