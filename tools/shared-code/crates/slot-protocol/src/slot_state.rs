// crates/slot-protocol/src/slot_state.rs
//
// Purpose:
//   Reactive slot subscription — creates DispatchSlots from Envelope state at
//   slot::* addresses. ONE mechanism for both boot (initial state) and runtime
//   (deltas). User adds slot through any caller → new Envelope at slot::X →
//   engine creates DispatchSlot instantly. No restart. No recompile.
//
// Architecture (§40):
//   Slot configuration is Envelope state at slot::* addresses, not downstream
//   data-owner state. Data owners are themselves slots, so Envelope state is
//   the pre-slot layer.
//   The SlotConfig payload is self-describing (L090): slot name, method list,
//   optional stored-byte references, optional plug state, and optional handler
//   name for infrastructure query handlers. The subscribe_slot_state() function
//   reads initial state and subscribes to changes reactively.
//
// Non-Negotiable Invariants:
//   - Slot config is Envelope state, not downstream data-owner state
//   - ONE mechanism for boot AND runtime (subscribe with initial read)
//   - Handler name maps to compiled function in HandlerTable for infrastructure handlers
//   - Private runner hookup is caller-provided, not protocol-owned runtime branching
//   - Adding a new slot = adding Envelope data. Zero code changes.

use bytes::Bytes;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::dispatch_handle::DispatchHandle;
use crate::dispatch_slot::DispatchSlot;
use crate::handler::{HandlerTable, QueryBatchResult, QueryHandler, QueryResult};
use crate::method::MethodDescriptor;
use crate::registry::SlotRegistry;
use crate::selector::SlotSubscription;
use crate::PathSegment;
use crate::{Envelope, EnvelopeError};

/// Structural path segment used for SlotConfig Envelope records.
///
/// Slot config addresses remain content-addressed (`slot::{name}`), but boot
/// discovery must not deserialize every live payload to find them. This path
/// lets current-state readers select slot configs by metadata before reading
/// the few matching payloads.
pub fn slot_config_path() -> Vec<PathSegment> {
    vec![PathSegment::hash_from("slot-config")]
}

// ============================================================================
// Capability gate — pure function for slot activation decisions
// ============================================================================

/// Result of checking a slot's required capabilities against the host.
/// Pure data — no logging, no side effects. The caller decides what to do.
#[derive(Debug, PartialEq)]
pub enum CapabilityGateResult {
    /// All required capabilities are satisfied (including match-all `Some([])`).
    Satisfied,
    /// Slot did not declare `required_capabilities` (None) — reject.
    Undeclared,
    /// Some required capabilities are missing from the host.
    Missing(Vec<String>),
}

/// Check whether a slot's required capabilities are satisfied by the local realizer.
/// PURE FUNCTION — no logging, no side effects, no external deps.
/// Returns structured result: the caller decides what to do (log, reject, etc.).
///
/// None required_capabilities → Undeclared (reject).
/// Some([]) → Satisfied (match-all). Some([...]) → required ⊆ provided.
pub fn check_slot_capabilities(
    config: &SlotConfig,
    provided: &HashSet<String>,
) -> CapabilityGateResult {
    match &config.required_capabilities {
        None => CapabilityGateResult::Undeclared,
        Some(required) => {
            let missing: Vec<String> = required
                .iter()
                .filter(|r| !provided.contains(r.as_str()))
                .cloned()
                .collect();
            if missing.is_empty() {
                CapabilityGateResult::Satisfied
            } else {
                CapabilityGateResult::Missing(missing)
            }
        }
    }
}

struct LazyPrivateQueryHandler {
    config: SlotConfig,
    resolver: SlotQueryHandlerResolver,
    resolved: tokio::sync::OnceCell<Option<Arc<dyn QueryHandler>>>,
}

impl LazyPrivateQueryHandler {
    fn new(config: SlotConfig, resolver: SlotQueryHandlerResolver) -> Self {
        Self {
            config,
            resolver,
            resolved: tokio::sync::OnceCell::new(),
        }
    }

    async fn resolve(&self) -> Result<Arc<dyn QueryHandler>, EnvelopeError> {
        let resolved = self
            .resolved
            .get_or_init(|| async {
                tracing::info!(
                    slot_name = %self.config.name,
                    "resolving private slot query handler lazily"
                );
                (self.resolver)(&self.config).await
            })
            .await;
        resolved.clone().ok_or(EnvelopeError::NotSupported)
    }
}

impl QueryHandler for LazyPrivateQueryHandler {
    fn query(
        &self,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            let handler = self.resolve().await?;
            handler.query(envelope).await
        })
    }

    fn query_batch(
        &self,
        envelopes: Vec<Envelope>,
    ) -> Pin<Box<dyn Future<Output = Result<QueryBatchResult, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            let handler = self.resolve().await?;
            handler.query_batch(envelopes).await
        })
    }
}

/// Callback invoked when a private runner emits output bytes.
///
/// Receives raw output bytes. The caller is blind: it routes opaque bytes
/// without inspecting domain meaning.
pub type SlotOutputCallback = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// Caller-supplied private-runner resolver.
///
/// Plain English: `slot-protocol` makes the door. The local realizer decides
/// what machine is plugged behind that door and may return a query handler for
/// the door. This keeps runtime/provider names out of the generic slot law.
pub type SlotQueryHandlerFuture<'a> =
    Pin<Box<dyn Future<Output = Option<Arc<dyn QueryHandler>>> + Send + 'a>>;

pub type SlotQueryHandlerResolver =
    Arc<dyn for<'a> Fn(&'a SlotConfig) -> SlotQueryHandlerFuture<'a> + Send + Sync>;

// ============================================================================
// Slot-door byte and plug state
// ============================================================================

/// Content-addressed bytes referenced by a slot door.
///
/// The `name` is body-private data for the realizer behind the plug. The
/// protocol only preserves the reference; it never branches on the name.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SlotStoredBytesConfig {
    /// Body-private reference name.
    pub name: String,

    /// CAS content hash for the artifact bytes.
    pub content_hash: String,
}

