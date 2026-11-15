//! Neutral vocabulary and helpers for provider-unit measurements.
//! Protocol requests, measured client payload bytes and elapsed time, inferred
//! units, and provider reports stay distinct. Unknown server-side quantities
//! are never replaced with client timings or zeroes.

use std::{cell::RefCell, time::{SystemTime, UNIX_EPOCH}};

#[derive(Clone, Debug, PartialEq)]
pub enum Quantity<T> {
    ProviderReported(T),
    Measured(T),
    Inferred(T),
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub provider: String,
    pub operation: String,
    pub scope: String,
    pub unit: String,
    pub started_unix_ms: u64,
    pub elapsed_ms: u64,
    /// Server execution time, if the provider protocol reports it.
    pub server_time_ms: Quantity<u64>,
    /// HTTP status, when the transport exposed one.
    pub response_status: Quantity<u16>,
    pub source_revision: String,
    pub attempts: Quantity<u64>,
    pub errors: Quantity<u64>,
    pub requests: Quantity<u64>,
    pub request_bytes: Quantity<u64>,
    pub items: Quantity<u64>,
    pub response_bytes: Quantity<u64>,
    /// Workload item count observed or supplied to one request. It is not a
    /// capacity unit and can remain unknown when the wire does not expose it.
    pub capacity_multiplier: Quantity<f64>,
    pub consumed_capacity_units: Quantity<f64>,
}

/// Per-connection in-memory measurements. It stores no URLs, credentials or
/// request contents. One observation represents one actual transport attempt.
#[derive(Default)]
pub struct Recorder(RefCell<Vec<Observation>>);

impl Recorder {
    pub fn record(
        &self,
        provider: &str,
        operation: &str,
        scope: &str,
        started_unix_ms: u64,
        elapsed_ms: u64,
        request_bytes: Quantity<u64>,
        response_bytes: Quantity<u64>,
        status: Quantity<u16>,
        items: Quantity<u64>,
        capacity_multiplier: Quantity<f64>,
        capacity: Quantity<f64>,
        errors: u64,
    ) {
        self.0.borrow_mut().push(Observation {
            provider: provider.to_owned(), operation: operation.to_owned(), scope: scope.to_owned(),
            unit: "transport_attempt".to_owned(), started_unix_ms, elapsed_ms,
            server_time_ms: Quantity::Unknown, response_status: status,
            source_revision: option_env!("SOURCE_REVISION").unwrap_or("unknown").to_owned(),
            attempts: Quantity::Measured(1), errors: Quantity::Measured(errors),
            requests: Quantity::Measured(1), request_bytes, items,
            response_bytes, capacity_multiplier, consumed_capacity_units: capacity,
        });
    }

    pub fn snapshot(&self) -> Vec<Observation> {
        self.0.borrow().clone()
    }

    pub fn snapshot_since(&self, index: usize) -> Vec<Observation> {
        self.0.borrow().iter().skip(index).cloned().collect()
    }

    pub fn len(&self) -> usize { self.0.borrow().len() }
}

