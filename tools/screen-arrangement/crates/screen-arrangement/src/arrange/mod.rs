// crates/screen-arrangement/src/arrange/mod.rs
//
// Pure work owned by screen-arrangement.

pub mod arrange_freeform_surfaces;
pub mod arrange_overlay_surfaces;
pub mod arrange_split_surfaces;
pub mod change_surface_focus;
pub mod publish_arrangement_delta;
pub mod screen_arrangement_types;

use arrange_freeform_surfaces::{
    auto_arrange_grid, max_freeform_z, merge_camera, window_from_rect, CameraPatch,
};
use arrange_overlay_surfaces::{default_overlay_box, max_overlay_z};
use arrange_split_surfaces::{
    collect_leaf_ids, even_split, insert_adjacent, insert_new_pane, remove_from_tree, swap_in_tree,
    update_cross_at_path, update_sizes_at_path, NewPaneLength,
};
use change_surface_focus::{focus_container, toggle_maximize, unfocus_container};
use publish_arrangement_delta::{publish_arrangement_delta, LayoutPublication};
use screen_arrangement_types::{
    ArrangementLayer, BaseSurfaceGeometry, Camera, FreeformWindow, LayoutContainer, LayoutState,
    LayoutSurface, OverlayBox, Rect, SplitDir, SplitSizeUnit, SplitTreeNode, SurfaceLabel, TabGroup, TabMeta,
    Viewport,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenArrangementRequest {
    pub state: LayoutState,
    #[serde(default)]
    pub viewport: Option<Viewport>,
    #[serde(default)]
    pub constraints: Option<ArrangementConstraints>,
    #[serde(flatten)]
    pub command: ArrangementCommand,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArrangementConstraints {
    #[serde(default, alias = "max_containers")]
    pub max_containers: Option<usize>,
    #[serde(default, alias = "max_tabs")]
    pub max_tabs: Option<usize>,
    #[serde(default, alias = "allowed_surfaces")]
    pub allowed_surfaces: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenArrangementReply {
    pub state: LayoutState,
    pub publication: LayoutPublication,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "operation", content = "payload")]
pub enum ArrangementCommand {
    #[serde(rename = "addTab")]
    AddTab(AddTabPayload),
    #[serde(rename = "addSurfaceTab")]
    AddSurfaceTab(AddTabPayload),
    #[serde(rename = "closeTab")]
    CloseTab(TabIdPayload),
    #[serde(rename = "activateTab")]
    ActivateTab(TabIdPayload),
    #[serde(rename = "updateTabMeta")]
    UpdateTabMeta(UpdateTabMetaPayload),
    #[serde(rename = "moveTabToContainer")]
    MoveTabToContainer(MoveTabToContainerPayload),
    #[serde(rename = "createContainer")]
    CreateContainer(CreateContainerPayload),
    #[serde(rename = "closeContainer")]
    CloseContainer(ContainerIdPayload),
    #[serde(rename = "splitContainer")]
    SplitContainer(SplitContainerPayload),
    #[serde(rename = "focusContainer")]
    FocusContainer(ContainerIdPayload),
    #[serde(rename = "unfocusContainer")]
    UnfocusContainer,
    #[serde(rename = "constrain")]
    Constrain,
    #[serde(rename = "toggleOverlay")]
    ToggleOverlay(ContainerIdPayload),
    #[serde(rename = "moveOverlay")]
    MoveOverlay(RectPositionPayload),
    #[serde(rename = "resizeOverlay")]
    ResizeOverlay(SizePayload),
    #[serde(rename = "bringOverlayToFront")]
    BringOverlayToFront(ContainerIdPayload),
    #[serde(rename = "resizeSplit")]
    ResizeSplit(ResizeSplitPayload),
    #[serde(rename = "resizeCross")]
    ResizeCross(ResizeCrossPayload),
    #[serde(rename = "addPaneBeside")]
    AddPaneBeside(AddPaneBesidePayload),
    #[serde(rename = "moveFloating")]
    MoveFloating(RectPositionPayload),
    #[serde(rename = "resizeFloating")]
    ResizeFloating(SizePayload),
    #[serde(rename = "updateFloatingRect")]
    UpdateFloatingRect(RectPayload),
    #[serde(rename = "bringFloatingToFront")]
    BringFloatingToFront(ContainerIdPayload),
    #[serde(rename = "setCamera")]
    SetCamera(CameraPatch),
    #[serde(rename = "createFloatingContainerWithTab")]
    CreateFloatingContainerWithTab(TabRectPayload),
    #[serde(rename = "createFloatingContainerWithSurface")]
    CreateFloatingContainerWithSurface(TabMetaRectPayload),
    #[serde(rename = "splitContainerWithTab")]
    SplitContainerWithTab(SplitContainerWithTabPayload),
    #[serde(rename = "splitContainerWithSurface")]
    SplitContainerWithSurface(SplitContainerWithSurfacePayload),
    #[serde(rename = "swapContainers")]
    SwapContainers(SwapContainersPayload),
    #[serde(rename = "moveContainerToEdge")]
    MoveContainerToEdge(MoveContainerToEdgePayload),
    #[serde(rename = "splitAtRoot")]
    SplitAtRoot(SplitAtRootPayload),
    #[serde(rename = "splitRootWithTab")]
    SplitRootWithTab(SplitRootWithTabPayload),
    #[serde(rename = "splitRootWithSurface")]
    SplitRootWithSurface(SplitRootWithSurfacePayload),
    #[serde(rename = "moveContainerToRoot")]
    MoveContainerToRoot(MoveContainerToRootPayload),
    #[serde(rename = "toggleMaximize")]
    ToggleMaximize(ContainerIdPayload),
    #[serde(rename = "setSurface")]
    SetSurface(SetSurfacePayload),
    #[serde(rename = "setActiveLayer")]
    SetActiveLayer(LayerIdPayload),
    #[serde(rename = "moveContainerToLayer")]
    MoveContainerToLayer(MoveContainerToLayerPayload),
    #[serde(rename = "createLayer")]
    CreateLayer(CreateLayerPayload),
    /// Restack planes. `layerIds` lists every layer back-to-front; z follows
    /// that order. Unknown or missing ids leave the stack unchanged.
    #[serde(rename = "reorderLayers")]
    ReorderLayers(ReorderLayersPayload),
    /// Declarative whole-layout placement. The caller names WHAT surface goes in
    /// WHICH coarse region; the slot owns HOW that becomes a valid tiled tree (it
    /// generates container/group ids and split nodes). This is the LLM-facing
    /// primitive: no brittle container-id threading, no operation-ordering hazard.
    #[serde(rename = "arrangeSurfaces")]
    ArrangeSurfaces(ArrangeSurfacesPayload),
    /// Lower-level escape hatch: fold an ordered list of commands through the same
    /// single-op reducer (each step re-normalized). Kept for completeness; the
    /// declarative `arrangeSurfaces` is preferred for agent/LLM callers.
    #[serde(rename = "applySequence")]
    ApplySequence(ApplySequencePayload),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTabPayload {
    pub container_id: String,
    pub tab: TabMeta,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabIdPayload {
    pub tab_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerIdPayload {
    pub container_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerIdPayload {
    pub layer_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveContainerToLayerPayload {
    pub container_id: String,
    pub layer_id: String,
    /// Destination placement: `grid` (default), `canvas`, or `overlay`.
    #[serde(default)]
    pub placement: Option<String>,
    /// Chosen spot in the arrangement's logical coordinate space. A canvas pane
    /// or PiP is centred on it and kept fully inside the viewport.
    #[serde(default)]
    pub position: Option<Point>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderLayersPayload {
    pub layer_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLayerPayload {
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTabMetaPayload {
    pub tab_id: String,
    #[serde(default)]
    pub patch: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveTabToContainerPayload {
    pub tab_id: String,
    pub target_container_id: String,
    #[serde(default)]
    pub index: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateContainerPayload {
    pub container_id: String,
    pub group_id: String,
    #[serde(default)]
    pub tab_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitContainerPayload {
    pub container_id: String,
    pub dir: SplitDir,
    #[serde(default)]
    pub position: RootPosition,
    #[serde(default)]
    pub initial_tab: Option<TabMeta>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectPositionPayload {
    pub container_id: String,
    pub xy: Point,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizePayload {
    pub container_id: String,
    pub size: Size,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectPayload {
    pub container_id: String,
    pub rect: Rect,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeSplitPayload {
    pub sizes: Vec<f64>,
    pub path: Vec<usize>,
    /// Absent means shares, the only unit requests carried before pane sizes.
    #[serde(default)]
    pub size_unit: SplitSizeUnit,
}

/// One child's length across the split at `path`, in layout pixels; null lets it fill the split again.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeCrossPayload {
    pub path: Vec<usize>,
    pub index: usize,
    #[serde(default)]
    pub length: Option<f64>,
}

/// A new pane beside `container_id` at `length_px` along `dir`, every pane keeping the length it is drawn at
/// (`target_px` is the target's drawn length along `dir`, so shares become the pixels they stand for).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPaneBesidePayload {
    pub container_id: String,
    pub dir: SplitDir,
    #[serde(default)]
    pub position: RootPosition,
    pub length_px: f64,
    pub target_px: f64,
    #[serde(default)]
    pub initial_tab: Option<TabMeta>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRectPayload {
    pub tab_id: String,
    pub rect: Rect,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabMetaRectPayload {
    pub tab: TabMeta,
    pub rect: Rect,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitContainerWithTabPayload {
    pub target_container_id: String,
    pub dir: SplitDir,
    #[serde(default)]
    pub position: RootPosition,
    pub tab_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitContainerWithSurfacePayload {
    pub target_container_id: String,
    pub dir: SplitDir,
    #[serde(default)]
    pub position: RootPosition,
    pub tab: TabMeta,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapContainersPayload {
    pub a: String,
    pub b: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveContainerToEdgePayload {
    pub source_id: String,
    pub target_id: String,
    pub dir: SplitDir,
    #[serde(default)]
    pub position: RootPosition,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RootPosition {
    Before,
    #[default]
    After,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitAtRootPayload {
    pub dir: SplitDir,
    pub position: RootPosition,
    #[serde(default)]
    pub initial_tab: Option<TabMeta>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitRootWithTabPayload {
    pub dir: SplitDir,
    pub position: RootPosition,
    pub tab_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitRootWithSurfacePayload {
    pub dir: SplitDir,
    pub position: RootPosition,
    pub tab: TabMeta,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveContainerToRootPayload {
    pub container_id: String,
    pub dir: SplitDir,
    pub position: RootPosition,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSurfacePayload {
    /// Open Society label for the activated base mode (`"grid"`/`"canvas"`/…).
    pub surface: SurfaceLabel,
    /// Self-described closed geometry the mode uses; the slot reconciles on this,
    /// never on `surface`. The client supplies it from its surface-mode registry.
    pub base_geometry: BaseSurfaceGeometry,
}

/// One surface placed in a coarse region of the workspace.
///
/// The caller (an AI agent or a human action) names a surface by its STABLE
/// catalog identity (`surface_id`) — the same id injected into the chat prompt's
/// surface catalog. The slot builds a minimal id-carrying tab whose only mount
/// hook is `metadata.placeable_surface_id`; the live arranger render path
/// (`tabWithCurrentSurfaceLabel`) joins that id against the live
/// `placeable-surfaces` catalog and mounts the real surface (packageEntry /
/// materialTarget / label). The caller therefore never has to know — or guess —
/// any internal mount field. `tab` is an escape hatch for fully-formed,
/// non-catalog placements and wins over `surface_id` when present.
/// `region` is the geometric slot; `size` is an optional 0..1 split hint.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfacePlacement {
    #[serde(default)]
    pub surface_id: Option<String>,
    #[serde(default)]
    pub tab: Option<TabMeta>,
    pub region: PlacementRegion,
    #[serde(default)]
    pub size: Option<f64>,
}

/// The coarse target regions a surface can occupy. This is the fixed geometry of
/// the layout model (a rectangle's subdivisions plus the two non-tiled layers),
/// not extensible Society vocabulary — same closed-by-physics status as the
/// `LayoutSurface` Tiled/Floating/Overlay split itself.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlacementRegion {
    Left,
    Right,
    Top,
    Bottom,
    Center,
    Overlay,
    Floating,
}

/// Declarative whole-workspace layout request. The caller supplies the desired
/// placements; the slot rebuilds a valid tiled tree from scratch (plus any
/// floating/overlay layers), generating all container/group ids itself.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangeSurfacesPayload {
    pub placements: Vec<SurfacePlacement>,
    #[serde(default)]
    pub focus_tab_id: Option<String>,
}

/// Ordered list of commands folded through the single-op reducer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySequencePayload {
    pub operations: Vec<ArrangementCommand>,
}

pub fn arrange_screen_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let request: ScreenArrangementRequest = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid screen-arrangement request: {error}"))?;
    if let Some(policy) = request.constraints.as_ref() {
        if policy.max_containers == Some(0) || policy.max_tabs == Some(0)
            || policy.allowed_surfaces.as_ref().is_some_and(|surfaces| {
                surfaces.is_empty() || surfaces.iter().any(|surface| !matches!(surface.as_str(), "tiled" | "floating" | "overlay"))
            }) {
            return Err("invalid screen-arrangement constraints".to_string());
        }
    }
    let reply = arrange_screen_request(request);
    serde_json::to_vec(&reply)
        .map_err(|error| format!("screen-arrangement reply encode failed: {error}"))
}

pub fn arrange_screen_request(request: ScreenArrangementRequest) -> ScreenArrangementReply {
    let previous = normalize_state(request.state);
    let viewport = request.viewport.unwrap_or_default();
    let mut state = apply_command(previous.clone(), request.command, viewport);
    if let Some(constraints) = request.constraints.as_ref() {
        apply_constraints(&mut state, constraints, &previous);
        state = normalize_state(state);
    }
    let publication = publish_arrangement_delta(&previous, &state);
    ScreenArrangementReply { state, publication }
}

/// Restrict the current presentation through the canonical arrangement model.
/// The caller keeps the saved source state while a temporary policy is active.
fn apply_constraints(state: &mut LayoutState, policy: &ArrangementConstraints, previous: &LayoutState) {
    let max_containers = policy.max_containers.unwrap_or(usize::MAX).max(1);
    let max_tabs = policy.max_tabs.unwrap_or(usize::MAX).max(1);
    let allowed = policy.allowed_surfaces.as_ref().map(|rows| rows.iter().map(String::as_str).collect::<BTreeSet<_>>());

    let mut ids = Vec::new();
    if let Some(id) = state.focused_container_id.as_ref().filter(|id| state.containers.contains_key(*id)) { ids.push(id.clone()); }
    for layout in &state.layouts {
        match layout {
            LayoutSurface::Tiled { root, .. } => ids.extend(collect_leaf_ids(root.as_ref())),
            LayoutSurface::Floating { containers, .. } => ids.extend(containers.iter().map(|row| row.container_id.clone())),
            LayoutSurface::Overlay { containers } => ids.extend(containers.iter().map(|row| row.container_id.clone())),
        }
    }
    ids.extend(state.containers.keys().cloned());
    let mut seen = BTreeSet::new();
    ids.retain(|id| state.containers.contains_key(id) && seen.insert(id.clone()));
    ids.truncate(max_containers);
    if ids.is_empty() { return; }

    let retained: BTreeSet<String> = ids.iter().cloned().collect();
    let focused = state.focused_container_id.as_ref().filter(|id| retained.contains(*id)).cloned()
        .filter(|id| previous.containers.contains_key(id))
        .or_else(|| ids.iter().find(|id| !previous.containers.contains_key(*id)).cloned())
        .or_else(|| state.focused_container_id.as_ref().filter(|id| retained.contains(*id)).cloned())
        .unwrap_or_else(|| ids[0].clone());
    state.containers.retain(|id, _| retained.contains(id));

    // Spend the tab budget on the focused/requested destination first, rather
    // than on whichever opaque group ID happens to sort first.
    let mut group_ids = Vec::new();
    for id in &ids {
        let group_id = state.containers[id].group_id.clone();
        if !group_ids.contains(&group_id) { group_ids.push(group_id); }
    }
    state.tab_groups.retain(|id, _| group_ids.contains(id));
    let old_tabs = std::mem::take(&mut state.tabs);
    let mut remaining = max_tabs;
    for id in group_ids {
        let Some(group) = state.tab_groups.get_mut(&id) else { continue };
        let added = group.tab_ids.iter().filter(|tab| !previous.tabs.contains_key(*tab)).cloned();
        let active = group.active_tab_id.as_ref().filter(|tab| group.tab_ids.contains(tab)).cloned();
        let ordered = added.chain(active).chain(group.tab_ids.iter().cloned());
        let mut kept = Vec::new();
        for tab_id in ordered {
            if kept.contains(&tab_id) || remaining == 0 { continue; }
            if let Some(tab) = old_tabs.get(&tab_id) {
                state.tabs.insert(tab_id.clone(), tab.clone());
                kept.push(tab_id);
                remaining -= 1;
            }
        }
        group.tab_ids = kept;
        group.active_tab_id = group.tab_ids.first().cloned();
    }

    state.layouts.retain(|layout| match layout {
        LayoutSurface::Tiled { .. } => allowed.as_ref().map_or(true, |set| set.contains("tiled")),
        LayoutSurface::Floating { .. } => allowed.as_ref().map_or(true, |set| set.contains("floating")),
        LayoutSurface::Overlay { .. } => allowed.as_ref().map_or(true, |set| set.contains("overlay")),
    });
    let has_home = state.layouts.iter().any(|layout| match layout {
        LayoutSurface::Tiled { root, .. } => collect_leaf_ids(root.as_ref()).contains(&focused),
        LayoutSurface::Floating { containers, .. } => containers.iter().any(|row| row.container_id == focused),
        LayoutSurface::Overlay { containers } => containers.iter().any(|row| row.container_id == focused),
    });
    if !has_home || state.layouts.is_empty() {
        let mode = allowed.as_ref().and_then(|set| ["tiled", "floating", "overlay"].into_iter().find(|mode| set.contains(mode))).unwrap_or("tiled");
        state.layouts.push(match mode {
            "floating" => LayoutSurface::floating(vec![window_from_rect(focused.clone(), Rect { x: 0.0, y: 0.0, w: 640.0, h: 480.0 }, 1)], Camera::default()),
            "overlay" => LayoutSurface::Overlay { containers: vec![default_overlay_box(focused.clone(), Viewport::default(), 1)] },
            _ => LayoutSurface::tiled(Some(SplitTreeNode::Leaf { container_id: focused.clone() })),
        });
    }
    let permits = |name: &str| allowed.as_ref().map_or(true, |set| set.contains(name));
    if state.surface == "canvas" && !permits("floating") { state.surface = "grid".into(); }
    if state.surface == "grid" && !permits("tiled") && permits("floating") { state.surface = "canvas".into(); }
    state.focused_container_id = Some(focused.clone());
    if state.maximized_container_id.as_ref().is_some_and(|id| !retained.contains(id)) {
        state.maximized_container_id = None;
    }
    // Apply the same policy to every selectable layer so switching layers
    // cannot reveal a forbidden layout or a removed container.
    for layer in &mut state.layers {
        layer.layouts.retain_mut(|layout| {
            let permitted = match layout {
                LayoutSurface::Tiled { .. } => permits("tiled"),
                LayoutSurface::Floating { .. } => permits("floating"),
                LayoutSurface::Overlay { .. } => permits("overlay"),
            };
            if !permitted { return false; }
            match layout {
                LayoutSurface::Tiled { root, .. } => {
                    let ids = collect_leaf_ids(root.as_ref());
                    let mut next = root.clone();
                    for id in ids {
                        if !retained.contains(&id) { next = remove_from_tree(next, &id); }
                    }
                    *root = next;
                }
                LayoutSurface::Floating { containers, .. } => containers.retain(|row| retained.contains(&row.container_id)),
                LayoutSurface::Overlay { containers } => containers.retain(|row| retained.contains(&row.container_id)),
            }
            true
        });
        if layer.layouts.is_empty() {
            let mode = ["tiled", "floating", "overlay"].into_iter().find(|mode| permits(mode)).unwrap_or("tiled");
            layer.layouts.push(match mode {
                "floating" => LayoutSurface::floating(vec![window_from_rect(focused.clone(), Rect { x: 0.0, y: 0.0, w: 640.0, h: 480.0 }, 1)], Camera::default()),
                "overlay" => LayoutSurface::Overlay { containers: vec![default_overlay_box(focused.clone(), Viewport::default(), 1)] },
                _ => LayoutSurface::tiled(Some(SplitTreeNode::Leaf { container_id: focused.clone() })),
            });
        }
        if layer.surface == "canvas" && !permits("floating") { layer.surface = "grid".into(); }
        if layer.surface == "grid" && !permits("tiled") && permits("floating") { layer.surface = "canvas".into(); }
    }
    // The saved copy is retained by the caller while this projected state is visible.
    if let Some(active_layer_id) = state.active_layer_id.as_deref() {
        if let Some(layer) = state.layers.iter_mut().find(|layer| layer.id == active_layer_id) {
            layer.layouts = state.layouts.clone();
            layer.surface = state.surface.clone();
        }
    }
    if state.layers.is_empty() {
        state.layers.push(ArrangementLayer { id: "default".into(), name: None, z: 0, surface: state.surface.clone(), layouts: state.layouts.clone() });
        state.active_layer_id = Some("default".into());
    }
}

fn apply_command(
    state: LayoutState,
    command: ArrangementCommand,
    viewport: Viewport,
) -> LayoutState {
    let mut state = match command {
        ArrangementCommand::AddTab(payload) => {
            add_tab(state, payload.container_id, payload.tab, false)
        }
        ArrangementCommand::AddSurfaceTab(payload) => {
            add_tab(state, payload.container_id, payload.tab, true)
        }
        ArrangementCommand::CloseTab(payload) => close_tab(state, &payload.tab_id),
        ArrangementCommand::ActivateTab(payload) => activate_tab(state, &payload.tab_id),
        ArrangementCommand::UpdateTabMeta(payload) => {
            update_tab_meta(state, &payload.tab_id, payload.patch)
        }
        ArrangementCommand::MoveTabToContainer(payload) => move_tab_to_container(
            state,
            &payload.tab_id,
            &payload.target_container_id,
            payload.index,
        ),
        ArrangementCommand::CreateContainer(payload) => create_container(
            state,
            payload.container_id,
            payload.group_id,
            payload.tab_ids,
        ),
        ArrangementCommand::CloseContainer(payload) => {
            close_container(state, &payload.container_id)
        }
        ArrangementCommand::SplitContainer(payload) => split_container(
            state,
            &payload.container_id,
            payload.dir,
            payload.position,
            payload.initial_tab,
            NewPaneLength::Half,
        ),
        ArrangementCommand::AddPaneBeside(payload) => {
            let lengths_usable = [payload.length_px, payload.target_px].iter().all(|px| px.is_finite() && *px > 0.0);
            if lengths_usable {
                split_container(
                    state,
                    &payload.container_id,
                    payload.dir,
                    payload.position,
                    payload.initial_tab,
                    NewPaneLength::Beside { new_px: payload.length_px, target_px: payload.target_px },
                )
            } else {
                state
            }
        }
        ArrangementCommand::FocusContainer(payload) => focus_container(state, payload.container_id),
        ArrangementCommand::UnfocusContainer => unfocus_container(state),
        ArrangementCommand::Constrain => state,
        ArrangementCommand::ToggleOverlay(payload) => {
            toggle_overlay(state, &payload.container_id, viewport)
        }
        ArrangementCommand::MoveOverlay(payload) => {
            move_overlay(state, &payload.container_id, payload.xy)
        }
        ArrangementCommand::ResizeOverlay(payload) => {
            resize_overlay(state, &payload.container_id, payload.size)
        }
        ArrangementCommand::BringOverlayToFront(payload) => {
            bring_overlay_to_front(state, &payload.container_id)
        }
        ArrangementCommand::ResizeSplit(payload) => {
            resize_split(state, &payload.sizes, &payload.path, payload.size_unit)
        }
        ArrangementCommand::ResizeCross(payload) => {
            let mut state = state;
            update_tiled_root(&mut state, |root| {
                root.map(|node| update_cross_at_path(node, &payload.path, payload.index, payload.length))
            });
            state
        }
        ArrangementCommand::MoveFloating(payload) => {
            move_floating(state, &payload.container_id, payload.xy)
        }
        ArrangementCommand::ResizeFloating(payload) => {
            resize_floating(state, &payload.container_id, payload.size)
        }
        ArrangementCommand::UpdateFloatingRect(payload) => {
            update_floating_rect(state, &payload.container_id, payload.rect)
        }
        ArrangementCommand::BringFloatingToFront(payload) => {
            bring_floating_to_front(state, &payload.container_id)
        }
        ArrangementCommand::SetCamera(patch) => set_camera(state, patch),
        ArrangementCommand::CreateFloatingContainerWithTab(payload) => {
            create_floating_container_with_tab(state, &payload.tab_id, payload.rect)
        }
        ArrangementCommand::CreateFloatingContainerWithSurface(payload) => {
            create_floating_container_with_surface(state, payload.tab, payload.rect)
        }
        ArrangementCommand::SplitContainerWithTab(payload) => split_container_with_tab(
            state,
            &payload.target_container_id,
            payload.dir,
            payload.position,
            &payload.tab_id,
            viewport,
        ),
        ArrangementCommand::SplitContainerWithSurface(payload) => split_container_with_surface(
            state,
            &payload.target_container_id,
            payload.dir,
            payload.position,
            payload.tab,
            viewport,
        ),
        ArrangementCommand::SwapContainers(payload) => {
            swap_containers(state, &payload.a, &payload.b)
        }
        ArrangementCommand::MoveContainerToEdge(payload) => move_container_to_edge(
            state,
            &payload.source_id,
            &payload.target_id,
            payload.dir,
            payload.position,
        ),
        ArrangementCommand::SplitAtRoot(payload) => {
            split_at_root(state, payload.dir, payload.position, payload.initial_tab)
        }
        ArrangementCommand::SplitRootWithTab(payload) => {
            split_root_with_tab(state, payload.dir, payload.position, &payload.tab_id)
        }
        ArrangementCommand::SplitRootWithSurface(payload) => {
            split_root_with_surface(state, payload.dir, payload.position, payload.tab)
        }
        ArrangementCommand::MoveContainerToRoot(payload) => {
            move_container_to_root(state, &payload.container_id, payload.dir, payload.position)
        }
        ArrangementCommand::ToggleMaximize(payload) => toggle_maximize(state, payload.container_id),
        ArrangementCommand::SetSurface(payload) => {
            set_surface(state, payload.surface, payload.base_geometry, viewport)
        }
        ArrangementCommand::SetActiveLayer(payload) => set_active_layer(state, &payload.layer_id),
        ArrangementCommand::MoveContainerToLayer(payload) => {
            move_container_to_layer(
                state,
                &payload.container_id,
                &payload.layer_id,
                payload.placement.as_deref(),
                payload.position,
                viewport,
            )
        }
        ArrangementCommand::CreateLayer(payload) => create_layer(state, payload.name),
        ArrangementCommand::ReorderLayers(payload) => reorder_layers(state, &payload.layer_ids),
        ArrangementCommand::ArrangeSurfaces(payload) => arrange_surfaces(state, payload, viewport),
        ArrangementCommand::ApplySequence(payload) => {
            payload.operations.into_iter().fold(state, |acc, op| {
                apply_command(normalize_state(acc), op, viewport)
            })
        }
    };
    sync_active_layer(&mut state);
    state
}

fn normalize_state(mut state: LayoutState) -> LayoutState {
    if state.containers.is_empty() {
        let defaults = LayoutState::default();
        state.containers = defaults.containers;
        state.tab_groups = defaults.tab_groups;
        state.tabs = defaults.tabs;
        state.layouts = defaults.layouts;
        state.focused_container_id = defaults.focused_container_id;
        state.maximized_container_id = defaults.maximized_container_id;
    }
    normalize_layers(&mut state);
    ensure_layouts(&mut state);
    normalize_tab_graph(&mut state);
    normalize_layout_references(&mut state);
    sync_active_layer(&mut state);
    normalize_focus(&mut state);
    state
}

fn normalize_layers(state: &mut LayoutState) {
    if state.layers.is_empty() {
        state.layers.push(ArrangementLayer {
            id: "default".to_string(),
            name: None,
            z: 0,
            surface: state.surface.clone(),
            layouts: state.layouts.clone(),
        });
    }
    let selected = state
        .active_layer_id
        .as_ref()
        .filter(|id| state.layers.iter().any(|layer| &layer.id == *id))
        .cloned()
        .unwrap_or_else(|| state.layers[0].id.clone());
    state.active_layer_id = Some(selected.clone());
    // The legacy top-level array is the active-layer projection and remains
    // the compatibility input for existing callers that only edit `layouts`.
    if let Some(active) = state.layers.iter_mut().find(|layer| layer.id == selected) {
        active.layouts = state.layouts.clone();
        active.surface = state.surface.clone();
    }
    for layer in &mut state.layers {
        if layer.layouts.is_empty() {
            layer.layouts = state.layouts.clone();
        }
    }
}

fn sync_active_layer(state: &mut LayoutState) {
    if let Some(layer) = state
        .layers
        .iter_mut()
        .find(|layer| Some(layer.id.as_str()) == state.active_layer_id.as_deref())
    {
        layer.layouts = state.layouts.clone();
        layer.surface = state.surface.clone();
    }
}

fn ensure_layouts(state: &mut LayoutState) {
    ensure_layout_vec(&mut state.layouts);
    for layer in &mut state.layers {
        ensure_layout_vec(&mut layer.layouts);
    }
}

fn ensure_layout_vec(layouts: &mut Vec<LayoutSurface>) {
    if !layouts
        .iter()
        .any(|layout| matches!(layout, LayoutSurface::Tiled { .. }))
    {
        layouts.push(LayoutSurface::tiled(None));
    }
    if !layouts
        .iter()
        .any(|layout| matches!(layout, LayoutSurface::Floating { .. }))
    {
        layouts.push(LayoutSurface::floating(Vec::new(), Camera::default()));
    }
    if !layouts
        .iter()
        .any(|layout| matches!(layout, LayoutSurface::Overlay { .. }))
    {
        layouts.push(LayoutSurface::overlay(Vec::new()));
    }
}

fn normalize_tab_graph(state: &mut LayoutState) {
    let used_group_ids: BTreeSet<String> = state
        .containers
        .values()
        .map(|container| container.group_id.clone())
        .collect();

    for group_id in &used_group_ids {
        state
            .tab_groups
            .entry(group_id.clone())
            .or_insert(TabGroup {
                tab_ids: Vec::new(),
                active_tab_id: None,
            });
    }

    let mut assigned_tab_ids = BTreeSet::new();
    let group_ids: Vec<String> = state.tab_groups.keys().cloned().collect();
    for group_id in group_ids {
        if !used_group_ids.contains(&group_id) {
            continue;
        }
        if let Some(group) = state.tab_groups.get_mut(&group_id) {
            group.tab_ids.retain(|tab_id| {
                state.tabs.contains_key(tab_id) && assigned_tab_ids.insert(tab_id.clone())
            });
            if !group.active_tab_id.as_ref().is_some_and(|active_tab_id| {
                group.tab_ids.iter().any(|tab_id| tab_id == active_tab_id)
            }) {
                group.active_tab_id = group.tab_ids.first().cloned();
            }
        }
    }

    state
        .tab_groups
        .retain(|group_id, _group| used_group_ids.contains(group_id));
    state
        .tabs
        .retain(|tab_id, _tab| assigned_tab_ids.contains(tab_id));
}

fn normalize_split_tree(
    node: Option<SplitTreeNode>,
    valid_container_ids: &BTreeSet<String>,
) -> Option<SplitTreeNode> {
    match node? {
        SplitTreeNode::Leaf { container_id } => valid_container_ids
            .contains(&container_id)
            .then_some(SplitTreeNode::Leaf { container_id }),
        SplitTreeNode::Split {
            dir,
            sizes,
            size_unit,
            cross_sizes,
            keep_lengths,
            stack_below,
            children,
        } => {
            // A child that goes takes its own lengths with it.
            let (children, kept): (Vec<SplitTreeNode>, Vec<(f64, Option<f64>)>) = children
                .into_iter()
                .enumerate()
                .filter_map(|(index, child)| {
                    normalize_split_tree(Some(child), valid_container_ids).map(|child| {
                        (child, (sizes.get(index).copied().unwrap_or(0.0), cross_sizes.get(index).copied().flatten()))
                    })
                })
                .unzip();
            let (sizes, cross): (Vec<f64>, Vec<Option<f64>>) = kept.into_iter().unzip();
            match children.len() {
                0 => None,
                1 => children.into_iter().next(),
                count => {
                    // A pixel size of 0 is a pane drawn at its content's height; a share is never 0.
                    let pixels = !size_unit.is_share();
                    let fallback_size = if pixels { 0.0 } else { 1.0 / count as f64 };
                    let normalized_sizes = (0..count)
                        .map(|index| {
                            sizes
                                .get(index)
                                .copied()
                                .filter(|size| size.is_finite() && (*size > 0.0 || (pixels && *size == 0.0)))
                                .unwrap_or(fallback_size)
                        })
                        .collect();
                    let cross_sizes = if cross.iter().all(Option::is_none) {
                        Vec::new()
                    } else {
                        cross.into_iter().map(|length| length.filter(|px| px.is_finite() && *px > 0.0)).collect()
                    };
                    Some(SplitTreeNode::Split {
                        dir,
                        sizes: normalized_sizes,
                        size_unit,
                        cross_sizes,
                        keep_lengths,
                        stack_below,
                        children,
                    })
                }
            }
        }
    }
}

fn normalize_layout_references(state: &mut LayoutState) {
    let valid_container_ids: BTreeSet<String> = state.containers.keys().cloned().collect();
    for layout in state
        .layers
        .iter_mut()
        .flat_map(|layer| layer.layouts.iter_mut())
    {
        match layout {
            LayoutSurface::Tiled { root, .. } => {
                *root = normalize_split_tree(root.take(), &valid_container_ids);
            }
            LayoutSurface::Floating { containers, .. } => {
                containers.retain(|entry| valid_container_ids.contains(&entry.container_id));
            }
            LayoutSurface::Overlay { containers } => {
                containers.retain(|entry| valid_container_ids.contains(&entry.container_id));
            }
        }
    }
    if let Some(layer) = state
        .layers
        .iter()
        .find(|layer| Some(layer.id.as_str()) == state.active_layer_id.as_deref())
    {
        state.layouts = layer.layouts.clone();
    }
}

fn set_active_layer(mut state: LayoutState, layer_id: &str) -> LayoutState {
    if let Some(layer) = state.layers.iter().find(|layer| layer.id == layer_id) {
        state.active_layer_id = Some(layer_id.to_string());
        state.layouts = layer.layouts.clone();
        state.surface = layer.surface.clone();
    }
    state
}

/// Top-left of a `w`×`h` box centred on `point`, clamped fully inside the viewport.
fn centred_inside(point: &Point, w: f64, h: f64, viewport: &Viewport) -> (f64, f64) {
    (
        (point.x - w / 2.0).clamp(0.0, (viewport.w - w).max(0.0)),
        (point.y - h / 2.0).clamp(0.0, (viewport.h - h).max(0.0)),
    )
}

fn layer_holds_container(layer: &ArrangementLayer, container_id: &str) -> bool {
    layer.layouts.iter().any(|layout| match layout {
        LayoutSurface::Tiled { root, .. } => root.as_ref().is_some_and(|node| tree_holds(node, container_id)),
        LayoutSurface::Floating { containers, .. } => containers.iter().any(|entry| entry.container_id == container_id),
        LayoutSurface::Overlay { containers } => containers.iter().any(|entry| entry.container_id == container_id),
    })
}

fn tree_holds(node: &SplitTreeNode, container_id: &str) -> bool {
    match node {
        SplitTreeNode::Leaf { container_id: id } => id == container_id,
        SplitTreeNode::Split { children, .. } => children.iter().any(|child| tree_holds(child, container_id)),
    }
}

fn reorder_layers(mut state: LayoutState, layer_ids: &[String]) -> LayoutState {
    let mut seen = std::collections::HashSet::new();
    let complete = layer_ids.len() == state.layers.len()
        && layer_ids.iter().all(|id| seen.insert(id.as_str()))
        && state.layers.iter().all(|layer| seen.contains(layer.id.as_str()));
    if !complete {
        return state;
    }
    for layer in &mut state.layers {
        if let Some(index) = layer_ids.iter().position(|id| *id == layer.id) {
            layer.z = index as i32;
        }
    }
    state.layers.sort_by_key(|layer| layer.z);
    state
}

fn create_layer(mut state: LayoutState, name: Option<String>) -> LayoutState {
    let layer_id = uid("layer");
    let z = state.layers.iter().map(|layer| layer.z).max().unwrap_or(-1) + 1;
    state.layers.push(ArrangementLayer {
        id: layer_id.clone(),
        name: name.filter(|value| !value.trim().is_empty()),
        z,
        surface: state.surface.clone(),
        layouts: vec![
            LayoutSurface::tiled(None),
            LayoutSurface::floating(Vec::new(), Camera::default()),
            LayoutSurface::overlay(Vec::new()),
        ],
    });
    state.active_layer_id = Some(layer_id);
    state.layouts = state.layers.last().map(|layer| layer.layouts.clone()).unwrap_or_default();
    state.focused_container_id = None;
    state
}

fn move_container_to_layer(
    mut state: LayoutState,
    container_id: &str,
    layer_id: &str,
    placement: Option<&str>,
    position: Option<Point>,
    viewport: Viewport,
) -> LayoutState {
    let placement = placement.unwrap_or("grid");
    if !matches!(placement, "grid" | "canvas" | "overlay")
        || !state.containers.contains_key(container_id)
        || !state.layers.iter().any(|layer| layer.id == layer_id)
    {
        return state;
    }
    // The source is the layer that HOLDS the container, not the layer receiving
    // edits: after a new layer is created it is active while the pane still
    // lives on the layer below.
    let source_id = state
        .layers
        .iter()
        .find(|layer| layer_holds_container(layer, container_id))
        .map(|layer| layer.id.clone())
        .or_else(|| state.active_layer_id.clone())
        .unwrap_or_default();
    if source_id == layer_id {
        return state;
    }
    // A layer has one base geometry. Fail closed when moving a tile into a
    // canvas that already contains floating peers (or vice versa), so no
    // source placement can be lost while the destination is hidden.
    let Some(destination_before) = state.layers.iter().find(|layer| layer.id == layer_id) else {
        return state;
    };
    let has_tiled_peers = destination_before.layouts.iter().any(|layout| {
        matches!(layout, LayoutSurface::Tiled { root: Some(_), .. })
    });
    let has_floating_peers = destination_before.layouts.iter().any(|layout| {
        matches!(layout, LayoutSurface::Floating { containers, .. } if !containers.is_empty())
    });
    if (placement == "grid" && has_floating_peers)
        || (placement == "canvas" && has_tiled_peers)
    {
        return state;
    }

    // Remove from every layer only after destination and placement have been
    // validated, then place exactly once in the requested geometry.
    for layer in &mut state.layers {
        for layout in &mut layer.layouts {
            match layout {
                LayoutSurface::Tiled { root, .. } => *root = remove_from_tree(root.take(), container_id),
                LayoutSurface::Floating { containers, .. } => {
                    containers.retain(|entry| entry.container_id != container_id)
                }
                LayoutSurface::Overlay { containers } => {
                    containers.retain(|entry| entry.container_id != container_id)
                }
            }
        }
    }

    let Some(destination) = state.layers.iter_mut().find(|layer| layer.id == layer_id) else {
        return state;
    };
    if placement == "grid" {
        destination.surface = "grid".to_string();
    } else if placement == "canvas" {
        destination.surface = "canvas".to_string();
    }
    match placement {
        "grid" => {
            if let Some(LayoutSurface::Tiled { root, .. }) = destination
                .layouts
                .iter_mut()
                .find(|layout| matches!(layout, LayoutSurface::Tiled { .. }))
            {
                let leaf = SplitTreeNode::Leaf { container_id: container_id.to_string() };
                let (dir, before) = position.as_ref().map(|point| {
                    if (point.y / viewport.h.max(1.0) - 0.5).abs() > (point.x / viewport.w.max(1.0) - 0.5).abs() {
                        (SplitDir::Column, point.y < viewport.h / 2.0)
                    } else {
                        (SplitDir::Row, point.x < viewport.w / 2.0)
                    }
                }).unwrap_or((SplitDir::Row, false));
                *root = Some(match root.take() {
                    Some(existing) => even_split(dir, if before { vec![leaf, existing] } else { vec![existing, leaf] }),
                    None => leaf,
                });
            }
        }
        "canvas" => {
            if let Some(LayoutSurface::Floating { containers, .. }) = destination
                .layouts
                .iter_mut()
                .find(|layout| matches!(layout, LayoutSurface::Floating { .. }))
            {
                let w = (viewport.w - 48.0).clamp(240.0, 420.0);
                let h = (viewport.h - 48.0).clamp(180.0, 340.0);
                let (x, y) = position
                    .as_ref()
                    .map(|point| centred_inside(point, w, h, &viewport))
                    .unwrap_or((24.0, 24.0));
                let rect = Rect { x, y, w, h };
                let z = max_freeform_z(containers) + 1;
                containers.push(window_from_rect(container_id.to_string(), rect, z));
            }
        }
        "overlay" => {
            if let Some(LayoutSurface::Overlay { containers }) = destination
                .layouts
                .iter_mut()
                .find(|layout| matches!(layout, LayoutSurface::Overlay { .. }))
            {
                let z = max_overlay_z(containers) + 1;
                let mut box_ = default_overlay_box(container_id.to_string(), viewport, z);
                if let Some(position) = position.as_ref() {
                    (box_.x, box_.y) = centred_inside(position, box_.w, box_.h, &viewport);
                }
                containers.push(box_);
            }
        }
        _ => unreachable!(),
    }

    {
        if let Some(active) = state
            .layers
            .iter()
            .find(|layer| Some(layer.id.as_str()) == state.active_layer_id.as_deref())
        {
            state.layouts = active.layouts.clone();
        }
    }
    state.focused_container_id = Some(container_id.to_string());
    state
}

fn normalize_focus(state: &mut LayoutState) {
    let first_container_id = state.containers.keys().next().cloned();
    if !state
        .focused_container_id
        .as_ref()
        .is_some_and(|container_id| state.containers.contains_key(container_id))
    {
        state.focused_container_id = first_container_id;
    }
    if !state
        .maximized_container_id
        .as_ref()
        .is_some_and(|container_id| state.containers.contains_key(container_id))
    {
        state.maximized_container_id = None;
    }
}

fn uid(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

fn default_tab() -> TabMeta {
    TabMeta {
        id: uid("tab"),
        title: "Empty tab".to_string(),
        target: None,
        material_target: None,
        icon: None,
        pinned: None,
        closable: None,
        metadata: None,
        extra: BTreeMap::new(),
    }
}

fn add_tab(mut state: LayoutState, container_id: String, tab: TabMeta, focus: bool) -> LayoutState {
    let tab_id = tab.id.clone();
    let Some(group_id) = state
        .containers
        .get(&container_id)
        .map(|entry| entry.group_id.clone())
    else {
        return state;
    };
    if state.tabs.contains_key(&tab_id) {
        remove_tab_id_from_groups(&mut state, &tab_id);
    }
    let Some(group) = state.tab_groups.get_mut(&group_id) else {
        return state;
    };
    group.tab_ids.push(tab_id.clone());
    group.active_tab_id = Some(tab_id.clone());
    state.tabs.insert(tab_id, tab);
    if focus {
        state.focused_container_id = Some(container_id);
    }
    state
}

fn remove_tab_id_from_groups(state: &mut LayoutState, tab_id: &str) {
    for group in state.tab_groups.values_mut() {
        let previous_len = group.tab_ids.len();
        group.tab_ids.retain(|id| id != tab_id);
        if group.tab_ids.len() != previous_len && group.active_tab_id.as_deref() == Some(tab_id) {
            group.active_tab_id = group.tab_ids.last().cloned();
        }
    }
}

fn close_tab(mut state: LayoutState, tab_id: &str) -> LayoutState {
    let Some(container_id) = find_container_for_tab(&state, tab_id) else {
        return state;
    };
    let Some(group_id) = state
        .containers
        .get(&container_id)
        .map(|container| container.group_id.clone())
    else {
        return state;
    };
    let mut close_empty_container = false;
    if let Some(group) = state.tab_groups.get_mut(&group_id) {
        group.tab_ids.retain(|id| id != tab_id);
        if group.active_tab_id.as_deref() == Some(tab_id) {
            group.active_tab_id = group.tab_ids.last().cloned();
        }
        close_empty_container = group.tab_ids.is_empty();
    }
    state.tabs.remove(tab_id);

    if close_empty_container && state.containers.len() > 1 {
        close_container(state, &container_id)
    } else {
        state
    }
}

fn activate_tab(mut state: LayoutState, tab_id: &str) -> LayoutState {
    let Some(container_id) = find_container_for_tab(&state, tab_id) else {
        return state;
    };
    let group_id = state.containers[&container_id].group_id.clone();
    if let Some(group) = state.tab_groups.get_mut(&group_id) {
        group.active_tab_id = Some(tab_id.to_string());
    }
    state.focused_container_id = Some(container_id);
    state
}

fn update_tab_meta(
    mut state: LayoutState,
    tab_id: &str,
    patch: serde_json::Map<String, Value>,
) -> LayoutState {
    let Some(tab) = state.tabs.get_mut(tab_id) else {
        return state;
    };
    for (key, value) in patch {
        match key.as_str() {
            "title" => {
                if let Some(next) = value.as_str() {
                    tab.title = next.to_string();
                }
            }
            "target" => {
                tab.target = value.as_str().map(ToString::to_string);
            }
            "materialTarget" => {
                tab.material_target = value.as_str().map(ToString::to_string);
            }
            "icon" => {
                tab.icon = value.as_str().map(ToString::to_string);
            }
            "pinned" => {
                tab.pinned = value.as_bool();
            }
            "closable" => {
                tab.closable = value.as_bool();
            }
            "metadata" => {
                tab.metadata = value
                    .as_object()
                    .cloned()
                    .map(|object| object.into_iter().collect());
            }
            _ if value.is_null() => {
                tab.extra.remove(&key);
            }
            _ => {
                tab.extra.insert(key, value);
            }
        }
    }
    state
}

fn move_tab_to_container(
    mut state: LayoutState,
    tab_id: &str,
    target_container_id: &str,
    index: Option<usize>,
) -> LayoutState {
    let Some(source_container_id) = find_container_for_tab(&state, tab_id) else {
        return state;
    };
    if !state.containers.contains_key(target_container_id) {
        return state;
    }

    let source_group_id = state.containers[&source_container_id].group_id.clone();
    let target_group_id = state.containers[target_container_id].group_id.clone();

    // Same tab strip → reposition the tab within its own group (within-strip
    // drag-to-reorder). `index` is the visual insertion slot among the CURRENT
    // tab ids (including the dragged one); we remove the dragged tab, then shift
    // the target left by one when it sat after the dragged tab's old slot, so
    // the dropped tab lands exactly where the pointer indicated.
    if source_group_id == target_group_id {
        if let Some(group) = state.tab_groups.get_mut(&source_group_id) {
            let Some(from) = group.tab_ids.iter().position(|id| id == tab_id) else {
                return state;
            };
            let mut target_index = index.unwrap_or(group.tab_ids.len());
            if from < target_index {
                target_index -= 1;
            }
            group.tab_ids.remove(from);
            let insert_index = target_index.min(group.tab_ids.len());
            group.tab_ids.insert(insert_index, tab_id.to_string());
            group.active_tab_id = Some(tab_id.to_string());
        }
        state.focused_container_id = Some(target_container_id.to_string());
        return state;
    }

    if let Some(source) = state.tab_groups.get_mut(&source_group_id) {
        source.tab_ids.retain(|id| id != tab_id);
        if source.active_tab_id.as_deref() == Some(tab_id) {
            source.active_tab_id = source.tab_ids.last().cloned();
        }
    }

    if let Some(target) = state.tab_groups.get_mut(&target_group_id) {
        let insert_index = index
            .unwrap_or(target.tab_ids.len())
            .min(target.tab_ids.len());
        target.tab_ids.insert(insert_index, tab_id.to_string());
        target.active_tab_id = Some(tab_id.to_string());
    }

    state.focused_container_id = Some(target_container_id.to_string());
    state
}

fn create_container(
    mut state: LayoutState,
    container_id: String,
    group_id: String,
    tab_ids: Vec<String>,
) -> LayoutState {
    if state.containers.contains_key(&container_id) || state.tab_groups.contains_key(&group_id) {
        return state;
    }
    state.containers.insert(
        container_id.clone(),
        LayoutContainer {
            id: container_id,
            group_id: group_id.clone(),
        },
    );
    state.tab_groups.insert(
        group_id,
        TabGroup {
            active_tab_id: tab_ids.first().cloned(),
            tab_ids,
        },
    );
    state
}

fn split_container(
    mut state: LayoutState,
    container_id: &str,
    dir: SplitDir,
    position: RootPosition,
    initial_tab: Option<TabMeta>,
    length: NewPaneLength,
) -> LayoutState {
    if !state.containers.contains_key(container_id) {
        return state;
    }
    let tab = initial_tab.unwrap_or_else(default_tab);
    let new_container_id = uid("container");
    let new_group_id = uid("group");
    let new_tab_id = tab.id.clone();

    state.containers.insert(
        new_container_id.clone(),
        LayoutContainer {
            id: new_container_id.clone(),
            group_id: new_group_id.clone(),
        },
    );
    state.tabs.insert(tab.id.clone(), tab);
    state.tab_groups.insert(
        new_group_id,
        TabGroup {
            tab_ids: vec![new_tab_id.clone()],
            active_tab_id: Some(new_tab_id),
        },
    );
    update_tiled_root(&mut state, |root| {
        root.map_or_else(
            || {
                Some(SplitTreeNode::Leaf {
                    container_id: new_container_id.clone(),
                })
            },
            |node| {
                Some(insert_new_pane(
                    node,
                    container_id,
                    &new_container_id,
                    dir,
                    position,
                    length,
                ))
            },
        )
    });
    state.focused_container_id = Some(new_container_id);
    state
}

fn close_container(mut state: LayoutState, container_id: &str) -> LayoutState {
    if state.containers.len() <= 1 || !state.containers.contains_key(container_id) {
        return state;
    }
    let group_id = state.containers[container_id].group_id.clone();
    if let Some(group) = state.tab_groups.get(&group_id) {
        for tab_id in &group.tab_ids {
            state.tabs.remove(tab_id);
        }
    }
    state.containers.remove(container_id);
    state.tab_groups.remove(&group_id);
    update_tiled_root(&mut state, |root| remove_from_tree(root, container_id));
    update_floating(&mut state, |containers, _camera| {
        containers.retain(|entry| entry.container_id != container_id);
    });
    update_overlay(&mut state, |containers| {
        containers.retain(|entry| entry.container_id != container_id);
    });
    if state.focused_container_id.as_deref() == Some(container_id) {
        state.focused_container_id = state.containers.keys().next().cloned();
    }
    if state.maximized_container_id.as_deref() == Some(container_id) {
        state.maximized_container_id = None;
    }
    state
}

fn toggle_overlay(mut state: LayoutState, container_id: &str, viewport: Viewport) -> LayoutState {
    if !state.containers.contains_key(container_id) {
        return state;
    }
    let in_overlay = overlay_containers(&state)
        .iter()
        .any(|entry| entry.container_id == container_id);

    if in_overlay {
        update_overlay(&mut state, |containers| {
            containers.retain(|entry| entry.container_id != container_id);
        });
        let target = container_id.to_string();
        update_tiled_root(&mut state, |root| {
            root.map_or_else(
                || {
                    Some(SplitTreeNode::Leaf {
                        container_id: target.clone(),
                    })
                },
                |node| {
                    Some(even_split(
                        SplitDir::Row,
                        vec![
                            node,
                            SplitTreeNode::Leaf {
                                container_id: target.clone(),
                            },
                        ],
                    ))
                },
            )
        });
    } else {
        update_tiled_root(&mut state, |root| remove_from_tree(root, container_id));
        update_floating(&mut state, |containers, _camera| {
            containers.retain(|entry| entry.container_id != container_id);
        });
        update_overlay(&mut state, |containers| {
            let z = max_overlay_z(containers) + 1;
            containers.push(default_overlay_box(container_id.to_string(), viewport, z));
        });
    }
    state
}

fn move_overlay(mut state: LayoutState, container_id: &str, xy: Point) -> LayoutState {
    update_overlay(&mut state, |containers| {
        for entry in containers {
            if entry.container_id == container_id {
                entry.x = xy.x;
                entry.y = xy.y;
            }
        }
    });
    state
}

fn resize_overlay(mut state: LayoutState, container_id: &str, size: Size) -> LayoutState {
    update_overlay(&mut state, |containers| {
        for entry in containers {
            if entry.container_id == container_id {
                entry.w = size.w;
                entry.h = size.h;
            }
        }
    });
    state
}

fn bring_overlay_to_front(mut state: LayoutState, container_id: &str) -> LayoutState {
    update_overlay(&mut state, |containers| {
        let z = max_overlay_z(containers) + 1;
        for entry in containers {
            if entry.container_id == container_id {
                entry.z = z;
            }
        }
    });
    state
}

fn resize_split(
    mut state: LayoutState,
    sizes: &[f64],
    path: &[usize],
    size_unit: SplitSizeUnit,
) -> LayoutState {
    update_tiled_root(&mut state, |root| {
        root.map(|node| update_sizes_at_path(node, path, sizes, size_unit))
    });
    state
}

fn move_floating(mut state: LayoutState, container_id: &str, xy: Point) -> LayoutState {
    update_floating(&mut state, |containers, _camera| {
        for entry in containers {
            if entry.container_id == container_id {
                entry.x = xy.x;
                entry.y = xy.y;
            }
        }
    });
    state
}

fn resize_floating(mut state: LayoutState, container_id: &str, size: Size) -> LayoutState {
    update_floating(&mut state, |containers, _camera| {
        for entry in containers {
            if entry.container_id == container_id {
                entry.w = size.w;
                entry.h = size.h;
            }
        }
    });
    state
}

fn update_floating_rect(mut state: LayoutState, container_id: &str, rect: Rect) -> LayoutState {
    update_floating(&mut state, |containers, _camera| {
        for entry in containers {
            if entry.container_id == container_id {
                entry.x = rect.x;
                entry.y = rect.y;
                entry.w = rect.w;
                entry.h = rect.h;
            }
        }
    });
    state
}

fn bring_floating_to_front(mut state: LayoutState, container_id: &str) -> LayoutState {
    update_floating(&mut state, |containers, _camera| {
        let z = max_freeform_z(containers) + 1;
        for entry in containers {
            if entry.container_id == container_id {
                entry.z = z;
            }
        }
    });
    state
}

fn set_camera(mut state: LayoutState, patch: CameraPatch) -> LayoutState {
    update_floating(&mut state, |_containers, camera| {
        *camera = merge_camera(*camera, patch);
    });
    state
}

fn create_floating_container_with_tab(
    mut state: LayoutState,
    tab_id: &str,
    rect: Rect,
) -> LayoutState {
    let Some(source_container_id) = find_container_for_tab(&state, tab_id) else {
        return state;
    };
    let source_group_id = state.containers[&source_container_id].group_id.clone();
    let new_container_id = uid("container");
    let new_group_id = uid("group");

    let mut source_empty = false;
    if let Some(source_group) = state.tab_groups.get_mut(&source_group_id) {
        source_group.tab_ids.retain(|id| id != tab_id);
        if source_group.active_tab_id.as_deref() == Some(tab_id) {
            source_group.active_tab_id = source_group.tab_ids.last().cloned();
        }
        source_empty = source_group.tab_ids.is_empty();
    }

    state.containers.insert(
        new_container_id.clone(),
        LayoutContainer {
            id: new_container_id.clone(),
            group_id: new_group_id.clone(),
        },
    );
    state.tab_groups.insert(
        new_group_id,
        TabGroup {
            tab_ids: vec![tab_id.to_string()],
            active_tab_id: Some(tab_id.to_string()),
        },
    );
    add_floating_container(&mut state, new_container_id.clone(), rect);
    add_container_to_tiled_tree(&mut state, &new_container_id);
    state.focused_container_id = Some(new_container_id);

    if source_empty {
        close_container(state, &source_container_id)
    } else {
        state
    }
}

fn create_floating_container_with_surface(
    mut state: LayoutState,
    tab: TabMeta,
    rect: Rect,
) -> LayoutState {
    let new_container_id = uid("container");
    let new_group_id = uid("group");
    let tab_id = tab.id.clone();
    state.containers.insert(
        new_container_id.clone(),
        LayoutContainer {
            id: new_container_id.clone(),
            group_id: new_group_id.clone(),
        },
    );
    state.tabs.insert(tab_id.clone(), tab);
    state.tab_groups.insert(
        new_group_id,
        TabGroup {
            tab_ids: vec![tab_id.clone()],
            active_tab_id: Some(tab_id),
        },
    );
    add_floating_container(&mut state, new_container_id.clone(), rect);
    add_container_to_tiled_tree(&mut state, &new_container_id);
    state.focused_container_id = Some(new_container_id);
    state
}

fn split_container_with_tab(
    mut state: LayoutState,
    target_container_id: &str,
    dir: SplitDir,
    position: RootPosition,
    tab_id: &str,
    viewport: Viewport,
) -> LayoutState {
    if !state.containers.contains_key(target_container_id) {
        return state;
    }
    let Some(source_container_id) = find_container_for_tab(&state, tab_id) else {
        return state;
    };
    let source_group_id = state.containers[&source_container_id].group_id.clone();
    let new_container_id = uid("container");
    let new_group_id = uid("group");

    let mut source_empty = false;
    if let Some(source_group) = state.tab_groups.get_mut(&source_group_id) {
        source_group.tab_ids.retain(|id| id != tab_id);
        if source_group.active_tab_id.as_deref() == Some(tab_id) {
            source_group.active_tab_id = source_group.tab_ids.last().cloned();
        }
        source_empty = source_group.tab_ids.is_empty();
    }

    state.containers.insert(
        new_container_id.clone(),
        LayoutContainer {
            id: new_container_id.clone(),
            group_id: new_group_id.clone(),
        },
    );
    state.tab_groups.insert(
        new_group_id,
        TabGroup {
            tab_ids: vec![tab_id.to_string()],
            active_tab_id: Some(tab_id.to_string()),
        },
    );
    if source_empty && source_container_id == target_container_id {
        replace_container_bounds(&mut state, target_container_id, &new_container_id);
    } else {
        split_container_bounds(
            &mut state,
            target_container_id,
            &new_container_id,
            dir,
            position,
            viewport,
        );
    }
    state.focused_container_id = Some(new_container_id);

    if source_empty {
        close_container(state, &source_container_id)
    } else {
        state
    }
}

fn split_container_bounds(
    state: &mut LayoutState,
    target_container_id: &str,
    new_container_id: &str,
    dir: SplitDir,
    position: RootPosition,
    viewport: Viewport,
) {
    // PiP containers are outside the tiled tree. Split inside the target's
    // overlay bounds so the new pane remains visible and can receive focus.
    let overlay_target = overlay_containers(state)
        .into_iter()
        .find(|entry| entry.container_id == target_container_id);
    if let Some(mut target) = overlay_target {
        // Overlay coordinates are CSS pixels in the window viewport. A PiP
        // window can be moved or restored from saved state beyond an edge, so
        // fit its shared split rectangle before placing either half.
        fit_overlay_box_to_viewport(&mut target, viewport);
        let new_z = max_overlay_z(&overlay_containers(state)) + 1;
        let mut new_box = target.clone();
        new_box.container_id = new_container_id.to_string();
        new_box.z = new_z;
        match dir {
            SplitDir::Row => {
                let half = target.w / 2.0;
                target.w = half;
                new_box.w = half;
                if matches!(position, RootPosition::Before) {
                    target.x += half;
                } else {
                    new_box.x += half;
                }
            }
            SplitDir::Column => {
                let half = target.h / 2.0;
                target.h = half;
                new_box.h = half;
                if matches!(position, RootPosition::Before) {
                    target.y += half;
                } else {
                    new_box.y += half;
                }
            }
        }
        update_overlay(state, |containers| {
            if let Some(entry) = containers
                .iter_mut()
                .find(|entry| entry.container_id == target_container_id)
            {
                *entry = target;
            }
            containers.push(new_box);
        });
    } else {
        update_tiled_root(state, |root| {
            root.map_or_else(
                || {
                    Some(SplitTreeNode::Leaf {
                        container_id: new_container_id.to_string(),
                    })
                },
                |node| {
                    Some(insert_adjacent(
                        node,
                        target_container_id,
                        new_container_id,
                        dir,
                        position,
                    ))
                },
            )
        });
    }
}

fn fit_overlay_box_to_viewport(target: &mut OverlayBox, viewport: Viewport) {
    let width = viewport.w.max(0.0);
    let height = viewport.h.max(0.0);
    target.w = target.w.max(0.0).min(width);
    target.h = target.h.max(0.0).min(height);
    target.x = target.x.max(0.0).min(width - target.w);
    target.y = target.y.max(0.0).min(height - target.h);
}

fn replace_container_bounds(state: &mut LayoutState, target_container_id: &str, new_container_id: &str) {
    let new_z = max_overlay_z(&overlay_containers(state)) + 1;
    update_overlay(state, |containers| {
        if let Some(entry) = containers
            .iter_mut()
            .find(|entry| entry.container_id == target_container_id)
        {
            entry.container_id = new_container_id.to_string();
            entry.z = new_z;
        }
    });
}

fn split_container_with_surface(
    mut state: LayoutState,
    target_container_id: &str,
    dir: SplitDir,
    position: RootPosition,
    tab: TabMeta,
    viewport: Viewport,
) -> LayoutState {
    if !state.containers.contains_key(target_container_id) {
        return state;
    }
    let new_container_id = uid("container");
    let new_group_id = uid("group");
    let tab_id = tab.id.clone();
    state.containers.insert(
        new_container_id.clone(),
        LayoutContainer {
            id: new_container_id.clone(),
            group_id: new_group_id.clone(),
        },
    );
    state.tabs.insert(tab_id.clone(), tab);
    state.tab_groups.insert(
        new_group_id,
        TabGroup {
            tab_ids: vec![tab_id.clone()],
            active_tab_id: Some(tab_id),
        },
    );
    split_container_bounds(
        &mut state,
        target_container_id,
        &new_container_id,
        dir,
        position,
        viewport,
    );
    state.focused_container_id = Some(new_container_id);
    state
}

fn swap_containers(mut state: LayoutState, a: &str, b: &str) -> LayoutState {
    if !state.containers.contains_key(a) || !state.containers.contains_key(b) {
        return state;
    }
    update_tiled_root(&mut state, |root| root.map(|node| swap_in_tree(node, a, b)));
    state
}

fn move_container_to_edge(
    mut state: LayoutState,
    source_id: &str,
    target_id: &str,
    dir: SplitDir,
    position: RootPosition,
) -> LayoutState {
    if source_id == target_id
        || !state.containers.contains_key(source_id)
        || !state.containers.contains_key(target_id)
    {
        return state;
    }
    update_tiled_root(&mut state, |root| {
        let root_without = remove_from_tree(root, source_id)?;
        Some(insert_adjacent(
            root_without,
            target_id,
            source_id,
            dir,
            position,
        ))
    });
    state.focused_container_id = Some(source_id.to_string());
    state
}

fn split_at_root(
    mut state: LayoutState,
    dir: SplitDir,
    position: RootPosition,
    initial_tab: Option<TabMeta>,
) -> LayoutState {
    let Some(root) = tiled_root(&state) else {
        return state;
    };
    let tab = initial_tab.unwrap_or_else(default_tab);
    let new_container_id = uid("container");
    let new_group_id = uid("group");
    let tab_id = tab.id.clone();
    state.containers.insert(
        new_container_id.clone(),
        LayoutContainer {
            id: new_container_id.clone(),
            group_id: new_group_id.clone(),
        },
    );
    state.tabs.insert(tab_id.clone(), tab);
    state.tab_groups.insert(
        new_group_id,
        TabGroup {
            tab_ids: vec![tab_id.clone()],
            active_tab_id: Some(tab_id),
        },
    );
    set_root_split(
        &mut state,
        root,
        SplitTreeNode::Leaf {
            container_id: new_container_id.clone(),
        },
        dir,
        position,
    );
    state.focused_container_id = Some(new_container_id);
    state
}

fn split_root_with_tab(
    mut state: LayoutState,
    dir: SplitDir,
    position: RootPosition,
    tab_id: &str,
) -> LayoutState {
    let Some(root) = tiled_root(&state) else {
        return state;
    };
    let Some(source_container_id) = find_container_for_tab(&state, tab_id) else {
        return state;
    };
    let source_group_id = state.containers[&source_container_id].group_id.clone();
    let new_container_id = uid("container");
    let new_group_id = uid("group");
    let mut source_empty = false;
    if let Some(source_group) = state.tab_groups.get_mut(&source_group_id) {
        source_group.tab_ids.retain(|id| id != tab_id);
        if source_group.active_tab_id.as_deref() == Some(tab_id) {
            source_group.active_tab_id = source_group.tab_ids.last().cloned();
        }
        source_empty = source_group.tab_ids.is_empty();
    }
    state.containers.insert(
        new_container_id.clone(),
        LayoutContainer {
            id: new_container_id.clone(),
            group_id: new_group_id.clone(),
        },
    );
    state.tab_groups.insert(
        new_group_id,
        TabGroup {
            tab_ids: vec![tab_id.to_string()],
            active_tab_id: Some(tab_id.to_string()),
        },
    );
    set_root_split(
        &mut state,
        root,
        SplitTreeNode::Leaf {
            container_id: new_container_id.clone(),
        },
        dir,
        position,
    );
    state.focused_container_id = Some(new_container_id);
    if source_empty {
        close_container(state, &source_container_id)
    } else {
        state
    }
}

/// Map a coarse region to the (axis, side) of a root split. `Center` seeds the
/// root surface itself (no split); `Overlay`/`Floating` are non-tiled layers.
fn region_root_split(region: PlacementRegion) -> Option<(SplitDir, RootPosition)> {
    match region {
        PlacementRegion::Left => Some((SplitDir::Row, RootPosition::Before)),
        PlacementRegion::Right => Some((SplitDir::Row, RootPosition::After)),
        PlacementRegion::Top => Some((SplitDir::Column, RootPosition::Before)),
        PlacementRegion::Bottom => Some((SplitDir::Column, RootPosition::After)),
        PlacementRegion::Center | PlacementRegion::Overlay | PlacementRegion::Floating => None,
    }
}

/// Seed a clean tiled root holding a single surface (`tab`). Used as the base of
/// a declarative `arrangeSurfaces` build before the remaining regions split it.
fn seed_root_surface(state: &mut LayoutState, tab: TabMeta) {
    let container_id = uid("container");
    let group_id = uid("group");
    let tab_id = tab.id.clone();
    state.containers.insert(
        container_id.clone(),
        LayoutContainer {
            id: container_id.clone(),
            group_id: group_id.clone(),
        },
    );
    state.tabs.insert(tab_id.clone(), tab);
    state.tab_groups.insert(
        group_id,
        TabGroup {
            tab_ids: vec![tab_id.clone()],
            active_tab_id: Some(tab_id),
        },
    );
    update_tiled_root(state, |_| {
        Some(SplitTreeNode::Leaf {
            container_id: container_id.clone(),
        })
    });
    state.focused_container_id = Some(container_id);
}

/// Resolve a placement to a mountable tab. A fully-formed `tab` wins; otherwise
/// the slot builds a minimal id-carrying tab from `surface_id` whose only mount
/// hook is `metadata.placeable_surface_id`. The live arranger render path
/// (`tabWithCurrentSurfaceLabel`) joins that id against the live
/// `placeable-surfaces` catalog and re-points the tab to the real surface, so the
/// slot never needs to know any package/material vocabulary (L090 — self-describing
/// data, generic handler). A placement with neither field resolves to `None` and
/// is skipped.
fn placement_tab(placement: &SurfacePlacement) -> Option<TabMeta> {
    if let Some(tab) = placement.tab.clone() {
        return Some(tab);
    }
    let surface_id = placement.surface_id.as_ref()?;
    let mut metadata: BTreeMap<String, Value> = BTreeMap::new();
    metadata.insert(
        "placeable_surface_id".to_string(),
        Value::String(surface_id.clone()),
    );
    Some(TabMeta {
        id: uid(surface_id),
        // The slot knows no words for a surface; an id is never a title. The render
        // path shows the catalog's label once the surface id is matched, and the
        // empty-tab title while it is not.
        title: "Empty tab".to_string(),
        target: None,
        material_target: None,
        icon: None,
        pinned: None,
        closable: Some(true),
        metadata: Some(metadata),
        extra: BTreeMap::new(),
    })
}

/// Declarative whole-workspace layout: rebuild a valid layout from the requested
/// placements. The slot owns all id generation and tree shaping; the caller only
/// says what goes where. Tiled placements seed/split the tiled root (Center first,
/// then Left/Right/Top/Bottom); Floating/Overlay become non-tiled layers.
fn arrange_surfaces(
    _state: LayoutState,
    payload: ArrangeSurfacesPayload,
    viewport: Viewport,
) -> LayoutState {
    // Fresh canvas — a declarative arrange replaces the whole layout.
    let mut state = LayoutState::default();
    state.containers.clear();
    state.tabs.clear();
    state.tab_groups.clear();
    ensure_layouts(&mut state);
    update_tiled_root(&mut state, |_| None);

    // Tiled regions, Center first so it becomes the root surface.
    let tiled: Vec<&SurfacePlacement> = payload
        .placements
        .iter()
        .filter(|p| region_root_split(p.region).is_some() || p.region == PlacementRegion::Center)
        .collect();
    let mut ordered: Vec<&SurfacePlacement> = Vec::new();
    ordered.extend(
        tiled
            .iter()
            .filter(|p| p.region == PlacementRegion::Center)
            .copied(),
    );
    ordered.extend(
        tiled
            .iter()
            .filter(|p| p.region != PlacementRegion::Center)
            .copied(),
    );

    let mut seeded = false;
    for placement in ordered {
        let Some(tab) = placement_tab(placement) else {
            continue;
        };
        if !seeded {
            seed_root_surface(&mut state, tab);
            seeded = true;
        } else if let Some((dir, position)) = region_root_split(placement.region) {
            state = split_root_with_surface(state, dir, position, tab);
        } else if let Some(container_id) = state.focused_container_id.clone() {
            // Extra Center surface → add as a tab to the focused container.
            state = add_tab(state, container_id, tab, true);
        }
    }

    // Non-tiled layers.
    for placement in payload.placements.iter().filter(|p| {
        matches!(
            p.region,
            PlacementRegion::Floating | PlacementRegion::Overlay
        )
    }) {
        let Some(tab) = placement_tab(placement) else {
            continue;
        };
        let rect = Rect {
            x: viewport.w * 0.25,
            y: viewport.h * 0.25,
            w: (viewport.w * 0.5).max(320.0),
            h: (viewport.h * 0.5).max(240.0),
        };
        state = create_floating_container_with_surface(state, tab, rect);
        if placement.region == PlacementRegion::Overlay {
            if let Some(container_id) = state.focused_container_id.clone() {
                state = toggle_overlay(state, &container_id, viewport);
            }
        }
    }

    if let Some(focus_tab) = payload.focus_tab_id.as_deref() {
        if let Some(container_id) = find_container_for_tab(&state, focus_tab) {
            state.focused_container_id = Some(container_id);
        }
    }

    normalize_state(state)
}

fn split_root_with_surface(
    mut state: LayoutState,
    dir: SplitDir,
    position: RootPosition,
    tab: TabMeta,
) -> LayoutState {
    let Some(root) = tiled_root(&state) else {
        return state;
    };
    let new_container_id = uid("container");
    let new_group_id = uid("group");
    let tab_id = tab.id.clone();
    state.containers.insert(
        new_container_id.clone(),
        LayoutContainer {
            id: new_container_id.clone(),
            group_id: new_group_id.clone(),
        },
    );
    state.tabs.insert(tab_id.clone(), tab);
    state.tab_groups.insert(
        new_group_id,
        TabGroup {
            tab_ids: vec![tab_id.clone()],
            active_tab_id: Some(tab_id),
        },
    );
    set_root_split(
        &mut state,
        root,
        SplitTreeNode::Leaf {
            container_id: new_container_id.clone(),
        },
        dir,
        position,
    );
    state.focused_container_id = Some(new_container_id);
    state
}

fn move_container_to_root(
    mut state: LayoutState,
    container_id: &str,
    dir: SplitDir,
    position: RootPosition,
) -> LayoutState {
    if !state.containers.contains_key(container_id) {
        return state;
    }
    let Some(root_without) = remove_from_tree(tiled_root(&state), container_id) else {
        return state;
    };
    set_root_split(
        &mut state,
        root_without,
        SplitTreeNode::Leaf {
            container_id: container_id.to_string(),
        },
        dir,
        position,
    );
    state.focused_container_id = Some(container_id.to_string());
    state
}

/// Activate a base mode. The slot reconciles purely on the self-described closed
/// [`BaseSurfaceGeometry`] — it NEVER inspects the open `surface` label, so a new
/// mode ("stage", …) that reuses an existing geometry needs zero slot code. The
/// reconcile is idempotent (it runs even when the label is unchanged), which also
/// repairs malformed/old states that arrived without geometry seeding.
fn set_surface(
    mut state: LayoutState,
    surface: SurfaceLabel,
    base_geometry: BaseSurfaceGeometry,
    viewport: Viewport,
) -> LayoutState {
    match base_geometry {
        // Tiled is the structural canonical layout — always populated, no seeding.
        BaseSurfaceGeometry::Tiled => {}
        // Coordinate-based geometry needs every active container placed.
        BaseSurfaceGeometry::Floating => ensure_floating_populated_from_tiled(&mut state, viewport),
    }
    state.surface = surface;
    state.maximized_container_id = None;
    state
}

/// Seed the floating layout with grid-arranged positions for every tiled
/// container that lacks a placement, and prune stale floats. A property of the
/// floating geometry (it requires explicit coordinates), not of any mode name.
fn ensure_floating_populated_from_tiled(state: &mut LayoutState, viewport: Viewport) {
    let tiled_ids = collect_leaf_ids(tiled_root(state).as_ref());
    let existing_ids: std::collections::BTreeSet<String> = floating_containers(state)
        .iter()
        .map(|entry| entry.container_id.clone())
        .collect();
    let new_ids: Vec<String> = tiled_ids
        .iter()
        .filter(|id| !existing_ids.contains(*id))
        .cloned()
        .collect();
    let tiled_set: std::collections::BTreeSet<String> = tiled_ids.into_iter().collect();
    update_floating(state, |containers, camera| {
        let existing_count = containers.len();
        containers.extend(auto_arrange_grid(&new_ids, viewport, existing_count));
        containers.retain(|entry| tiled_set.contains(&entry.container_id));
        if camera.scale == 0.0 {
            *camera = Camera::default();
        }
    });
}

fn find_container_for_tab(state: &LayoutState, tab_id: &str) -> Option<String> {
    state
        .containers
        .iter()
        .find_map(|(container_id, container)| {
            state.tab_groups.get(&container.group_id).and_then(|group| {
                group
                    .tab_ids
                    .iter()
                    .any(|id| id == tab_id)
                    .then(|| container_id.clone())
            })
        })
}

fn tiled_root(state: &LayoutState) -> Option<SplitTreeNode> {
    state.layouts.iter().find_map(|layout| {
        if let LayoutSurface::Tiled { root, .. } = layout {
            root.clone()
        } else {
            None
        }
    })
}

fn update_tiled_root(
    state: &mut LayoutState,
    update: impl FnOnce(Option<SplitTreeNode>) -> Option<SplitTreeNode>,
) {
    let mut update = Some(update);
    for layout in &mut state.layouts {
        if let LayoutSurface::Tiled { root, .. } = layout {
            let current = root.take();
            *root = update.take().expect("update called once")(current);
            return;
        }
    }
}

fn set_root_split(
    state: &mut LayoutState,
    existing: SplitTreeNode,
    new_leaf: SplitTreeNode,
    dir: SplitDir,
    position: RootPosition,
) {
    let children = match position {
        RootPosition::After => vec![existing, new_leaf],
        RootPosition::Before => vec![new_leaf, existing],
    };
    update_tiled_root(state, |_| Some(even_split(dir, children)));
}

fn floating_containers(state: &LayoutState) -> Vec<FreeformWindow> {
    state
        .layouts
        .iter()
        .find_map(|layout| {
            if let LayoutSurface::Floating { containers, .. } = layout {
                Some(containers.clone())
            } else {
                None
            }
        })
        .unwrap_or_default()
}

fn overlay_containers(state: &LayoutState) -> Vec<OverlayBox> {
    state
        .layouts
        .iter()
        .find_map(|layout| {
            if let LayoutSurface::Overlay { containers } = layout {
                Some(containers.clone())
            } else {
                None
            }
        })
        .unwrap_or_default()
}

fn update_floating(
    state: &mut LayoutState,
    update: impl FnOnce(&mut Vec<FreeformWindow>, &mut Camera),
) {
    let mut update = Some(update);
    for layout in &mut state.layouts {
        if let LayoutSurface::Floating { containers, camera } = layout {
            update.take().expect("update called once")(containers, camera);
            return;
        }
    }
}

fn update_overlay(state: &mut LayoutState, update: impl FnOnce(&mut Vec<OverlayBox>)) {
    let mut update = Some(update);
    for layout in &mut state.layouts {
        if let LayoutSurface::Overlay { containers } = layout {
            update.take().expect("update called once")(containers);
            return;
        }
    }
}

fn add_floating_container(state: &mut LayoutState, container_id: String, rect: Rect) {
    update_floating(state, |containers, _camera| {
        let z = max_freeform_z(containers) + 1;
        containers.push(window_from_rect(container_id, rect, z));
    });
}

fn add_container_to_tiled_tree(state: &mut LayoutState, container_id: &str) {
    let anchor = state
        .containers
        .keys()
        .find(|id| id.as_str() != container_id)
        .cloned();
    update_tiled_root(state, |root| {
        let Some(root) = root else {
            return Some(SplitTreeNode::Leaf {
                container_id: container_id.to_string(),
            });
        };
        if let Some(anchor) = anchor {
            Some(insert_adjacent(
                root,
                &anchor,
                container_id,
                SplitDir::Row,
                RootPosition::After,
            ))
        } else {
            Some(root)
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> LayoutState {
        LayoutState::default()
    }

    #[test]
    fn presentation_constraints_keep_one_focused_screen_and_leave_the_source_copy_intact() {
        let mut initial = state();
        initial.containers.insert("second".into(), LayoutContainer { id: "second".into(), group_id: "second-group".into() });
        initial.tab_groups.insert("second-group".into(), TabGroup { tab_ids: vec!["second-tab".into()], active_tab_id: Some("second-tab".into()) });
        initial.tabs.insert("second-tab".into(), tab("second-tab"));
        initial.layouts[0] = LayoutSurface::tiled(Some(even_split(SplitDir::Row, vec![
            SplitTreeNode::Leaf { container_id: "main".into() },
            SplitTreeNode::Leaf { container_id: "second".into() },
        ])));
        initial.focused_container_id = Some("second".into());
        initial.maximized_container_id = Some("second".into());
        initial.layers.push(ArrangementLayer {
            id: "workbench".into(), name: Some("Workbench".into()), z: 2, surface: "grid".into(),
            layouts: vec![LayoutSurface::Overlay { containers: vec![default_overlay_box("second".into(), Viewport::default(), 1)] }],
        });
        let source = initial.clone();

        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: initial.clone(),
            viewport: None,
            constraints: Some(ArrangementConstraints { max_containers: Some(1), max_tabs: Some(1), allowed_surfaces: Some(vec!["tiled".into()]) }),
            command: ArrangementCommand::Constrain,
        });

        assert_eq!(initial, source, "policy projection does not mutate its source");
        assert_eq!(reply.state.containers.len(), 1);
        assert!(reply.state.containers.contains_key("second"));
        assert_eq!(reply.state.tabs.len(), 1);
        assert!(reply.state.tabs.contains_key("second-tab"));
        assert_eq!(reply.state.focused_container_id.as_deref(), Some("second"));
        assert_eq!(reply.state.maximized_container_id.as_deref(), Some("second"));
        assert!(reply.state.layers.iter().any(|layer| layer.id == "workbench"));
        assert!(!reply.state.layers.iter().find(|layer| layer.id == "workbench").unwrap().layouts.iter().any(|layout| matches!(layout, LayoutSurface::Overlay { containers } if !containers.is_empty())));
        let root = tiled_root(&reply.state);
        assert_eq!(collect_leaf_ids(root.as_ref()), vec!["second"]);
        assert!(!overlay_containers(&reply.state).iter().any(|row| row.container_id == "second"));
        assert!(!floating_containers(&reply.state).iter().any(|row| row.container_id == "second"));
    }

    #[test]
    fn constrained_actions_replace_the_current_screen_without_growing_structure() {
        let cases = [
            serde_json::json!({"operation":"addSurfaceTab", "payload":{"containerId":"main", "tab":tab("next-screen")}}),
            serde_json::json!({"operation":"splitContainerWithSurface", "payload":{"targetContainerId":"main", "dir":"row", "tab":tab("next-screen")}}),
            serde_json::json!({"operation":"toggleOverlay", "payload":{"containerId":"main"}}),
            serde_json::json!({"operation":"setSurface", "payload":{"surface":"canvas", "baseGeometry":"floating"}}),
            serde_json::json!({"operation":"applySequence", "payload":{"operations":[
                {"operation":"addSurfaceTab", "payload":{"containerId":"main", "tab":tab("next-screen")}},
                {"operation":"toggleOverlay", "payload":{"containerId":"main"}}
            ]}}),
        ];
        for mut request in cases {
            request["state"] = serde_json::to_value(state()).unwrap();
            request["constraints"] = serde_json::json!({"max_containers":1,"max_tabs":1,"allowed_surfaces":["tiled"]});
            let bytes = arrange_screen_bytes(&serde_json::to_vec(&request).unwrap()).unwrap();
            let reply: Value = serde_json::from_slice(&bytes).unwrap();
            let state: LayoutState = serde_json::from_value(reply["state"].clone()).unwrap();
            assert_eq!(state.containers.len(), 1, "{request}");
            assert_eq!(state.tabs.len(), 1, "{request}");
            assert_eq!(collect_leaf_ids(tiled_root(&state).as_ref()).len(), 1, "{request}");
            assert!(floating_containers(&state).is_empty(), "{request}");
            assert!(overlay_containers(&state).is_empty(), "{request}");
            if matches!(request["operation"].as_str(), Some("addSurfaceTab" | "applySequence")) {
                assert!(state.tabs.contains_key("next-screen"), "ordinary navigation must show its requested destination");
            }
        }
    }

    #[test]
    fn a_global_tab_budget_keeps_the_focused_destination_first() {
        let mut initial = state();
        initial.containers.insert("second".into(), LayoutContainer { id: "second".into(), group_id: "zz-last-group".into() });
        initial.tab_groups.insert("zz-last-group".into(), TabGroup { tab_ids: vec!["focused-tab".into()], active_tab_id: Some("focused-tab".into()) });
        initial.tabs.insert("focused-tab".into(), tab("focused-tab"));
        initial.focused_container_id = Some("second".into());
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: initial, viewport: None,
            constraints: Some(ArrangementConstraints { max_containers: Some(2), max_tabs: Some(1), allowed_surfaces: Some(vec!["tiled".into()]) }),
            command: ArrangementCommand::Constrain,
        });
        assert_eq!(reply.state.tabs.len(), 1);
        assert!(reply.state.tabs.contains_key("focused-tab"));
    }

    #[test]
    fn malformed_policy_is_refused_at_the_byte_boundary() {
        for policy in [serde_json::json!({"max_tabs":0}), serde_json::json!({"max_containers":-1}),
            serde_json::json!({"allowed_surfaces":[]}), serde_json::json!({"allowed_surfaces":["canvas"]}), serde_json::json!({"unknown_limit":1})] {
            let request = serde_json::json!({"state":state(),"operation":"constrain","constraints":policy});
            assert!(arrange_screen_bytes(&serde_json::to_vec(&request).unwrap()).is_err());
        }
    }

    #[test]
    fn absent_policy_and_larger_caps_preserve_the_existing_layout() {
        let mut initial = state();
        initial.containers.insert("second".into(), LayoutContainer { id: "second".into(), group_id: "second-group".into() });
        initial.tab_groups.insert("second-group".into(), TabGroup { tab_ids: vec!["second-tab".into()], active_tab_id: Some("second-tab".into()) });
        initial.tabs.insert("second-tab".into(), tab("second-tab"));
        initial.layouts[0] = LayoutSurface::tiled(Some(even_split(SplitDir::Row, vec![
            SplitTreeNode::Leaf { container_id: "main".into() },
            SplitTreeNode::Leaf { container_id: "second".into() },
        ])));
        let request = |constraints| ScreenArrangementRequest {
            state: initial.clone(),
            viewport: None,
            constraints,
            command: ArrangementCommand::Constrain,
        };
        let unrestricted = arrange_screen_request(request(None));
        let roomy = arrange_screen_request(request(Some(ArrangementConstraints {
            max_containers: Some(4), max_tabs: Some(8), allowed_surfaces: Some(vec!["tiled".into()]),
        })));
        assert_eq!(unrestricted.state.containers.len(), 2);
        assert_eq!(roomy.state.containers.len(), 2);
        assert_eq!(roomy.state.tabs.len(), 2);
        assert_eq!(collect_leaf_ids(tiled_root(&roomy.state).as_ref()), vec!["main", "second"]);
    }

    #[test]
    fn layer_switch_uses_layer_layout_and_keeps_legacy_projection_in_sync() {
        let mut initial = state();
        let mut other = initial.layers[0].clone();
        other.id = "workbench".to_string();
        other.name = Some("Workbench".to_string());
        other.z = 1;
        other.layouts = vec![
            LayoutSurface::tiled(None),
            LayoutSurface::floating(Vec::new(), Camera::default()),
            LayoutSurface::overlay(Vec::new()),
        ];
        other.surface = "canvas".to_string();
        initial.layers.push(other);

        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: initial,
            viewport: None,
            constraints: None,
            command: ArrangementCommand::SetActiveLayer(LayerIdPayload {
                layer_id: "workbench".to_string(),
            }),
        });

        assert_eq!(reply.state.active_layer_id.as_deref(), Some("workbench"));
        assert_eq!(reply.state.surface, "canvas");
        assert!(matches!(
            reply.state.layouts[0],
            LayoutSurface::Tiled { root: None, .. }
        ));
        assert_eq!(reply.state.layers[1].layouts, reply.state.layouts);
    }

    #[test]
    fn reorder_layers_restacks_every_plane_and_rejects_partial_lists() {
        let mut initial = state();
        let mut other = initial.layers[0].clone();
        other.id = "workbench".to_string();
        other.z = 1;
        initial.layers.push(other);
        let base_id = initial.layers[0].id.clone();
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: initial.clone(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::ReorderLayers(ReorderLayersPayload {
                layer_ids: vec!["workbench".to_string(), base_id.clone()],
            }),
        });
        assert_eq!(reply.state.layers[0].id, "workbench");
        assert_eq!(reply.state.layers[0].z, 0);
        assert_eq!(reply.state.layers[1].id, base_id);
        assert_eq!(reply.state.layers[1].z, 1);

        let partial = arrange_screen_request(ScreenArrangementRequest {
            state: initial,
            viewport: None,
            constraints: None,
            command: ArrangementCommand::ReorderLayers(ReorderLayersPayload {
                layer_ids: vec!["workbench".to_string()],
            }),
        });
        assert_eq!(partial.state.layers[0].id, base_id);
    }

    #[test]
    fn create_layer_adds_an_empty_top_plane_and_selects_it() {
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: state(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::CreateLayer(CreateLayerPayload {
                name: Some("Second plane".to_string()),
            }),
        });

        assert_eq!(reply.state.layers.len(), 2);
        let active_id = reply.state.active_layer_id.as_deref().unwrap();
        let active = reply.state.layers.iter().find(|layer| layer.id == active_id).unwrap();
        assert_eq!(active.name.as_deref(), Some("Second plane"));
        assert_eq!(active.z, 1);
        assert_eq!(active.surface, "grid");
        assert!(matches!(active.layouts[0], LayoutSurface::Tiled { root: None, .. }));
        assert!(reply.state.focused_container_id.is_none());
    }

    #[test]
    fn moving_into_the_active_layer_takes_the_pane_from_the_layer_holding_it() {
        let mut initial = state();
        let mut other = initial.layers[0].clone();
        other.id = "fresh".to_string();
        other.z = 1;
        other.layouts = vec![
            LayoutSurface::tiled(None),
            LayoutSurface::floating(Vec::new(), Camera::default()),
            LayoutSurface::overlay(Vec::new()),
        ];
        initial.layers.push(other);
        initial.active_layer_id = Some("fresh".to_string());
        initial.layouts = initial.layers[1].layouts.clone();

        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: initial,
            viewport: None,
            constraints: None,
            command: ArrangementCommand::MoveContainerToLayer(MoveContainerToLayerPayload {
                container_id: "main".to_string(),
                layer_id: "fresh".to_string(),
                placement: Some("overlay".to_string()),
                position: None,
            }),
        });

        assert!(matches!(reply.state.layers[0].layouts[0], LayoutSurface::Tiled { root: None, .. }));
        assert!(matches!(
            &reply.state.layouts[2],
            LayoutSurface::Overlay { containers } if containers.iter().any(|entry| entry.container_id == "main")
        ));
    }

    #[test]
    fn moving_container_between_layers_removes_source_and_places_destination() {
        let mut initial = state();
        let mut other = initial.layers[0].clone();
        other.id = "workbench".to_string();
        other.layouts = vec![
            LayoutSurface::tiled(None),
            LayoutSurface::floating(Vec::new(), Camera::default()),
            LayoutSurface::overlay(Vec::new()),
        ];
        initial.layers.push(other);

        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: initial,
            viewport: None,
            constraints: None,
            command: ArrangementCommand::MoveContainerToLayer(MoveContainerToLayerPayload {
                container_id: "main".to_string(),
                layer_id: "workbench".to_string(),
                placement: None,
                position: None,
            }),
        });

        assert!(matches!(
            reply.state.layers[0].layouts[0],
            LayoutSurface::Tiled { root: None, .. }
        ));
        assert!(matches!(
            &reply.state.layers[1].layouts[0],
            LayoutSurface::Tiled { root: Some(SplitTreeNode::Leaf { container_id }), .. }
                if container_id == "main"
        ));
        assert!(matches!(
            reply.state.layouts[0],
            LayoutSurface::Tiled { root: None, .. }
        ));
    }

    #[test]
    fn moving_container_to_layer_supports_canvas_and_overlay_placements_without_loss() {
        for placement in ["canvas", "overlay"] {
            let mut initial = state();
            let mut other = initial.layers[0].clone();
            other.id = "workbench".to_string();
            other.layouts = vec![
                LayoutSurface::tiled(None),
                LayoutSurface::floating(Vec::new(), Camera::default()),
                LayoutSurface::overlay(Vec::new()),
            ];
            initial.layers.push(other);
            let reply = arrange_screen_request(ScreenArrangementRequest {
                state: initial,
                viewport: Some(Viewport { w: 1280.0, h: 720.0 }),
                constraints: None,
                command: ArrangementCommand::MoveContainerToLayer(MoveContainerToLayerPayload {
                    container_id: "main".to_string(),
                    layer_id: "workbench".to_string(),
                    placement: Some(placement.to_string()),
                    position: Some(Point { x: 640.0, y: 360.0 }),
                }),
            });
            assert!(reply.state.containers.contains_key("main"));
            assert!(reply.state.layers[0].layouts.iter().all(|layout| match layout {
                LayoutSurface::Tiled { root, .. } => root.is_none(),
                LayoutSurface::Floating { containers, .. } => containers.is_empty(),
                LayoutSurface::Overlay { containers } => containers.is_empty(),
            }));
            let destination = &reply.state.layers[1].layouts;
            match placement {
                "canvas" => assert!(matches!(&destination[1], LayoutSurface::Floating { containers, .. } if containers.iter().any(|entry| entry.container_id == "main" && entry.x + entry.w / 2.0 == 640.0 && entry.y + entry.h / 2.0 == 360.0))),
                "overlay" => assert!(matches!(&destination[2], LayoutSurface::Overlay { containers } if containers.iter().any(|entry| entry.container_id == "main" && entry.x + entry.w / 2.0 == 640.0 && entry.y + entry.h / 2.0 == 360.0))),
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn moving_container_to_layer_defaults_to_grid_placement() {
        let mut initial = state();
        let mut other = initial.layers[0].clone();
        other.id = "workbench".to_string();
        other.layouts = vec![
            LayoutSurface::tiled(None),
            LayoutSurface::floating(Vec::new(), Camera::default()),
            LayoutSurface::overlay(Vec::new()),
        ];
        initial.layers.push(other);
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: initial,
            viewport: None,
            constraints: None,
            command: ArrangementCommand::MoveContainerToLayer(MoveContainerToLayerPayload {
                container_id: "main".to_string(),
                layer_id: "workbench".to_string(),
                placement: None,
                position: None,
            }),
        });
        assert!(matches!(
            reply.state.layers[1].layouts[0],
            LayoutSurface::Tiled { root: Some(SplitTreeNode::Leaf { ref container_id }), .. } if container_id == "main"
        ));
        assert!(reply.state.containers.contains_key("main"));
    }

    #[test]
    fn moving_into_incompatible_base_geometry_fails_closed_without_loss() {
        let mut initial = state();
        initial.containers.insert("existing".to_string(), LayoutContainer {
            id: "existing".to_string(),
            group_id: "main-group".to_string(),
        });
        let mut other = initial.layers[0].clone();
        other.id = "workbench".to_string();
        other.surface = "canvas".to_string();
        other.layouts = vec![
            LayoutSurface::tiled(None),
            LayoutSurface::floating(
                vec![FreeformWindow::rect(
                    "existing".to_string(),
                    Rect { x: 0.0, y: 0.0, w: 300.0, h: 200.0 },
                    1,
                )],
                Camera::default(),
            ),
            LayoutSurface::overlay(Vec::new()),
        ];
        initial.layers.push(other);
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: initial.clone(),
            viewport: Some(Viewport { w: 1280.0, h: 720.0 }),
            constraints: None,
            command: ArrangementCommand::MoveContainerToLayer(MoveContainerToLayerPayload {
                container_id: "main".to_string(),
                layer_id: "workbench".to_string(),
                placement: Some("grid".to_string()),
                position: None,
            }),
        });
        assert!(reply.state.containers.contains_key("main"));
        assert!(matches!(reply.state.layers[0].layouts[0], LayoutSurface::Tiled { root: Some(_), .. }));
        assert_eq!(reply.state.layers[1].surface, "canvas");
        assert!(matches!(&reply.state.layers[1].layouts[1], LayoutSurface::Floating { containers, .. } if containers.len() == 1));
    }

    #[test]
    fn legacy_layout_state_without_layers_migrates_to_default_layer() {
        let value = serde_json::to_value(LayoutState::default()).expect("serialize state");
        let mut value = value;
        value
            .as_object_mut()
            .expect("state object")
            .remove("layers");
        value
            .as_object_mut()
            .expect("state object")
            .remove("activeLayerId");
        let legacy: LayoutState = serde_json::from_value(value).expect("decode legacy state");
        let normalized = normalize_state(legacy);
        assert_eq!(normalized.active_layer_id.as_deref(), Some("default"));
        assert_eq!(normalized.layers.len(), 1);
        assert_eq!(normalized.layers[0].layouts, normalized.layouts);
    }

    fn tab(id: &str) -> TabMeta {
        TabMeta {
            id: id.to_string(),
            title: id.to_string(),
            target: Some(format!("slot::fixture/{id}")),
            material_target: None,
            icon: None,
            pinned: None,
            closable: None,
            metadata: None,
            extra: BTreeMap::new(),
        }
    }

    fn material_tab(id: &str, material_target: &str) -> TabMeta {
        TabMeta {
            target: None,
            material_target: Some(material_target.to_string()),
            ..tab(id)
        }
    }

    fn stale_first_tab_reference_state() -> LayoutState {
        let mut initial = state();
        initial.tabs.clear();
        initial
            .tab_groups
            .get_mut("main-group")
            .expect("default group exists")
            .tab_ids = vec!["surface-default".to_string()];
        initial
            .tab_groups
            .get_mut("main-group")
            .expect("default group exists")
            .active_tab_id = Some("surface-default".to_string());
        initial
    }

    #[test]
    fn add_surface_tab_preserves_caller_owned_tab_fields_from_request_bytes() {
        let request = serde_json::json!({
            "state": state(),
            "operation": "addSurfaceTab",
            "payload": {
                "containerId": "main",
                "tab": {
                    "id": "surface-package-entry",
                    "title": "Chat",
                    "target": null,
                    "packageEntry": {
                        "packageName": "chat",
                        "entryName": "chat"
                    },
                    "futureCallerField": {
                        "kind": "fixture",
                        "value": 42
                    }
                }
            }
        });

        let reply_bytes = arrange_screen_bytes(&serde_json::to_vec(&request).unwrap())
            .expect("arrangement request succeeds");
        let reply: Value = serde_json::from_slice(&reply_bytes).expect("arrangement reply is json");
        let tab = &reply["state"]["tabs"]["surface-package-entry"];

        assert_eq!(tab["packageEntry"]["packageName"], "chat");
        assert_eq!(tab["packageEntry"]["entryName"], "chat");
        assert_eq!(tab["futureCallerField"]["value"], 42);
    }

    #[test]
    fn add_surface_tab_updates_existing_tab_descriptor_in_place() {
        let first_request = serde_json::json!({
            "state": state(),
            "operation": "addSurfaceTab",
            "payload": {
                "containerId": "main",
                "tab": {
                    "id": "surface-chat",
                    "title": "Chat",
                    "target": null
                }
            }
        });
        let first_reply: Value = serde_json::from_slice(
            &arrange_screen_bytes(&serde_json::to_vec(&first_request).unwrap()).unwrap(),
        )
        .expect("first reply is json");
        let second_request = serde_json::json!({
            "state": first_reply["state"],
            "operation": "addSurfaceTab",
            "payload": {
                "containerId": "main",
                "tab": {
                    "id": "surface-chat",
                    "title": "Chat",
                    "target": null,
                    "packageEntry": {
                        "packageName": "chat",
                        "entryName": "chat"
                    }
                }
            }
        });

        let second_reply: Value = serde_json::from_slice(
            &arrange_screen_bytes(&serde_json::to_vec(&second_request).unwrap()).unwrap(),
        )
        .expect("second reply is json");
        let group = &second_reply["state"]["tabGroups"]["main-group"];
        let tab = &second_reply["state"]["tabs"]["surface-chat"];

        assert_eq!(group["activeTabId"], "surface-chat");
        assert_eq!(
            group["tabIds"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|id| id.as_str() == Some("surface-chat"))
                .count(),
            1
        );
        assert_eq!(tab["packageEntry"]["packageName"], "chat");
        assert_eq!(tab["packageEntry"]["entryName"], "chat");
    }

    #[test]
    fn add_surface_tab_adds_and_focuses_container() {
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: state(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::AddSurfaceTab(AddTabPayload {
                container_id: "main".to_string(),
                tab: tab("surface-b"),
            }),
        });

        assert!(reply.state.tabs.contains_key("surface-b"));
        assert_eq!(reply.state.focused_container_id.as_deref(), Some("main"));
    }

    #[test]
    fn arrange_surfaces_builds_declarative_tiled_layout_and_focus() {
        // "chat left, vision board right, saved links bottom" — the exact user intent.
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: state(),
            viewport: Some(Viewport {
                w: 1600.0,
                h: 1000.0,
            }),
            constraints: None,
            command: ArrangementCommand::ArrangeSurfaces(ArrangeSurfacesPayload {
                placements: vec![
                    SurfacePlacement {
                        surface_id: None,
                        tab: Some(material_tab("chat", "component:chat")),
                        region: PlacementRegion::Left,
                        size: None,
                    },
                    SurfacePlacement {
                        surface_id: None,
                        tab: Some(material_tab("vision-board", "component:vision-board")),
                        region: PlacementRegion::Right,
                        size: None,
                    },
                    SurfacePlacement {
                        surface_id: None,
                        tab: Some(material_tab("saved-links", "component:saved-links")),
                        region: PlacementRegion::Bottom,
                        size: None,
                    },
                ],
                focus_tab_id: Some("chat".to_string()),
            }),
        });

        // All three surfaces present, each in its own container, slot-generated ids.
        assert!(reply.state.tabs.contains_key("chat"));
        assert!(reply.state.tabs.contains_key("vision-board"));
        assert!(reply.state.tabs.contains_key("saved-links"));
        assert_eq!(reply.state.containers.len(), 3, "one container per surface");
        // Material target round-trips opaque (no Society vocabulary in the slot).
        assert_eq!(
            reply.state.tabs["vision-board"].material_target.as_deref(),
            Some("component:vision-board")
        );
        // Focus honored: focused container holds the chat tab.
        let focused = reply
            .state
            .focused_container_id
            .as_deref()
            .expect("a container is focused");
        assert_eq!(
            find_container_for_tab(&reply.state, "chat").as_deref(),
            Some(focused)
        );
        // Tiled root is a non-trivial split tree (not a bare leaf).
        let root = tiled_root(&reply.state).expect("tiled root exists");
        assert!(
            matches!(root, SplitTreeNode::Split { .. }),
            "multi-pane split"
        );
    }

    #[test]
    fn arrange_surfaces_by_surface_id_carries_mount_hook() {
        // The AI names surfaces by stable catalog id only. The slot must build a
        // tab whose metadata.placeable_surface_id matches that id, so the live
        // render path (tabWithCurrentSurfaceLabel) can join it to the catalog and
        // mount the real surface — no material/package vocabulary in the slot.
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: state(),
            viewport: Some(Viewport {
                w: 1600.0,
                h: 1000.0,
            }),
            constraints: None,
            command: ArrangementCommand::ArrangeSurfaces(ArrangeSurfacesPayload {
                placements: vec![
                    SurfacePlacement {
                        surface_id: Some("chat".to_string()),
                        tab: None,
                        region: PlacementRegion::Left,
                        size: None,
                    },
                    SurfacePlacement {
                        surface_id: Some("vision-board".to_string()),
                        tab: None,
                        region: PlacementRegion::Right,
                        size: None,
                    },
                ],
                focus_tab_id: None,
            }),
        });

        assert_eq!(reply.state.containers.len(), 2, "one container per surface");
        let surface_ids: Vec<String> = reply
            .state
            .tabs
            .values()
            .filter_map(|tab| {
                tab.metadata
                    .as_ref()
                    .and_then(|m| m.get("placeable_surface_id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
        assert!(
            surface_ids.contains(&"chat".to_string()),
            "chat tab carries its surface id mount hook"
        );
        assert!(
            surface_ids.contains(&"vision-board".to_string()),
            "vision-board tab carries its surface id mount hook"
        );
        // The slot stays free of material/package vocabulary — surface_id placements
        // produce no materialTarget guess.
        for tab in reply.state.tabs.values() {
            assert!(
                tab.material_target.is_none(),
                "slot must not invent a material target from a surface id"
            );
        }
    }

    #[test]
    fn apply_sequence_folds_commands_through_single_op_reducer() {
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: state(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::ApplySequence(ApplySequencePayload {
                operations: vec![
                    ArrangementCommand::AddSurfaceTab(AddTabPayload {
                        container_id: "main".to_string(),
                        tab: tab("seq-a"),
                    }),
                    ArrangementCommand::SplitRootWithSurface(SplitRootWithSurfacePayload {
                        dir: SplitDir::Row,
                        position: RootPosition::After,
                        tab: tab("seq-b"),
                    }),
                ],
            }),
        });

        assert!(reply.state.tabs.contains_key("seq-a"));
        assert!(reply.state.tabs.contains_key("seq-b"));
    }

    #[test]
    fn add_surface_tab_preserves_opaque_material_target() {
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: state(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::AddSurfaceTab(AddTabPayload {
                container_id: "main".to_string(),
                tab: material_tab("surface-material", "component:fixture-surface"),
            }),
        });

        let tab = reply
            .state
            .tabs
            .get("surface-material")
            .expect("surface material tab is added");
        assert_eq!(tab.target, None);
        assert_eq!(
            tab.material_target.as_deref(),
            Some("component:fixture-surface")
        );
    }

    #[test]
    fn stale_first_tab_reference_is_pruned_before_any_operation() {
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: stale_first_tab_reference_state(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::FocusContainer(ContainerIdPayload {
                container_id: "main".to_string(),
            }),
        });

        let group = reply
            .state
            .tab_groups
            .get("main-group")
            .expect("main tab group remains");
        assert_eq!(group.tab_ids, Vec::<String>::new());
        assert_eq!(group.active_tab_id, None);
        assert!(!reply.state.tabs.contains_key("surface-default"));
        assert_eq!(reply.state.focused_container_id.as_deref(), Some("main"));
    }

    #[test]
    fn stale_first_tab_reference_refills_with_surface_tab() {
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: stale_first_tab_reference_state(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::AddSurfaceTab(AddTabPayload {
                container_id: "main".to_string(),
                tab: tab("surface-chat"),
            }),
        });

        let group = reply
            .state
            .tab_groups
            .get("main-group")
            .expect("main tab group remains");
        assert_eq!(group.tab_ids, vec!["surface-chat".to_string()]);
        assert_eq!(group.active_tab_id.as_deref(), Some("surface-chat"));
        assert!(reply.state.tabs.contains_key("surface-chat"));
        assert!(!reply.state.tabs.contains_key("surface-default"));
    }

    #[test]
    fn close_final_tab_leaves_single_container_ready_for_empty_state() {
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: state(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::CloseTab(TabIdPayload {
                tab_id: "surface-default".to_string(),
            }),
        });

        assert!(reply.state.containers.contains_key("main"));
        assert!(!reply.state.tabs.contains_key("surface-default"));
        assert_eq!(
            reply
                .state
                .tab_groups
                .get("main-group")
                .expect("main tab group remains")
                .tab_ids,
            Vec::<String>::new()
        );
        assert_eq!(
            reply
                .state
                .tab_groups
                .get("main-group")
                .expect("main tab group remains")
                .active_tab_id,
            None
        );
        assert!(matches!(
            tiled_root(&reply.state),
            Some(SplitTreeNode::Leaf { container_id }) if container_id == "main"
        ));
    }

    #[test]
    fn empty_final_container_refills_with_surface_tab() {
        let empty_reply = arrange_screen_request(ScreenArrangementRequest {
            state: state(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::CloseTab(TabIdPayload {
                tab_id: "surface-default".to_string(),
            }),
        });
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: empty_reply.state,
            viewport: None,
            constraints: None,
            command: ArrangementCommand::AddSurfaceTab(AddTabPayload {
                container_id: "main".to_string(),
                tab: tab("surface-chat"),
            }),
        });

        let group = reply
            .state
            .tab_groups
            .get("main-group")
            .expect("main tab group remains");
        assert_eq!(group.tab_ids, vec!["surface-chat".to_string()]);
        assert_eq!(group.active_tab_id.as_deref(), Some("surface-chat"));
        assert_eq!(reply.state.focused_container_id.as_deref(), Some("main"));
    }

    #[test]
    fn split_container_with_surface_from_pip_keeps_right_pane_visible_and_focused() {
        let initial = toggle_overlay(
            state(),
            "main",
            Viewport { w: 1280.0, h: 720.0 },
        );
        let reply = split_container_with_surface(
            initial,
            "main",
            SplitDir::Row,
            RootPosition::After,
            tab("pip-right"),
            Viewport {
                w: 1280.0,
                h: 720.0,
            },
        );
        let new_container_id = reply.containers.iter().find_map(|(id, container)| {
            reply.tab_groups.get(&container.group_id)
                .filter(|group| group.tab_ids.iter().any(|tab_id| tab_id == "pip-right"))
                .map(|_| id.clone())
        }).expect("split surface has a container");

        assert_eq!(reply.focused_container_id.as_deref(), Some(new_container_id.as_str()));
        let overlay = overlay_containers(&reply);
        let target = overlay.iter().find(|entry| entry.container_id == "main").unwrap();
        let new = overlay.iter().find(|entry| entry.container_id == new_container_id).unwrap();
        assert_eq!(target.w, new.w);
        assert_eq!(new.x, target.x + target.w);
        assert!(!collect_leaf_ids(tiled_root(&reply).as_ref()).contains(&new_container_id));
    }

    #[test]
    fn split_container_with_surface_from_near_right_edge_pip_fits_both_panes_in_viewport() {
        let viewport = Viewport {
            w: 3456.0,
            h: 1200.0,
        };
        let mut initial = toggle_overlay(state(), "main", viewport);
        update_overlay(&mut initial, |containers| {
            let target = containers
                .iter_mut()
                .find(|entry| entry.container_id == "main")
                .unwrap();
            target.x = 3300.0;
            target.y = 800.0;
        });

        let reply = split_container_with_surface(
            initial,
            "main",
            SplitDir::Row,
            RootPosition::After,
            tab("pip-right-edge"),
            viewport,
        );
        let overlay = overlay_containers(&reply);
        let target = overlay
            .iter()
            .find(|entry| entry.container_id == "main")
            .unwrap();
        let new = overlay
            .iter()
            .find(|entry| {
                reply
                    .containers
                    .get(&entry.container_id)
                    .is_some_and(|container| {
                        reply
                            .tab_groups
                            .get(&container.group_id)
                            .is_some_and(|group| {
                                group.tab_ids.iter().any(|tab_id| tab_id == "pip-right-edge")
                            })
                    })
            })
            .expect("split surface has an overlay pane");

        assert_eq!(target.x, 3036.0);
        assert_eq!(target.w, 210.0);
        assert_eq!(new.x, target.x + target.w);
        assert_eq!(new.w, target.w);
        for pane in [target, new] {
            assert!(pane.x >= 0.0);
            assert!(pane.y >= 0.0);
            assert!(pane.x + pane.w <= viewport.w);
            assert!(pane.y + pane.h <= viewport.h);
        }
        assert_eq!(
            reply.focused_container_id.as_deref(),
            Some(new.container_id.as_str())
        );
    }

    #[test]
    fn split_container_with_surface_from_pip_keeps_below_pane_visible_and_focused() {
        let initial = toggle_overlay(
            state(),
            "main",
            Viewport { w: 1280.0, h: 720.0 },
        );
        let reply = split_container_with_surface(
            initial,
            "main",
            SplitDir::Column,
            RootPosition::After,
            tab("pip-below"),
            Viewport {
                w: 1280.0,
                h: 720.0,
            },
        );
        let new_container_id = reply.containers.iter().find_map(|(id, container)| {
            reply.tab_groups.get(&container.group_id)
                .filter(|group| group.tab_ids.iter().any(|tab_id| tab_id == "pip-below"))
                .map(|_| id.clone())
        }).expect("split surface has a container");

        assert_eq!(reply.focused_container_id.as_deref(), Some(new_container_id.as_str()));
        let overlay = overlay_containers(&reply);
        let target = overlay.iter().find(|entry| entry.container_id == "main").unwrap();
        let new = overlay.iter().find(|entry| entry.container_id == new_container_id).unwrap();
        assert_eq!(target.h, new.h);
        assert_eq!(new.y, target.y + target.h);
        assert!(!collect_leaf_ids(tiled_root(&reply).as_ref()).contains(&new_container_id));
    }

    #[test]
    fn split_container_with_tab_into_pip_keeps_moved_tab_visible_and_focused() {
        let with_source_tab = split_container_with_surface(
            state(),
            "main",
            SplitDir::Row,
            RootPosition::After,
            tab("existing-post"),
            Viewport {
                w: 1280.0,
                h: 720.0,
            },
        );
        let initial = toggle_overlay(
            with_source_tab,
            "main",
            Viewport { w: 1280.0, h: 720.0 },
        );
        let reply = split_container_with_tab(
            initial,
            "main",
            SplitDir::Row,
            RootPosition::After,
            "existing-post",
            Viewport {
                w: 1280.0,
                h: 720.0,
            },
        );
        let new_container_id = reply.containers.iter().find_map(|(id, container)| {
            reply.tab_groups.get(&container.group_id)
                .filter(|group| group.tab_ids.iter().any(|tab_id| tab_id == "existing-post"))
                .map(|_| id.clone())
        }).expect("moved post tab has a container");

        assert_eq!(reply.focused_container_id.as_deref(), Some(new_container_id.as_str()));
        let overlay = overlay_containers(&reply);
        let target = overlay.iter().find(|entry| entry.container_id == "main").unwrap();
        let new = overlay.iter().find(|entry| entry.container_id == new_container_id).unwrap();
        assert_eq!(target.w, new.w);
        assert_eq!(new.x, target.x + target.w);
        assert!(!collect_leaf_ids(tiled_root(&reply).as_ref()).contains(&new_container_id));
    }

    #[test]
    fn split_sole_pip_tab_replaces_container_without_shrinking_bounds() {
        let viewport = Viewport { w: 1280.0, h: 720.0 };
        let initial = toggle_overlay(state(), "main", viewport);
        let original = overlay_containers(&initial)
            .into_iter()
            .find(|entry| entry.container_id == "main")
            .expect("main is in PiP");

        let reply = split_container_with_tab(
            initial,
            "main",
            SplitDir::Row,
            RootPosition::After,
            "surface-default",
            viewport,
        );

        let new_container_id = reply
            .focused_container_id
            .clone()
            .expect("replacement pane is focused");
        assert!(!reply.containers.contains_key("main"));
        let overlay = overlay_containers(&reply);
        assert_eq!(overlay.len(), 1);
        let replacement = overlay
            .iter()
            .find(|entry| entry.container_id == new_container_id)
            .expect("replacement pane remains in PiP");
        assert_eq!(replacement.x, original.x);
        assert_eq!(replacement.y, original.y);
        assert_eq!(replacement.w, original.w);
        assert_eq!(replacement.h, original.h);
        assert!(tiled_root(&reply).is_none());
    }

    #[test]
    fn split_container_with_surface_creates_new_focused_container() {
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: state(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::SplitContainerWithSurface(
                SplitContainerWithSurfacePayload {
                    target_container_id: "main".to_string(),
                    dir: SplitDir::Row,
                    position: RootPosition::After,
                    tab: tab("surface-split"),
                },
            ),
        });

        assert!(reply.state.tabs.contains_key("surface-split"));
        assert_ne!(reply.state.focused_container_id.as_deref(), Some("main"));
        assert!(matches!(
            tiled_root(&reply.state),
            Some(SplitTreeNode::Split { .. })
        ));
    }

    #[test]
    fn split_container_with_surface_honors_before_position() {
        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: state(),
            viewport: None,
            constraints: None,
            command: ArrangementCommand::SplitContainerWithSurface(
                SplitContainerWithSurfacePayload {
                    target_container_id: "main".to_string(),
                    dir: SplitDir::Row,
                    position: RootPosition::Before,
                    tab: tab("surface-before"),
                },
            ),
        });

        let inserted_container_id = reply
            .state
            .containers
            .iter()
            .find_map(|(container_id, container)| {
                let group = reply.state.tab_groups.get(&container.group_id)?;
                group
                    .tab_ids
                    .iter()
                    .any(|tab_id| tab_id == "surface-before")
                    .then(|| container_id.clone())
            })
            .expect("surface tab is placed in a new container");

        assert!(matches!(
            tiled_root(&reply.state),
            Some(SplitTreeNode::Split { children, .. })
                if matches!(&children[0], SplitTreeNode::Leaf { container_id } if container_id == &inserted_container_id)
                    && matches!(&children[1], SplitTreeNode::Leaf { container_id } if container_id == "main")
        ));
    }

    #[test]
    fn set_surface_to_canvas_auto_arranges_tiled_containers() {
        let mut initial = state();
        initial = split_container_with_surface(
            initial,
            "main",
            SplitDir::Row,
            RootPosition::After,
            tab("surface-split"),
            Viewport {
                w: 1000.0,
                h: 800.0,
            },
        );

        let reply = arrange_screen_request(ScreenArrangementRequest {
            state: initial.clone(),
            viewport: Some(Viewport {
                w: 1000.0,
                h: 800.0,
            }),
            constraints: None,
            command: ArrangementCommand::SetSurface(SetSurfacePayload {
                surface: "canvas".to_string(),
                base_geometry: BaseSurfaceGeometry::Floating,
            }),
        });

        assert_eq!(reply.state.surface, "canvas");
        assert!(!floating_containers(&reply.state).is_empty());
        assert_eq!(
            reply.state.layouts[0], initial.layouts[0],
            "switching to canvas must retain the complete tiled arrangement",
        );
    }

    #[test]
    fn canvas_round_trip_preserves_thirteen_tiled_containers() {
        // Regression: canvas -> grid must flip the surface label back while
        // retaining all thirteen panes in the tiled tree. The Tiled base
        // geometry needs no reconcile, but the label MUST change so the client
        // routes back to the split-tree arranger.
        let mut initial = state();
        for index in 0..12 {
            initial = split_container_with_surface(
                initial,
                "main",
                SplitDir::Row,
                RootPosition::After,
                tab(&format!("surface-{index}")),
                Viewport {
                    w: 1000.0,
                    h: 800.0,
                },
            );
        }
        assert_eq!(collect_leaf_ids(tiled_root(&initial).as_ref()).len(), 13);
        let canvas = arrange_screen_request(ScreenArrangementRequest {
            state: initial.clone(),
            viewport: Some(Viewport {
                w: 1000.0,
                h: 800.0,
            }),
            constraints: None,
            command: ArrangementCommand::SetSurface(SetSurfacePayload {
                surface: "canvas".to_string(),
                base_geometry: BaseSurfaceGeometry::Floating,
            }),
        });
        assert_eq!(canvas.state.surface, "canvas");
        assert_eq!(floating_containers(&canvas.state).len(), 13);
        let grid = arrange_screen_request(ScreenArrangementRequest {
            state: canvas.state,
            viewport: Some(Viewport {
                w: 1000.0,
                h: 800.0,
            }),
            constraints: None,
            command: ArrangementCommand::SetSurface(SetSurfacePayload {
                surface: "grid".to_string(),
                base_geometry: BaseSurfaceGeometry::Tiled,
            }),
        });
        assert_eq!(grid.state.surface, "grid");
        assert_eq!(
            grid.state.layouts[0], initial.layouts[0],
            "switching back to tiles must reveal the original pane tree",
        );
    }
}