/// Resolved plug state for a slot door.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SlotPlugConfig {
    /// Cold-side proof row for the plugged callable thing.
    pub permission: shared_slot_batches::PlugCallPermissionRow,

    /// Opaque private-runner config. Generic protocol code never inspects it.
    #[serde(default)]
    pub config: Value,
}

/// Private-runner input stored with a slot door.
///
/// Generic protocol code preserves this object but never interprets it. The
/// local realizer behind the plug decides whether it understands the data.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SlotRunnerConfig {
    /// Body-private data for the realizer behind the plug.
    #[serde(default)]
    pub private_config: Value,
}

impl Default for SlotRunnerConfig {
    fn default() -> Self {
        Self {
            private_config: Value::Null,
        }
    }
}

// ============================================================================
// SlotConfig — deserialized from Envelope payload at slot::*
// ============================================================================

/// Configuration for a single slot, stored as Envelope state.
///
/// This is Society data — slot names, method lists, handler names are all
/// conventions. The engine treats them generically.
///
/// # Envelope Address Convention
///
/// Slot configs are stored at addresses derived from `slot::{name}`.
/// Example: `slot::alpha`, `slot::beta`, `slot::gamma`.
/// The address is the Multihash of the string `slot::{name}`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SlotConfig {
    /// Slot name (Society data — "alpha", "beta", "gamma", etc.)
    pub name: String,

    /// Methods this slot advertises (Society data — method names + descriptions).
    pub methods: Vec<SlotMethodConfig>,

    /// Content-addressed byte references associated with this slot door.
    ///
    /// These are not runtime/provider declarations. They are raw stored bytes
    /// that a private runner may understand after the door is plugged.
    #[serde(default)]
    pub stored_bytes: Vec<SlotStoredBytesConfig>,

    /// Machine-readable callable byte boundary for the slot door.
    ///
    /// Generic protocol code checks only that this data is present where
    /// package law requires it. It never branches on boundary contents.
    #[serde(default)]
    pub boundary: Value,

    /// Private-runner input data preserved for the local realizer.
    ///
    /// This is not slot-owned query config. It tells the machine behind the
    /// plug how to interpret the stored bytes.
    #[serde(default)]
    pub runner: SlotRunnerConfig,

    /// Optional resolved plug state for the door.
    ///
    /// Absence means the door exists but no private callable is currently
    /// plugged behind it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plug: Option<SlotPlugConfig>,

    /// Infrastructure dispatch routing — maps to a native QueryHandler in the HandlerTable.
    /// This is only for compiled infrastructure handlers that provide runtime
    /// services. It is not the executable slot mechanism.
    /// If present: HandlerTable O(1) lookup for infrastructure dispatch.
    /// If absent: no infrastructure handler.
    #[serde(default)]
    pub handler: Option<String>,

    /// Retired AP-07C field. Executable bytes use `stored_bytes`.
    ///
    /// Kept only until old persisted slot records are rewritten. Activation must
    /// not read this as slot physics.
    #[serde(default)]
    pub binary: Option<String>,

    /// Capabilities this slot requires. None = undeclared, Some([]) = match-all,
    /// Some([...]) = required subset of the local realizer capabilities.
    #[serde(default)]
    pub required_capabilities: Option<Vec<String>>,

    /// Capabilities this slot optionally uses. None = no optional capabilities declared.
    #[serde(default)]
    pub optional_capabilities: Option<Vec<String>>,

    /// Capabilities this slot provides as input — other slots can route output here.
    /// Same type as required_capabilities (opaque strings). The platform constructs
    /// callbacks that write to this slot's input region when matched.
    #[serde(default)]
    pub provides_capabilities: Option<Vec<String>>,

    /// Exact subscribed-slot feed contract.
    ///
    /// The composition root uses this for:
    /// 1. coarse engine-side subscribe registration
    /// 2. exact boot snapshot filtering
    /// 3. exact per-slot live delta payload filtering
    ///
    /// `None` means no delta delivery.
    #[serde(default)]
    pub subscription: Option<SlotSubscription>,

    /// Opaque slot-owned configuration blob copied from the manifest.
    ///
    /// Physics never interprets this. It is delivered back to the slot as
    /// opaque query context bytes when the host invokes the slot's query path.
    #[serde(default)]
    pub config: Value,
}

/// Method configuration within a SlotConfig.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SlotMethodConfig {
    /// Method name (Society data)
    pub name: String,
    /// Method description (Society data)
    #[serde(default)]
    pub description: String,
}

/// Opaque bytes injected into every query for a configured slot when the
/// caller did not already supply envelope.context.
pub type SlotQueryContext = Option<Bytes>;

pub fn order_slot_configs_by_capabilities(
    configs: &[SlotConfig],
) -> Result<Vec<SlotConfig>, String> {
    let provider_index: HashMap<String, usize> = configs
        .iter()
        .enumerate()
        .flat_map(|(index, config)| {
            config
                .provides_capabilities
                .iter()
                .flatten()
                .cloned()
                .map(move |capability| (capability, index))
        })
        .collect();

    let mut dependencies: Vec<HashSet<usize>> = vec![HashSet::new(); configs.len()];
    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); configs.len()];

    for (index, config) in configs.iter().enumerate() {
        for capability in config.required_capabilities.iter().flatten() {
            let Some(provider) = provider_index.get(capability) else {
                continue;
            };
            if *provider == index {
                continue;
            }
            if dependencies[index].insert(*provider) {
                dependents[*provider].push(index);
            }
        }
    }

    let mut ordered = Vec::with_capacity(configs.len());
    let mut ready: Vec<usize> = (0..configs.len())
        .filter(|index| dependencies[*index].is_empty())
        .collect();
    sort_ready_slot_indexes(configs, &mut ready);
    let mut queued = HashSet::new();
    queued.extend(ready.iter().copied());

    while let Some(index) = ready.first().copied() {
        ready.remove(0);
        queued.remove(&index);
        ordered.push(configs[index].clone());
        for dependent in &dependents[index] {
            dependencies[*dependent].remove(&index);
            if dependencies[*dependent].is_empty() && !queued.contains(dependent) {
                ready.push(*dependent);
                sort_ready_slot_indexes(configs, &mut ready);
                queued.insert(*dependent);
            }
        }
    }

    if ordered.len() == configs.len() {
        return Ok(ordered);
    }

    let remaining: Vec<_> = (0..configs.len())
        .filter(|index| {
            !ordered
                .iter()
                .any(|config| config.name == configs[*index].name)
        })
        .map(|index| configs[index].name.clone())
        .collect();
    Err(format!(
        "cycle in slot capability graph: {}",
        remaining.join(" -> ")
    ))
}

