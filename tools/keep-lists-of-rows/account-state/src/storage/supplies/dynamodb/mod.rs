// src/storage/supplies/dynamodb/mod.rs
//
// Purpose: The DynamoDB-API `Backend` for the shared key-value supply, spoken to DynamoDB Local over HTTP (the wire is
// the real DynamoDB JSON protocol, so it is the same traffic a cloud endpoint receives). One table per store name, one
// partition, a binary sort key: the table is the ordered keyspace.
//
// Non-Negotiable Invariants:
// - Reads are strongly consistent. A range is a Query on the one partition with the sort key bounded, ascending or
//   descending, so byte order is the sort key's order; the table's partition holds the whole keyspace, which a cloud
//   table would cap at the throughput of a single partition (see the README).
// - A batch of up to 99 writes is one `TransactWriteItems`: all writes land together or none do, with the guard as a
//   condition on its own item (a transaction may not name an item twice, so the guard rides on the write of that key when
//   there is one). A larger batch cannot be one DynamoDB transaction (the service caps it at 100 items), so it runs the
//   crash-atomic record protocol of `kv::wal` instead: it survives a crash whole but a concurrent reader can see it half
//   applied. `atomicity` reports that weaker guarantee, because a scope of any size can commit.
// - What DynamoDB cannot carry in one item is refused, never trimmed: a sort key over 1024 bytes and a value over the
//   400 KB item limit answer `TooBig`.
//
// Key Concepts:
// - `DynamoDb::connect(url, table)`: creates the table if missing.
//
// Security Considerations:
// - DynamoDB Local ignores credentials but requires a well-formed signature header; the fixed local access key here
//   authenticates nothing and is not a secret.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::kv::{
    wal::{self, Plain},
    Atomicity, Backend, Limits, Outcome, Write,
};
use crate::{provider_units::{self, DynamoRequestOptions, Quantity, Recorder}};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use local_engine::storage::{Error, Result};
use serde_json::{json, Value};
use std::{cell::Cell, io::Read, time::Instant};

const PARTITION: &str = "s";
/// The most items one DynamoDB transaction holds.
const TRANSACTION_ITEMS: usize = 100;

pub struct DynamoDb {
    agent: ureq::Agent,
    url: String,
    table: String,
    rounds: Cell<u64>,
    measurements: Recorder,
}

