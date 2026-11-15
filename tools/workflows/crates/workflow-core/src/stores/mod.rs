// crates/workflow-core/src/stores/mod.rs
//
// Purpose:
//   Workflow store implementations.
//   Definition lookup is slot-owned cache state. Event polling still routes
//   through opaque Envelope dispatch.
//
// Non-Negotiable Invariants:
//   1. Definition ownership stays inside workflow-owned cache state — no
//      lookup through source-owner storage internals.
//   2. Event polling dispatch still uses EnvelopeDispatchFn opaquely.
//   3. Workflow never touches SQL.
//
// Dependencies:
//   Depends on: workflow domain (trait definitions), serde_json (serialization)
//   Depended on by: hosts (construct dispatch functions and pass to workflow)

mod cached_definition_store;
mod remote_event_store;

pub use cached_definition_store::CachedDefinitionStore;
pub use remote_event_store::RemoteEventStore;

const IDENTITY_ADDR_CODE: u64 = 0x1F;

/// Resolve a workflow-facing address string into the actual substrate address.
///
/// Workflow does not guess that a bare target is a slot. Target labels are
/// exact: `compute.process` addresses the native process handler, while
/// `slot::workflow` addresses the workflow slot. Canonical multihash text is
/// already an address and is preserved exactly. Direct fact labels become
/// identity multihash digests when they use the historical `|` form or the
/// package-record `package::` form. Package-owned stored bytes are different:
/// the package compiler publishes `package::<name>::stored-bytes::<name>` with
/// the normal label hash, so workflow reads must use that same address instead
/// of inventing an identity-text twin. Handler labels such as `slot::workflow`
/// and `compute.process` remain hashed labels.
pub fn runtime_fact_address(target: &str) -> slot_protocol::FactAddress {
    let target = target.trim();
    if let Some(multihash) = parse_exact_multihash_text(target) {
        slot_protocol::FactAddress::from_multihash(multihash)
    } else if is_package_stored_bytes_label(target) {
        slot_protocol::FactAddress::hash_from(target)
    } else if target.contains('|') || target.starts_with("package::") {
        slot_protocol::FactAddress::from_digest(IDENTITY_ADDR_CODE, target.as_bytes().to_vec())
    } else {
        slot_protocol::FactAddress::hash_from(target)
    }
}

fn is_package_stored_bytes_label(target: &str) -> bool {
    let mut segments = target.split("::");
    matches!(
        (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ),
        (Some("package"), Some(package), Some("stored-bytes"), Some(name), None)
            if !package.is_empty() && !name.is_empty()
    )
}

fn parse_exact_multihash_text(target: &str) -> Option<content_crypto::Multihash> {
    if let Ok(multihash) = content_crypto::Multihash::from_code_hex(target) {
        return Some(multihash);
    }
    let bytes = hex::decode(target).ok()?;
    content_crypto::Multihash::decode(&bytes).ok()
}

/// Resolve an address with an EXPLICIT mode, falling back to the heuristic.
///
/// The bare [`runtime_fact_address`] recognizes canonical fact strings and
/// package-record addresses. An explicit mode remains available for every other
/// identity string and for the uncommon case where a package-looking string is
/// intentionally a hashed label.
pub fn runtime_fact_address_with_mode(
    target: &str,
    mode: Option<&str>,
) -> slot_protocol::FactAddress {
    match mode {
        Some("identity_text") => {
            slot_protocol::FactAddress::from_digest(IDENTITY_ADDR_CODE, target.as_bytes().to_vec())
        }
        Some("label_hash") => slot_protocol::FactAddress::hash_from(target),
        // None (or any unrecognized value) → unchanged heuristic, back-compat.
        _ => runtime_fact_address(target),
    }
}