fn sort_ready_slot_indexes(configs: &[SlotConfig], ready: &mut [usize]) {
    ready.sort_by(|left, right| {
        configs[*left]
            .name
            .cmp(&configs[*right].name)
            .then_with(|| left.cmp(right))
    });
}

// ============================================================================
// apply_slot_config — creates/updates a DispatchSlot from config
// ============================================================================

/// Create a DispatchSlot from a SlotConfig and register it in the registry.
///
/// Resolution order:
/// 1. `handler` present → HandlerTable O(1) lookup for infrastructure handlers.
/// 2. caller-supplied resolver returns a private-runner handler for this slot door.
/// 3. neither → no query handler (write-only slot, returns NotSupported).
///
/// This function is called both at boot (for initial state) and at runtime
/// (when new slot config Envelopes arrive via delta subscription). It never
/// loads artifacts and never dispatches by runtime/provider names.
pub async fn apply_slot_config(
    config: &SlotConfig,
    handle: &Arc<dyn DispatchHandle>,
    handler_table: &HandlerTable,
    registry: &SlotRegistry,
    private_query_resolver: Option<&SlotQueryHandlerResolver>,
) {
    let slot = prepare_slot_config(config, handle, handler_table, private_query_resolver);
    registry.register(config.name.clone(), slot);
    tracing::info!(slot_name = %config.name, "slot configured from Envelope state");
}

/// Construct a candidate without exposing it to callers. Runtime replacement
/// owners hydrate and verify this exact instance before registering it.
pub fn prepare_slot_config(
    config: &SlotConfig,
    handle: &Arc<dyn DispatchHandle>,
    handler_table: &HandlerTable,
    private_query_resolver: Option<&SlotQueryHandlerResolver>,
) -> Arc<dyn crate::Slot> {
    let descriptors: Vec<MethodDescriptor> = config
        .methods
        .iter()
        .map(|m| MethodDescriptor::new(&m.name, &m.description))
        .collect();

    // Resolution: infrastructure handler > lazy caller-provided private runner > write-only.
    let query_handler = if let Some(name) = config.handler.as_deref() {
        // Native handler path — HandlerTable O(1) lookup
        handler_table.get(name)
    } else {
        private_query_resolver.map(|resolve| {
            Arc::new(LazyPrivateQueryHandler::new(
                config.clone(),
                Arc::clone(resolve),
            )) as Arc<dyn QueryHandler>
        })
    };

    let query_context = if config.config.is_null() {
        None
    } else {
        serde_json::to_vec(&config.config).ok().map(Bytes::from)
    };

    let slot = match query_handler {
        Some(handler) => DispatchSlot::with_query_handler(
            &config.name,
            descriptors,
            handle.clone_handle(),
            handler,
            query_context,
        ),
        None => DispatchSlot::new(
            &config.name,
            descriptors,
            handle.clone_handle(),
            query_context,
        ),
    };

    Arc::new(slot)
}

/// The runtime owns subscription handoff and publishes a prepared candidate
/// only after initialization. An error must not expose that candidate.
pub type SlotConfigActivator = Arc<
    dyn Fn(
            SlotConfig,
            crate::DeltaAssert,
            Arc<dyn crate::Slot>,
        ) -> Pin<Box<dyn Future<Output = Result<(), EnvelopeError>> + Send>>
        + Send
        + Sync,
>;

/// Remove a slot from the registry by name.
///
/// Called when a slot config Envelope is retracted (slot removed at runtime).
pub fn remove_slot(name: &str, registry: &SlotRegistry) {
    match registry.unregister(name) {
        Ok(()) => tracing::info!(slot_name = %name, "slot removed (Envelope retracted)"),
        Err(_) => tracing::warn!(slot_name = %name, "attempted to remove unknown slot"),
    }
}

/// Apply a batch of slot configs (boot path — initial state).
///
/// Reads all slot configs and creates DispatchSlots for each.
/// This is the "boot = initial state" half of the reactive mechanism.
pub async fn apply_initial_slot_configs(
    configs: &[SlotConfig],
    handle: &Arc<dyn DispatchHandle>,
    handler_table: &HandlerTable,
    registry: &SlotRegistry,
    private_query_resolver: Option<&SlotQueryHandlerResolver>,
    should_activate: impl Fn(&SlotConfig) -> bool,
) {
    let ordered_configs = match order_slot_configs_by_capabilities(configs) {
        Ok(configs) => configs,
        Err(error) => {
            tracing::error!(%error, "failed to order initial slot configs");
            return;
        }
    };
    tracing::info!(
        slot_count = ordered_configs.len(),
        "applying initial slot configs from Envelope state"
    );
    for config in &ordered_configs {
        if !should_activate(config) {
            continue;
        }
        apply_slot_config(
            config,
            handle,
            handler_table,
            registry,
            private_query_resolver,
        )
        .await;
    }
}

// ============================================================================
// Delta processing — handles assertions/retractions from subscription stream
// ============================================================================