fn encode(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

fn key_of(sort: &[u8]) -> Value {
    json!({"p": {"S": PARTITION}, "k": {"B": encode(sort)}})
}

impl DynamoDb {
    /// Connect to `url` (`http://host:port`) and use `table`, creating it when it does not exist.
    pub fn connect(url: &str, table: &str) -> Result<Self> {
        let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(60)).build();
        let db = Self { agent, url: url.to_owned(), table: table.to_owned(), rounds: Cell::new(0), measurements: Recorder::default() };
        match db.call(
            "CreateTable",
            &json!({
                "TableName": table,
                "AttributeDefinitions": [
                    {"AttributeName": "p", "AttributeType": "S"},
                    {"AttributeName": "k", "AttributeType": "B"}
                ],
                "KeySchema": [
                    {"AttributeName": "p", "KeyType": "HASH"},
                    {"AttributeName": "k", "KeyType": "RANGE"}
                ],
                "BillingMode": "PAY_PER_REQUEST"
            }),
        ) {
            Ok(_) => {}
            Err(Failure::Typed(kind, _, _)) if kind.ends_with("ResourceInUseException") => {}
            Err(failure) => return Err(failure.into()),
        }
        wal::recover(&db)?;
        Ok(db)
    }

    fn call(&self, operation: &str, body: &Value) -> std::result::Result<Value, Failure> {
        self.rounds.set(self.rounds.get() + 1);
        let mut request = body.clone();
        if operation != "CreateTable" && DynamoRequestOptions::return_capacity().return_consumed_capacity {
            request["ReturnConsumedCapacity"] = json!("TOTAL");
        }
        let serialized = request.to_string();
        let request_bytes = provider_units::request_body_bytes(serialized.as_bytes());
        let started_unix_ms = provider_units::now_unix_ms();
        let started = Instant::now();
        let response = self
            .agent
            .post(&self.url)
            .set("Content-Type", "application/x-amz-json-1.0")
            .set("X-Amz-Target", &format!("DynamoDB_20120810.{operation}"))
            .set(
                "Authorization",
                "AWS4-HMAC-SHA256 Credential=local/20260101/us-east-1/dynamodb/aws4_request, SignedHeaders=host;x-amz-date;x-amz-target, Signature=0000000000000000000000000000000000000000000000000000000000000000",
            )
            .set("X-Amz-Date", "20260101T000000Z")
            .send_string(&serialized);
        match response {
            Ok(response) => {
                let status = response.status();
                let mut raw = Vec::new();
                if response.into_reader().read_to_end(&mut raw).is_err() {
                    self.measurements.record("dynamodb", operation, &self.table, started_unix_ms, started.elapsed().as_millis() as u64,
                        request_bytes, Quantity::Unknown, Quantity::Measured(status), dynamodb_items(operation, &request, &Value::Null),
                        transaction_multiplier(operation), Quantity::Unknown, 1);
                    return Err(local_engine::cause!(Failure::Unavailable));
                }
                let text = std::str::from_utf8(&raw).unwrap_or_default();
                let capacity = provider_units::dynamodb_consumed_capacity(text);
                let parsed = match serde_json::from_slice::<Value>(&raw) {
                    Ok(parsed) => parsed,
                    Err(_) => {
                        self.measurements.record("dynamodb", operation, &self.table, started_unix_ms, started.elapsed().as_millis() as u64,
                            request_bytes, Quantity::Measured(raw.len() as u64), Quantity::Measured(status), Quantity::Unknown,
                            transaction_multiplier(operation), capacity, 1);
                        return Err(local_engine::cause!(Failure::Unavailable));
                    }
                };
                let items = dynamodb_items(operation, &request, &parsed);
                let multiplier = transaction_multiplier(operation);
                self.measurements.record("dynamodb", operation, &self.table, started_unix_ms, started.elapsed().as_millis() as u64,
                    request_bytes, Quantity::Measured(raw.len() as u64), Quantity::Measured(status), items, multiplier, capacity,
                    u64::from(status >= 400));
                Ok(parsed)
            }
            Err(ureq::Error::Status(status, response)) => {
                let mut raw = Vec::new();
                response.into_reader().read_to_end(&mut raw).map_err(|error| local_engine::carry_cause!(Failure::Unavailable, error))?;
                self.measurements.record("dynamodb", operation, &self.table, started_unix_ms, started.elapsed().as_millis() as u64,
                    request_bytes, Quantity::Measured(raw.len() as u64), Quantity::Measured(status),
                    dynamodb_items(operation, &request, &Value::Null), transaction_multiplier(operation), Quantity::Unknown, 1);
                let body: Value = serde_json::from_slice(&raw).map_err(|error| local_engine::carry_cause!(Failure::Unavailable, error))?;
                let kind = body.get("__type").and_then(Value::as_str).unwrap_or_default().to_owned();
                Err(Failure::Typed(kind, body, local_engine::cause!()))
            }
            Err(_) => {
                self.measurements.record("dynamodb", operation, &self.table, started_unix_ms, started.elapsed().as_millis() as u64,
                    request_bytes, Quantity::Unknown, Quantity::Unknown, dynamodb_items(operation, &request, &Value::Null),
                    transaction_multiplier(operation), Quantity::Unknown, 1);
                Err(local_engine::cause!(Failure::Unavailable))
            }
        }
    }

    /// A snapshot of actual transport attempts. Local DynamoDB-compatible
    /// servers are labelled `dynamodb`; provider capacity is reported only
    /// when the response includes its top-level value.
    pub fn measurements(&self) -> Vec<provider_units::Observation> { self.measurements.snapshot() }
}

fn transaction_multiplier(operation: &str) -> Quantity<f64> {
    if operation == "TransactWriteItems" { Quantity::Inferred(2.0) } else { Quantity::Unknown }
}

fn dynamodb_items(operation: &str, request: &Value, response: &Value) -> Quantity<u64> {
    match operation {
        "GetItem" | "PutItem" | "DeleteItem" => Quantity::Measured(1),
        "BatchGetItem" => request["RequestItems"].as_object().and_then(|tables| tables.values().next())
            .and_then(|table| table["Keys"].as_array()).map(|keys| Quantity::Measured(keys.len() as u64)).unwrap_or(Quantity::Unknown),
        "TransactWriteItems" => request["TransactItems"].as_array().map(|items| Quantity::Measured(items.len() as u64)).unwrap_or(Quantity::Unknown),
        "Query" => response["Count"].as_u64().map(Quantity::Measured).unwrap_or(Quantity::Unknown),
        _ => Quantity::Unknown,
    }
}

use local_engine::refusal_cause::Cause;

/// A failed call: the server answered with a typed error, or did not answer.
enum Failure {
    Typed(String, Value, Cause),
    Unavailable(Cause),
}
impl Failure {
    fn cause(&self) -> local_engine::refusal_cause::Cause {
        match self { Self::Typed(_, _, cause) | Self::Unavailable(cause) => cause.clone() }
    }
}
local_engine::impl_caused!(Failure);

