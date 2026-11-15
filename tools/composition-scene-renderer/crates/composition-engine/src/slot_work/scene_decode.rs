// crates/composition-engine/src/slot_work/scene_decode.rs
//
// Decodes canonical scene assertions into kernel scene nodes.

use composition_engine_core::kernel::types::SceneNode;
use slot_protocol::{FactAddress, WireAssert};

pub(crate) fn canonical_scene_address() -> String {
    hex::encode(FactAddress::hash_from("scene").as_multihash().encode())
}

pub(crate) fn decode_scene_assert(assert: &WireAssert) -> Result<Option<SceneNode>, String> {
    if assert.address != canonical_scene_address() {
        return Ok(None);
    }

    let Some(bytes) = decode_inline_content(&assert.content)? else {
        return Ok(None);
    };

    serde_json::from_slice::<SceneNode>(&bytes)
        .map(Some)
        .map_err(|e| format!("scene payload decode failed: {e}"))
}

fn decode_inline_content(content: &Option<String>) -> Result<Option<Vec<u8>>, String> {
    let assert = WireAssert {
        address: String::new(),
        content_hash: String::new(),
        path: Vec::new(),
        content: content.clone(),
    };
    assert
        .content_bytes()
        .map_err(|e| format!("inline content decode: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{canonical_scene_address, decode_scene_assert};
    use base64::Engine as _;
    use composition_engine_core::kernel::types::{NodeKind, SceneNode};
    use slot_protocol::WireAssert;

    fn encode_node(node: &SceneNode) -> String {
        let bytes = serde_json::to_vec(node).expect("scene node json");
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn canonical_scene_address_matches_scene_hash() {
        assert_eq!(
            canonical_scene_address(),
            hex::encode(
                slot_protocol::FactAddress::hash_from("scene")
                    .as_multihash()
                    .encode()
            )
        );
    }

    #[test]
    fn decode_scene_assert_ignores_non_scene_addresses() {
        let node = SceneNode::new("root", NodeKind::Container);
        let assert = WireAssert {
            address: hex::encode(
                slot_protocol::FactAddress::hash_from("not-scene")
                    .as_multihash()
                    .encode(),
            ),
            content_hash: String::new(),
            path: Vec::new(),
            content: Some(encode_node(&node)),
        };

        assert!(decode_scene_assert(&assert).unwrap().is_none());
    }

    #[test]
    fn decode_scene_assert_accepts_canonical_scene_address() {
        let node = SceneNode::new("root", NodeKind::Container);
        let assert = WireAssert {
            address: canonical_scene_address(),
            content_hash: String::new(),
            path: Vec::new(),
            content: Some(encode_node(&node)),
        };

        let decoded = decode_scene_assert(&assert).unwrap().expect("scene node");
        assert_eq!(decoded.id, "root");
        assert_eq!(decoded.kind, NodeKind::Container);
    }
}
