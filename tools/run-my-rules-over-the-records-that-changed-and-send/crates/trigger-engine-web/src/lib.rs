// crates/trigger-engine-web/src/lib.rs
//
// Purpose:
//   Runs the trigger engine (crates/trigger-engine, ported whole from bitfield-packages) over a person's own records
//   inside a wasm host: the host hands in the records that changed, the engine keeps every `trigger-rule`
//   record resident, checks each change against every rule's `match_condition`, and sends each matched rule's
//   rendered `output_template` to its `dispatch.target`. The engine reaches nothing itself; everything it needs from
//   outside is one host function, `answer(request)`.
//
// Non-Negotiable Invariants:
//   1. The engine is unchanged; this crate only translates. A change is `{address, path?, value}` (or
//      `{address, removed: true}`); a record whose path names `trigger-rule` is a rule. Record addresses reach rules
//      as `envelope.address_text`, record values as `change`.
//   2. The engine asks for three things and the host answers each as JSON (`Request`):
//      `{kind: "read", address}` → the record's current value (or null when it is gone);
//      `{kind: "list", cursor, limit, addresses}` → `{entries: [{address, path, value}], next_cursor}` (current
//      records, only when the engine reconciles after a delivery gap);
//      `{kind: "send", target, payload, later}` → the target's reply. `later: true` means the rule chose
//      `later_with_durable_outcome`: the host keeps the request durably and the receipt is made here from its bytes.
//   3. Content identities are BLAKE3 multihashes of the value's JSON bytes, computed here the same way for a change
//      and for a read, so the engine's "the bytes I read are the bytes that changed" check holds.
//   4. A target is sent by the name its rule gave. The engine hashes names into addresses, so this crate keeps the
//      name of every target and evaluator a rule it has seen names; a send to a name no seen rule gave is refused.
//   5. `apply` returns `{status, dispatch_failures, writes: [{address, payload}], continue}`: `writes` are the
//      engine's durable failure and dispatch-outcome records for the host to keep.
//   6. A Worker runs one thread, so the host's JavaScript function and the futures awaiting it are marked sendable
//      here and nowhere else.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
use std::collections::HashMap;

/// The path segment a change carries for the engine to read it as a rule (invariant 1; the engine's own
/// `trigger_rule_path_segment`). A host hands each rule as `{address, path: [RULE_PATH], value}` and names no rule
/// word of its own.
pub const RULE_PATH: &str = "trigger-rule";
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use bytes::Bytes;
use serde_json::{json, Value};
use slot_protocol::{
    DeltaPayload, Envelope, FactAddress, PartitionKey, PathSegment, ReplyDelivery, WireAssert,
};
use trigger_engine::slot_work::HandleOutcome;
use trigger_engine::TriggerRule;

/// The names of targets and evaluators the rules seen so far give, by the address the engine hashes them into.
#[derive(Default)]
pub struct Names(Mutex<HashMap<FactAddress, String>>);

impl Names {
    fn learn(&self, value: &Value) {
        let Ok(rule) = serde_json::from_value::<TriggerRule>(value.clone()) else { return };
        let Ok(mut names) = self.0.lock() else { return };
        names.insert(FactAddress::hash_from(&rule.dispatch.target), rule.dispatch.target.clone());
        if let Some(evaluator) = rule.evaluator {
            names.insert(FactAddress::hash_from(&evaluator.address), evaluator.address);
        }
    }

    fn name_of(&self, address: &FactAddress) -> Option<String> {
        self.0.lock().ok()?.get(address).cloned()
    }
}

/// A record's address as the engine carries it: the address text itself as the digest, so rules read it back as
/// `envelope.address_text`.
fn record_address(text: &str) -> FactAddress {
    FactAddress::from_digest(0x1F, text.as_bytes().to_vec())
}

fn address_text(address: &FactAddress) -> String {
    address.as_utf8_text().map_or_else(|| address.to_string(), str::to_string)
}

fn content_hash(bytes: &[u8]) -> content_crypto::Multihash {
    content_crypto::Multihash::blake3(bytes)
}

fn value_bytes(value: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|error| format!("record value: {error}"))
}