impl From<Failure> for Error {
    fn from(failure: Failure) -> Self {
        let cause = failure.cause();
        match failure {
            Failure::Unavailable(_) => Error::Unavailable(cause),
            Failure::Typed(kind, body, _) => {
                let kind = kind.rsplit('#').next().unwrap_or_default();
                match kind {
                    "ProvisionedThroughputExceededException" | "ThrottlingException" | "RequestLimitExceeded" => Error::Busy(cause),
                    "TransactionConflictException" => Error::Busy(cause),
                    "ItemCollectionSizeLimitExceededException" => Error::TooBig(cause),
                    "ValidationException" => {
                        let message = body.get("message").or_else(|| body.get("Message")).and_then(Value::as_str).unwrap_or_default();
                        if message.contains("size") || message.contains("Member must have length") || message.contains("too many") {
                            Error::TooBig(cause)
                        } else {
                            Error::Invalid(cause)
                        }
                    }
                    _ => Error::Unavailable(cause),
                }
            }
        }
    }
}

fn bytes_of(item: &Value, attribute: &str) -> Result<Vec<u8>> {
    let text = item.get(attribute).and_then(|value| value.get("B")).and_then(Value::as_str).ok_or(local_engine::cause!(Error::Unavailable))?;
    BASE64.decode(text).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))
}

impl Plain for DynamoDb {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let answer = self.call("GetItem", &json!({"TableName": self.table, "Key": key_of(key), "ConsistentRead": true}))?;
        answer.get("Item").map(|item| bytes_of(item, "v")).transpose()
    }

    fn put(&self, key: &[u8], value: &[u8]) -> Result<()> {
        self.call("PutItem", &json!({"TableName": self.table, "Item": {"p": {"S": PARTITION}, "k": {"B": encode(key)}, "v": {"B": encode(value)}}}))?;
        Ok(())
    }

    fn put_new(&self, key: &[u8], value: &[u8]) -> Result<bool> {
        let created = self.call(
            "PutItem",
            &json!({
                "TableName": self.table,
                "Item": {"p": {"S": PARTITION}, "k": {"B": encode(key)}, "v": {"B": encode(value)}},
                "ConditionExpression": "attribute_not_exists(#k)",
                "ExpressionAttributeNames": {"#k": "k"}
            }),
        );
        match created {
            Ok(_) => Ok(true),
            Err(Failure::Typed(kind, _, _)) if kind.ends_with("ConditionalCheckFailedException") => Ok(false),
            Err(failure) => Err(failure.into()),
        }
    }

    fn delete(&self, key: &[u8]) -> Result<()> {
        self.call("DeleteItem", &json!({"TableName": self.table, "Key": key_of(key)}))?;
        Ok(())
    }
}

impl Backend for DynamoDb {
    fn atomicity(&self) -> Atomicity {
        Atomicity::CrashSafe
    }

