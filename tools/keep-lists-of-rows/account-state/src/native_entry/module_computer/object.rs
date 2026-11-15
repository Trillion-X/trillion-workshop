// src/native_entry/module_computer/object.rs
//
// Purpose: the module's two entries on its host. The front (`front`) turns `/a/<address>/...` into the one object of
// that account (by the address's name, as the old app's host adapter did with `idFromName`) and sends the request
// to it. The object (`AccountObject`) holds the account: its record store over its own SQL storage, its placement row,
// and the routes:
//   GET  /a/<address>/report                         this computer's report
//   GET  /a/<address>/placement                      the row this computer holds (404 before one)
//   PUT  /a/<address>/placement                      {expected_revision, row}: one compare-and-set on the revision
//   GET  /a/<address>/records/<resource>/<id>        a read from this computer's own copy
//   GET  /a/<address>/records/<resource>             a list page from this computer's own copy (?after=)
//   POST /a/<address>/records/<resource>             a Mutation; answered only while the row names this computer writer
//   GET  /a/<address>/stamp/<resource>               the newest stamp this copy holds
//   GET  /a/<address>/feed/<resource>?after=&limit=  the writer's change feed (`carried_page`), under the row's revision
//   GET  /a/<address>/history/<resource>?id=&version=&since=&before=&limit=
//   POST /a/<address>/follow/<resource>              catch up from the writer the row names
//
// Non-Negotiable Invariants:
// - No borrow of the record store is held across an await: each step of a follow reads, awaits the writer, then applies
//   one page whole (`apply_page_whole`), so a request that fails part way leaves whole pages only.
// - A follow sends no page this object has not checked: the writer's term is the row's revision, and a page from a
//   lower term is refused by the store itself.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{edit_allowed, host::ObjectSql, report, route, settings, word, Placement, PlacementEdit};
use serde_json::{json, Value};
use std::{cell::RefCell, collections::HashMap};
use crate::{
    records::{Change, Error as RecordError, Mutation, Records},
    storage::{
        hosted_sql,
        record_store::{
            follow::{Carried, FeedSource, HistoryPage, Past, WriterPage},
            settings::Limits,
            RecordStore, RealClock,
        },
    },
};
use worker::*;

type Store = RecordStore<hosted_sql::Supply<ObjectSql>>;

const PLACEMENT_KEY: &str = "placement";

#[event(fetch)]
async fn front(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();
    let Some((address, _)) = route(&path) else {
        return Response::error(word("no_route"), 404);
    };
    let objects = env.durable_object("ACCOUNT_OBJECT")?;
    objects.id_from_name(address)?.get_stub()?.fetch_with_request(req).await
}

#[durable_object]
pub struct AccountObject {
    state: State,
    env: Env,
    store: RefCell<Option<Store>>,
}

fn record_error(error: RecordError) -> Result<Response> {
    let cause = error.cause();
    let (status, code) = match &error {
        RecordError::Conflict(_) => (409, "record_conflict"),
        RecordError::Invalid(_, _) => (400, "invalid_record_request"),
        RecordError::Refused(_, _) => (403, "refused"),
        RecordError::Unavailable(_) => (503, "resource_unavailable"),
        RecordError::OutcomeUnknown(_) => (503, "resource_outcome_unknown"),
    };
    crate::quiet_eprintln!("door-refusal code={code} cause={cause}");
    Ok(Response::from_json(&json!({ "refused": code, "detail": format!("{error:?}"), "cause": cause.id() }))?.with_status(status))
}

fn query(req: &Request) -> Result<HashMap<String, String>> {
    Ok(req.url()?.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect())
}
fn number(query: &HashMap<String, String>, name: &str) -> Option<i64> {
    query.get(name).and_then(|value| value.parse().ok())
}

/// A writer's feed as this computer reads it over the network: the page already fetched, and the history pages fetched
/// so far. A history the page needs and nobody fetched yet is named in `wanted` and answered unavailable, so the
/// caller fetches it and applies the page again (applying a page is all or nothing).
struct Fetched {
    page: WriterPage,
    history: RefCell<HashMap<(String, i64, i64, i64), HistoryPage>>,
    wanted: RefCell<Option<(String, i64, i64, i64, usize)>>,
}
impl FeedSource for Fetched {
    fn page(&self, _account: &str, _resource: &str, _after: i64, _limit: usize) -> std::result::Result<WriterPage, RecordError> {
        Ok(self.page.clone())
    }
    fn caught_up(&self, _account: &str, _resource: &str, _stamp: i64) -> std::result::Result<(), RecordError> {
        Ok(())
    }
    fn history(&self, _account: &str, _resource: &str, id: &str, version: i64, since: i64, before: i64, limit: usize) -> std::result::Result<HistoryPage, RecordError> {
        if let Some(page) = self.history.borrow().get(&(id.to_owned(), version, since, before)) {
            return Ok(page.clone());
        }
        *self.wanted.borrow_mut() = Some((id.to_owned(), version, since, before, limit));
        Err(crate::cause!(RecordError::Unavailable))
    }
}

