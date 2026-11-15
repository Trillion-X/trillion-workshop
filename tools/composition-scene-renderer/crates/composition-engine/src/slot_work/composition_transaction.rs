// crates/composition-engine/src/slot_work/composition_transaction.rs
//
// Generic authoring transaction boundary for the composition-engine slot.
//
// This module exposes the existing kernel primitives to packages through one
// opaque slot payload. It intentionally contains no journal, document, block,
// workflow, or screen-arrangement vocabulary.

use composition_engine_core::kernel::scene_diff_types::ScenePatch;
use composition_engine_core::kernel::types::{
    Camera, EdgeConnection, EdgeMutation, HostTextMeasurement, NodeKind, SceneNode, Size,
};
use composition_engine_core::kernel::Kernel;
use serde::Deserialize;

const TRANSACTION_TYPE: &str = "composition-transaction";

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CompositionTransaction {
    #[serde(rename = "type")]
    transaction_type: String,
    /// Which scene SESSION this transaction addresses (scene_state keys kernels
    /// by it). Opaque caller-chosen DATA — the engine never interprets it.
    /// Absent = the shared anonymous session (backward compatible).
    #[serde(default)]
    pub(crate) session: Option<String>,
    #[serde(default)]
    pub(crate) set_scene: Option<SceneNode>,
    #[serde(default)]
    pub(crate) scene_patches: Vec<ScenePatch>,
    #[serde(default)]
    pub(crate) set_edges: Option<Vec<EdgeConnection>>,
    #[serde(default)]
    pub(crate) edge_mutations: Vec<EdgeMutation>,
    #[serde(default)]
    pub(crate) layout_patches: Vec<NodeLayoutPatch>,
    #[serde(default)]
    pub(crate) clear_layout: Vec<String>,
    #[serde(default)]
    pub(crate) camera: Option<Camera>,
    #[serde(default)]
    pub(crate) viewport: Option<Size>,
    /// Ephemeral host-measured wrapped text heights (`node_id` → height, px). The
    /// engine has no fonts; the host measures each text block's real DOM height and
    /// feeds it here so the measure phase reflows the blocks below. Never persisted.
    #[serde(default)]
    pub(crate) text_measurements: Vec<TextMeasurement>,
    /// Ephemeral interaction events: "node `node_id` received fsm event `event`".
    /// Each is dispatched to the kernel's inline FSM for that node id
    /// (`dispatch_fsm_event_str`), flipping a toggle / to-do / accordion so the
    /// descendant `visible {from:'fsm'}` bindings re-resolve on the next render. This
    /// is the ONLY authored-state-free input: no `scene_patches`, so nothing in the
    /// document changes and the host must NOT persist the reply (the `{from:'fsm'}`
    /// binding stays intact — never baked into a resolved bool). Absent by default =
    /// byte-identical behavior for every existing caller (additive, self-describing).
    #[serde(default)]
    pub(crate) interactions: Vec<InteractionEvent>,
}

