// crates/screen-arrangement/src/arrange/screen_arrangement_types.rs
//
// Generic screen/surface arrangement data model.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SplitDir {
    Row,
    Column,
}

/// What a split's `sizes` measure.
///
/// `Share`: fractions of the split's own space; the children always fill it.
/// Layouts saved before pane sizes existed carry no unit and read as `Share`.
/// `Px`: each child's own width (row) or height (column) in layout pixels.
/// Changing one child changes nothing else; the split is as long as its
/// children together and the arrangement scrolls past the window.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SplitSizeUnit {
    #[default]
    Share,
    Px,
}

impl SplitSizeUnit {
    pub fn is_share(&self) -> bool {
        *self == SplitSizeUnit::Share
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum SplitTreeNode {
    #[serde(rename = "leaf", rename_all = "camelCase")]
    Leaf { container_id: String },
    #[serde(rename = "split", rename_all = "camelCase")]
    Split {
        dir: SplitDir,
        sizes: Vec<f64>,
        #[serde(default, skip_serializing_if = "SplitSizeUnit::is_share")]
        size_unit: SplitSizeUnit,
        /// Each child's own length across the split (its height in a row, its width in a column), in layout pixels;
        /// `None` (or no entry) fills the split. Empty when every child fills, which is how every split began.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        cross_sizes: Vec<Option<f64>>,
        /// Pixel sizes are drawn exactly as kept, the split as long as its children together and the arrangement
        /// scrolling past the window, instead of scaled to fit (a pane added beside another never shrinks it).
        #[serde(default, skip_serializing_if = "is_false")]
        keep_lengths: bool,
        /// A row drawn narrower than this many layout pixels draws its children stacked instead (each at its own
        /// length across the row, the arrangement scrolling), so a dashboard of pieces reads as one column on a phone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stack_below: Option<f64>,
        children: Vec<SplitTreeNode>,
    },
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TiledLayout {
    #[serde(rename = "type")]
    pub layout_type: TiledLayoutKind,
    pub root: Option<SplitTreeNode>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TiledLayoutKind {
    Tiled,
}

impl Default for TiledLayout {
    fn default() -> Self {
        Self {
            layout_type: TiledLayoutKind::Tiled,
            root: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub w: f64,
    pub h: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            w: 1280.0,
            h: 720.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeformWindow {
    pub container_id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub z: i32,
}

impl FreeformWindow {
    pub fn rect(container_id: String, rect: Rect, z: i32) -> Self {
        Self {
            container_id,
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            z,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Camera {
    pub scale: f64,
    pub tx: f64,
    pub ty: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            scale: 1.0,
            tx: 0.0,
            ty: 0.0,
            min: None,
            max: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FloatingLayout {
    #[serde(rename = "type")]
    pub layout_type: FloatingLayoutKind,
    pub containers: Vec<FreeformWindow>,
    pub camera: Camera,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FloatingLayoutKind {
    Floating,
}

impl Default for FloatingLayout {
    fn default() -> Self {
        Self {
            layout_type: FloatingLayoutKind::Floating,
            containers: Vec::new(),
            camera: Camera::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverlayBox {
    pub container_id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub z: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverlayLayout {
    #[serde(rename = "type")]
    pub layout_type: OverlayLayoutKind,
    pub containers: Vec<OverlayBox>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OverlayLayoutKind {
    Overlay,
}

impl Default for OverlayLayout {
    fn default() -> Self {
        Self {
            layout_type: OverlayLayoutKind::Overlay,
            containers: Vec::new(),
        }
    }
}

/// How long the tiled arrangement itself is, in layout pixels, on each axis the person has sized by dragging a pane's
/// outer edge. An absent axis fills the visible stage; a present one never renders shorter than the stage and may be
/// longer, in which case the stage scrolls. Saved with the layout, so a saved arrangement keeps its size.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TiledExtent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<f64>,
}

impl TiledExtent {
    pub fn is_empty(&self) -> bool {
        self.w.is_none() && self.h.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum LayoutSurface {
    #[serde(rename = "tiled")]
    Tiled {
        root: Option<SplitTreeNode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        extent: Option<TiledExtent>,
    },
    #[serde(rename = "floating", rename_all = "camelCase")]
    Floating {
        containers: Vec<FreeformWindow>,
        camera: Camera,
    },
    #[serde(rename = "overlay", rename_all = "camelCase")]
    Overlay { containers: Vec<OverlayBox> },
}

impl LayoutSurface {
    pub fn tiled(root: Option<SplitTreeNode>) -> Self {
        Self::Tiled { root, extent: None }
    }

    pub fn floating(containers: Vec<FreeformWindow>, camera: Camera) -> Self {
        Self::Floating { containers, camera }
    }

    pub fn overlay(containers: Vec<OverlayBox>) -> Self {
        Self::Overlay { containers }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutContainer {
    pub id: String,
    pub group_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabGroup {
    pub tab_ids: Vec<String>,
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabMeta {
    pub id: String,
    pub title: String,
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
    #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

/// An open, Society-authored label for which base arrangement is foregrounded
/// (e.g. `"grid"`, `"canvas"`, a future `"stage"`). The slot NEVER branches on
/// this value — behavior is driven only by the closed [`BaseSurfaceGeometry`]
/// the caller self-describes on the `setSurface` command. Adding a new mode is
/// a client data row, not slot code (L090).
pub type SurfaceLabel = String;

/// A selectable arrangement layer. Container and tab records remain shared;
/// each layer stores its own placement geometry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArrangementLayer {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub z: i32,
    #[serde(default = "default_surface")]
    pub surface: SurfaceLabel,
    #[serde(default = "default_layouts")]
    pub layouts: Vec<LayoutSurface>,
}

/// The closed set of base arrangement geometries the slot actually implements —
/// each is distinct geometry math, so this is Physics-closed (a new one is new
/// slot code, never a user/package extension). `Overlay` is deliberately absent:
/// it is an orthogonal always-present layer (PiP), not a selectable base.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BaseSurfaceGeometry {
    Tiled,
    Floating,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutState {
    #[serde(default)]
    pub containers: BTreeMap<String, LayoutContainer>,
    #[serde(default)]
    pub tab_groups: BTreeMap<String, TabGroup>,
    #[serde(default)]
    pub tabs: BTreeMap<String, TabMeta>,
    #[serde(default = "default_layouts")]
    pub layouts: Vec<LayoutSurface>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<ArrangementLayer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_layer_id: Option<String>,
    #[serde(default = "default_surface")]
    pub surface: SurfaceLabel,
    #[serde(default)]
    pub focused_container_id: Option<String>,
    #[serde(default)]
    pub maximized_container_id: Option<String>,
    /// Client-only render fields the slot does not interpret but MUST preserve
    /// across every operation round-trip — e.g. `visualLayerStacks` (region
    /// decoration) and `chrome`. Without this catch-all, serde drops any field
    /// not named above, so a single op (activateTab, etc.) would erase a node's
    /// background/grain. Flatten captures every extra key and re-emits it
    /// unchanged: the slot mutates only the typed fields it owns.
    #[serde(flatten)]
    pub passthrough: BTreeMap<String, Value>,
}

impl Default for LayoutState {
    fn default() -> Self {
        let mut containers = BTreeMap::new();
        containers.insert(
            "main".to_string(),
            LayoutContainer {
                id: "main".to_string(),
                group_id: "main-group".to_string(),
            },
        );

        let mut tab_groups = BTreeMap::new();
        tab_groups.insert(
            "main-group".to_string(),
            TabGroup {
                tab_ids: vec!["surface-default".to_string()],
                active_tab_id: Some("surface-default".to_string()),
            },
        );

        let mut tabs = BTreeMap::new();
        tabs.insert(
            "surface-default".to_string(),
            TabMeta {
                id: "surface-default".to_string(),
                title: "Empty tab".to_string(),
                target: None,
                material_target: None,
                icon: None,
                pinned: None,
                closable: None,
                metadata: None,
                extra: BTreeMap::new(),
            },
        );

        Self {
            containers,
            tab_groups,
            tabs,
            layouts: vec![
                LayoutSurface::tiled(Some(SplitTreeNode::Leaf {
                    container_id: "main".to_string(),
                })),
                LayoutSurface::floating(Vec::new(), Camera::default()),
                LayoutSurface::overlay(Vec::new()),
            ],
            layers: vec![ArrangementLayer {
                id: "default".to_string(),
                name: None,
                z: 0,
                surface: default_surface(),
                layouts: vec![
                    LayoutSurface::tiled(Some(SplitTreeNode::Leaf {
                        container_id: "main".to_string(),
                    })),
                    LayoutSurface::floating(Vec::new(), Camera::default()),
                    LayoutSurface::overlay(Vec::new()),
                ],
            }],
            active_layer_id: Some("default".to_string()),
            surface: default_surface(),
            focused_container_id: Some("main".to_string()),
            maximized_container_id: None,
            passthrough: BTreeMap::new(),
        }
    }
}

pub fn default_layouts() -> Vec<LayoutSurface> {
    LayoutState::default().layouts
}

pub fn default_surface() -> SurfaceLabel {
    "grid".to_string()
}