fn path_of(change: &Value) -> Vec<String> {
    change
        .get("path")
        .and_then(Value::as_array)
        .map(|segments| segments.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// The engine's input for a list of changed records.
pub fn delta_for(partition: &str, changes: &Value, names: &Names) -> Result<Envelope, String> {
    let changes = changes.as_array().ok_or("changes must be a list")?;
    let mut delta = DeltaPayload { kind: "delta".into(), asserts: Vec::new(), retracts: Vec::new(), gap: None };
    for change in changes {
        let address = change.get("address").and_then(Value::as_str).ok_or("a change needs an address")?;
        let wire_address = record_address(address).to_wire_hex();
        if change.get("removed").and_then(Value::as_bool) == Some(true) {
            delta.retracts.push(wire_address);
            continue;
        }
        let value = change.get("value").ok_or_else(|| format!("the change at {address} has no value"))?;
        names.learn(value);
        let bytes = value_bytes(value)?;
        delta.asserts.push(WireAssert {
            address: wire_address,
            content_hash: hex::encode(content_hash(&bytes).encode()),
            path: path_of(change).iter().map(|segment| PathSegment::hash_from(segment).to_wire_hex()).collect(),
            content: Some(STANDARD.encode(bytes)),
        });
    }
    let payload = serde_json::to_vec(&delta).map_err(|error| error.to_string())?;
    Ok(Envelope::minimal(
        PartitionKey::hash_from(partition),
        FactAddress::hash_from("trigger-engine"),
        Some(Bytes::from(payload)),
    ))
}

/// What the engine needs from the host for one outward envelope.
pub struct Request {
    pub json: Value,
    kind: RequestKind,
}

enum RequestKind {
    Read,
    List { path_prefix: Vec<String> },
    Send { later: Option<Vec<u8>> },
}

/// Translate one outward envelope into the host's request.
pub fn request_for(envelope: &Envelope, delivery: ReplyDelivery, names: &Names) -> Result<Request, String> {
    if envelope.address == FactAddress::hash_from(slot_protocol::LIVE_STATE_ADDRESS) {
        let request = slot_protocol::decode_list_live_state_request(envelope.payload.as_deref().unwrap_or_default())
            .map_err(|error| error.to_string())?;
        return Ok(Request {
            json: json!({
                "kind": "list",
                "cursor": request.cursor,
                "limit": request.limit,
                "addresses": request.addresses.iter().map(address_text).collect::<Vec<_>>(),
            }),
            kind: RequestKind::List { path_prefix: request.path_prefix.iter().map(PathSegment::to_wire_hex).collect() },
        });
    }
    let Some(payload) = envelope.payload.as_deref() else {
        return Ok(Request { json: json!({"kind": "read", "address": address_text(&envelope.address)}), kind: RequestKind::Read });
    };
    let target = names
        .name_of(&envelope.address)
        .ok_or_else(|| format!("no rule seen names the target at {}", envelope.address))?;
    let payload_value: Value = serde_json::from_slice(payload).map_err(|error| format!("dispatch payload: {error}"))?;
    let later = match delivery {
        ReplyDelivery::LaterWithDurableOutcome => Some(
            slot_protocol::make_request_bytes_for_other_slots_with_reply_delivery(envelope, delivery)
                .map_err(|error| error.to_string())?,
        ),
        _ => None,
    };
    Ok(Request {
        json: json!({"kind": "send", "target": target, "payload": payload_value, "later": later.is_some()}),
        kind: RequestKind::Send { later },
    })
}

impl Request {
    /// The bytes the engine expects back, from the host's JSON answer.
    pub fn reply_bytes(&self, answer: &Value, names: &Names) -> Result<Vec<u8>, String> {
        match &self.kind {
            RequestKind::Read => {
                if answer.is_null() {
                    return Err(format!("{} is gone", self.json["address"].as_str().unwrap_or_default()));
                }
                names.learn(answer);
                let payload = value_bytes(answer)?;
                slot_protocol::encode_direct_read_reply(&slot_protocol::DirectReadReply {
                    content_hash: content_hash(&payload).to_code_hex(),
                    payload,
                })
                .map_err(|error| error.to_string())
            }
            RequestKind::List { path_prefix } => {
                let mut entries = Vec::new();
                for entry in answer.get("entries").and_then(Value::as_array).into_iter().flatten() {
                    let address = entry.get("address").and_then(Value::as_str).ok_or("a listed record needs an address")?;
                    let path: Vec<String> = path_of(entry).iter().map(|segment| PathSegment::hash_from(segment).to_wire_hex()).collect();
                    if !path.starts_with(path_prefix) {
                        continue;
                    }
                    let payload = value_bytes(entry.get("value").unwrap_or(&Value::Null))?;
                    entries.push(slot_protocol::LiveStateEntryReply {
                        address: record_address(address).as_multihash().encode(),
                        content_hash: content_hash(&payload).to_code_hex(),
                        path: path.iter().map(|segment| hex::decode(segment).unwrap_or_default()).collect(),
                        payload: None,
                    });
                }
                let reply = slot_protocol::ListLiveStateReply { entries, next_cursor: answer.get("next_cursor").and_then(Value::as_u64) };
                slot_protocol::encode_list_live_state_reply(&reply).map_err(|error| error.to_string())
            }
            RequestKind::Send { later: Some(request_bytes) } => {
                serde_json::to_vec(&slot_protocol::SendLaterReceipt::new(slot_protocol::send_later_request_hash(request_bytes)))
                    .map_err(|error| error.to_string())
            }
            RequestKind::Send { later: None } => value_bytes(answer),
        }
    }
}

/// The engine's result as the host keeps it.
pub fn outcome_json(outcome: HandleOutcome) -> Result<Value, String> {
    let mut result: Value = serde_json::from_slice(&outcome.response).map_err(|error| error.to_string())?;
    let writes = outcome
        .failure_writes
        .into_iter()
        .chain(outcome.outcome_writes)
        .map(|write| {
            let payload = write.payload.as_deref().map(serde_json::from_slice::<Value>).transpose().map_err(|error| error.to_string())?;
            Ok(json!({"address": write.address.to_string(), "payload": payload}))
        })
        .collect::<Result<Vec<_>, String>>()?;
    result["continue"] = result.get("subscription_continuation").map_or(Value::Bool(false), |next| Value::Bool(!next.is_null()));
    if let Some(object) = result.as_object_mut() {
        object.remove("subscription_continuation");
    }
    result["writes"] = Value::Array(writes);
    Ok(result)
}

/// The host as native code (and tests) supply it.
#[cfg(not(target_arch = "wasm32"))]
pub type Answer = dyn Fn(&Value) -> Result<Value, String> + Send + Sync;

#[cfg(not(target_arch = "wasm32"))]
struct Slots {
    names: Arc<Names>,
    answer: Box<Answer>,
}

#[cfg(not(target_arch = "wasm32"))]
impl trigger_engine::TalkToOtherSlots for Slots {
    fn dispatch(&self, envelope: &Envelope, delivery: ReplyDelivery) -> Result<Vec<u8>, String> {
        let request = request_for(envelope, delivery, &self.names)?;
        let answer = (self.answer)(&request.json)?;
        request.reply_bytes(&answer, &self.names)
    }
}

/// One person's trigger engine, native: rules stay resident between `apply` calls.
#[cfg(not(target_arch = "wasm32"))]
pub struct TriggerEngine {
    partition: String,
    names: Arc<Names>,
    handler: trigger_engine::TriggerHandler<Slots>,
}

#[cfg(not(target_arch = "wasm32"))]
impl TriggerEngine {
    pub fn new(partition: &str, answer: Box<Answer>) -> Self {
        let names = Arc::new(Names::default());
        let handler = trigger_engine::TriggerHandler::new(Slots { names: names.clone(), answer });
        Self { partition: partition.to_string(), names, handler }
    }

    pub fn apply(&self, changes: &Value) -> Result<Value, String> {
        let envelope = delta_for(&self.partition, changes, &self.names)?;
        outcome_json(self.handler.handle_with_writes(&envelope)?)
    }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod worker {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::rc::Rc;
    use std::task::{Context, Poll};
    use wasm_bindgen::prelude::*;

    // Evaluating a rule never draws entropy (see Cargo.toml).
    fn entropy_is_not_offered(_buffer: &mut [u8]) -> Result<(), getrandom_02::Error> {
        Err(getrandom_02::Error::UNSUPPORTED)
    }
    getrandom_02::register_custom_getrandom!(entropy_is_not_offered);

    /// A future awaited on the Worker's one thread.
    struct OneThread<F>(F);
    unsafe impl<F> Send for OneThread<F> {}
    impl<F: Future + Unpin> Future for OneThread<F> {
        type Output = F::Output;
        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            Pin::new(&mut self.0).poll(cx)
        }
    }

    struct Slots {
        names: Arc<Names>,
        answer: js_sys::Function,
    }
    unsafe impl Send for Slots {}
    unsafe impl Sync for Slots {}

    #[async_trait::async_trait(?Send)]
    impl trigger_engine::TalkToOtherSlots for Slots {
        async fn dispatch(&self, envelope: &Envelope, delivery: ReplyDelivery) -> Result<Vec<u8>, String> {
            let request = request_for(envelope, delivery, &self.names)?;
            let asked = JsValue::from_str(&request.json.to_string());
            let promise = self.answer.call1(&JsValue::NULL, &asked).map_err(|error| describe(&error))?;
            let settled = OneThread(wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&promise)))
                .await
                .map_err(|error| describe(&error))?;
            let answer = if settled.is_undefined() || settled.is_null() {
                Value::Null
            } else {
                let text = js_sys::JSON::stringify(&settled).map_err(|error| describe(&error))?;
                serde_json::from_str(&String::from(text)).map_err(|error| format!("host answer: {error}"))?
            };
            request.reply_bytes(&answer, &self.names)
        }
    }

    fn describe(error: &JsValue) -> String {
        error
            .as_string()
            .or_else(|| js_sys::Reflect::get(error, &JsValue::from_str("message")).ok().and_then(|message| message.as_string()))
            .unwrap_or_else(|| format!("{error:?}"))
    }

    struct Engine {
        partition: String,
        names: Arc<Names>,
        handler: trigger_engine::TriggerHandler<Slots>,
    }

    /// One person's trigger engine in a Worker. `answer(requestJson: string) → Promise<any>` answers the engine's
    /// read, list and send requests (see the file header). Rules stay resident between `apply` calls.
    #[wasm_bindgen]
    pub struct TriggerEngine(Rc<Engine>);

    #[wasm_bindgen]
    impl TriggerEngine {
        #[wasm_bindgen(constructor)]
        pub fn new(partition: String, answer: js_sys::Function) -> TriggerEngine {
            let names = Arc::new(Names::default());
            let handler = trigger_engine::TriggerHandler::new(Slots { names: names.clone(), answer });
            TriggerEngine(Rc::new(Engine { partition, names, handler }))
        }

        /// `changes_json`: a JSON list of `{address, path?, value}` or `{address, removed: true}`. Resolves to the
        /// result as JSON text: `{status, dispatch_failures, writes, continue}`.
        pub fn apply(&self, changes_json: String) -> js_sys::Promise {
            let engine = self.0.clone();
            wasm_bindgen_futures::future_to_promise(async move {
                let changes: Value = serde_json::from_str(&changes_json).map_err(|error| JsValue::from_str(&format!("changes: {error}")))?;
                let envelope = delta_for(&engine.partition, &changes, &engine.names).map_err(|error| JsValue::from_str(&error))?;
                let outcome = engine.handler.handle_with_writes(&envelope).await.map_err(|error| JsValue::from_str(&error))?;
                let result = outcome_json(outcome).map_err(|error| JsValue::from_str(&error))?;
                Ok(JsValue::from_str(&result.to_string()))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule() -> Value {
        json!({
            "id": "tell-me-when-a-lead-is-won",
            "match_condition": {"conditions": [{"$bind": {
                "select": {"from": "change", "path": "stage"},
                "transform": [{"op": "op:core.equals", "args": {"value": "won"}}]
            }}]},
            "dispatch": {"target": "tool:send-message", "output_template": {
                "to": "me",
                "about": {"$bind": {"select": {"from": "envelope", "path": "address_text"}}},
                "value": {"$bind": {"select": {"from": "change", "path": "value"}}}
            }}
        })
    }

    #[test]
    fn a_rule_over_the_persons_records_sends_its_target_only_for_a_matching_change() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let recorded = sent.clone();
        let engine = TriggerEngine::new("person:test", Box::new(move |request: &Value| {
            recorded.lock().unwrap().push(request.clone());
            Ok(json!({"ok": true}))
        }));
        engine.apply(&json!([{"address": "rule:won", "path": ["trigger-rule"], "value": rule()}])).expect("rule loads");
        engine.apply(&json!([{"address": "lead:acme", "value": {"stage": "open", "value": 10}}])).expect("open lead");
        assert!(sent.lock().unwrap().is_empty(), "a lead that is not won sends nothing");
        let result = engine.apply(&json!([{"address": "lead:acme", "value": {"stage": "won", "value": 12}}])).expect("won lead");
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert_eq!(sent[0], json!({"kind": "send", "target": "tool:send-message", "later": false,
            "payload": {"to": "me", "about": "lead:acme", "value": 12}}));
        assert_eq!(result["status"], "ok");
        let outcome = result["writes"].as_array().unwrap().iter().find(|write| write["payload"]["kind"] == "trigger-dispatch-outcome").expect("an outcome write");
        assert_eq!(outcome["payload"]["status"], "succeeded");
    }

    #[test]
    fn a_later_rule_gets_its_receipt_from_the_request_bytes_and_a_failed_send_is_recorded() {
        let mut later = rule();
        later["dispatch"]["delivery"] = json!("later_with_durable_outcome");
        let engine = TriggerEngine::new("person:test", Box::new(|request: &Value| {
            assert_eq!(request["later"], true);
            Ok(Value::Null)
        }));
        engine.apply(&json!([{"address": "rule:won", "path": ["trigger-rule"], "value": later}])).unwrap();
        let result = engine.apply(&json!([{"address": "lead:acme", "value": {"stage": "won"}}])).unwrap();
        let outcome = result["writes"].as_array().unwrap().iter().find(|write| write["payload"]["kind"] == "trigger-dispatch-outcome").unwrap();
        assert_eq!(outcome["payload"]["status"], "accepted");
        assert!(outcome["payload"]["delivery_receipt"]["request_hash"].as_str().unwrap().starts_with("1f:"));

        let failing = TriggerEngine::new("person:test", Box::new(|_: &Value| Err("the target is asleep".to_string())));
        failing.apply(&json!([{"address": "rule:won", "path": ["trigger-rule"], "value": rule()}])).unwrap();
        let result = failing.apply(&json!([{"address": "lead:acme", "value": {"stage": "won"}}])).unwrap();
        assert!(result.to_string().contains("the target is asleep"), "{result}");
    }

    #[test]
    fn a_removed_record_reaches_rules_as_a_retraction() {
        let sent = Arc::new(Mutex::new(0));
        let counted = sent.clone();
        let engine = TriggerEngine::new("person:test", Box::new(move |_: &Value| {
            *counted.lock().unwrap() += 1;
            Ok(json!({}))
        }));
        let on_removed = json!({
            "id": "on-removed",
            "match_condition": {"conditions": [{"$bind": {
                "select": {"from": "envelope", "path": "is_retraction"},
                "transform": [{"op": "op:core.equals", "args": {"value": true}}]
            }}]},
            "dispatch": {"target": "tool:note", "output_template": {"gone": {"$bind": {"select": {"from": "envelope", "path": "address_text"}}}}}
        });
        engine.apply(&json!([{"address": "rule:removed", "path": ["trigger-rule"], "value": on_removed}])).unwrap();
        engine.apply(&json!([{"address": "lead:acme", "value": {"stage": "open"}}])).unwrap();
        assert_eq!(*sent.lock().unwrap(), 0);
        engine.apply(&json!([{"address": "lead:acme", "removed": true}])).unwrap();
        assert_eq!(*sent.lock().unwrap(), 1);
    }
}
