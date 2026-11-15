// crates/screen-arrangement/src/arrange/arrange_freeform_surfaces.rs
//
// Freeform/canvas arrangement math.

use crate::arrange::screen_arrangement_types::{Camera, FreeformWindow, Rect, Viewport};

pub fn auto_arrange_grid(
    container_ids: &[String],
    viewport: Viewport,
    existing_count: usize,
) -> Vec<FreeformWindow> {
    let pad = 40.0;
    let gap = 12.0;
    let n = container_ids.len();
    if n == 0 {
        return Vec::new();
    }

    let cols = (n as f64).sqrt().ceil().max(1.0) as usize;
    let rows = ((n as f64) / cols as f64).ceil().max(1.0) as usize;
    let cell_w = ((viewport.w - pad * 2.0 - gap * (cols as f64 - 1.0)) / cols as f64).floor();
    let cell_h = ((viewport.h - pad * 2.0 - gap * (rows as f64 - 1.0)) / rows as f64).floor();
    let offset = existing_count as f64 * 30.0;

    container_ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            let col = index % cols;
            let row = index / cols;
            FreeformWindow {
                container_id: id.clone(),
                x: pad + col as f64 * (cell_w + gap) + offset,
                y: pad + row as f64 * (cell_h + gap) + offset,
                w: cell_w,
                h: cell_h,
                z: (existing_count + index) as i32,
            }
        })
        .collect()
}

pub fn max_freeform_z(containers: &[FreeformWindow]) -> i32 {
    containers.iter().map(|entry| entry.z).max().unwrap_or(0)
}

pub fn merge_camera(current: Camera, patch: CameraPatch) -> Camera {
    Camera {
        scale: patch.scale.unwrap_or(current.scale),
        tx: patch.tx.unwrap_or(current.tx),
        ty: patch.ty.unwrap_or(current.ty),
        min: patch.min.or(current.min),
        max: patch.max.or(current.max),
    }
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraPatch {
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub tx: Option<f64>,
    #[serde(default)]
    pub ty: Option<f64>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

pub fn window_from_rect(container_id: String, rect: Rect, z: i32) -> FreeformWindow {
    FreeformWindow::rect(container_id, rect, z)
}
