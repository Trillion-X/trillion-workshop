// src/store/by_calls.rs
//
// Purpose: The person's names rows reached by calls, so the run that holds the byte store's key never holds the database's
// login. The engine lets one process reach only the hosts every value it holds may go to (the engine's network fence), so a run that held both the S3 key and the database login could reach no host at all. `RowsByCalls` is a `Rows`
// whose every operation is one call `send(operation, arguments)` that answers JSON. `answer` is the other side: one
// operation of any `Rows`, answered as that JSON. The run that answers (`live-namespace rows`) holds the login alone.
//
// Non-Negotiable Invariants:
// - Every operation of `Rows` crosses under its own name in `OPERATIONS`, and `answer` refuses any other name.
// - Each operation is atomic on its own (a mutate is a compare-and-set on the row's version, one change one transaction),
//   so no transaction spans calls.
// - A refusal crosses as its kind (conflict, invalid, unavailable, outcome unknown), never as a value of a row.
// - A mutate whose call failed after it may have been sent answers OutcomeUnknown: the caller retries under the mutation's
//   own request key, which the store answers once.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{Change, Changed, Error, Mutation, Page, Read, Record, Rows, Total};
use serde_json::{json, Value};
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

/// Every operation of `Rows`, by the name it crosses under.
pub const OPERATIONS: [&str; 14] = [
    "get", "get_many", "held_record_with_version", "list_page", "ids", "mutate", "stamp", "totals", "search", "place", "order",
    "changes", "minted", "wait_for_order",
];

/// One call: the operation's name and its arguments, answered with the JSON `answer` gives (`{"answer": ..}` or
/// `{"refused": ..}`), or the call's own failure.
pub type Send = dyn Fn(&str, &Value, Duration) -> Result<Value, Error> + std::marker::Send + Sync;

/// How long a call may take, past a wait the call itself asks for.
const CALL_WAIT: Duration = Duration::from_secs(30);

/// The person's rows, reached by calls.
pub struct RowsByCalls {
    send: Box<Send>,
    place: OnceLock<String>,
}

impl RowsByCalls {
    pub fn new(send: Box<Send>) -> Self {
        Self { send, place: OnceLock::new() }
    }

    /// The answer of one call, or its refusal as the store's own error.
    fn call(&self, operation: &str, arguments: Value, wait: Duration) -> Result<Value, Error> {
        // How long each call took, by its operation's name only (never a value of it): the run's process evidence.
        let began = std::time::Instant::now();
        let said = (self.send)(operation, &arguments, wait);
        crate::quiet_eprintln!("names-call operation={operation} ms={} outcome={}", began.elapsed().as_millis(),
            match &said { Ok(said) if said.get("refused").is_some() => "refused", Ok(_) => "answered", Err(_) => "failed" });
        let said = said?;
        if let Some(refused) = said.get("refused") {
            return Err(refusal_of(refused));
        }
        said.get("answer").cloned().ok_or(crate::cause!(Error::Unavailable))
    }

    fn ask(&self, operation: &str, arguments: Value) -> Result<Value, Error> {
        self.call(operation, arguments, CALL_WAIT)
    }
}

impl Rows for RowsByCalls {
    fn get(&self, scope: &str, id: &str) -> Result<Read, Error> {
        Ok(Read { record: record_or_none(&self.ask("get", json!({"scope": scope, "id": id}))?)? })
    }

