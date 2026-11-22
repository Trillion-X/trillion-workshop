// crates/workflow-engine/src/lib.rs
//
// Purpose:
//   Runs one workflow definition with workflow-core, the workflow engine ported whole from bitfield-packages, inside a
//   wasm host or natively. The engine never reaches anything itself: every step that needs the outside world goes through
//   the host's `ask(name, payload)` and `read(from)`, which the host answers with the person's own tools, agents and
//   records.
//
// Non-Negotiable Invariants:
//   1. One entry: `run_definition(definitions, id, input, partition, product_word, host)` → the run as JSON. `product_word`
//      is the host's own word (its declared name) the process wire identities are derived from; this crate names
//      none. The host passes every
//      definition the run may reach (a step of kind "action" runs another definition by id). A run is "completed",
//      "failed", or "paused" when some ask was answered `{"$kind": "not-answered-yet"}` (workflow-core's
//      `NOT_ANSWERED_YET`); running the same definition again with the host's kept answers goes on from there.
//   4. `ask` hands the host the step's `context` bytes too, so a host can tell which step is asking.
//   2. Legacy execution is unchanged; the opt-in bounded API supplies host policy to workflow-core.
//      No step vocabulary is known here, and its dispatch/iteration counts are not CPU fuel.
//   3. A Worker runs one thread, so a JavaScript promise awaited inside the engine is marked sendable here and nowhere
//      else (`OneThread`).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
pub mod answer_shape;
mod approval;
pub mod fill_input;
pub mod uses;

use std::sync::Arc;

use serde_json::Value;
use workflow_core::executor::context::{DirectReadResult, OutsideAccess};
use workflow_core::{AsyncWorkflowExecutor, BoundedRunLimits, BoundedRunUsage, CachedDefinitionStore, Definition, RetryPolicy, StartData};

/// The bounded API's version, after the host's own word: `<namespace>.workflow-engine.run-bounded/v1` (with the word
/// the old host passes, the same bytes this crate wrote before the product name moved to the caller). A word
/// `ProductWordIds` refuses gets the version without a word, so even that refusal names a version.
pub const BOUNDED_API_VERSION_AFTER_PRODUCT_WORD: &str = "workflow-engine.run-bounded/v1";

pub fn bounded_api_version(product_word: &str) -> String {
    match execution_types::ProductWordIds::new(product_word) {
        Ok(_) => format!("{product_word}.{BOUNDED_API_VERSION_AFTER_PRODUCT_WORD}"),
        Err(_) => BOUNDED_API_VERSION_AFTER_PRODUCT_WORD.to_string(),
    }
}

/// Host-owned wire and closure caps for the opt-in bounded API. These values are
/// separate from workflow content and are checked before compilation.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct BoundedEnvelopeLimits {
    pub max_definitions_json_bytes: usize,
    pub max_input_json_bytes: usize,
    pub max_id_bytes: usize,
    pub max_partition_bytes: usize,
    pub max_definitions: usize,
    pub max_total_steps: usize,
    pub max_total_edges: usize,
    pub max_nested_closure_bytes: usize,
    pub max_output_json_bytes: usize,
}

impl BoundedEnvelopeLimits {
    fn validate(self) -> Result<Self, String> {
        if [self.max_definitions_json_bytes, self.max_input_json_bytes, self.max_id_bytes,
            self.max_partition_bytes, self.max_definitions,
            self.max_total_steps, self.max_total_edges, self.max_nested_closure_bytes,
            self.max_output_json_bytes].contains(&0) {
            return Err("bounded envelope limits must all be positive".to_string());
        }
        Ok(self)
    }
}

/// What the engine asks of its host. Native tests implement it directly; the Worker implements it with JS functions.
#[async_trait::async_trait]
pub trait Host: Send + Sync {
    async fn ask(&self, name: &str, payload: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, String>;
    async fn read(&self, from: &str) -> Result<Vec<u8>, String>;
}

struct Access<H: Host>(Arc<H>);

#[async_trait::async_trait]
impl<H: Host + 'static> OutsideAccess for Access<H> {
    async fn ask(&self, name: &str, _: &slot_protocol::PartitionKey, payload: bytes::Bytes, context: Option<bytes::Bytes>) -> Result<Arc<[u8]>, String> {
        let step_context: Value = context.as_ref().and_then(|bytes| serde_json::from_slice(bytes).ok()).unwrap_or(Value::Null);
        // An ask of the person that names an approval is settled by the approval check before the person is asked, so no
        // workflow reaches the person past it. The settled answer is checked against `submit` like any other.
        let answer = match approval::settle(self.0.as_ref(), name, &step_context).await? {
            Some(settled) => serde_json::to_vec(&settled).map_err(|error| error.to_string())?,
            None => self.0.ask(name, payload.to_vec(), context.as_ref().map(|bytes| bytes.to_vec())).await?,
        };
        // An ask that names the shape of its answer (`submit`) gets only an answer of that shape, from any host.
        let asked: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
        if let Some(shape) = asked.get("submit").filter(|shape| shape.is_object()) {
            let given: Value = serde_json::from_slice(&answer).map_err(|error| format!("The answer is not JSON: {error}"))?;
            let waiting = given.get("$kind").and_then(Value::as_str) == Some(workflow_core::executor::context::NOT_ANSWERED_YET);
            let wrong = if waiting { vec![] } else { answer_shape::misses(shape, &given) };
            if !wrong.is_empty() {
                let step = context.as_ref().and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
                    .and_then(|context| context["step_id"].as_str().map(String::from)).unwrap_or_default();
                return Err(format!("The answer to step {step} does not fit what it asks for: {}", wrong.join("; ")));
            }
        }
        Ok(Arc::from(answer.into_boxed_slice()))
    }
    async fn read(&self, from: &str, _: &slot_protocol::PartitionKey) -> Result<DirectReadResult, String> {
        let bytes = self.0.read(from).await?;
        let content_hash = content_hash(&bytes);
        Ok(DirectReadResult { bytes: Arc::from(bytes.into_boxed_slice()), content_hash })
    }
}

fn content_hash(bytes: &[u8]) -> String {
    // The engine binds what it read by identity; FNV-1a is enough to tell two reads apart inside one run.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes { hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3); }
    format!("{hash:016x}")
}

/// Runs definition `id` from `definitions` with `input`, and returns the finished run (status, every step's output).
pub async fn run_definition<H: Host + 'static>(definitions: Vec<Definition>, id: &str, input: Value, partition: &str, product_word: &str, host: Arc<H>) -> Result<Value, String> {
    run_definition_with_started_at(definitions, id, input, partition, product_word, "", host).await
}

/// Runs a durable host-owned workflow replay with its original start time.
/// Replay identity includes this value; the engine never substitutes its clock.
pub async fn run_definition_with_started_at<H: Host + 'static>(definitions: Vec<Definition>, id: &str, input: Value, partition: &str, product_word: &str, started_at: &str, host: Arc<H>) -> Result<Value, String> {
    let product_word = execution_types::ProductWordIds::new(product_word).map_err(|error| format!("product word: {error}"))?;
    let store = Arc::new(CachedDefinitionStore::new());
    let mut chosen = None;
    for mut definition in definitions {
        definition.partition_key = partition.into();
        if definition.id == id { chosen = Some(definition.clone()); }
        store.insert_definition(definition);
    }
    let definition = chosen.ok_or_else(|| format!("There is no definition {id} among those given."))?;
    // Every workflow a step asked for and did not find is answered as `definitions_missed`, so the starter can read it.
    let noted = Arc::new(uses::Noted::new(store));
    let executor = AsyncWorkflowExecutor::new(partition, slot_protocol::PartitionKey::hash_from(partition), Arc::new(Access(host)), noted.clone(), product_word);
    let start = StartData { start_type: "host".into(), input, started_at: started_at.to_string(), start_id: None };
    let run = executor
        .execute_definition(definition, start, slot_protocol::ActorContext::new(partition), &RetryPolicy::default())
        .await
        .map_err(|error| format!("{error:?}"))?;
    let runtime_outputs = serde_json::to_value(&run.execution_context.runtime_outputs).map_err(|error| error.to_string())?;
    let mut value = serde_json::to_value(run).map_err(|error| error.to_string())?;
    value["runtime_outputs"] = runtime_outputs;
    let missed = noted.missed();
    if !missed.is_empty() { value["definitions_missed"] = serde_json::json!(missed); }
    Ok(value)
}