/// Envelope dispatch function type — routes requests to a target address.
///
/// The workflow crate has ZERO knowledge of what sits behind this function.
/// It provides the logical target address, partition key, opaque payload, and
/// optional opaque caller context.
/// The implementation decides how to serialize that into an Envelope for the
/// talk_to_other_slots runner. The handler could be any other slot, a remote service, or a mock.
pub type EnvelopeDispatchFn = dyn Fn(
        &str,
        &slot_protocol::PartitionKey,
        Option<&[u8]>,
        Option<&[u8]>,
    ) -> Result<std::sync::Arc<[u8]>, String>
    + Send
    + Sync;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_fact_address_keeps_fact_strings_as_identity_addresses() {
        let address = runtime_fact_address(
            "attribute_fact|partition:genesis|component:app-shell|prop:resource:compiler_config|type:extension",
        );
        assert_eq!(address.algo_code(), IDENTITY_ADDR_CODE);
        assert_eq!(
            address.as_multihash().digest,
            b"attribute_fact|partition:genesis|component:app-shell|prop:resource:compiler_config|type:extension"
        );
    }

    #[test]
    fn runtime_fact_address_hashes_slot_names() {
        let address = runtime_fact_address("slot::workflow");
        assert_eq!(
            address,
            slot_protocol::FactAddress::hash_from("slot::workflow")
        );
    }

    #[test]
    fn runtime_fact_address_keeps_package_records_as_identity_addresses() {
        let target = "package::selected-agent::chosen-ai-provider";
        let address = runtime_fact_address(target);
        assert_eq!(address.algo_code(), IDENTITY_ADDR_CODE);
        assert_eq!(address.as_multihash().digest, target.as_bytes());
        assert_eq!(
            runtime_fact_address_with_mode(target, Some("label_hash")),
            slot_protocol::FactAddress::hash_from(target),
            "an explicit label_hash remains authoritative for package-set handler labels"
        );
    }

    #[test]
    fn runtime_fact_address_hashes_package_owned_stored_bytes() {
        let target = "package::hosted-public-app::stored-bytes::run-provider-deploy";
        assert_eq!(
            runtime_fact_address(target),
            slot_protocol::FactAddress::hash_from(target),
            "stored bytes must resolve to the one address emitted by the package compiler"
        );
    }

    #[test]
    fn runtime_fact_address_keeps_exact_multihash_text() {
        let target = "package::research-workspace::workflow-action::research-add";
        let expected =
            slot_protocol::FactAddress::from_digest(IDENTITY_ADDR_CODE, target.as_bytes().to_vec());
        let wire_hex =
            "1f3a7061636b6167653a3a72657365617263682d776f726b73706163653a3a776f726b666c6f772d616374696f6e3a3a72657365617263682d616464";

        assert_eq!(runtime_fact_address(wire_hex), expected);
        assert_eq!(
            runtime_fact_address(&expected.as_multihash().to_code_hex()),
            expected
        );
    }

    #[test]
    fn explicit_identity_mode_forces_identity_even_for_non_pipe_addresses() {
        // The bare heuristic would HASH an unrecognized `::` address; explicit
        // identity_text must instead make it an identity digest — the same way
        // the engine write-batch addresses it. This is the whole point of the
        // mode-aware variant (lets a workflow write a feed-visible captured-item).
        let target = "destination::captured-item::abc";
        let hashed = runtime_fact_address_with_mode(target, None);
        assert_eq!(hashed, slot_protocol::FactAddress::hash_from(target)); // None = heuristic
        let identity = runtime_fact_address_with_mode(target, Some("identity_text"));
        assert_eq!(identity.algo_code(), IDENTITY_ADDR_CODE);
        assert_eq!(identity.as_multihash().digest, target.as_bytes());
        // explicit label_hash matches the hashed form
        assert_eq!(
            runtime_fact_address_with_mode(target, Some("label_hash")),
            slot_protocol::FactAddress::hash_from(target)
        );
    }

    #[test]
    fn runtime_fact_address_hashes_native_handler_targets_without_slot_prefix() {
        let address = runtime_fact_address("compute.process");
        assert_eq!(
            address,
            slot_protocol::FactAddress::hash_from("compute.process")
        );
    }
}