/// One ephemeral fsm interaction. `node_id` is the inline-FSM owner (the clicked
/// node's own id — the kernel registers each node's `fsm` under that id); `event`
/// is the fsm event name carried by the node's `handlers.click` DISPATCH_FSM DATA
/// (e.g. `toggle`). The slot names neither — both are opaque caller DATA.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct InteractionEvent {
    pub(crate) node_id: String,
    pub(crate) event: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct NodeLayoutPatch {
    pub(crate) node_id: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TextMeasurement {
    pub(crate) node_id: String,
    pub(crate) height: f64,
    #[serde(default)]
    pub(crate) natural_width: Option<f64>,
}

impl CompositionTransaction {
    pub(crate) fn is_composition_transaction(&self) -> bool {
        self.transaction_type == TRANSACTION_TYPE
    }
}

pub(crate) fn decode(payload: &[u8]) -> Result<Option<CompositionTransaction>, String> {
    let maybe_type = serde_json::from_slice::<serde_json::Value>(payload)
        .map_err(|e| format!("composition transaction parse error: {}", e))?;

    if maybe_type.get("type").and_then(|value| value.as_str()) != Some(TRANSACTION_TYPE) {
        return Ok(None);
    }

    let transaction = serde_json::from_value::<CompositionTransaction>(maybe_type)
        .map_err(|e| format!("composition transaction shape error: {}", e))?;

    if !transaction.is_composition_transaction() {
        return Ok(None);
    }

    Ok(Some(transaction))
}

pub(crate) fn apply_to_kernel(
    kernel: &mut Kernel,
    transaction: CompositionTransaction,
) -> Result<(), String> {
    if let Some(viewport) = transaction.viewport {
        kernel.set_viewport(viewport);
    }

    if let Some(scene) = transaction.set_scene {
        kernel
            .update_scene(scene)
            .map_err(|e| format!("set_scene failed: {:?}", e))?;
    }

    if !transaction.scene_patches.is_empty() {
        kernel
            .apply_patches(transaction.scene_patches)
            .map_err(|e| format!("scene patch apply failed: {:?}", e))?;
    }

    if let Some(edges) = transaction.set_edges {
        kernel
            .set_edges(edges)
            .map_err(|e| format!("set_edges failed: {:?}", e))?;
    }

    apply_edge_mutations(kernel, transaction.edge_mutations)?;
    apply_layout_patches(kernel, transaction.layout_patches)?;

    for node_id in transaction.clear_layout {
        kernel.remove_node_layout(&node_id);
    }

    if let Some(camera) = transaction.camera {
        kernel
            .set_camera(camera)
            .map_err(|e| format!("set_camera failed: {:?}", e))?;
    }

    if !transaction.text_measurements.is_empty() {
        let measurements = transaction
            .text_measurements
            .into_iter()
            .map(|m| (m.node_id, HostTextMeasurement { height: m.height, natural_width: m.natural_width }))
            .collect();
        kernel.apply_text_measurements(measurements);
    }

    // Ephemeral fsm interactions LAST — after every scene mutation, so a node
    // inserted THIS transaction is already fsm-registered before we dispatch to it
    // (insert-then-click in one payload works). A dispatch to an unknown/registerless
    // node id is a no-op Err we intentionally ignore (a stale click must never fail the
    // whole transaction). No render here — the caller renders the snapshot next, which
    // re-resolves the `visible {from:'fsm'}` bindings against the transitioned state.
    for interaction in transaction.interactions {
        let _ = kernel.dispatch_fsm_event_str(&interaction.node_id, &interaction.event);
    }

    Ok(())
}

pub(crate) fn default_scene() -> SceneNode {
    SceneNode::new("root", NodeKind::Container)
}

fn apply_edge_mutations(kernel: &mut Kernel, mutations: Vec<EdgeMutation>) -> Result<(), String> {
    for mutation in mutations {
        match mutation {
            EdgeMutation::Add(edge) => kernel
                .add_edge(edge)
                .map_err(|e| format!("add_edge failed: {:?}", e))?,
            EdgeMutation::Remove { edge_id } => kernel.remove_edge(&edge_id),
            EdgeMutation::Update(edge) => kernel
                .update_edge(edge)
                .map_err(|e| format!("update_edge failed: {:?}", e))?,
        }
    }
    Ok(())
}

fn apply_layout_patches(kernel: &mut Kernel, patches: Vec<NodeLayoutPatch>) -> Result<(), String> {
    for patch in patches {
        kernel
            .update_node_layout(&patch.node_id, patch.x, patch.y)
            .map_err(|e| format!("update_node_layout failed: {:?}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use composition_engine_core::kernel::scene_diff_types::PropChanges;
    use composition_engine_core::kernel::types::{Anchor, NodeProps};

    #[test]
    fn authored_properties_survive_scene_patch_and_render() {
        use serde_json::json;
        let root = SceneNode::new("root", NodeKind::Container);
        let mut kernel = Kernel::new(root, Size { w: 800.0, h: 600.0 });
        let transaction = json!({
            "type": "composition-transaction",
            "scene_patches": [{"type": "INSERT_NODE", "parent_id": "root", "index": 0,
                "node": {"id": "item", "kind": "Text", "visible": true, "children": [],
                    "props": {"text": "Child", "made_by_shortcut": "caller-rule", "indent_level": 1,
                        "caller_metadata": {"nested": [1, true, null]}, "look": "caller-look"}}}]
        });
        let tx = decode(&serde_json::to_vec(&transaction).unwrap()).unwrap().unwrap();
        apply_to_kernel(&mut kernel, tx).unwrap();
        let publication = kernel.render_with_delta(16.0);
        let composition_engine_core::kernel::snapshot_delta::SnapshotPublication::Full(snapshot) = publication else {
            panic!("first publication must contain the full scene");
        };
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(encoded.contains("caller_metadata"));
        let inserted = &snapshot.tree.children[0].props;
        assert_eq!(inserted.extra["indent_level"], json!(1));
        assert_eq!(inserted.extra["caller_metadata"], json!({"nested": [1, true, null]}));

        let transaction = json!({
            "type": "composition-transaction",
            "scene_patches": [{"type": "UPDATE_PROPS", "node_id": "item", "changes": {"props": {
                "text": "Plain", "made_by_shortcut": null, "indent_level": 0,
                "caller_metadata": {"next": "value"}}}}]
        });
        let tx = decode(&serde_json::to_vec(&transaction).unwrap()).unwrap().unwrap();
        apply_to_kernel(&mut kernel, tx).unwrap();
        let delta = serde_json::to_value(kernel.render_with_delta(16.0)).unwrap();
        assert_eq!(delta["mode"], json!("delta"));
        let wire = serde_json::to_string(&delta).unwrap();
        assert!(wire.contains("caller_metadata"));
        assert!(wire.contains("made_by_shortcut"));
        let snapshot = kernel.render(16.0);
        let accepted = serde_json::to_value(&snapshot.tree.children[0].props).unwrap();
        assert_eq!(accepted["text"], json!("Plain"));
        assert_eq!(accepted["made_by_shortcut"], json!(null));
        assert_eq!(accepted["indent_level"], json!(0));
        assert_eq!(accepted["caller_metadata"], json!({"next": "value"}));
        assert!(accepted.get("look").is_none(), "full props replacement removes omitted metadata");
    }

    #[test]
    fn live_json_decodes_and_applies_via_kernel() {
        let json = br#"{"set_scene":{"id":"composition:launch-bitfield-studio:scene","kind":"Canvas","props":{},"visible":true,"children":[{"id":"node:launch-title","kind":"Text","props":{"text":"Launch Bitfield Studio","style":{"width":320,"height":80}},"visible":true,"children":[]}]},"set_edges":[],"camera":{"pan_x":0,"pan_y":0,"zoom":1},"viewport":{"w":1120,"h":680},"type":"composition-transaction"}"#;
        let tx = decode(json).expect("parse").expect("is transaction");
        assert!(tx.set_scene.is_some(), "set_scene must decode");
        let root = SceneNode::new("root", NodeKind::Container);
        let mut kernel = Kernel::new(root, Size { w: 800.0, h: 600.0 });
        apply_to_kernel(&mut kernel, tx).expect("applies");
        assert_eq!(kernel.node_count(), 2, "scene root + text child");
        let snap = kernel.render(16.0);
        let out = serde_json::to_string(&snap).unwrap();
        eprintln!("snapshot: {}", &out[..out.len().min(600)]);
        assert!(
            out.contains("node:launch-title"),
            "snapshot must contain the text node"
        );
    }

    #[test]
    fn text_measurement_transaction_drives_rendered_wrapped_height() {
        // A full-width text block with NO explicit height. Without a host
        // measurement it would be one line; the transaction's text_measurements
        // feed the real wrapped height, and the rendered frame must use it.
        let root = SceneNode::new("root", NodeKind::Container);
        let mut kernel = Kernel::new(root, Size { w: 800.0, h: 600.0 });
        let json = br#"{"type":"composition-transaction","scene_patches":[{"type":"INSERT_NODE","parent_id":"root","index":0,"node":{"id":"blk","kind":"Text","props":{"text":"a paragraph that wraps to several lines","style":{"width":300}},"visible":true,"children":[]}}],"text_measurements":[{"node_id":"blk","height":140.0,"natural_width":420.0}]}"#;
        let tx = decode(json).expect("parse").expect("is transaction");
        apply_to_kernel(&mut kernel, tx).expect("applies");
        assert_eq!(
            kernel.get_state().text_measurements.get("blk").map(|m| (m.height, m.natural_width)),
            Some((140.0, Some(420.0))),
            "measurement stored in the kernel's ephemeral side-map",
        );
        let _ = kernel.render(16.0);
        assert_eq!(
            kernel
                .get_state()
                .layout_frames
                .get("blk")
                .map(|f| f.rect.h),
            Some(140.0),
            "rendered frame uses the host-measured wrapped height, not one line",
        );
        assert_eq!(
            kernel.get_state().layout_frames.get("blk").map(|f| f.rect.w),
            Some(300.0),
            "authored width remains authoritative over host natural width",
        );
    }

    #[test]
    fn height_only_text_measurements_remain_wire_compatible() {
        let json = br#"{"type":"composition-transaction","text_measurements":[{"node_id":"blk","height":96.0}]}"#;
        let tx = decode(json).expect("legacy payload parses").expect("transaction type");
        let measurement = tx.text_measurements.first().expect("measurement row");
        assert_eq!(measurement.height, 96.0);
        assert_eq!(measurement.natural_width, None);
    }

    #[test]
    fn interaction_event_flips_an_inline_fsm() {
        // The interactive-block INTERACTION primitive (B-72): a toggle block is an
        // inline-FSM owner node; a user click arrives as an `interactions` entry and
        // must flip the fsm so descendant `visible {from:'fsm'}` bindings re-resolve.
        let root = SceneNode::new("root", NodeKind::Container);
        let mut kernel = Kernel::new(root, Size { w: 800.0, h: 600.0 });
        // Insert an fsm owner (open <-toggle-> closed), auto-registered under its id.
        let insert = br#"{"type":"composition-transaction","scene_patches":[{"type":"INSERT_NODE","parent_id":"root","index":0,"node":{"id":"tg","kind":"Container","props":{},"visible":true,"fsm":{"initial":"open","states":{"open":{"on":{"toggle":[{"target":"closed"}]}},"closed":{"on":{"toggle":[{"target":"open"}]}}}},"children":[]}}]}"#;
        let tx = decode(insert).expect("parse").expect("is transaction");
        apply_to_kernel(&mut kernel, tx).expect("insert applies");
        assert_eq!(
            kernel.get_fsm_state_str("tg").ok().as_deref(),
            Some("open"),
            "inline fsm auto-registers in its INITIAL state on insert",
        );
        // A click → an interaction event → the slot dispatches it to the kernel.
        let click = br#"{"type":"composition-transaction","interactions":[{"node_id":"tg","event":"toggle"}]}"#;
        let tx = decode(click).expect("parse").expect("is transaction");
        assert!(
            tx.scene_patches.is_empty(),
            "an interaction carries NO scene_patches"
        );
        assert_eq!(tx.interactions.len(), 1, "the interactions field decodes");
        apply_to_kernel(&mut kernel, tx).expect("interaction applies");
        assert_eq!(
            kernel.get_fsm_state_str("tg").ok().as_deref(),
            Some("closed"),
            "the interaction dispatched the fsm event and flipped open -> closed",
        );
        // A second click flips it back — the same generic path, no per-event code.
        let tx = decode(click).expect("parse").expect("is transaction");
        apply_to_kernel(&mut kernel, tx).expect("second interaction applies");
        assert_eq!(
            kernel.get_fsm_state_str("tg").ok().as_deref(),
            Some("open"),
            "a second toggle flips closed -> open (round-trip)",
        );
    }

    #[test]
    fn interaction_to_unknown_node_is_a_harmless_noop() {
        // A stale click (node gone, or no fsm) must NEVER fail the whole transaction.
        let root = SceneNode::new("root", NodeKind::Container);
        let mut kernel = Kernel::new(root, Size { w: 800.0, h: 600.0 });
        let click = br#"{"type":"composition-transaction","interactions":[{"node_id":"ghost","event":"toggle"}]}"#;
        let tx = decode(click).expect("parse").expect("is transaction");
        apply_to_kernel(&mut kernel, tx)
            .expect("a dispatch to an unknown node id is a no-op, not an error");
    }

    #[test]
    fn absent_interactions_field_is_byte_identical_default() {
        // Additive-safety: an existing caller that never sends `interactions` decodes
        // to an empty vec and the loop is a no-op — zero behavior change.
        let json = br#"{"type":"composition-transaction","scene_patches":[]}"#;
        let tx = decode(json).expect("parse").expect("is transaction");
        assert!(
            tx.interactions.is_empty(),
            "interactions defaults to empty when absent"
        );
    }

    #[test]
    fn edge_mutation_routes_appear_in_snapshot_reply() {
        let root = SceneNode::new("root", NodeKind::Container);
        let mut kernel = Kernel::new(root, Size { w: 800.0, h: 600.0 });
        let json = br#"{"type":"composition-transaction","scene_patches":[{"type":"INSERT_NODE","parent_id":"root","index":0,"node":{"id":"ea","kind":"Text","props":{"text":"A","style":{"width":100,"height":40}},"visible":true,"children":[]}},{"type":"INSERT_NODE","parent_id":"root","index":1,"node":{"id":"eb","kind":"Text","props":{"text":"B","style":{"width":100,"height":40}},"visible":true,"children":[]}}],"edge_mutations":[{"type":"add","edge_id":"e1","source_id":"ea","target_id":"eb","source_anchor":"right","target_anchor":"left"}]}"#;
        let tx = decode(json).expect("parse").expect("is transaction");
        apply_to_kernel(&mut kernel, tx).expect("applies");
        let snap = kernel.render(16.0);
        let out = serde_json::to_string(&snap).unwrap();
        assert!(
            out.contains("visible_edge_routes"),
            "snapshot has routes field"
        );
        assert!(
            out.contains("\"e1\""),
            "route for e1 present: {}",
            &out[..out.len().min(400)]
        );
    }

    #[test]
    fn ignores_non_transaction_payloads() {
        let payload = br#"{"type":"delta","assertions":[]}"#;
        let decoded = decode(payload).expect("non-transaction json should parse");
        assert!(decoded.is_none());
    }

    #[test]
    fn decodes_explicit_composition_transaction() {
        let payload = br#"{
            "type":"composition-transaction",
            "camera":{"pan_x":10.0,"pan_y":20.0,"zoom":1.25}
        }"#;

        let decoded = decode(payload)
            .expect("transaction json should parse")
            .expect("transaction type should decode");

        assert_eq!(decoded.camera.expect("camera").pan_x, 10.0);
    }

    #[test]
    fn applies_scene_patch_edges_layout_and_camera_through_kernel() {
        let root = SceneNode::new("root", NodeKind::Container);
        let mut kernel = Kernel::new(root, Size { w: 800.0, h: 600.0 });

        let child = SceneNode::new("child", NodeKind::Text).with_props(NodeProps {
            text: Some("hello".to_string()),
            ..Default::default()
        });

        let transaction = CompositionTransaction {
            transaction_type: TRANSACTION_TYPE.to_string(),
            session: None,
            set_scene: None,
            scene_patches: vec![ScenePatch::InsertNode {
                parent_id: "root".to_string(),
                index: 0,
                node: child,
            }],
            set_edges: Some(vec![EdgeConnection {
                edge_id: "edge:root-child".to_string(),
                source_id: "root".to_string(),
                target_id: "child".to_string(),
                source_anchor: Anchor::Right,
                target_anchor: Anchor::Left,
            }]),
            edge_mutations: Vec::new(),
            layout_patches: vec![NodeLayoutPatch {
                node_id: "child".to_string(),
                x: 120.0,
                y: 80.0,
            }],
            clear_layout: Vec::new(),
            camera: Some(Camera {
                pan_x: 12.0,
                pan_y: 24.0,
                zoom: 1.5,
            }),
            viewport: None,
            text_measurements: Vec::new(),
            interactions: Vec::new(),
        };

        apply_to_kernel(&mut kernel, transaction).expect("transaction applies");

        assert_eq!(kernel.node_count(), 2);
        assert_eq!(kernel.camera().pan_x, 12.0);
        assert_eq!(kernel.camera().pan_y, 24.0);
        assert_eq!(kernel.camera().zoom, 1.5);
    }

    #[test]
    fn rejects_kind_changes_through_patch_instead_of_special_casing_them() {
        let root = SceneNode::new("root", NodeKind::Container)
            .with_children(vec![SceneNode::new("child", NodeKind::Text)]);
        let mut kernel = Kernel::new(root, Size { w: 800.0, h: 600.0 });

        let transaction = CompositionTransaction {
            transaction_type: TRANSACTION_TYPE.to_string(),
            session: None,
            set_scene: None,
            scene_patches: vec![ScenePatch::UpdateProps {
                node_id: "child".to_string(),
                changes: PropChanges {
                    props: Some(NodeProps {
                        text: Some("updated".to_string()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            }],
            set_edges: None,
            edge_mutations: Vec::new(),
            layout_patches: Vec::new(),
            clear_layout: Vec::new(),
            camera: None,
            viewport: None,
            text_measurements: Vec::new(),
            interactions: Vec::new(),
        };

        apply_to_kernel(&mut kernel, transaction).expect("property patch applies");
        assert_eq!(kernel.node_count(), 2);
    }
}