async fn get_json(url: &str) -> Result<Value> {
    let mut answer = Fetch::Url(Url::parse(url)?).send().await?;
    if answer.status_code() != 200 {
        return Err(Error::RustError(format!("{url} answered {}", answer.status_code())));
    }
    // Read as text and parsed here: the host's own JSON reader rounds a stamp past 53 bits.
    serde_json::from_str(&answer.text().await?).map_err(|error| Error::RustError(error.to_string()))
}

impl AccountObject {
    fn computer_id(&self) -> String {
        self.env.var("COMPUTER_ID").map(|var| var.to_string()).unwrap_or_default()
    }
    fn reach(&self) -> String {
        self.env.var("COMPUTER_REACH").map(|var| var.to_string()).unwrap_or_default()
    }
    fn always_on(&self) -> Option<bool> {
        self.env.var("COMPUTER_ALWAYS_ON").ok().and_then(|var| var.to_string().parse().ok())
    }
    /// The record store over this object's own SQL storage, opened at its first use.
    fn with_store<T>(&self, run: impl FnOnce(&mut Store) -> std::result::Result<T, RecordError>) -> std::result::Result<T, RecordError> {
        let mut held = self.store.borrow_mut();
        if held.is_none() {
            let supply = hosted_sql::open(ObjectSql(self.state.storage().sql()), "record_store", settings().max_record_bytes).map_err(|error| crate::carry_cause!(RecordError::Unavailable, error))?;
            let limits = Limits::fixed(settings().max_record_bytes, settings().storage_bytes);
            *held = Some(RecordStore::new(supply, Box::new(RealClock), limits)?);
        }
        run(held.as_mut().expect("opened above"))
    }
    async fn placement(&self) -> Result<Option<Placement>> {
        self.state.storage().get::<Placement>(PLACEMENT_KEY).await
    }

    async fn follow(&self, address: &str, resource: &str, row: &Placement) -> Result<Response> {
        let writer = row.computers.get(&row.writer).cloned().unwrap_or_default();
        let (limit, most) = (settings().follow_page, settings().follow_pages_per_request);
        let (mut applied_total, mut pages) = (0usize, 0usize);
        loop {
            let after = match self.with_store(|store| store.stamp(address, resource)) {
                Ok(stamp) => stamp,
                Err(error) => return record_error(error),
            };
            let body = get_json(&format!("{writer}/a/{address}/feed/{resource}?after={after}&limit={limit}")).await?;
            let changes: Vec<Carried> = serde_json::from_value(body["changes"].clone()).map_err(|error| Error::RustError(error.to_string()))?;
            let term = body["term"].as_u64().unwrap_or(0);
            if term != row.revision {
                // The computer that answer is not the writer under the row this computer holds: nothing of it is applied.
                return Ok(Response::from_json(&json!({ "refused": "stale_writer", "term": term, "row": row.revision }))?.with_status(409));
            }
            let fetched = Fetched {
                page: WriterPage { term, base: body["base"].as_i64().unwrap_or(0), changes, more: body["more"].as_bool().unwrap_or(false) },
                history: RefCell::new(HashMap::new()),
                wanted: RefCell::new(None),
            };
            let applied = loop {
                match self.with_store(|store| store.apply_page_whole(&fetched, address, resource, &fetched.page, limit)) {
                    Ok(applied) => break applied,
                    Err(RecordError::Unavailable(_)) if fetched.wanted.borrow().is_some() => {
                        let (id, version, since, before, most) = fetched.wanted.borrow_mut().take().expect("named above");
                        let page = get_json(&format!(
                            "{writer}/a/{address}/history/{resource}?id={id}&version={version}&since={since}&before={before}&limit={most}"
                        ))
                        .await?;
                        let versions: Vec<Past> = serde_json::from_value(page["versions"].clone()).map_err(|error| Error::RustError(error.to_string()))?;
                        fetched.history.borrow_mut().insert(
                            (id, version, since, before),
                            HistoryPage {
                                term: page["term"].as_u64().unwrap_or(0),
                                base: page["base"].as_i64().unwrap_or(0),
                                versions,
                                more: page["more"].as_bool().unwrap_or(false),
                                kept: page["kept"].as_i64().unwrap_or(0),
                                sealed: false,
                            },
                        );
                    }
                    Err(error) => return record_error(error),
                }
            };
            applied_total += applied.applied;
            pages += 1;
            if !fetched.page.more || pages >= most {
                return Response::from_json(&json!({ "stamp": applied.stamp, "applied": applied_total, "pages": pages, "more": fetched.page.more }));
            }
            if applied.stamp == after {
                return Ok(Response::from_json(&json!({ "refused": "follow_stalled", "detail": word("follow_stalled") }))?.with_status(503));
            }
        }
    }
}