/// Execute a versioned, opt-in bounded run from raw JSON. Input UTF-8 sizes are
/// refused before parsing; definition/step/edge and conservative nested-closure
/// totals are checked before the executor compiles a graph. Dispatch counts,
/// iterations and nesting do not bound arbitrary handler CPU or total memory.
pub async fn run_bounded_v1<H: Host + 'static>(
    definitions_json: &str,
    id: &str,
    input_json: &str,
    partition: &str,
    product_word: &str,
    envelope: BoundedEnvelopeLimits,
    execution: BoundedRunLimits,
    host: Arc<H>,
) -> Result<String, String> {
    run_bounded_with_start_v1(definitions_json, id, input_json, partition, product_word, "", None, envelope, execution, host).await
}

/// Bounded durable replay using the same original start data as legacy replay.
/// This additive entry preserves the existing bounded v1 argument layout.
pub async fn run_bounded_with_start_v1<H: Host + 'static>(
    definitions_json: &str, id: &str, input_json: &str, partition: &str, product_word: &str,
    started_at: &str, start_id: Option<&str>,
    envelope: BoundedEnvelopeLimits, execution: BoundedRunLimits, host: Arc<H>,
) -> Result<String, String> {
    let version = bounded_api_version(product_word);
    let version = version.as_str();
    let envelope = match envelope.validate() {
        Ok(envelope) => envelope,
        Err(reason) => return Err(bounded_refusal(version, "FE_BOUNDED_POLICY_INVALID", &reason)),
    };
    if let Err(error) = execution.validate() { return Err(bounded_workflow_error(version, &error)); }
    for (dimension, observed, limit) in [
        ("definitions_json_bytes", definitions_json.len(), envelope.max_definitions_json_bytes),
        ("input_json_bytes", input_json.len(), envelope.max_input_json_bytes),
        ("id_bytes", id.len(), envelope.max_id_bytes),
        ("partition_bytes", partition.len(), envelope.max_partition_bytes),
        ("started_at_bytes", started_at.len(), envelope.max_input_json_bytes),
        ("start_id_bytes", start_id.map_or(0, str::len), envelope.max_id_bytes),
    ] {
        if observed > limit {
            return Err(bounded_refusal(version, "FE_PAYLOAD_TOO_LARGE", &format!("{dimension} observed {observed}, limit {limit}")));
        }
    }

    let definitions: Vec<Definition> = serde_json::from_str(definitions_json)
        .map_err(|error| bounded_refusal(version, "FE_INVALID_JSON", &format!("definitions: {error}")))?;
    if definitions.len() > envelope.max_definitions {
        return Err(bounded_refusal(version, "FE_PAYLOAD_TOO_LARGE", &format!("definitions observed {}, limit {}", definitions.len(), envelope.max_definitions)));
    }
    let mut total_steps = 0usize;
    let mut total_edges = 0usize;
    let mut closure_bytes = 0usize;
    for definition in &definitions {
        total_steps = match total_steps.checked_add(definition.steps.len()) {
            Some(total) => total,
            None => return Err(bounded_refusal(version, "FE_PAYLOAD_TOO_LARGE", "total_steps arithmetic overflow")),
        };
        // Definitions without authored edges compile into an implicit sequence.
        let effective_edges = if definition.edges.is_empty() {
            definition.steps.len().saturating_sub(1)
        } else {
            definition.edges.len()
        };
        total_edges = match total_edges.checked_add(effective_edges) {
            Some(total) => total,
            None => return Err(bounded_refusal(version, "FE_PAYLOAD_TOO_LARGE", "total_edges arithmetic overflow")),
        };
        let encoded = serde_json::to_vec(definition).map_err(|error| bounded_refusal(version, "FE_SERIALIZATION", &error.to_string()))?;
        closure_bytes = match closure_bytes.checked_add(encoded.len()) {
            Some(total) => total,
            None => return Err(bounded_refusal(version, "FE_PAYLOAD_TOO_LARGE", "nested_closure_bytes arithmetic overflow")),
        };
    }
    for (dimension, observed, limit) in [
        ("total_steps", total_steps, envelope.max_total_steps),
        ("total_edges", total_edges, envelope.max_total_edges),
        ("nested_closure_bytes", closure_bytes, envelope.max_nested_closure_bytes),
    ] {
        if observed > limit {
            return Err(bounded_refusal(version, "FE_PAYLOAD_TOO_LARGE", &format!("{dimension} observed {observed}, limit {limit}")));
        }
    }
    let input: Value = serde_json::from_str(input_json)
        .map_err(|error| bounded_refusal(version, "FE_INVALID_JSON", &format!("input: {error}")))?;

    let store = Arc::new(CachedDefinitionStore::new());
    let mut chosen = None;
    for mut definition in definitions {
        definition.partition_key = partition.into();
        if definition.id == id { chosen = Some(definition.clone()); }
        store.insert_definition(definition);
    }
    let definition = chosen.ok_or_else(|| bounded_refusal(version, "FE_DEFINITION_NOT_FOUND", "requested definition is not in the bounded input"))?;
    let product_word = execution_types::ProductWordIds::new(product_word).map_err(|error| bounded_refusal(version, "FE_NAMESPACE_INVALID", &format!("product word: {error}")))?;
    let executor = AsyncWorkflowExecutor::new(partition, slot_protocol::PartitionKey::hash_from(partition), Arc::new(Access(host)), store, product_word);
    let start = StartData { start_type: "host".into(), input, started_at: started_at.to_string(), start_id: start_id.map(str::to_owned) };
    let (run, usage) = executor.execute_definition_bounded(
        definition, start, slot_protocol::ActorContext::new(partition), &RetryPolicy::default(), execution,
    ).await.map_err(|error| bounded_workflow_error(version, &error))?;
    let response = BoundedRunResponse { version, usage, result: BoundedRunResult { instance: &run, runtime_outputs: &run.execution_context.runtime_outputs } };
    let mut writer = CappedWriter::new(envelope.max_output_json_bytes);
    if let Err(error) = serde_json::to_writer(&mut writer, &response) {
        if writer.exceeded {
            return Err(bounded_refusal(version, "FE_PAYLOAD_TOO_LARGE", &format!(
                "output_json_bytes exceeds limit {}", envelope.max_output_json_bytes
            )));
        }
        return Err(bounded_refusal(version, "FE_SERIALIZATION", &error.to_string()));
    }
    String::from_utf8(writer.bytes).map_err(|_| bounded_refusal(version, "FE_SERIALIZATION", "bounded response was not UTF-8"))
}

#[derive(serde::Serialize)]
struct BoundedRunResponse<'a> {
    version: &'a str,
    usage: BoundedRunUsage,
    result: BoundedRunResult<'a>,
}
#[derive(serde::Serialize)]
struct BoundedRunResult<'a> {
    #[serde(flatten)]
    instance: &'a workflow_core::WorkflowInstance,
    runtime_outputs: &'a std::collections::HashMap<String, workflow_core::StepOutput>,
}

