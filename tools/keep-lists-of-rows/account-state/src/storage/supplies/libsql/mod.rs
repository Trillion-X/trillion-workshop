// src/storage/supplies/libsql/mod.rs
//
// Purpose: The libSQL-server `Wire` for the shared relational supply, spoken over the Hrana HTTP protocol (`/v2/pipeline`)
// that libSQL servers (sqld, Turso) answer. It is SQLite's own dialect behind an HTTP connection, so the same SQL the
// native SQLite supply runs is run here by the shared relational supply.
//
// Non-Negotiable Invariants:
// - One pipeline request is one network round trip however many statements it carries, so a scope opens (`BEGIN` and the
//   mark update) and closes in one round trip each.
// - The connection is one Hrana stream held by its baton. A failed statement leaves the stream and its transaction open,
//   so the baton is kept and the next statement continues the same transaction.
// - A driver error is mapped to a `storage::Error` here: a constraint violation is `Conflict`; a locked database is
//   `Busy`; anything else is `Unavailable`.
// - Dropping the handle closes its stream, which rolls back an open transaction: a dropped handle is a crash.
// - The store lives in a store name of the server (selected by the request's Host header), created through the admin API.
//
// Key Concepts:
// - `LibSql::connect(url, admin_url, store_name)`: `http://host:port` for queries, `http://host:port` for the admin API.
//
// Security Considerations:
// - A server token, if one is needed, is part of the caller's URL as `http://token@host:port` and sent as a bearer
//   header; `place` omits it.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::sql::{Answer, Cell, Dialect, Param, Shape, Step, Wire};
use base64::{
    alphabet,
    engine::{general_purpose::GeneralPurpose, DecodePaddingMode, GeneralPurposeConfig},
    Engine,
};
use local_engine::storage::{Error, Result};
use serde_json::{json, Value};
use std::cell::{Cell as Counter, RefCell};

/// Hrana answers blobs without padding and accepts either.
const BASE64: GeneralPurpose = GeneralPurpose::new(&alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));

pub struct LibSql {
    agent: ureq::Agent,
    url: String,
    host: String,
    token: Option<String>,
    baton: RefCell<Option<String>>,
    rounds: Counter<u64>,
    place: String,
}

fn argument(param: &Param) -> Value {
    match param {
        Param::Bytes(bytes) => json!({"type": "blob", "base64": BASE64.encode(bytes)}),
        Param::Int(number) => json!({"type": "integer", "value": number.to_string()}),
    }
}

fn cell(value: &Value) -> Result<Cell> {
    match value["type"].as_str() {
        Some("null") => Ok(Cell::Null),
        Some("blob") => Ok(Cell::Bytes(BASE64.decode(value["base64"].as_str().ok_or(local_engine::cause!(Error::Unavailable))?).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))?)),
        Some("integer") => Ok(Cell::Int(value["value"].as_str().and_then(|text| text.parse().ok()).ok_or(local_engine::cause!(Error::Unavailable))?)),
        _ => Err(local_engine::cause!(Error::Unavailable)),
    }
}

#[track_caller]
fn failure(message: &str) -> Error {
    let refusal = if message.contains("UNIQUE") || message.contains("constraint") {
        local_engine::cause!(caller: Error::Conflict)
    } else if message.contains("locked") || message.contains("BUSY") {
        local_engine::cause!(caller: Error::Busy)
    } else if message.contains("too big") || message.contains("TOOBIG") {
        local_engine::cause!(caller: Error::TooBig)
    } else {
        local_engine::cause!(caller: Error::Unavailable)
    };
    if std::env::var_os("STORAGE_SUPPLY_DEBUG").is_some() {
        crate::quiet_eprintln!("storage-refusal cause={}", refusal.cause());
    }
    refusal
}

impl LibSql {
    /// Connect to the server at `url` and use `store_name`, creating it through the admin API at `admin`.
    pub fn connect(url: &str, admin: &str, store_name: &str) -> Result<Self> {
        let rest = url.strip_prefix("http://").ok_or(local_engine::cause!(Error::Invalid))?;
        let (token, host) = match rest.split_once('@') {
            Some((token, host)) => (Some(token.to_owned()), host),
            None => (None, rest),
        };
        let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(120)).build();
        let made = agent
            .post(&format!("{admin}/v1/namespaces/{store_name}/create"))
            .set("Content-Type", "application/json")
            .send_string("{}");
        match made {
            Ok(_) => {}
            // The admin API answers 400 `StoreName ... already exists` for a store name made earlier (a restart).
            Err(ureq::Error::Status(_, response)) => {
                if !response.into_string().is_ok_and(|body| body.contains("already exists")) {
                    return Err(local_engine::cause!(Error::Unavailable));
                }
            }
            Err(_) => return Err(local_engine::cause!(Error::Unavailable)),
        }
        Ok(Self {
            agent,
            url: format!("http://{host}/v2/pipeline"),
            host: format!("{store_name}.localhost"),
            token,
            baton: RefCell::new(None),
            rounds: Counter::new(1),
            place: format!("http://{host} store_name={store_name}"),
        })
    }

    /// Send requests in one HTTP call; returns each request's response.
    fn call(&self, requests: Vec<Value>) -> Result<Vec<Value>> {
        self.rounds.set(self.rounds.get() + 1);
        let body = json!({"baton": self.baton.borrow().clone(), "requests": requests});
        let mut call = self.agent.post(&self.url).set("Content-Type", "application/json").set("Host", &self.host);
        if let Some(token) = &self.token {
            call = call.set("Authorization", &format!("Bearer {token}"));
        }
        let answer: Value = call.send_string(&body.to_string()).map_err(|_| local_engine::cause!(Error::Unavailable))?.into_json().map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))?;
        *self.baton.borrow_mut() = answer["baton"].as_str().map(str::to_owned);
        let mut results = Vec::new();
        for result in answer["results"].as_array().ok_or(local_engine::cause!(Error::Unavailable))? {
            if result["type"] == "error" {
                // The stream stays open after a failed statement (its transaction too), so the baton is kept.
                return Err(failure(result["error"]["message"].as_str().unwrap_or_default()));
            }
            results.push(result["response"].clone());
        }
        Ok(results)
    }
}