    fn get_many(&self, scope: &str, ids: &[&str]) -> Result<Vec<Option<Record>>, Error> {
        let answer = self.ask("get_many", json!({"scope": scope, "ids": ids}))?;
        let records = array(&answer)?.iter().map(record_or_none).collect::<Result<Vec<_>, _>>()?;
        if records.len() != ids.len() {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok(records)
    }

    fn held_record_with_version(&self, scope: &str, id: &str) -> Result<(i64, Option<Record>), Error> {
        let answer = self.ask("held_record_with_version", json!({"scope": scope, "id": id}))?;
        Ok((int(&answer["version"])?, record_or_none(&answer["record"])?))
    }

    fn list_page(&self, scope: &str, after: &str, limit: usize) -> Result<Page<Record, String>, Error> {
        let answer = self.ask("list_page", json!({"scope": scope, "after": after, "limit": limit}))?;
        let items = array(&answer["items"])?.iter().map(record).collect::<Result<Vec<_>, _>>()?;
        let next = text_or_none(&answer["next"])?;
        Ok(Page { items, next, serialized_item_bytes: count(&answer["serialized_item_bytes"])? })
    }

    fn ids(&self, scope: &str, after: Option<&str>, limit: usize) -> Result<(Vec<String>, Option<String>), Error> {
        let answer = self.ask("ids", json!({"scope": scope, "after": after, "limit": limit}))?;
        let ids = array(&answer["ids"])?.iter().map(text).collect::<Result<Vec<_>, _>>()?;
        Ok((ids, text_or_none(&answer["next"])?))
    }

    fn mutate(&self, scope: &str, input: Mutation) -> Result<Change, Error> {
        let arguments = json!({"scope": scope, "mutation": input});
        // The change may have been made before the call failed: the caller retries under the mutation's request key.
        let answer = self.ask("mutate", arguments).map_err(|error| match error {
            Error::Unavailable(cause) => Error::OutcomeUnknown(cause),
            other => other,
        })?;
        serde_json::from_value(answer).map_err(|_| crate::cause!(Error::OutcomeUnknown))
    }

    fn stamp(&self, scope: &str) -> Result<i64, Error> {
        int(&self.ask("stamp", json!({"scope": scope}))?)
    }

    fn totals(&self) -> Result<Vec<Total>, Error> {
        array(&self.ask("totals", json!({}))?)?.iter().map(total).collect()
    }

    fn search(&self, words: &[String], hits: usize) -> Result<Vec<Record>, Error> {
        array(&self.ask("search", json!({"words": words, "hits": hits}))?)?.iter().map(record).collect()
    }

    fn place(&self) -> String {
        // Where the rows are, for a person to read: asked once, and said as the run that keeps them when it does not answer.
        if let Some(place) = self.place.get() {
            return place.clone();
        }
        match self.ask("place", json!({})).ok().and_then(|answer| answer.as_str().map(str::to_owned)) {
            Some(place) => self.place.get_or_init(|| place).clone(),
            None => "the run that keeps the names".to_owned(),
        }
    }

    fn order(&self) -> Result<i64, Error> {
        int(&self.ask("order", json!({}))?)
    }

    fn changes(&self, prefixes: &[&str], after: i64, limit: usize) -> Result<Page<Changed, i64>, Error> {
        let answer = self.ask("changes", json!({"prefixes": prefixes, "after": after, "limit": limit}))?;
        let items = array(&answer["items"])?.iter().map(changed).collect::<Result<Vec<_>, _>>()?;
        let next = if answer["next"].is_null() { None } else { Some(int(&answer["next"])?) };
        Ok(Page { items, next, serialized_item_bytes: count(&answer["serialized_item_bytes"])? })
    }

    fn minted(&self, prefixes: &[&str], minted: i64) -> Result<Option<(String, Record)>, Error> {
        let answer = self.ask("minted", json!({"prefixes": prefixes, "minted": minted}))?;
        if answer.is_null() {
            return Ok(None);
        }
        Ok(Some((text(&answer["scope"])?, record(&answer["record"])?)))
    }

    fn wait_for_order(&self, after: i64, until: Instant) -> Result<i64, Error> {
        let wait = until.saturating_duration_since(Instant::now());
        let wait_ms = u64::try_from(wait.as_millis()).unwrap_or(u64::MAX);
        int(&self.call("wait_for_order", json!({"after": after, "wait_ms": wait_ms}), wait + CALL_WAIT)?)
    }
}

/// One operation of `store`, answered as the JSON a call carries: `{"answer": ..}`, or `{"refused": {kind, words}}`.
pub fn answer(store: &dyn Rows, operation: &str, arguments: &Value) -> Value {
    let began = std::time::Instant::now();
    let answered = answered(store, operation, arguments);
    // How long the store took, by the operation's name only: with the caller's own line, the door's share is the difference.
    crate::quiet_eprintln!("names-answer operation={operation} ms={} outcome={}", began.elapsed().as_millis(),
        if answered.is_ok() { "answered" } else { "refused" });
    match answered {
        Ok(answer) => json!({"answer": answer}),
        Err(error) => json!({"refused": refusal(&error)}),
    }
}

fn answered(store: &dyn Rows, operation: &str, a: &Value) -> Result<Value, Error> {
    let scope = || text_at(a, "scope");
    let limit = || count(&a["limit"]);
    let prefixes = || -> Result<Vec<String>, Error> { array(&a["prefixes"])?.iter().map(text).collect() };
    Ok(match operation {
        "get" => record_value(store.get(&scope()?, &text_at(a, "id")?)?.record.as_ref()),
        "get_many" => {
            let ids = array(&a["ids"])?.iter().map(text).collect::<Result<Vec<_>, _>>()?;
            let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
            Value::Array(store.get_many(&scope()?, &ids)?.iter().map(Option::as_ref).map(record_value).collect())
        }
        "held_record_with_version" => {
            let (version, record) = store.held_record_with_version(&scope()?, &text_at(a, "id")?)?;
            json!({"version": version, "record": record_value(record.as_ref())})
        }
        "list_page" => {
            let page = store.list_page(&scope()?, &text_at(a, "after")?, limit()?)?;
            json!({"items": page.items, "next": page.next, "serialized_item_bytes": page.serialized_item_bytes})
        }
        "ids" => {
            let (ids, next) = store.ids(&scope()?, text_or_none(&a["after"])?.as_deref(), limit()?)?;
            json!({"ids": ids, "next": next})
        }
        "mutate" => {
            let mutation: Mutation = serde_json::from_value(a["mutation"].clone())
                .map_err(|_| Error::Invalid("a mutate names one mutation", crate::cause!()))?;
            serde_json::to_value(store.mutate(&scope()?, mutation)?).map_err(|_| crate::cause!(Error::OutcomeUnknown))?
        }
        "stamp" => json!(store.stamp(&scope()?)?),
        "totals" => Value::Array(store.totals()?.iter().map(total_value).collect()),
        "search" => {
            let words = array(&a["words"])?.iter().map(text).collect::<Result<Vec<_>, _>>()?;
            json!(store.search(&words, count(&a["hits"])?)?)
        }
        "place" => json!(store.place()),
        "order" => json!(store.order()?),
        "changes" => {
            let prefixes = prefixes()?;
            let prefixes: Vec<&str> = prefixes.iter().map(String::as_str).collect();
            let page = store.changes(&prefixes, int(&a["after"])?, limit()?)?;
            let items: Vec<Value> = page.items.iter().map(changed_value).collect();
            json!({"items": items, "next": page.next, "serialized_item_bytes": page.serialized_item_bytes})
        }
        "minted" => {
            let prefixes = prefixes()?;
            let prefixes: Vec<&str> = prefixes.iter().map(String::as_str).collect();
            match store.minted(&prefixes, int(&a["minted"])?)? {
                Some((scope, record)) => json!({"scope": scope, "record": record}),
                None => Value::Null,
            }
        }
        "wait_for_order" => {
            let wait = Duration::from_millis(a["wait_ms"].as_u64().ok_or(Error::Invalid("a wait names its milliseconds", crate::cause!()))?);
            json!(store.wait_for_order(int(&a["after"])?, Instant::now() + wait)?)
        }
        _ => return Err(Error::Invalid("no operation of the rows has this name", crate::cause!())),
    })
}

/// A refusal as it crosses: its kind and the store's own words for it.
fn refusal(error: &Error) -> Value {
    let kind = match error {
        Error::Conflict(_) => "conflict",
        Error::Invalid(..) => "invalid",
        Error::Unavailable(_) => "unavailable",
        Error::OutcomeUnknown(_) => "outcome_unknown",
    };
    json!({"kind": kind, "words": error.to_string()})
}

/// A refusal that crossed, as the store's error. Its words stay with the run that refused; an invalid call is said here in
/// words of its own.
fn refusal_of(refused: &Value) -> Error {
    match refused["kind"].as_str() {
        Some("conflict") => crate::cause!(Error::Conflict),
        Some("invalid") => Error::Invalid("the run that keeps the names refused the call as not valid", crate::cause!()),
        Some("outcome_unknown") => crate::cause!(Error::OutcomeUnknown),
        _ => crate::cause!(Error::Unavailable),
    }
}

fn record_value(record: Option<&Record>) -> Value {
    record.map_or(Value::Null, |record| serde_json::to_value(record).unwrap_or(Value::Null))
}

fn total_value(total: &Total) -> Value {
    json!({"total": total.total, "group": total.group, "count": total.count, "sum": total.sum})
}

fn changed_value(changed: &Changed) -> Value {
    json!({"scope": changed.scope, "id": changed.id, "changed": changed.changed, "version": changed.version,
        "record": record_value(changed.record.as_ref()), "minted": changed.minted})
}

fn unreadable() -> Error {
    crate::cause!(Error::Unavailable)
}

fn record(value: &Value) -> Result<Record, Error> {
    serde_json::from_value(value.clone()).map_err(|_| unreadable())
}

fn record_or_none(value: &Value) -> Result<Option<Record>, Error> {
    if value.is_null() { Ok(None) } else { record(value).map(Some) }
}

fn total(value: &Value) -> Result<Total, Error> {
    Ok(Total { total: text(&value["total"])?, group: text_or_none(&value["group"])?, count: int(&value["count"])?, sum: int(&value["sum"])? })
}

fn changed(value: &Value) -> Result<Changed, Error> {
    let minted = if value["minted"].is_null() { None } else { Some(int(&value["minted"])?) };
    Ok(Changed { scope: text(&value["scope"])?, id: text(&value["id"])?, changed: int(&value["changed"])?, version: int(&value["version"])?,
        record: record_or_none(&value["record"])?, minted })
}

fn array(value: &Value) -> Result<&Vec<Value>, Error> {
    value.as_array().ok_or_else(unreadable)
}

fn text(value: &Value) -> Result<String, Error> {
    value.as_str().map(str::to_owned).ok_or_else(unreadable)
}

fn text_at(arguments: &Value, field: &'static str) -> Result<String, Error> {
    arguments[field].as_str().map(str::to_owned).ok_or(Error::Invalid("a call names each text it takes", crate::cause!()))
}

fn text_or_none(value: &Value) -> Result<Option<String>, Error> {
    if value.is_null() { Ok(None) } else { text(value).map(Some) }
}

fn int(value: &Value) -> Result<i64, Error> {
    value.as_i64().ok_or_else(unreadable)
}

fn count(value: &Value) -> Result<usize, Error> {
    value.as_u64().and_then(|count| usize::try_from(count).ok()).ok_or_else(unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SqlStore;
    use std::sync::Arc;

    /// Rows reached by calls to `answer` over a store of their own, every argument and answer crossing as JSON text.
    fn by_calls(store: Arc<SqlStore>) -> RowsByCalls {
        RowsByCalls::new(Box::new(move |operation: &str, arguments: &Value, _: Duration| {
            let crossed: Value = serde_json::from_str(&arguments.to_string()).unwrap();
            let said = answer(store.as_ref(), operation, &crossed);
            Ok(serde_json::from_str(&said.to_string()).unwrap())
        }))
    }

    fn put(rows: &dyn Rows, scope: &str, id: &str, expected_version: i64, key: &str, value: Value) -> Result<Change, Error> {
        rows.mutate(scope, Mutation { id: id.into(), expected_version, request_key: key.into(), deleted: false, value })
    }

    #[test]
    fn every_operation_answers_by_calls_what_the_store_answers_itself() {
        let store = Arc::new(SqlStore::memory().unwrap());
        let calls = by_calls(store.clone());
        let scope = "@namespace/names/a";
        let first = put(&calls, scope, "one", 0, "k1", json!({"name": "first words"})).unwrap();
        put(store.as_ref(), scope, "two", 0, "k2", json!({"name": "second"})).unwrap();
        assert_eq!(first.version, 1);
        assert_eq!(calls.get(scope, "one").unwrap().record, store.get(scope, "one").unwrap().record);
        assert_eq!(calls.get(scope, "none").unwrap().record, None);
        assert_eq!(calls.get_many(scope, &["two", "none", "one"]).unwrap(), store.get_many(scope, &["two", "none", "one"]).unwrap());
        assert_eq!(calls.held_record_with_version(scope, "one").unwrap(), store.held_record_with_version(scope, "one").unwrap());
        let (by_call, direct) = (calls.list_page(scope, "", 1).unwrap(), store.list_page(scope, "", 1).unwrap());
        assert_eq!((by_call.items, by_call.next), (direct.items, direct.next));
        assert_eq!(calls.ids(scope, None, 10).unwrap(), store.ids(scope, None, 10).unwrap());
        assert_eq!(calls.stamp(scope).unwrap(), store.stamp(scope).unwrap());
        assert_eq!(calls.totals().unwrap(), store.totals().unwrap());
        assert_eq!(calls.order().unwrap(), store.order().unwrap());
        let (by_call, direct) = (calls.changes(&["@namespace/"], 0, 10).unwrap(), store.changes(&["@namespace/"], 0, 10).unwrap());
        assert_eq!((by_call.items, by_call.next), (direct.items, direct.next));
        assert_eq!(calls.minted(&["@namespace/"], 1).unwrap(), store.minted(&["@namespace/"], 1).unwrap());
        assert_eq!(calls.place(), store.place());
        let order = store.order().unwrap();
        assert_eq!(calls.wait_for_order(order, Instant::now() + Duration::from_millis(20)).unwrap(), order);
    }

    #[test]
    fn a_conflict_crosses_as_a_conflict_and_a_retry_under_the_same_key_answers_the_same_change() {
        let store = Arc::new(SqlStore::memory().unwrap());
        let calls = by_calls(store);
        let scope = "@namespace/names/a";
        let made = put(&calls, scope, "one", 0, "k1", json!({"name": "x"})).unwrap();
        assert_eq!(put(&calls, scope, "one", 0, "k1", json!({"name": "x"})).unwrap(), made);
        assert!(matches!(put(&calls, scope, "one", 0, "k9", json!({"name": "y"})), Err(Error::Conflict(_))));
    }

    #[test]
    fn a_mutate_whose_call_fails_is_an_unknown_outcome_and_a_read_is_unavailable() {
        let failing = RowsByCalls::new(Box::new(|_: &str, _: &Value, _: Duration| Err(crate::cause!(Error::Unavailable))));
        assert!(matches!(put(&failing, "@namespace/x", "one", 0, "k", json!({})), Err(Error::OutcomeUnknown(_))));
        assert!(matches!(failing.get("@namespace/x", "one"), Err(Error::Unavailable(_))));
    }

    #[test]
    fn an_operation_of_no_such_name_is_refused_and_every_name_is_answered() {
        let store = SqlStore::memory().unwrap();
        assert_eq!(answer(&store, "drop_everything", &json!({}))["refused"]["kind"], "invalid");
        for operation in OPERATIONS {
            let said = answer(&store, operation, &json!({}));
            assert!(said["refused"]["kind"] != "invalid" || said["refused"]["words"] != "no operation of the rows has this name", "{operation}");
        }
    }
}