/// Process a batch of asserted slot config references (from a Delta's asserts).
///
/// Each DeltaAssert carries (address, content_hash). The `resolve_content` closure
/// resolves the hash to payload bytes from CAS — compiler enforces that resolution
/// happens (L096 compile-time physics contract, same pattern as to_write_batch).
///
/// Invalid payloads or resolution failures are logged and skipped — they don't
/// crash the engine. This is the runtime path: a new Envelope at `slot::X` →
/// new DispatchSlot.
pub async fn process_slot_assertions(
    asserts: &[crate::selector::DeltaAssert],
    resolve_content: impl Fn(&crate::newtypes::Hash) -> Result<bytes::Bytes, Box<dyn std::error::Error>>,
    handle: &Arc<dyn DispatchHandle>,
    handler_table: &HandlerTable,
    registry: &SlotRegistry,
    private_query_resolver: Option<&SlotQueryHandlerResolver>,
    should_activate: &impl Fn(&SlotConfig) -> bool,
) -> usize {
    process_slot_assertions_with_activation(
        asserts,
        resolve_content,
        handle,
        handler_table,
        registry,
        private_query_resolver,
        should_activate,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn process_slot_assertions_with_activation(
    asserts: &[crate::selector::DeltaAssert],
    resolve_content: impl Fn(&crate::newtypes::Hash) -> Result<bytes::Bytes, Box<dyn std::error::Error>>,
    handle: &Arc<dyn DispatchHandle>,
    handler_table: &HandlerTable,
    registry: &SlotRegistry,
    private_query_resolver: Option<&SlotQueryHandlerResolver>,
    should_activate: &impl Fn(&SlotConfig) -> bool,
    activate: Option<&SlotConfigActivator>,
) -> usize {
    let mut decoded_configs = Vec::new();
    let mut config_assertions = HashMap::new();
    let mut applied = 0;
    for assert in asserts {
        let payload = match resolve_content(&assert.content_hash) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    address = ?assert.address,
                    "CAS resolution failed for slot config delta — skipping"
                );
                continue;
            }
        };
        match deserialize_slot_config(&payload) {
            Ok(config) => {
                if config_assertions
                    .insert(config.name.clone(), assert.clone())
                    .is_some()
                {
                    tracing::error!(slot = %config.name, "ambiguous slot config assertions in one batch");
                    return 0;
                }
                decoded_configs.push(config);
            }
            Err(e) => {
                tracing::debug!(
                    error = %e,
                    payload_len = payload.len(),
                    "skipping non-slot-config Envelope in slot::* delta"
                );
            }
        }
    }
    let ordered_configs = match order_slot_configs_by_capabilities(&decoded_configs) {
        Ok(configs) => configs,
        Err(error) => {
            tracing::error!(%error, "failed to order slot config delta batch");
            return 0;
        }
    };
    for config in ordered_configs {
        if !should_activate(&config) {
            continue;
        }
        if let Some(activate) = activate {
            let candidate =
                prepare_slot_config(&config, handle, handler_table, private_query_resolver);
            let basis = config_assertions
                .remove(&config.name)
                .expect("decoded assertion basis");
            if let Err(error) = activate(config.clone(), basis, candidate).await {
                tracing::error!(slot = %config.name, %error, "slot initialization failed");
                continue;
            }
        } else {
            apply_slot_config(
                &config,
                handle,
                handler_table,
                registry,
                private_query_resolver,
            )
            .await;
        }
        applied += 1;
    }
    applied
}

/// Process a batch of retracted slot addresses (from a Delta's retracts).
///
/// Retractions carry address hashes (FactAddress, Multihash-backed) — no payload (the data is gone,
/// that's what retraction means). The SlotRegistry's bidirectional index provides
/// O(1) address_hash → slot_name lookup, maintained in lockstep with register/unregister.
pub fn process_slot_retractions(retracts: &[crate::FactAddress], registry: &SlotRegistry) -> usize {
    let mut removed = 0;
    for address_hash in retracts {
        match registry.unregister_by_address(address_hash) {
            Ok(name) => {
                tracing::info!(slot_name = %name, "slot removed (Envelope retracted)");
                removed += 1;
            }
            Err(_) => {
                tracing::debug!("retracted address not a known slot — ignoring");
            }
        }
    }
    removed
}

// ============================================================================
// Serialization helpers
// ============================================================================

/// Serialize a SlotConfig to bytes for storage as Envelope payload.
pub fn serialize_slot_config(config: &SlotConfig) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(config)
}