impl Drop for LibSql {
    /// A handle dropped with a transaction open is a crash: closing the stream rolls the transaction back on the server,
    /// which would otherwise hold its write lock until the stream expires.
    fn drop(&mut self) {
        let Some(baton) = self.baton.borrow_mut().take() else { return };
        let mut call = self.agent.post(&self.url).set("Content-Type", "application/json").set("Host", &self.host);
        if let Some(token) = &self.token {
            call = call.set("Authorization", &format!("Bearer {token}"));
        }
        let _ = call.send_string(&json!({"baton": baton, "requests": [{"type": "close"}]}).to_string());
    }
}

/// The most JSON one request carries (a byte is about 1.4 characters of base64); a longer pipeline goes in several.
const MAX_REQUEST: usize = 8 * 1024 * 1024;

fn statement(step: &Step) -> Value {
    json!({"sql": step.sql, "args": step.params.iter().map(argument).collect::<Vec<_>>()})
}

fn weight(step: &Step) -> usize {
    step.sql.len() + step.params.iter().map(|param| if let Param::Bytes(bytes) = param { bytes.len() * 3 / 2 + 40 } else { 40 }).sum::<usize>()
}

impl LibSql {
    /// Statements as one `batch` request in which each step runs only if the one before it succeeded, so a failure ends
    /// the run. The answers are in step order.
    fn batch(&self, steps: &[Step], answers: &mut Vec<Answer>) -> Result<()> {
        let listed: Vec<Value> = steps
            .iter()
            .enumerate()
            .map(|(at, step)| {
                let condition = if at == 0 { Value::Null } else { json!({"type": "ok", "step": at - 1}) };
                json!({"stmt": statement(step), "condition": condition})
            })
            .collect();
        let response = self.call(vec![json!({"type": "batch", "batch": {"steps": listed}})])?.pop().ok_or(local_engine::cause!(Error::Unavailable))?;
        let result = &response["result"];
        if let Some(error) = result["step_errors"].as_array().into_iter().flatten().find(|error| !error.is_null()) {
            return Err(failure(error["message"].as_str().unwrap_or_default()));
        }
        let results = result["step_results"].as_array().ok_or(local_engine::cause!(Error::Unavailable))?;
        for (step, one) in steps.iter().zip(results) {
            answers.push(match step.shape {
                Shape::Rows => Answer::Rows(
                    one["rows"].as_array().ok_or(local_engine::cause!(Error::Unavailable))?.iter().map(|row| row.as_array().ok_or(local_engine::cause!(Error::Unavailable))?.iter().map(cell).collect()).collect::<Result<_>>()?,
                ),
                Shape::Changed => Answer::Changed(one["affected_row_count"].as_u64().ok_or(local_engine::cause!(Error::Unavailable))?),
            });
        }
        if results.len() != steps.len() {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        Ok(())
    }
}

impl Wire for LibSql {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    fn pipeline(&self, steps: &[Step]) -> Result<Vec<Answer>> {
        let mut answers = Vec::with_capacity(steps.len());
        let mut from = 0;
        let mut size = 0;
        for (at, step) in steps.iter().enumerate() {
            if at > from && size + weight(step) >= MAX_REQUEST {
                self.batch(&steps[from..at], &mut answers)?;
                (from, size) = (at, 0);
            }
            size += weight(step);
        }
        if from < steps.len() {
            self.batch(&steps[from..], &mut answers)?;
        }
        Ok(answers)
    }

    fn script(&self, statements: &[String]) -> Result<()> {
        self.call(statements.iter().map(|sql| json!({"type": "execute", "stmt": {"sql": sql}})).collect()).map(|_| ())
    }

    fn rounds(&self) -> u64 {
        self.rounds.get()
    }

    fn place(&self) -> String {
        self.place.clone()
    }
}