impl DurableObject for AccountObject {
    fn new(state: State, env: Env) -> Self {
        Self { state, env, store: RefCell::new(None) }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let path = req.path();
        let Some((address, parts)) = route(&path) else { return Response::error(word("no_route"), 404) };
        let address = address.to_owned();
        let parts: Vec<String> = parts.into_iter().map(str::to_owned).collect();
        let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
        let method = req.method();
        if parts == ["report"] {
            return Response::from_json(&report(&self.reach(), self.always_on()));
        }
        let held = self.placement().await?;
        match (method, parts.as_slice()) {
            (Method::Get, ["placement"]) => match held {
                Some(row) => Response::from_json(&row),
                None => Response::error(word("not_placed"), 404),
            },
            (Method::Put, ["placement"]) => {
                let Some(edit) = req.text().await.ok().and_then(|text| serde_json::from_str::<PlacementEdit>(&text).ok()) else { return Response::error(word("bad_request"), 400) };
                if !edit_allowed(held.as_ref(), &edit) {
                    return Ok(Response::from_json(&json!({ "refused": "stale_row", "detail": word("stale_row"), "held": held }))?.with_status(409));
                }
                self.state.storage().put(PLACEMENT_KEY, &edit.row).await?;
                Response::from_json(&json!({ "revision": edit.row.revision, "holds": edit.row.holds(&self.computer_id()), "writer": edit.row.writer == self.computer_id() }))
            }
            _ => {
                let Some(row) = held.filter(|row| row.holds(&self.computer_id())) else {
                    return Ok(Response::from_json(&json!({ "refused": "not_placed", "detail": word("not_placed") }))?.with_status(404));
                };
                let writer = row.writer == self.computer_id();
                let query = query(&req)?;
                match (req.method(), parts.as_slice()) {
                    (Method::Get, ["records", resource, id]) => match self.with_store(|store| store.get(&address, resource, id)) {
                        Ok(read) => Response::from_json(&json!({ "record": read.record, "computer": self.computer_id() })),
                        Err(error) => record_error(error),
                    },
                    (Method::Get, ["records", resource]) => {
                        let after = query.get("after").cloned().unwrap_or_default();
                        match self.with_store(|store| store.list_page(&address, resource, &after, settings().list_page)) {
                            Ok(page) => Response::from_json(&json!({ "items": page.items, "next": page.next, "computer": self.computer_id() })),
                            Err(error) => record_error(error),
                        }
                    }
                    (Method::Post, ["records", resource]) => {
                        if !writer {
                            return Ok(Response::from_json(&json!({ "refused": "not_writer", "writer": row.writer, "detail": word("not_writer") }))?.with_status(409));
                        }
                        let Some(mutation) = req.text().await.ok().and_then(|text| serde_json::from_str::<Mutation>(&text).ok()) else { return Response::error(word("bad_request"), 400) };
                        match self.with_store(|store| store.mutate(&address, resource, mutation)) {
                            Ok(change) => Response::from_json::<Change>(&change),
                            Err(error) => record_error(error),
                        }
                    }
                    (Method::Get, ["stamp", resource]) => match self.with_store(|store| store.stamp(&address, resource)) {
                        Ok(stamp) => Response::from_json(&json!({ "stamp": stamp, "computer": self.computer_id() })),
                        Err(error) => record_error(error),
                    },
                    (Method::Get, ["feed", resource]) => {
                        if !writer {
                            return Ok(Response::from_json(&json!({ "refused": "not_writer", "writer": row.writer }))?.with_status(409));
                        }
                        let after = number(&query, "after").unwrap_or(0);
                        let limit = number(&query, "limit").map_or(settings().follow_page, |limit| limit.clamp(1, 1000) as usize);
                        match self.with_store(|store| store.carried_page(&address, resource, after, limit, 8)) {
                            Ok((changes, more)) => Response::from_json(&json!({ "term": row.revision, "base": 0, "changes": changes, "more": more })),
                            Err(error) => record_error(error),
                        }
                    }
                    (Method::Get, ["history", resource]) => {
                        let id = query.get("id").cloned().unwrap_or_default();
                        let field = |name| number(&query, name).unwrap_or(0);
                        let limit = field("limit").clamp(1, 1000) as usize;
                        match self.with_store(|store| store.history_page(&address, resource, &id, field("version"), field("since"), field("before"), limit)) {
                            Ok((versions, more, kept)) => Response::from_json(&json!({ "term": row.revision, "base": 0, "versions": versions, "more": more, "kept": kept })),
                            Err(error) => record_error(error),
                        }
                    }
                    (Method::Post, ["follow", resource]) => {
                        if writer {
                            return Response::from_json(&json!({ "stamp": self.with_store(|store| store.stamp(&address, resource)).unwrap_or(0), "writer": true }));
                        }
                        self.follow(&address, resource, &row).await
                    }
                    _ => Response::error(word("no_route"), 404),
                }
            }
        }
    }
}