    fn limits(&self) -> Limits {
        // The sort key may be 1024 bytes; an item (its names and values) 400 KB; a transaction 100 items.
        Limits { max_key: 1000, max_value: 390_000, max_writes: usize::MAX / 2 }
    }

    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        Plain::get(self, key)
    }

    fn get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>> {
        let mut found = std::collections::HashMap::new();
        for batch in keys.chunks(100) {
            let mut pending: Vec<Value> = batch.iter().map(|key| key_of(key)).collect::<Vec<_>>();
            while !pending.is_empty() {
                let answer = self.call(
                    "BatchGetItem",
                    &json!({"RequestItems": {self.table.clone(): {"Keys": pending, "ConsistentRead": true}}}),
                )?;
                for item in answer["Responses"][&self.table].as_array().into_iter().flatten() {
                    found.insert(bytes_of(item, "k")?, bytes_of(item, "v")?);
                }
                pending = answer["UnprocessedKeys"][&self.table]["Keys"].as_array().cloned().unwrap_or_default();
            }
        }
        Ok(keys.iter().map(|key| found.get(key).cloned()).collect())
    }

    fn range(&self, lo: &[u8], hi: Option<&[u8]>, reverse: bool, limit: usize, values: bool) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        // DynamoDB bounds a sort key with BETWEEN, which includes both ends; the upper end is dropped here.
        let mut body = json!({
            "TableName": self.table,
            "ConsistentRead": true,
            "ScanIndexForward": !reverse,
            "ExpressionAttributeNames": {"#k": "k", "#p": "p"},
        });
        let mut names = vec!["#k"];
        if values {
            body["ExpressionAttributeNames"]["#v"] = json!("v");
            names.push("#v");
        }
        body["ProjectionExpression"] = json!(names.join(","));
        match hi {
            Some(hi) => {
                body["KeyConditionExpression"] = json!("#p = :p AND #k BETWEEN :lo AND :hi");
                body["ExpressionAttributeValues"] = json!({":p": {"S": PARTITION}, ":lo": {"B": encode(lo)}, ":hi": {"B": encode(hi)}});
            }
            None => {
                body["KeyConditionExpression"] = json!("#p = :p AND #k >= :lo");
                body["ExpressionAttributeValues"] = json!({":p": {"S": PARTITION}, ":lo": {"B": encode(lo)}});
            }
        }
        let mut found: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        loop {
            // One more than wanted when the excluded upper end could be among the results.
            body["Limit"] = json!((limit - found.len()).saturating_add(usize::from(hi.is_some())).min(1_000_000));
            let answer = self.call("Query", &body)?;
            for item in answer["Items"].as_array().into_iter().flatten() {
                let key = bytes_of(item, "k")?;
                if hi.is_some_and(|hi| key.as_slice() == hi) {
                    continue;
                }
                let value = if values { bytes_of(item, "v")? } else { Vec::new() };
                found.push((key, value));
            }
            match answer.get("LastEvaluatedKey") {
                Some(last) if found.len() < limit => body["ExclusiveStartKey"] = last.clone(),
                _ => break,
            }
        }
        found.truncate(limit);
        Ok(found)
    }

    fn apply(&self, guard: (&[u8], Option<&[u8]>), writes: &[Write]) -> Result<Outcome> {
        if writes.len() > TRANSACTION_ITEMS - 1 {
            return wal::apply(self, 300_000, guard, writes);
        }
        let (condition, values) = match guard.1 {
            Some(expected) => ("#v = :e", Some(json!({":e": {"B": encode(expected)}}))),
            None => ("attribute_not_exists(#k)", None),
        };
        let attach = |action: &mut Value| {
            action["ConditionExpression"] = json!(condition);
            action["ExpressionAttributeNames"] = if values.is_some() { json!({"#v": "v"}) } else { json!({"#k": "k"}) };
            if let Some(values) = &values {
                action["ExpressionAttributeValues"] = values.clone();
            }
        };
        let mut items: Vec<Value> = Vec::with_capacity(writes.len() + 1);
        let mut guarded = false;
        for write in writes {
            match write {
                Write::Set(key, value) => {
                    let mut put = json!({"TableName": self.table, "Item": {"p": {"S": PARTITION}, "k": {"B": encode(key)}, "v": {"B": encode(value)}}});
                    if key.as_slice() == guard.0 {
                        attach(&mut put);
                        guarded = true;
                    }
                    items.push(json!({"Put": put}));
                }
                Write::Delete(key) => {
                    let mut delete = json!({"TableName": self.table, "Key": key_of(key)});
                    if key.as_slice() == guard.0 {
                        attach(&mut delete);
                        guarded = true;
                    }
                    items.push(json!({"Delete": delete}));
                }
            }
        }
        if !guarded {
            let mut check = json!({"TableName": self.table, "Key": key_of(guard.0)});
            attach(&mut check);
            items.push(json!({"ConditionCheck": check}));
        }
        match self.call("TransactWriteItems", &json!({"TransactItems": items})) {
            Ok(_) => Ok(Outcome::Applied),
            Err(Failure::Typed(kind, body, _)) if kind.ends_with("TransactionCanceledException") => {
                let reasons: Vec<&str> = body["CancellationReasons"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|reason| reason["Code"].as_str())
                    .collect();
                if reasons.contains(&"ConditionalCheckFailed") {
                    Ok(Outcome::Refused)
                } else if reasons.contains(&"TransactionConflict") || reasons.contains(&"ThrottlingError") {
                    Err(local_engine::cause!(Error::Busy))
                } else if reasons.contains(&"ValidationError") {
                    Err(local_engine::cause!(Error::TooBig))
                } else {
                    Err(local_engine::cause!(Error::Unavailable))
                }
            }
            Err(failure) => Err(failure.into()),
        }
    }

    fn rounds(&self) -> u64 {
        self.rounds.get()
    }

    fn measurements(&self) -> Vec<provider_units::Observation> { self.measurements.snapshot() }
    fn measurement_count(&self) -> usize { self.measurements.len() }
    fn measurements_since(&self, index: usize) -> Vec<provider_units::Observation> { self.measurements.snapshot_since(index) }

    fn place(&self) -> String {
        format!("{} table={}", self.url, self.table)
    }
}