/// Deserialize a SlotConfig from Envelope payload bytes.
pub fn deserialize_slot_config(bytes: &[u8]) -> Result<SlotConfig, serde_json::Error> {
    serde_json::from_slice(bytes)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::QueryHandler;
    use crate::selector::DeltaAssert;
    use crate::{
        Envelope, EnvelopeError, FactAddress, Hash, PartitionKey, PathSegment, QueryResult,
    };
    use content_crypto::Multihash;
    use std::future::Future;
    use std::pin::Pin;

    struct MockHandle;

    impl DispatchHandle for MockHandle {
        fn dispatch_rewrite(
            &self,
            _partition: PartitionKey,
            target: FactAddress,
            _payload: Option<Vec<u8>>,
            _path: Vec<PathSegment>,
        ) -> Pin<Box<dyn Future<Output = Result<Hash, EnvelopeError>> + Send + '_>> {
            Box::pin(async move { Ok(Hash::from_multihash(target.as_multihash().clone())) })
        }

        fn read_envelope(
            &self,
            _partition: PartitionKey,
            _address: FactAddress,
        ) -> Pin<Box<dyn Future<Output = Result<Option<Envelope>, EnvelopeError>> + Send + '_>>
        {
            Box::pin(async move { Ok(None) })
        }

        fn visit_direct_read(
            &self,
            _partition: &PartitionKey,
            _address: &FactAddress,
            _visitor: &mut dyn crate::dispatch_handle::DirectReadVisitor,
        ) -> Result<bool, EnvelopeError> {
            Ok(false)
        }

        fn list_live_state(
            &self,
            _partition: PartitionKey,
        ) -> Pin<
            Box<dyn Future<Output = Result<Vec<crate::LiveStateEntry>, EnvelopeError>> + Send + '_>,
        > {
            Box::pin(async move { Ok(vec![]) })
        }

        fn visit_live_state(
            &self,
            _partition: &PartitionKey,
            _selector: &crate::EnvelopeSelector,
            _visitor: &mut dyn crate::dispatch_handle::DirectReadVisitor,
        ) -> Result<(), EnvelopeError> {
            Ok(())
        }

        fn scan_live_state(
            &self,
            _partition: &PartitionKey,
            _selector: &crate::EnvelopeSelector,
            _cursor: u64,
            _content: crate::SubscriptionContentMode,
            _visitor: &mut dyn crate::LiveStateScanVisitor,
        ) -> Result<Option<u64>, EnvelopeError> {
            Ok(None)
        }

        fn subscribe_cursor(
            &self,
            _p: PartitionKey,
            _cb: Arc<dyn Fn(crate::dispatch_handle::LogCursor) + Send + Sync>,
        ) -> Pin<Box<dyn Future<Output = Result<(), EnvelopeError>> + Send + '_>> {
            Box::pin(async { Ok(()) })
        }
        fn current_root(
            &self,
            _p: PartitionKey,
        ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>> {
            Box::pin(async { Ok(Multihash::blake3(b"stub-root")) })
        }
        fn root_diff(
            &self,
            _p: PartitionKey,
            have_root: Option<Multihash>,
        ) -> Pin<Box<dyn Future<Output = Result<crate::RootDiff, EnvelopeError>> + Send + '_>>
        {
            Box::pin(async move {
                Ok(crate::RootDiff {
                    have_root,
                    root: Multihash::blake3(b"stub-root"),
                    nodes: Vec::new(),
                    payloads: Vec::new(),
                    kept_roots: Vec::new(),
                })
            })
        }
        fn sync_mesh(
            &self,
            _p: PartitionKey,
            _from_peer: Option<Vec<u8>>,
            diff: crate::RootDiff,
        ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>> {
            Box::pin(async move { Ok(diff.root) })
        }
        fn current_cursor(
            &self,
            _p: PartitionKey,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<crate::dispatch_handle::LogCursor, EnvelopeError>>
                    + Send
                    + '_,
            >,
        > {
            Box::pin(async { Ok(crate::dispatch_handle::LogCursor::ZERO) })
        }

        fn clone_handle(&self) -> Arc<dyn DispatchHandle> {
            Arc::new(MockHandle)
        }
    }

    struct MockQueryHandler;

    impl QueryHandler for MockQueryHandler {
        fn query(
            &self,
            _envelope: Envelope,
        ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
            let data: Arc<[u8]> = b"mock_response".to_vec().into();
            Box::pin(async move { Ok(QueryResult::read_only(data)) })
        }
    }

    fn test_config(name: &str, handler: Option<&str>) -> SlotConfig {
        SlotConfig {
            name: name.to_string(),
            methods: vec![
                SlotMethodConfig {
                    name: "create".to_string(),
                    description: "Create operation".to_string(),
                },
                SlotMethodConfig {
                    name: "query".to_string(),
                    description: "Query operation".to_string(),
                },
            ],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: handler.map(|s| s.to_string()),
            binary: None,
            required_capabilities: Some(vec![]),
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        }
    }

    #[test]
    fn order_slot_configs_by_capabilities_honors_provider_before_consumer() {
        let mut producer_a = test_config("producer-a", None);
        producer_a.provides_capabilities = Some(vec!["capability-a".to_string()]);

        let mut producer_b = test_config("producer-b", None);
        producer_b.provides_capabilities = Some(vec!["capability-b".to_string()]);

        let mut consumer = test_config("consumer", None);
        consumer.required_capabilities = Some(vec![
            "storage.envelope_log".to_string(),
            "capability-a".to_string(),
            "capability-b".to_string(),
        ]);

        let ordered = order_slot_configs_by_capabilities(&[
            consumer.clone(),
            producer_b.clone(),
            producer_a.clone(),
        ])
        .expect("topological order");
        let names: Vec<_> = ordered.into_iter().map(|config| config.name).collect();
        assert_eq!(
            names,
            vec![
                "producer-a".to_string(),
                "producer-b".to_string(),
                "consumer".to_string()
            ]
        );
    }

    #[test]
    fn order_slot_configs_by_capabilities_rejects_cycles() {
        let mut a = test_config("slot-a", None);
        a.required_capabilities = Some(vec!["slot-b".to_string()]);
        a.provides_capabilities = Some(vec!["slot-a".to_string()]);

        let mut b = test_config("slot-b", None);
        b.required_capabilities = Some(vec!["slot-a".to_string()]);
        b.provides_capabilities = Some(vec!["slot-b".to_string()]);

        let error = order_slot_configs_by_capabilities(&[a, b]).expect_err("cycle");
        assert!(error.contains("cycle in slot capability graph"));
    }

    /// Build DeltaAsserts from payloads and return a content map for resolve_content.
    fn make_asserts(
        payloads: &[bytes::Bytes],
    ) -> (
        Vec<DeltaAssert>,
        std::collections::HashMap<Hash, bytes::Bytes>,
    ) {
        let mut asserts = Vec::new();
        let mut content_map = std::collections::HashMap::new();
        for (i, payload) in payloads.iter().enumerate() {
            let hash = Hash::blake3_hash(payload);
            let address = FactAddress::from_digest(0x1F, vec![i as u8; 32]);
            asserts.push(DeltaAssert {
                address,
                content_hash: hash.clone(),
            });
            content_map.insert(hash, payload.clone());
        }
        (asserts, content_map)
    }

    #[tokio::test]
    async fn apply_slot_config_without_handler() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        let config = test_config("test-slot", None);
        apply_slot_config(&config, &handle, &table, &registry, None).await;

        assert!(registry.resolve("test-slot").is_ok());
        let slot = registry.resolve("test-slot").unwrap();
        assert_eq!(slot.methods().len(), 2);
    }

    #[tokio::test]
    async fn apply_slot_config_with_native_handler() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let mut table = HandlerTable::new();
        table.register("alpha-handler", Arc::new(MockQueryHandler));
        let registry = SlotRegistry::new();

        let config = test_config("alpha-handler", Some("alpha-handler"));
        apply_slot_config(&config, &handle, &table, &registry, None).await;

        let slot = registry.resolve("alpha-handler").unwrap();
        assert_eq!(slot.methods().len(), 2);
    }

    #[tokio::test]
    async fn slot_with_handler_supports_query() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let mut table = HandlerTable::new();
        table.register("test", Arc::new(MockQueryHandler));
        let registry = SlotRegistry::new();

        let config = test_config("test", Some("test"));
        apply_slot_config(&config, &handle, &table, &registry, None).await;

        let slot = registry.resolve("test").unwrap();
        let env = Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            None,
        );
        let result = slot.query(env).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().as_ref(), b"mock_response");
    }

    #[tokio::test]
    async fn slot_without_handler_returns_not_supported() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        let config = test_config("no-handler", None);
        apply_slot_config(&config, &handle, &table, &registry, None).await;

        let slot = registry.resolve("no-handler").unwrap();
        let env = Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            None,
        );
        let result = slot.query(env).await;
        assert!(matches!(result, Err(EnvelopeError::NotSupported)));
    }

    #[tokio::test]
    async fn apply_initial_configs_batch() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        let configs = vec![
            test_config("slot-a", None),
            test_config("slot-b", None),
            test_config("slot-c", None),
        ];

        apply_initial_slot_configs(&configs, &handle, &table, &registry, None, |_| true).await;

        assert!(registry.resolve("slot-a").is_ok());
        assert!(registry.resolve("slot-b").is_ok());
        assert!(registry.resolve("slot-c").is_ok());
        assert_eq!(registry.list().len(), 3);
    }

    #[tokio::test]
    async fn private_runner_resolver_is_lazy_after_slot_registration() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();
        let resolve_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let resolver_count = Arc::clone(&resolve_count);
        let resolver: SlotQueryHandlerResolver = Arc::new(move |_config| {
            let resolver_count = Arc::clone(&resolver_count);
            Box::pin(async move {
                resolver_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Some(Arc::new(MockQueryHandler) as Arc<dyn QueryHandler>)
            })
        });

        let config = test_config("lazy-slot", None);
        apply_initial_slot_configs(
            &[config],
            &handle,
            &table,
            &registry,
            Some(&resolver),
            |_| true,
        )
        .await;

        assert!(registry.resolve("lazy-slot").is_ok());
        assert_eq!(resolve_count.load(std::sync::atomic::Ordering::SeqCst), 0);

        let slot = registry.resolve("lazy-slot").unwrap();
        let env = Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            None,
        );
        let result = slot.query(env.clone()).await.unwrap();
        assert_eq!(result.as_ref(), b"mock_response");
        assert_eq!(resolve_count.load(std::sync::atomic::Ordering::SeqCst), 1);

        let second = slot.query(env).await.unwrap();
        assert_eq!(second.as_ref(), b"mock_response");
        assert_eq!(resolve_count.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn remove_slot_from_registry() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        let config = test_config("removable", None);
        apply_slot_config(&config, &handle, &table, &registry, None).await;
        assert!(registry.resolve("removable").is_ok());

        remove_slot("removable", &registry);
        assert!(registry.resolve("removable").is_err());
    }

    #[test]
    fn remove_nonexistent_slot_is_safe() {
        let registry = SlotRegistry::new();
        remove_slot("nonexistent", &registry); // should not panic
    }

    #[test]
    fn slot_config_round_trip_serialization() {
        let config = test_config("round-trip", Some("native-handler"));
        let bytes = serialize_slot_config(&config).unwrap();
        let deserialized = deserialize_slot_config(&bytes).unwrap();

        assert_eq!(deserialized.name, "round-trip");
        assert_eq!(deserialized.methods.len(), 2);
        assert_eq!(deserialized.handler.as_deref(), Some("native-handler"));
    }

    #[test]
    fn slot_config_without_handler_serialization() {
        let config = test_config("no-handler", None);
        let bytes = serialize_slot_config(&config).unwrap();
        let deserialized = deserialize_slot_config(&bytes).unwrap();

        assert_eq!(deserialized.name, "no-handler");
        assert!(deserialized.handler.is_none());
    }

    #[test]
    fn l030_old_format_browser_fields_ignored() {
        // L030 clean break: old-format JSON with browser_assets_hash/browser_url
        // remains private-runner data only. Generic SlotConfig ignores it.
        let json = r#"{
            "name": "legacy",
            "methods": [],
            "browser_assets_hash": "abc123",
            "browser_url": "/old/path"
        }"#;
        let config: SlotConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.name, "legacy");
        assert_eq!(config.runner, SlotRunnerConfig::default());
        assert!(config.required_capabilities.is_none());
    }

    #[test]
    fn slot_config_empty_methods() {
        let config = SlotConfig {
            name: "empty".to_string(),
            methods: vec![],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: None,
            binary: None,
            required_capabilities: Some(vec![]),
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        };
        let bytes = serialize_slot_config(&config).unwrap();
        let deserialized = deserialize_slot_config(&bytes).unwrap();
        assert!(deserialized.methods.is_empty());
    }

    #[tokio::test]
    async fn apply_config_updates_existing_slot() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        // Register with 2 methods
        let config_v1 = test_config("updatable", None);
        apply_slot_config(&config_v1, &handle, &table, &registry, None).await;
        assert_eq!(registry.resolve("updatable").unwrap().methods().len(), 2);

        // Re-register with 1 method (simulates runtime config update)
        let config_v2 = SlotConfig {
            name: "updatable".to_string(),
            methods: vec![SlotMethodConfig {
                name: "only-method".to_string(),
                description: "".to_string(),
            }],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: None,
            binary: None,
            required_capabilities: Some(vec![]),
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        };
        apply_slot_config(&config_v2, &handle, &table, &registry, None).await;
        assert_eq!(registry.resolve("updatable").unwrap().methods().len(), 1);
    }

    #[tokio::test]
    async fn failed_candidate_activation_never_publishes_replacement() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = Arc::new(SlotRegistry::new());
        let config = test_config("hydrated-owner", None);
        apply_slot_config(&config, &handle, &table, &registry, None).await;
        let old = registry.resolve(&config.name).unwrap();
        let candidate_registry = Arc::clone(&registry);
        let expected_old = Arc::clone(&old);
        let activate: SlotConfigActivator = Arc::new(move |config, basis, candidate| {
            assert_eq!(
                basis.address,
                crate::address_for_routable_name(&config.name)
            );
            assert_eq!(
                basis.content_hash,
                Hash::blake3_hash(&serialize_slot_config(&config).unwrap())
            );
            let registry = Arc::clone(&candidate_registry);
            let old = Arc::clone(&expected_old);
            Box::pin(async move {
                assert!(Arc::ptr_eq(&registry.resolve(&config.name).unwrap(), &old));
                assert!(!Arc::ptr_eq(&candidate, &old));
                Err(EnvelopeError::Internal("hydration failed".into()))
            })
        });
        let bytes = Bytes::from(serialize_slot_config(&config).unwrap());
        let asserts = vec![DeltaAssert {
            address: crate::address_for_routable_name(&config.name),
            content_hash: Hash::blake3_hash(&bytes),
        }];
        let applied = process_slot_assertions_with_activation(
            &asserts,
            |_| Ok(bytes.clone()),
            &handle,
            &table,
            &registry,
            None,
            &|_| true,
            Some(&activate),
        )
        .await;
        assert_eq!(applied, 0);
        assert!(Arc::ptr_eq(&registry.resolve(&config.name).unwrap(), &old));
    }

    // ================================================================
    // Tests for process_slot_assertions / process_slot_retractions
    // ================================================================

    #[tokio::test]
    async fn process_assertions_creates_slots() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        let configs = [test_config("slot-a", None), test_config("slot-b", None)];
        let payloads: Vec<bytes::Bytes> = configs
            .iter()
            .map(|c| bytes::Bytes::from(serialize_slot_config(c).unwrap()))
            .collect();
        let (asserts, content_map) = make_asserts(&payloads);

        let applied = process_slot_assertions(
            &asserts,
            |h| {
                content_map
                    .get(h)
                    .cloned()
                    .ok_or_else(|| "not found".into())
            },
            &handle,
            &table,
            &registry,
            None,
            &|_| true,
        )
        .await;
        assert_eq!(applied, 2);
        assert!(registry.resolve("slot-a").is_ok());
        assert!(registry.resolve("slot-b").is_ok());
    }

    #[tokio::test]
    async fn process_assertions_skips_invalid_payloads() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        let payloads: Vec<bytes::Bytes> = vec![
            bytes::Bytes::from(serialize_slot_config(&test_config("valid", None)).unwrap()),
            bytes::Bytes::from_static(b"not valid json at all"),
            bytes::Bytes::from_static(&[0xFF, 0xFE]), // binary garbage
        ];
        let (asserts, content_map) = make_asserts(&payloads);

        let applied = process_slot_assertions(
            &asserts,
            |h| {
                content_map
                    .get(h)
                    .cloned()
                    .ok_or_else(|| "not found".into())
            },
            &handle,
            &table,
            &registry,
            None,
            &|_| true,
        )
        .await;
        assert_eq!(applied, 1);
        assert!(registry.resolve("valid").is_ok());
    }

    #[tokio::test]
    async fn process_retractions_removes_slots_o1() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        // Create slots first
        let configs = vec![test_config("keep-me", None), test_config("remove-me", None)];
        apply_initial_slot_configs(&configs, &handle, &table, &registry, None, |_| true).await;
        assert_eq!(registry.list().len(), 2);

        // Retract by address hash — O(1) via bidirectional index
        let retract_address = crate::FactAddress::hash_from("slot::remove-me");
        let removed = process_slot_retractions(&[retract_address], &registry);

        assert_eq!(removed, 1);
        assert!(registry.resolve("keep-me").is_ok());
        assert!(registry.resolve("remove-me").is_err());
    }

    #[test]
    fn process_retractions_ignores_unknown_addresses() {
        let registry = SlotRegistry::new();
        let unknown_address = crate::FactAddress::from_digest(0x1F, vec![42u8; 32]);
        let removed = process_slot_retractions(&[unknown_address], &registry);
        assert_eq!(removed, 0);
    }

    #[tokio::test]
    async fn unregister_by_address_round_trip() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        let config = test_config("by-address", None);
        apply_slot_config(&config, &handle, &table, &registry, None).await;
        assert!(registry.resolve("by-address").is_ok());

        // Unregister via address hash
        let address_hash = crate::FactAddress::hash_from("slot::by-address");
        let name = registry.unregister_by_address(&address_hash).unwrap();
        assert_eq!(name, "by-address");
        assert!(registry.resolve("by-address").is_err());
    }

    #[tokio::test]
    async fn bidirectional_index_survives_re_register() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        // Register, unregister, re-register
        let config = test_config("cycle", None);
        apply_slot_config(&config, &handle, &table, &registry, None).await;
        registry.unregister("cycle").unwrap();
        apply_slot_config(&config, &handle, &table, &registry, None).await;

        // Both directions should work after re-register
        assert!(registry.resolve("cycle").is_ok());
        let address_hash = crate::FactAddress::hash_from("slot::cycle");
        let name = registry.unregister_by_address(&address_hash).unwrap();
        assert_eq!(name, "cycle");
    }

    // ================================================================
    // Tests for check_slot_capabilities (pure function)
    // ================================================================

    #[test]
    fn check_capabilities_undeclared_when_none() {
        let config = SlotConfig {
            name: "no-caps".to_string(),
            methods: vec![],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: None,
            binary: None,
            required_capabilities: None,
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        };
        let provided = HashSet::new();
        assert_eq!(
            check_slot_capabilities(&config, &provided),
            CapabilityGateResult::Undeclared
        );
    }

    #[test]
    fn check_capabilities_satisfied_match_all() {
        let config = SlotConfig {
            name: "match-all".to_string(),
            methods: vec![],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: None,
            binary: None,
            required_capabilities: Some(vec![]),
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        };
        let provided = HashSet::new();
        assert_eq!(
            check_slot_capabilities(&config, &provided),
            CapabilityGateResult::Satisfied
        );
    }

    #[test]
    fn check_capabilities_satisfied_when_all_present() {
        let config = SlotConfig {
            name: "has-caps".to_string(),
            methods: vec![],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: None,
            binary: None,
            required_capabilities: Some(vec!["test.alpha".to_string()]),
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        };
        let provided: HashSet<String> = ["test.alpha".to_string()].into_iter().collect();
        assert_eq!(
            check_slot_capabilities(&config, &provided),
            CapabilityGateResult::Satisfied
        );
    }

    #[test]
    fn check_capabilities_missing_when_not_provided() {
        let config = SlotConfig {
            name: "needs-gpu".to_string(),
            methods: vec![],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: None,
            binary: None,
            required_capabilities: Some(vec!["test.beta".to_string()]),
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        };
        let provided: HashSet<String> = ["test.alpha".to_string()].into_iter().collect();
        assert_eq!(
            check_slot_capabilities(&config, &provided),
            CapabilityGateResult::Missing(vec!["test.beta".to_string()])
        );
    }

    // ================================================================
    // Tests for gate predicate on apply/process functions
    // ================================================================

    #[tokio::test]
    async fn apply_initial_configs_gate_rejects_all() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        let configs = vec![test_config("slot-a", None), test_config("slot-b", None)];

        apply_initial_slot_configs(&configs, &handle, &table, &registry, None, |_| false).await;
        assert_eq!(registry.list().len(), 0);
    }

    #[tokio::test]
    async fn process_assertions_gate_rejects() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let table = HandlerTable::new();
        let registry = SlotRegistry::new();

        let configs = [test_config("gated", None)];
        let payloads: Vec<bytes::Bytes> = configs
            .iter()
            .map(|c| bytes::Bytes::from(serialize_slot_config(c).unwrap()))
            .collect();
        let (asserts, content_map) = make_asserts(&payloads);

        let applied = process_slot_assertions(
            &asserts,
            |h| {
                content_map
                    .get(h)
                    .cloned()
                    .ok_or_else(|| "not found".into())
            },
            &handle,
            &table,
            &registry,
            None,
            &|_| false,
        )
        .await;
        assert_eq!(applied, 0);
        assert!(registry.resolve("gated").is_err());
    }

    // =========================================================================
    // check_slot_capabilities — pure function tests
    // =========================================================================

    #[test]
    fn cap_gate_none_returns_undeclared() {
        let config = SlotConfig {
            name: "undeclared".to_string(),
            methods: vec![],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: None,
            binary: None,
            required_capabilities: None,
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        };
        let provided = std::collections::HashSet::new();
        assert_eq!(
            check_slot_capabilities(&config, &provided),
            CapabilityGateResult::Undeclared
        );
    }

    #[test]
    fn cap_gate_empty_returns_satisfied() {
        let config = SlotConfig {
            name: "match-all".to_string(),
            methods: vec![],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: None,
            binary: None,
            required_capabilities: Some(vec![]),
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        };
        let provided = std::collections::HashSet::new();
        assert_eq!(
            check_slot_capabilities(&config, &provided),
            CapabilityGateResult::Satisfied
        );
    }

    #[test]
    fn cap_gate_missing_returns_missing() {
        let config = SlotConfig {
            name: "needs-net".to_string(),
            methods: vec![],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: None,
            binary: None,
            required_capabilities: Some(vec!["test.epsilon".to_string()]),
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        };
        let provided: std::collections::HashSet<String> =
            ["test.zeta".to_string()].into_iter().collect();
        assert_eq!(
            check_slot_capabilities(&config, &provided),
            CapabilityGateResult::Missing(vec!["test.epsilon".to_string()])
        );
    }

    #[test]
    fn cap_gate_present_returns_satisfied() {
        let config = SlotConfig {
            name: "has-net".to_string(),
            methods: vec![],
            stored_bytes: vec![],
            boundary: serde_json::Value::Null,
            runner: SlotRunnerConfig::default(),
            plug: None,
            handler: None,
            binary: None,
            required_capabilities: Some(vec!["test.epsilon".to_string()]),
            optional_capabilities: None,
            provides_capabilities: None,
            subscription: None,
            config: serde_json::Value::Null,
        };
        let provided: std::collections::HashSet<String> =
            ["test.epsilon".to_string(), "test.zeta".to_string()]
                .into_iter()
                .collect();
        assert_eq!(
            check_slot_capabilities(&config, &provided),
            CapabilityGateResult::Satisfied
        );
    }

    // =========================================================================
    // L030 clean break — old format rejected
    // =========================================================================

    #[test]
    fn old_format_browser_assets_hash_rejected() {
        // Old-format JSON with browser_assets_hash is ignored by generic
        // SlotConfig. It does not become generic slot state.
        let old_json = r#"{
            "name": "old-slot",
            "methods": [],
            "browser_assets_hash": "abc123",
            "browser_url": "/slot/old-slot/index.html"
        }"#;
        let config: SlotConfig = serde_json::from_str(old_json).unwrap();
        assert_eq!(config.name, "old-slot");
        assert_eq!(config.runner, SlotRunnerConfig::default());
    }
}