const MAX_FAILURE_ENVELOPE_BYTES: usize = 512;
fn failure_details_truncated(version: &str) -> String {
    format!(r#"{{"version":"{version}","error":{{"code":"FE_FAILURE_DETAILS_TRUNCATED"}}}}"#)
}

#[derive(serde::Serialize)]
struct BoundedFailure<'a> { version: &'a str, error: BoundedFailureDetail<'a> }

#[derive(serde::Serialize)]
struct BoundedFailureDetail<'a> { code: &'a str, detail: &'a str }

fn bounded_refusal(version: &str, code: &str, detail: &str) -> String {
    let detail: String = detail.chars().take(64).collect();
    let failure = BoundedFailure { version, error: BoundedFailureDetail { code, detail: &detail } };
    let mut writer = CappedWriter::new(MAX_FAILURE_ENVELOPE_BYTES);
    if serde_json::to_writer(&mut writer, &failure).is_ok() {
        String::from_utf8(writer.bytes).unwrap_or_else(|_| failure_details_truncated(version))
    } else {
        failure_details_truncated(version)
    }
}

fn bounded_workflow_error<E: serde::Serialize>(version: &str, error: &E) -> String {
    #[derive(serde::Serialize)]
    struct TypedFailure<'a, E: serde::Serialize> { version: &'a str, error: &'a E }
    let response = TypedFailure { version, error };
    let mut writer = CappedWriter::new(MAX_FAILURE_ENVELOPE_BYTES);
    if serde_json::to_writer(&mut writer, &response).is_ok() {
        String::from_utf8(writer.bytes).unwrap_or_else(|_| failure_details_truncated(version))
    } else {
        failure_details_truncated(version)
    }
}

struct CappedWriter { bytes: Vec<u8>, limit: usize, exceeded: bool }
impl CappedWriter { fn new(limit: usize) -> Self { Self { bytes: Vec::with_capacity(limit.min(4096)), limit, exceeded: false } } }
impl std::io::Write for CappedWriter {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        let available = self.limit.saturating_sub(self.bytes.len());
        let accepted = available.min(input.len());
        self.bytes.extend_from_slice(&input[..accepted]);
        if accepted != input.len() { self.exceeded = true; return Err(std::io::Error::new(std::io::ErrorKind::Other, "bounded JSON output limit exceeded")); }
        Ok(accepted)
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod worker {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use wasm_bindgen::prelude::*;

    /// A future awaited on the Worker's one thread.
    struct OneThread<F>(F);
    unsafe impl<F> Send for OneThread<F> {}
    impl<F: Future + Unpin> Future for OneThread<F> {
        type Output = F::Output;
        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> { Pin::new(&mut self.0).poll(cx) }
    }

    struct JsHost { ask: js_sys::Function, read: js_sys::Function }
    unsafe impl Send for JsHost {}
    unsafe impl Sync for JsHost {}

    async fn call(function: &js_sys::Function, first: JsValue, second: JsValue, third: JsValue) -> Result<Vec<u8>, String> {
        let promise = function.call3(&JsValue::NULL, &first, &second, &third).map_err(|error| format!("{error:?}"))?;
        let settled = OneThread(wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&promise))).await.map_err(|error| error.as_string().unwrap_or_else(|| format!("{error:?}")))?;
        Ok(js_sys::Uint8Array::new(&settled).to_vec())
    }

    #[async_trait::async_trait]
    impl Host for JsHost {
        async fn ask(&self, name: &str, payload: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
            let context = context.map_or(JsValue::UNDEFINED, |bytes| js_sys::Uint8Array::from(bytes.as_slice()).into());
            OneThread(Box::pin(call(&self.ask, JsValue::from_str(name), js_sys::Uint8Array::from(payload.as_slice()).into(), context))).await
        }
        async fn read(&self, from: &str) -> Result<Vec<u8>, String> {
            OneThread(Box::pin(call(&self.read, JsValue::from_str(from), JsValue::UNDEFINED, JsValue::UNDEFINED))).await
        }
    }

    /// `definitions_json`: a JSON list of definitions; `product_word`: the host's own word (its declared name); `ask(name, payload: Uint8Array, context?: Uint8Array) →
    /// Promise<Uint8Array>`;
    /// `read(from) → Promise<Uint8Array>`. Resolves to the finished run as JSON text.
    #[wasm_bindgen]
    pub async fn run(definitions_json: String, id: String, input_json: String, partition: String, product_word: String, ask: js_sys::Function, read: js_sys::Function) -> Result<String, JsValue> {
        run_with_started_at(definitions_json, id, input_json, partition, product_word, String::new(), ask, read).await
    }

    #[wasm_bindgen(js_name = runWithStartedAt)]
    pub async fn run_with_started_at(definitions_json: String, id: String, input_json: String, partition: String, product_word: String, started_at: String, ask: js_sys::Function, read: js_sys::Function) -> Result<String, JsValue> {
        let definitions: Vec<Definition> = serde_json::from_str(&definitions_json).map_err(|error| JsValue::from_str(&format!("definitions: {error}")))?;
        let input: Value = serde_json::from_str(&input_json).map_err(|error| JsValue::from_str(&format!("input: {error}")))?;
        let run = OneThread(Box::pin(run_definition_with_started_at(definitions, &id, input, &partition, &product_word, &started_at, Arc::new(JsHost { ask, read })))).await.map_err(|error| JsValue::from_str(&error))?;
        Ok(run.to_string())
    }

    /// Versioned opt-in bounded adapter. Limits are host-owned scalar arguments,
    /// never authored recipe fields. Missing this export in an older module is an
    /// unsupported API; callers must not fall back to `run`.
    #[wasm_bindgen]
    pub async fn run_bounded_v1(
        definitions_json: String, id: String, input_json: String, partition: String, product_word: String,
        max_definitions_json_bytes: u32, max_input_json_bytes: u32,
        max_id_bytes: u32, max_partition_bytes: u32,
        max_definitions: u32, max_total_steps: u32, max_total_edges: u32,
        max_nested_closure_bytes: u32, max_output_json_bytes: u32,
        max_step_attempts: u32, max_loop_iterations: u32, max_action_depth: u32,
        ask: js_sys::Function, read: js_sys::Function,
    ) -> Result<String, JsValue> {
        let envelope = BoundedEnvelopeLimits {
            max_definitions_json_bytes: max_definitions_json_bytes as usize,
            max_input_json_bytes: max_input_json_bytes as usize,
            max_id_bytes: max_id_bytes as usize,
            max_partition_bytes: max_partition_bytes as usize,
            max_definitions: max_definitions as usize,
            max_total_steps: max_total_steps as usize,
            max_total_edges: max_total_edges as usize,
            max_nested_closure_bytes: max_nested_closure_bytes as usize,
            max_output_json_bytes: max_output_json_bytes as usize,
        };
        let execution = BoundedRunLimits {
            max_step_attempts: max_step_attempts as usize,
            max_loop_iterations: max_loop_iterations as usize,
            max_action_depth: max_action_depth as usize,
        };
        OneThread(Box::pin(super::run_bounded_v1(
            &definitions_json, &id, &input_json, &partition, &product_word, envelope, execution,
            Arc::new(JsHost { ask, read }),
        ))).await.map_err(|error| JsValue::from_str(&error))
    }
    /// Start-aware bounded companion; old modules cannot silently lose replay data.
    #[wasm_bindgen]
    pub async fn run_bounded_with_start_v1(
        definitions_json: String, id: String, input_json: String, partition: String, product_word: String,
        max_definitions_json_bytes: u32, max_input_json_bytes: u32,
        max_id_bytes: u32, max_partition_bytes: u32,
        max_definitions: u32, max_total_steps: u32, max_total_edges: u32,
        max_nested_closure_bytes: u32, max_output_json_bytes: u32,
        max_step_attempts: u32, max_loop_iterations: u32, max_action_depth: u32,
        started_at: String, start_id: Option<String>,
        ask: js_sys::Function, read: js_sys::Function,
    ) -> Result<String, JsValue> {
        let envelope = BoundedEnvelopeLimits {
            max_definitions_json_bytes: max_definitions_json_bytes as usize,
            max_input_json_bytes: max_input_json_bytes as usize,
            max_id_bytes: max_id_bytes as usize, max_partition_bytes: max_partition_bytes as usize,
            max_definitions: max_definitions as usize, max_total_steps: max_total_steps as usize,
            max_total_edges: max_total_edges as usize, max_nested_closure_bytes: max_nested_closure_bytes as usize,
            max_output_json_bytes: max_output_json_bytes as usize,
        };
        let execution = BoundedRunLimits {
            max_step_attempts: max_step_attempts as usize,
            max_loop_iterations: max_loop_iterations as usize,
            max_action_depth: max_action_depth as usize,
        };
        OneThread(Box::pin(super::run_bounded_with_start_v1(
            &definitions_json, &id, &input_json, &partition, &product_word, &started_at, start_id.as_deref(),
            envelope, execution, Arc::new(JsHost { ask, read }),
        ))).await.map_err(|error| JsValue::from_str(&error))
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recording(Mutex<Vec<(String, Value)>>);
    #[async_trait::async_trait]
    impl Host for Recording {
        async fn ask(&self, name: &str, payload: Vec<u8>, _: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
            let sent: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
            self.0.lock().unwrap().push((name.to_string(), sent.clone()));
            Ok(serde_json::to_vec(&serde_json::json!({ "answered": name, "echo": sent })).unwrap())
        }
        async fn read(&self, _: &str) -> Result<Vec<u8>, String> { Ok(b"{}".to_vec()) }
    }

    #[tokio::test]
    async fn duplicate_step_ids_are_refused_before_any_host_action() {
        // Explicit edges used to hide duplicate IDs by replacing one map entry.
        // Also cover collisions between authored IDs and generated legacy IDs.
        for steps in [
            serde_json::json!([
                { "id": "first", "kind": "ask", "config": { "name": "tool:first" } },
                { "id": "same", "kind": "ask", "config": { "name": "tool:omitted" } },
                { "id": "same", "kind": "ask", "config": { "name": "tool:last" } }
            ]),
            serde_json::json!([
                { "id": "step_1", "kind": "ask", "config": { "name": "tool:authored" } },
                { "kind": "ask", "config": { "name": "tool:generated" } }
            ]),
        ] {
            for edges in [serde_json::json!([]), serde_json::json!([
                { "from": steps[0]["id"], "to": "same", "kind": "always" }
            ])] {
                let definition: Definition = serde_json::from_value(serde_json::json!({
                    "id": "duplicates", "name": "Duplicates", "kind": "workflow",
                    "is_active": true, "version": 1, "steps": steps, "edges": edges
                })).unwrap();
                let host = Arc::new(Recording::default());
                let result = run_definition(vec![definition], "duplicates", serde_json::json!({}), "person:test", "example", host.clone()).await;
                assert!(format!("{result:?}").contains("Duplicate step ID"), "{result:?}");
                assert!(host.0.lock().unwrap().is_empty(), "No work may start for an ambiguous graph");
            }
        }
    }

    #[tokio::test]
    async fn generated_step_ids_remain_valid_when_unique() {
        let definition: Definition = serde_json::from_value(serde_json::json!({
            "id": "legacy", "name": "Legacy", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [
                { "kind": "ask", "config": { "name": "tool:first", "input": {} } },
                { "kind": "ask", "config": { "name": "tool:second", "input": {} } }
            ]
        })).unwrap();
        let host = Arc::new(Recording::default());
        let run = run_definition(vec![definition], "legacy", serde_json::json!({}), "person:test", "example", host.clone()).await.unwrap();
        assert_eq!(run["status"], "completed", "{run}");
        let asked: Vec<String> = host.0.lock().unwrap().iter().map(|(name, _)| name.clone()).collect();
        assert_eq!(asked, vec!["tool:first", "tool:second"]);
    }

    #[tokio::test]
    async fn durable_started_at_is_preserved_on_cold_replay() {
        let definition: Definition = serde_json::from_value(serde_json::json!({
            "id": "durable-time", "name": "Durable time", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [{ "id": "ask", "kind": "ask", "config": { "name": "tool:stable", "input": {}, "context": { "step_id": "ask" } } }],
            "edges": []
        })).expect("definition decodes");
        let started_at = "2026-10-14T16:20:00.000Z";
        let first = run_definition_with_started_at(vec![definition.clone()], "durable-time", serde_json::json!({}), "person:test", "example", started_at, Arc::new(Recording::default())).await.expect("first execution runs");
        let replay = run_definition_with_started_at(vec![definition], "durable-time", serde_json::json!({}), "person:test", "example", started_at, Arc::new(Recording::default())).await.expect("cold replay runs");

        for run in [&first, &replay] {
            assert_eq!(run["started_at"], started_at);
            assert_eq!(run["execution_context"]["start"]["started_at"], started_at);
        }
    }

    #[tokio::test]
    async fn a_definition_asks_the_host_for_each_step_in_order() {
        let definition: Definition = serde_json::from_value(serde_json::json!({
            "id": "draft-then-count", "name": "Draft then count", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [
                { "id": "draft", "kind": "ask", "config": { "name": "tool:draft", "input": { "topic": "pottery" } } },
                { "id": "count", "kind": "ask", "config": { "name": "tool:count-words", "input": {} } }
            ],
            "edges": [{ "from": "draft", "to": "count", "kind": "always" }]
        })).expect("definition decodes");
        let host = Arc::new(Recording::default());
        let run = run_definition(vec![definition], "draft-then-count", serde_json::json!({}), "person:test", "example", host.clone()).await.expect("runs");
        assert_eq!(run["status"], "completed", "{run}");
        let asked: Vec<String> = host.0.lock().unwrap().iter().map(|(name, _)| name.clone()).collect();
        assert_eq!(asked, vec!["tool:draft", "tool:count-words"]);
    }

    /// A host that has answered only what it holds: "ai" is answered from `answers`, else not yet.
    struct Answers(std::collections::HashMap<String, Value>, Vec<String>);
    #[async_trait::async_trait]
    impl Host for Answers {
        async fn ask(&self, name: &str, _: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
            let step: Value = serde_json::from_slice(&context.unwrap_or_default()).unwrap_or(Value::Null);
            let id = step["step_id"].as_str().unwrap_or_default().to_string();
            let reply = self.0.get(&id).cloned().unwrap_or_else(|| serde_json::json!({ "$kind": workflow_core::executor::context::NOT_ANSWERED_YET, "step_id": id, "asked": name }));
            Ok(serde_json::to_vec(&reply).unwrap())
        }
        async fn read(&self, from: &str) -> Result<Vec<u8>, String> {
            let wanted: Value = serde_json::from_str(from).map_err(|error| error.to_string())?;
            if self.1.iter().any(|known| wanted["id"] == *known) { Ok(b"{}".to_vec()) } else { Err("no such thing".into()) }
        }
    }

    /// A host that never has an answer yet and counts every ask it was given.
    struct NotYet(Mutex<usize>);
    #[async_trait::async_trait]
    impl Host for NotYet {
        async fn ask(&self, name: &str, _: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
            *self.0.lock().unwrap() += 1;
            let step: Value = serde_json::from_slice(&context.unwrap_or_default()).unwrap_or(Value::Null);
            Ok(serde_json::to_vec(&serde_json::json!({ "$kind": workflow_core::executor::context::NOT_ANSWERED_YET, "step_id": step["step_id"], "asked": name })).unwrap())
        }
        async fn read(&self, _: &str) -> Result<Vec<u8>, String> { Ok(b"{}".to_vec()) }
    }

    #[tokio::test]
    async fn a_parallel_loop_asks_every_lane_before_it_pauses_and_a_sequential_one_asks_one() {
        let lanes = |parallel: bool| -> Vec<Definition> {
            let root = serde_json::json!({ "id": "fan", "name": "Fan", "kind": "workflow", "is_active": true, "version": 1,
                "steps": [{ "id": "lanes", "kind": "loop", "config": { "source": (0..40).collect::<Vec<_>>(), "item_var": "lane", "definition_id": "lane", "parallel": parallel, "max_concurrency": 40 } }] });
            let lane = serde_json::json!({ "id": "lane", "name": "Lane", "kind": "workflow", "is_active": true, "version": 1,
                "steps": [{ "id": "work", "kind": "ask", "config": { "name": "ai", "input": {}, "context": { "step_id": "work" } } }] });
            vec![serde_json::from_value(root).unwrap(), serde_json::from_value(lane).unwrap()]
        };
        let host = Arc::new(NotYet(Mutex::new(0)));
        let run = run_definition(lanes(true), "fan", serde_json::json!({}), "person:test", "example", host.clone()).await.expect("runs");
        assert_eq!(run["status"], "paused", "{run}");
        assert_eq!(*host.0.lock().unwrap(), 40, "every lane's ask is made before the loop pauses");
        let host = Arc::new(NotYet(Mutex::new(0)));
        let run = run_definition(lanes(false), "fan", serde_json::json!({}), "person:test", "example", host.clone()).await.expect("runs");
        assert_eq!(run["status"], "paused", "{run}");
        assert_eq!(*host.0.lock().unwrap(), 1, "a sequential loop waits at its first lane");
    }

    fn scope_then_plan() -> Definition {
        serde_json::from_value(serde_json::json!({
            "id": "scope-then-plan", "name": "Scope then plan", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [
                { "id": "scope", "kind": "ask", "config": { "name": "ai", "input": {}, "context": { "step_id": "scope" } } },
                { "id": "plan", "kind": "ask", "config": { "name": "ai", "input": {}, "context": { "step_id": "plan" } } }
            ],
            "edges": [{ "from": "scope", "to": "plan", "kind": "always" }]
        })).expect("definition decodes")
    }

    /// A host whose side cannot be reached for one step (a stub left over from the Worker before an update, a reset
    /// store): the ask fails before anything answers it.
    struct Unreachable { answers: std::collections::HashMap<String, Value>, unreachable: Option<String> }
    #[async_trait::async_trait]
    impl Host for Unreachable {
        async fn ask(&self, name: &str, _: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
            let step: Value = serde_json::from_slice(&context.unwrap_or_default()).unwrap_or(Value::Null);
            let id = step["step_id"].as_str().unwrap_or_default().to_string();
            if self.unreachable.as_deref() == Some(id.as_str()) { return Err("TypeError: The RPC receiver does not implement the method \"call\".".into()); }
            let reply = self.answers.get(&id).cloned().unwrap_or_else(|| serde_json::json!({ "$kind": workflow_core::executor::context::NOT_ANSWERED_YET, "step_id": id, "asked": name }));
            Ok(serde_json::to_vec(&reply).unwrap())
        }
        async fn read(&self, _: &str) -> Result<Vec<u8>, String> { Ok(b"{}".to_vec()) }
    }

    #[tokio::test]
    async fn an_ask_its_host_could_not_reach_says_so_as_data_and_the_same_run_goes_on_once_it_is_reached() {
        let mut answers = std::collections::HashMap::new();
        answers.insert("scope".to_string(), serde_json::json!({ "areas": ["pricing"] }));
        let cut = run_definition(vec![scope_then_plan()], "scope-then-plan", serde_json::json!({}), "person:test", "example",
            Arc::new(Unreachable { answers: answers.clone(), unreachable: Some("plan".into()) })).await.expect("runs");
        assert_eq!(cut["status"], "failed", "{cut}");
        assert_eq!(cut["execution_context"]["steps"]["scope"]["status"], "completed", "the step answered before it is kept");
        let failed = &cut["execution_context"]["steps"]["plan"];
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["output"]["dispatch_failed"]["dispatch"], "ask:ai", "{failed}");
        assert!(failed["output"]["dispatch_failed"]["reason"].as_str().unwrap().contains("does not implement the method"), "{failed}");

        answers.insert("plan".to_string(), serde_json::json!({ "sections": ["pricing"], "tools": [] }));
        let carried_on = run_definition(vec![scope_then_plan()], "scope-then-plan", serde_json::json!({}), "person:test", "example",
            Arc::new(Unreachable { answers, unreachable: None })).await.expect("runs");
        assert_eq!(carried_on["status"], "completed", "{carried_on}");
        assert_eq!(carried_on["execution_context"]["steps"]["scope"]["output"]["areas"][0], "pricing", "the answer kept before the cut is the one used");
    }

    fn wait_then_ask(condition: Value) -> Definition {
        serde_json::from_value(serde_json::json!({
            "id": "wait-then-ask", "name": "Wait then ask", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [
                { "id": "hold", "kind": "wait", "config": { "wait_condition": condition } },
                { "id": "after", "kind": "ask", "config": { "name": "tool:after", "input": {}, "context": { "step_id": "after" } } }
            ],
            "edges": [{ "from": "hold", "to": "after", "kind": "always" }]
        })).expect("definition decodes")
    }

    #[tokio::test]
    async fn a_wait_this_build_cannot_hold_pauses_the_run_until_the_host_answers_it() {
        let waits = [
            serde_json::json!({ "type": "duration", "secs": 3600 }),
            serde_json::json!({ "type": "until", "datetime": "2099-01-01T00:00:00Z" }),
            serde_json::json!({ "type": "event", "event_type": "order.placed" }),
            serde_json::json!({ "type": "race", "conditions": [{ "type": "duration", "secs": 3600 }, { "type": "event", "event_type": "order.placed" }] }),
        ];
        for condition in waits {
            let paused = run_definition(vec![wait_then_ask(condition.clone())], "wait-then-ask", serde_json::json!({}), "person:test", "example",
                Arc::new(Answers(Default::default(), vec![]))).await.expect("runs");
            assert_eq!(paused["status"], "paused", "{condition}: {paused}");
            assert_eq!(paused["execution_context"]["steps"]["hold"]["status"], "paused", "{condition}");
            assert_eq!(paused["execution_context"]["steps"]["hold"]["output"]["asked"], workflow_core::executor::automation::WAIT_ASK, "{condition}");
            assert!(paused["execution_context"]["steps"].get("after").is_none(), "{condition}: nothing after the wait runs before it is over");

            let mut answers = std::collections::HashMap::new();
            answers.insert("hold".to_string(), serde_json::json!({ "over_at": "2099-01-01T00:00:00Z" }));
            answers.insert("after".to_string(), serde_json::json!({ "done": true }));
            let done = run_definition(vec![wait_then_ask(condition.clone())], "wait-then-ask", serde_json::json!({}), "person:test", "example",
                Arc::new(Answers(answers, vec![]))).await.expect("runs");
            assert_eq!(done["status"], "completed", "{condition}: {done}");
            assert_eq!(done["execution_context"]["steps"]["hold"]["output"]["answered"]["over_at"], "2099-01-01T00:00:00Z");
        }
    }

    #[tokio::test]
    async fn a_wait_already_over_is_held_here_without_asking() {
        for (condition, winner) in [
            (serde_json::json!({ "type": "until", "datetime": "2020-01-01T00:00:00Z" }), None),
            (serde_json::json!({ "type": "duration", "secs": 0 }), None),
            (serde_json::json!({ "type": "race", "conditions": [{ "type": "duration", "secs": 3600 }, { "type": "duration", "secs": 0 }] }), Some(1)),
        ] {
            let host = Arc::new(Recording::default());
            let run = run_definition(vec![wait_then_ask(condition.clone())], "wait-then-ask", serde_json::json!({}), "person:test", "example", host.clone()).await.expect("runs");
            assert_eq!(run["status"], "completed", "{condition}: {run}");
            let asked: Vec<String> = host.0.lock().unwrap().iter().map(|(name, _)| name.clone()).collect();
            assert_eq!(asked, vec!["tool:after"], "{condition}: the wait itself asked nothing");
            if let Some(index) = winner { assert_eq!(run["execution_context"]["steps"]["hold"]["output"]["winner_index"], index); }
        }
    }

    fn test_envelope_limits() -> BoundedEnvelopeLimits {
        BoundedEnvelopeLimits {
            max_definitions_json_bytes: 64 * 1024,
            max_input_json_bytes: 4096,
            max_id_bytes: 256,
            max_partition_bytes: 256,
            max_definitions: 8,
            max_total_steps: 32,
            max_total_edges: 32,
            max_nested_closure_bytes: 64 * 1024,
            max_output_json_bytes: 64 * 1024,
        }
    }

    fn test_run_limits(max_step_attempts: usize) -> BoundedRunLimits {
        BoundedRunLimits { max_step_attempts, max_loop_iterations: 16, max_action_depth: 8 }
    }

    #[tokio::test]
    async fn bounded_v1_reserves_each_sequential_dispatch_and_returns_typed_fatal_refusal() {
        let definition: Definition = serde_json::from_value(serde_json::json!({
            "id": "bounded-two", "name": "Bounded two", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [
                { "id": "first", "kind": "ask", "config": { "name": "tool:first", "input": {} } },
                { "id": "second", "kind": "ask", "config": { "name": "tool:second", "input": {} } }
            ],
            "edges": [{ "from": "first", "to": "second", "kind": "always" }]
        })).unwrap();
        let definitions_json = serde_json::to_string(&vec![definition]).unwrap();
        let host = Arc::new(Recording::default());
        let refusal = run_bounded_v1(&definitions_json, "bounded-two", "{}", "person:test", "example",
            test_envelope_limits(), test_run_limits(1), host.clone()).await.unwrap_err();
        assert!(refusal.contains("FE_RUN_BUDGET_EXCEEDED"), "{refusal}");
        assert!(refusal.contains("step_attempts") && refusal.contains("attempted"), "{refusal}");
        let dispatched: Vec<String> = host.0.lock().unwrap().iter().map(|(name, _)| name.clone()).collect();
        assert_eq!(dispatched, vec!["tool:first"], "the over-limit second step never dispatches");
    }

    #[tokio::test]
    async fn bounded_v1_checks_utf8_wire_limit_before_json_parsing() {
        let host = Arc::new(Recording::default());
        let mut limits = test_envelope_limits();
        limits.max_definitions_json_bytes = 2;
        let refusal = run_bounded_v1("not valid JSON", "missing", "{}", "person:test", "example",
            limits, test_run_limits(4), host.clone()).await.unwrap_err();
        assert!(refusal.contains("definitions_json_bytes"), "wire policy runs before parser: {refusal}");
        assert!(host.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn bounded_v1_caps_identity_strings_before_parse_and_partition_hash() {
        let host = Arc::new(Recording::default());
        let mut limits = test_envelope_limits();
        limits.max_id_bytes = 2;
        let id_refusal = run_bounded_v1("not JSON", "too-long", "{}", "ok", "example", limits,
            test_run_limits(4), host.clone()).await.unwrap_err();
        assert!(id_refusal.contains("id_bytes"), "id cap precedes JSON parsing: {id_refusal}");

        let mut limits = test_envelope_limits();
        limits.max_partition_bytes = 2;
        let partition_refusal = run_bounded_v1("not JSON", "ok", "{}", "too-long", "example", limits,
            test_run_limits(4), host.clone()).await.unwrap_err();
        assert!(partition_refusal.contains("partition_bytes"), "partition cap precedes hashing and JSON parsing: {partition_refusal}");
        assert!(host.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn bounded_v1_checks_definition_step_and_implicit_edge_closure_before_compile() {
        let definition: Definition = serde_json::from_value(serde_json::json!({
            "id": "oversized-closure", "name": "Closure", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [
                { "id": "same", "kind": "ask", "config": { "name": "tool:one", "input": {} } },
                { "id": "same", "kind": "ask", "config": { "name": "tool:two", "input": {} } },
                { "id": "third", "kind": "ask", "config": { "name": "tool:three", "input": {} } }
            ]
        })).unwrap();
        let definitions_json = serde_json::to_string(&vec![definition]).unwrap();
        let host = Arc::new(Recording::default());
        let mut limits = test_envelope_limits();
        limits.max_total_steps = 2;
        let step_refusal = run_bounded_v1(&definitions_json, "oversized-closure", "{}", "person:test", "example",
            limits, test_run_limits(8), host.clone()).await.unwrap_err();
        assert!(step_refusal.contains("total_steps"), "step cap runs before duplicate-ID compilation: {step_refusal}");

        let mut limits = test_envelope_limits();
        limits.max_total_edges = 1;
        let edge_refusal = run_bounded_v1(&definitions_json, "oversized-closure", "{}", "person:test", "example",
            limits, test_run_limits(8), host.clone()).await.unwrap_err();
        assert!(edge_refusal.contains("total_edges"), "generated implicit edges are included before compilation: {edge_refusal}");
        assert!(host.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn bounded_v1_caps_serialized_response_without_changing_legacy_result_shape() {
        let definition = scope_then_plan();
        let definitions_json = serde_json::to_string(&vec![definition.clone()]).unwrap();
        let mut limits = test_envelope_limits();
        limits.max_output_json_bytes = 8;
        let refusal = run_bounded_v1(&definitions_json, "scope-then-plan", "{}", "person:test", "example",
            limits, test_run_limits(8), Arc::new(Recording::default())).await.unwrap_err();
        assert!(refusal.contains("output_json_bytes"), "{refusal}");

        // The legacy export still returns the established bare WorkflowInstance JSON shape.
        let legacy = run_definition(vec![definition], "scope-then-plan", serde_json::json!({}), "person:test", "example",
            Arc::new(Recording::default())).await.unwrap();
        assert!(legacy.get("status").is_some());
        assert!(legacy.get("version").is_none());
    }

    #[tokio::test]
    async fn bounded_v1_uses_one_dispatch_budget_across_nested_action_graphs() {
        let root: Definition = serde_json::from_value(serde_json::json!({
            "id": "root", "name": "Root", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [{ "id": "call", "kind": "action", "config": { "definition_id": "child", "inputs": {} } }]
        })).unwrap();
        let child: Definition = serde_json::from_value(serde_json::json!({
            "id": "child", "name": "Child", "kind": "action", "is_active": true, "version": 1,
            "steps": [{ "id": "ask", "kind": "ask", "config": { "name": "tool:must-not-run", "input": {} } }]
        })).unwrap();
        let definitions_json = serde_json::to_string(&vec![root, child]).unwrap();
        let host = Arc::new(Recording::default());
        let refusal = run_bounded_v1(&definitions_json, "root", "{}", "person:test", "example",
            test_envelope_limits(), test_run_limits(1), host.clone()).await.unwrap_err();
        assert!(refusal.contains("FE_RUN_BUDGET_EXCEEDED") && refusal.contains("step_attempts"), "{refusal}");
        assert!(host.0.lock().unwrap().is_empty(), "the child dispatch is beyond the aggregate root allowance");
    }

    #[tokio::test]
    async fn bounded_v1_action_depth_is_path_local_and_refuses_before_descendant_dispatch() {
        let root: Definition = serde_json::from_value(serde_json::json!({
            "id": "root-depth", "name": "Root", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [{ "id": "call-child", "kind": "action", "config": { "definition_id": "child-depth", "inputs": {} } }]
        })).unwrap();
        let child: Definition = serde_json::from_value(serde_json::json!({
            "id": "child-depth", "name": "Child", "kind": "action", "is_active": true, "version": 1,
            "steps": [{ "id": "call-leaf", "kind": "action", "config": { "definition_id": "leaf-depth", "inputs": {} } }]
        })).unwrap();
        let leaf: Definition = serde_json::from_value(serde_json::json!({
            "id": "leaf-depth", "name": "Leaf", "kind": "action", "is_active": true, "version": 1,
            "steps": [{ "id": "ask", "kind": "ask", "config": { "name": "tool:must-not-run", "input": {} } }]
        })).unwrap();
        let definitions_json = serde_json::to_string(&vec![root, child, leaf]).unwrap();
        let host = Arc::new(Recording::default());
        let mut limits = test_run_limits(16);
        limits.max_action_depth = 1;
        let refusal = run_bounded_v1(&definitions_json, "root-depth", "{}", "person:test", "example",
            test_envelope_limits(), limits, host.clone()).await.unwrap_err();
        assert!(refusal.contains("FE_RUN_BUDGET_EXCEEDED") && refusal.contains("action_depth"), "{refusal}");
        assert!(host.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn bounded_v1_loop_batch_reservation_cannot_be_swallowed_by_item_tolerance() {
        let root: Definition = serde_json::from_value(serde_json::json!({
            "id": "root-loop", "name": "Root loop", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [{ "id": "items", "kind": "loop", "config": {
                "definition_id": "loop-child",
                "source": { "$kind": "binding", "select": { "from": "start", "path": "input.items" } },
                "item_var": "item", "max_iterations": 8, "parallel": true, "tolerate_item_errors": true
            } }]
        })).unwrap();
        let child: Definition = serde_json::from_value(serde_json::json!({
            "id": "loop-child", "name": "Loop child", "kind": "action", "is_active": true, "version": 1,
            "steps": [{ "id": "ask", "kind": "ask", "config": { "name": "tool:must-not-run", "input": {} } }]
        })).unwrap();
        let definitions_json = serde_json::to_string(&vec![root, child]).unwrap();
        let host = Arc::new(Recording::default());
        let mut limits = test_run_limits(16);
        limits.max_loop_iterations = 1;
        let refusal = run_bounded_v1(&definitions_json, "root-loop", r#"{"items":[1,2]}"#, "person:test", "example",
            test_envelope_limits(), limits, host.clone()).await.unwrap_err();
        assert!(refusal.contains("FE_RUN_BUDGET_EXCEEDED") && refusal.contains("loop_iterations"), "{refusal}");
        assert!(host.0.lock().unwrap().is_empty(), "over-budget batch is refused before its first item dispatch");
    }

    #[tokio::test]
    async fn bounded_v1_contention_never_admits_more_than_the_shared_dispatch_ceiling() {
        let mut steps: Vec<Value> = (0..24).map(|index| serde_json::json!({
            "id": format!("root-{index}"), "kind": "ask",
            "config": { "name": format!("tool:{index}"), "input": {} }
        })).collect();
        steps.push(serde_json::json!({ "id": "sink", "kind": "ask", "config": { "name": "tool:sink", "input": {} } }));
        let edges: Vec<Value> = (0..24).map(|index| serde_json::json!({
            "from": format!("root-{index}"), "to": "sink", "kind": "always"
        })).collect();
        let definition: Definition = serde_json::from_value(serde_json::json!({
            "id": "bounded-contention", "name": "Contention", "kind": "workflow", "is_active": true, "version": 1,
            "steps": steps, "edges": edges
        })).unwrap();
        let definitions_json = serde_json::to_string(&vec![definition]).unwrap();
        let host = Arc::new(Recording::default());
        let refusal = run_bounded_v1(&definitions_json, "bounded-contention", "{}", "person:test", "example",
            test_envelope_limits(), test_run_limits(3), host.clone()).await.unwrap_err();
        assert!(refusal.contains("FE_RUN_BUDGET_EXCEEDED"), "{refusal}");
        let dispatches = host.0.lock().unwrap().len();
        assert!(dispatches <= 3, "aggregate reservations must never exceed the configured cap: {dispatches}");
    }

    #[tokio::test]
    async fn bounded_v1_parallel_loop_context_clones_share_the_attempt_budget() {
        let root: Definition = serde_json::from_value(serde_json::json!({
            "id": "root-parallel-loop", "name": "Parallel loop", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [{ "id": "items", "kind": "loop", "config": {
                "definition_id": "parallel-child",
                "source": { "$kind": "binding", "select": { "from": "start", "path": "input.items" } },
                "item_var": "item", "max_iterations": 8, "parallel": true, "max_concurrency": 4
            } }]
        })).unwrap();
        let child: Definition = serde_json::from_value(serde_json::json!({
            "id": "parallel-child", "name": "Parallel child", "kind": "action", "is_active": true, "version": 1,
            "steps": [{ "id": "ask", "kind": "ask", "config": { "name": "tool:parallel-item", "input": {} } }]
        })).unwrap();
        let definitions_json = serde_json::to_string(&vec![root, child]).unwrap();
        let host = Arc::new(Recording::default());
        let refusal = run_bounded_v1(&definitions_json, "root-parallel-loop", r#"{"items":[1,2,3,4]}"#, "person:test", "example",
            test_envelope_limits(), test_run_limits(3), host.clone()).await.unwrap_err();
        assert!(refusal.contains("FE_RUN_BUDGET_EXCEEDED") && refusal.contains("step_attempts"), "{refusal}");
        assert!(host.0.lock().unwrap().len() <= 2, "the loop parent consumes one of three shared attempts");
    }

    #[tokio::test]
    async fn bounded_v1_true_do_while_refuses_instead_of_completing_at_iteration_cap() {
        let root: Definition = serde_json::from_value(serde_json::json!({
            "id": "root-do-while", "name": "Do while", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [{ "id": "repeat", "kind": "loop", "config": {
                "definition_id": "do-child", "condition": true, "item_var": "item",
                "max_iterations": 8, "parallel": false
            } }]
        })).unwrap();
        let child: Definition = serde_json::from_value(serde_json::json!({
            "id": "do-child", "name": "Do child", "kind": "action", "is_active": true, "version": 1,
            "steps": [{ "id": "ask", "kind": "ask", "config": { "name": "tool:body", "input": {} } }]
        })).unwrap();
        let definitions_json = serde_json::to_string(&vec![root, child]).unwrap();
        let host = Arc::new(Recording::default());
        let mut limits = test_run_limits(16);
        limits.max_loop_iterations = 2;
        let refusal = run_bounded_v1(&definitions_json, "root-do-while", "{}", "person:test", "example",
            test_envelope_limits(), limits, host.clone()).await.unwrap_err();
        assert!(refusal.contains("FE_RUN_BUDGET_EXCEEDED") && refusal.contains("loop_iterations"), "{refusal}");
        assert_eq!(host.0.lock().unwrap().len(), 2, "two bodies run; the third is refused before it can start");
    }

    #[tokio::test]
    async fn bounded_v1_allows_sibling_actions_at_the_same_path_depth() {
        let root: Definition = serde_json::from_value(serde_json::json!({
            "id": "root-siblings", "name": "Siblings", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [
                { "id": "first", "kind": "action", "config": { "definition_id": "sibling-child", "inputs": {} } },
                { "id": "second", "kind": "action", "config": { "definition_id": "sibling-child", "inputs": {} } }
            ]
        })).unwrap();
        let child: Definition = serde_json::from_value(serde_json::json!({
            "id": "sibling-child", "name": "Sibling child", "kind": "action", "is_active": true, "version": 1,
            "steps": [{ "id": "ask", "kind": "ask", "config": { "name": "tool:sibling", "input": {} } }]
        })).unwrap();
        let definitions_json = serde_json::to_string(&vec![root, child]).unwrap();
        let host = Arc::new(Recording::default());
        let mut limits = test_run_limits(8);
        limits.max_action_depth = 1;
        let response: Value = serde_json::from_str(&run_bounded_v1(&definitions_json, "root-siblings", "{}", "person:test", "example",
            test_envelope_limits(), limits, host.clone()).await.unwrap()).unwrap();
        assert_eq!(response["result"]["status"], "completed", "sibling branches do not accumulate depth");
        assert_eq!(response["usage"]["action_depth"], 1);
        assert_eq!(host.0.lock().unwrap().len(), 2);
    }

    #[test]
    fn the_bounded_version_is_the_hosts_word_then_the_engines_and_a_refused_word_gets_none() {
        assert_eq!(bounded_api_version("example"), "example.workflow-engine.run-bounded/v1");
        assert_eq!(bounded_api_version("Not A Word"), "workflow-engine.run-bounded/v1");
        let truncated: Value = serde_json::from_str(&failure_details_truncated(&bounded_api_version("example"))).unwrap();
        assert_eq!(truncated["version"], "example.workflow-engine.run-bounded/v1");
        assert_eq!(truncated["error"]["code"], "FE_FAILURE_DETAILS_TRUNCATED");
    }

    #[test]
    fn bounded_failure_envelopes_are_capped_and_budget_refusals_keep_total_usage() {
        let version = bounded_api_version("example");
        let version = version.as_str();
        let refusal = bounded_refusal(version, "FE_CUSTOM", &"x".repeat(10000));
        assert!(refusal.len() <= MAX_FAILURE_ENVELOPE_BYTES);
        assert!(refusal.contains("FE_CUSTOM"));
        let error = workflow_core::executor::budget::BudgetExceeded {
            code: "FE_RUN_BUDGET_EXCEEDED",
            dimension: "step_attempts".into(), attempted: 2, limit: 1, overflow: false,
            step_attempts_used: 1, loop_iterations_used: 4, action_depth_used: 2,
        };
        let typed = bounded_workflow_error(version, &error);
        let decoded: Value = serde_json::from_str(&typed).unwrap();
        assert_eq!(typed.len() <= MAX_FAILURE_ENVELOPE_BYTES, true);
        assert_eq!(decoded["error"]["code"], "FE_RUN_BUDGET_EXCEEDED");
        assert_eq!(decoded["error"]["step_attempts_used"], 1);
        assert_eq!(decoded["error"]["loop_iterations_used"], 4);
        assert_eq!(decoded["error"]["action_depth_used"], 2);
    }

    #[tokio::test]
    async fn an_ask_not_answered_yet_pauses_the_run_and_the_same_run_goes_on_once_answered() {
        let paused = run_definition(vec![scope_then_plan()], "scope-then-plan", serde_json::json!({}), "person:test", "example", Arc::new(Answers(Default::default(), vec![]))).await.expect("runs");
        assert_eq!(paused["status"], "paused", "{paused}");
        assert_eq!(paused["execution_context"]["steps"]["scope"]["status"], "paused");
        assert_eq!(paused["execution_context"]["steps"]["scope"]["output"]["step_id"], "scope");
        assert!(paused["execution_context"]["steps"].get("plan").is_none(), "nothing after the waiting step runs");

        let mut answers = std::collections::HashMap::new();
        answers.insert("scope".to_string(), serde_json::json!({ "areas": ["pricing", "support"] }));
        answers.insert("plan".to_string(), serde_json::json!({ "sections": ["pricing"], "tools": ["tool:real"] }));
        let done = run_definition(vec![scope_then_plan()], "scope-then-plan", serde_json::json!({}), "person:test", "example", Arc::new(Answers(answers, vec!["tool:real".into()]))).await.expect("runs");
        assert_eq!(done["status"], "completed", "{done}");
    }

    fn shaped() -> Definition {
        serde_json::from_value(serde_json::json!({
            "id": "shaped", "name": "Shaped", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [{ "id": "count", "kind": "ask", "config": { "name": "whoever-holds-the-run",
                "input": { "do": "Count them.", "submit": { "type": "object", "required": ["n"], "properties": { "n": { "type": "integer", "minimum": 1 } } } },
                "context": { "step_id": "count" } } }],
            "edges": []
        })).expect("definition")
    }

    #[tokio::test]
    async fn an_answer_that_does_not_fit_its_submit_shape_fails_the_step_and_a_fitting_one_completes_it() {
        for (given, missed) in [(serde_json::json!({ "n": 0 }), "answer.n: 0 is below 1"), (serde_json::json!({ "m": 2 }), "answer.n: is missing"),
            (serde_json::json!("two"), "answer: is string")] {
            let mut answers = std::collections::HashMap::new();
            answers.insert("count".to_string(), given.clone());
            let run = run_definition(vec![shaped()], "shaped", serde_json::json!({}), "person:test", "example",
                Arc::new(Unreachable { answers, unreachable: None })).await.expect("runs");
            assert_eq!(run["status"], "failed", "{given}: {run}");
            let reason = run["execution_context"]["steps"]["count"]["output"]["dispatch_failed"]["reason"].as_str().unwrap_or_default().to_string();
            assert!(reason.contains("does not fit what it asks for") && reason.contains(missed), "{given}: {reason}");
        }
        let mut answers = std::collections::HashMap::new();
        answers.insert("count".to_string(), serde_json::json!({ "n": 3 }));
        let run = run_definition(vec![shaped()], "shaped", serde_json::json!({}), "person:test", "example",
            Arc::new(Unreachable { answers, unreachable: None })).await.expect("runs");
        assert_eq!(run["status"], "completed", "{run}");
        let waiting = run_definition(vec![shaped()], "shaped", serde_json::json!({}), "person:test", "example",
            Arc::new(Unreachable { answers: Default::default(), unreachable: None })).await.expect("runs");
        assert_ne!(waiting["status"], "failed", "an ask not answered yet is not checked: {waiting}");
    }

    /// A used workflow ending `held` then `refused` (the branch not taken): `held` ran, so it answers.
    fn held_or_refused(id: &str, good: bool) -> serde_json::Value {
        serde_json::json!({ "id": id, "name": id, "kind": "action", "is_active": true, "version": 1,
            "steps": [
                { "id": "decide", "kind": "return", "config": { "value": { "good": good } } },
                { "id": "held", "kind": "return", "config": { "value": { "pages": "PAGE 1\nkept" } } },
                { "id": "refused", "kind": "fail", "config": { "error": "not good" } } ],
            "edges": [
                { "from": "decide", "to": "held", "kind": "on_result", "config": { "$kind": "binding", "select": { "from": "input", "path": "output.good" } } },
                { "from": "decide", "to": "refused", "kind": "on_result", "config": { "$kind": "binding", "select": { "from": "input", "path": "output.good" }, "transform": [{ "op": "op:core.not" }] } } ] })
    }

    #[tokio::test]
    async fn a_used_workflow_answers_with_the_step_that_ran_not_the_last_one_listed() {
        // Nov 20 2026: the owner's voice step (held, then refused) answered null after held ran, so a carousel got no pages.
        let main: Definition = serde_json::from_value(serde_json::json!({ "id": "main", "name": "Main", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [
                { "id": "voice", "kind": "action", "config": { "definition_id": "voice", "inputs": {} } },
                { "id": "each", "kind": "loop", "config": { "source": { "$kind": "binding", "select": { "from": "literal", "value": [1, 2] } }, "item_var": "item", "max_iterations": 5, "definition_id": "voice" } },
                { "id": "out", "kind": "return", "config": { "value": {
                    "voice": { "$kind": "binding", "select": { "key": "voice", "from": "steps", "path": "output.pages" } },
                    "each": { "$kind": "binding", "select": { "key": "each", "from": "steps", "path": "output" } } } } } ],
            "edges": [ { "from": "voice", "to": "each", "kind": "always" }, { "from": "each", "to": "out", "kind": "always" } ] })).expect("main");
        let voice: Definition = serde_json::from_value(held_or_refused("voice", true)).expect("voice");
        let run = run_definition(vec![main, voice], "main", serde_json::json!({}), "person:test", "example",
            Arc::new(Unreachable { answers: Default::default(), unreachable: None })).await.expect("runs");
        assert_eq!(run["status"], "completed", "{run}");
        let out = &run["execution_context"]["steps"]["out"]["output"];
        assert_eq!(out["voice"], "PAGE 1\nkept", "an action answers with held, which ran: {out}");
        assert_eq!(out["each"], serde_json::json!([{ "pages": "PAGE 1\nkept" }, { "pages": "PAGE 1\nkept" }]), "each loop item too: {out}");
        let refused: Definition = serde_json::from_value(held_or_refused("voice", false)).expect("refusing voice");
        let main_again: Definition = serde_json::from_value(serde_json::json!({ "id": "m2", "name": "M2", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [ { "id": "voice", "kind": "action", "config": { "definition_id": "voice", "inputs": {} } } ], "edges": [] })).expect("m2");
        let failed = run_definition(vec![main_again, refused], "m2", serde_json::json!({}), "person:test", "example",
            Arc::new(Unreachable { answers: Default::default(), unreachable: None })).await.expect("runs");
        assert_eq!(failed["status"], "failed", "when refused is the branch taken, the action fails: {failed}");
    }

}