pub fn now_unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|v| v.as_millis() as u64).unwrap_or(0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DynamoRequestOptions {
    pub return_consumed_capacity: bool,
}

impl DynamoRequestOptions {
    /// Set this on supported requests. It requests accounting; it is not a
    /// measurement until the server returns `ConsumedCapacity.CapacityUnits`.
    pub fn return_capacity() -> Self {
        Self { return_consumed_capacity: true }
    }
}

/// Extract DynamoDB's top-level provider-reported total capacity units. A
/// table/index breakdown is not substituted when the top-level total is absent.
pub fn dynamodb_consumed_capacity(body: &str) -> Quantity<f64> {
    let Some(consumed) = body.find("\"ConsumedCapacity\"") else { return Quantity::Unknown };
    let Some(value) = body[consumed..].find(':').map(|n| body[consumed + n + 1..].trim_start()) else { return Quantity::Unknown };
    if let Some(array) = value.strip_prefix('[') {
        let Some(end) = array.find(']') else { return Quantity::Unknown };
        let mut rest = &array[..end];
        let mut total = 0.0;
        let mut seen = false;
        while let Some(at) = rest.find("\"CapacityUnits\"") {
            let after = rest[at + "\"CapacityUnits\"".len()..].trim_start();
            let Some(number) = after.strip_prefix(':').map(str::trim_start) else { return Quantity::Unknown };
            let digits = number.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')).unwrap_or(number.len());
            let Ok(units) = number[..digits].parse::<f64>() else { return Quantity::Unknown };
            if !units.is_finite() { return Quantity::Unknown; }
            total += units;
            seen = true;
            rest = &after[digits..];
        }
        return if seen { Quantity::ProviderReported(total) } else { Quantity::Unknown };
    }
    let Some(mut rest) = value.strip_prefix('{') else { return Quantity::Unknown };
    loop {
        rest = rest.trim_start();
        if rest.starts_with('}') || rest.is_empty() { return Quantity::Unknown; }
        let Some(key) = rest.strip_prefix('"') else { return Quantity::Unknown };
        let Some(key_end) = key.find('"') else { return Quantity::Unknown };
        let (name, tail) = (&key[..key_end], key[key_end + 1..].trim_start());
        let Some(tail) = tail.strip_prefix(':').map(str::trim_start) else { return Quantity::Unknown };
        if name == "CapacityUnits" {
            let end = tail.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')).unwrap_or(tail.len());
            if end == 0 { return Quantity::Unknown; }
            return tail[..end].parse::<f64>().ok().filter(|n| n.is_finite()).map(Quantity::ProviderReported).unwrap_or(Quantity::Unknown);
        }
        let comma = tail.find(',');
        let brace = tail.find('}');
        let skip = match (comma, brace) {
            (Some(c), Some(b)) => c.min(b) + 1,
            (Some(c), None) => c + 1,
            (None, Some(b)) => b,
            (None, None) => return Quantity::Unknown,
        };
        rest = &tail[skip..];
    }
}

/// Exact byte length of a serialized JSON request body supplied by the caller.
/// This is measured client payload size, not provider network billing.
pub fn request_body_bytes(serialized_json: &[u8]) -> Quantity<u64> {
    Quantity::Measured(serialized_json.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_capacity_requires_top_level_report() {
        assert_eq!(dynamodb_consumed_capacity(r#"{"ConsumedCapacity":{"CapacityUnits":2.5}}"#), Quantity::ProviderReported(2.5));
        assert_eq!(dynamodb_consumed_capacity(r#"{"ConsumedCapacity":[{"TableName":"t","CapacityUnits":1.0},{"TableName":"u","CapacityUnits":0.5}]}"#), Quantity::ProviderReported(1.5));
        assert_eq!(dynamodb_consumed_capacity(r#"{"ConsumedCapacity":{"Table":{"CapacityUnits":4}}}"#), Quantity::Unknown);
        assert_eq!(dynamodb_consumed_capacity(r#"{"ConsumedCapacity":null}"#), Quantity::Unknown);
        assert_eq!(dynamodb_consumed_capacity(r#"{"ConsumedCapacity":{"CapacityUnits":null}}"#), Quantity::Unknown);
    }

    #[test]
    fn capacity_request_flag_does_not_invent_a_result() {
        assert_eq!(DynamoRequestOptions::return_capacity(), DynamoRequestOptions { return_consumed_capacity: true });
        assert_eq!(dynamodb_consumed_capacity("{}"), Quantity::Unknown);
    }

    #[test]
    fn payload_bytes_are_measured_and_not_billing_units() {
        let body = br#"{"v":"abc"}"#;
        assert_eq!(request_body_bytes(body), Quantity::Measured(body.len() as u64));
    }
}
