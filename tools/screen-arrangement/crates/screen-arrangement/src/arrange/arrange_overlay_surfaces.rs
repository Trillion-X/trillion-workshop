// crates/screen-arrangement/src/arrange/arrange_overlay_surfaces.rs
//
// Overlay/PiP arrangement math.

use crate::arrange::screen_arrangement_types::{OverlayBox, Viewport};

pub fn max_overlay_z(containers: &[OverlayBox]) -> i32 {
    containers.iter().map(|entry| entry.z).max().unwrap_or(0)
}

pub fn default_overlay_box(container_id: String, viewport: Viewport, z: i32) -> OverlayBox {
    let width = 420.0_f64.min((viewport.w - 24.0).max(0.0));
    let height = 340.0_f64.min((viewport.h - 68.0).max(0.0));
    OverlayBox {
        container_id,
        x: (viewport.w - width - 20.0).max(12.0),
        // Keep the default PiP clear of the lower-right area where preview
        // timelines and their primary actions commonly sit. Explicit moves
        // are still persisted by the arrangement owner as before.
        y: 56.0_f64.min((viewport.h - height - 12.0).max(0.0)),
        w: width,
        h: height,
        z,
    }
}

pub fn snap_to_viewport(x: f64, y: f64, w: f64, h: f64, viewport: Viewport) -> (f64, f64) {
    const PEEK: f64 = 12.0;
    let sx = x.min(viewport.w - PEEK).max(-w + PEEK);
    let sy = y.min(viewport.h - PEEK).max(-h + PEEK);
    (sx, sy)
}

#[cfg(test)]
mod tests {
    use super::default_overlay_box;
    use crate::arrange::screen_arrangement_types::Viewport;

    #[test]
    fn default_overlay_stays_above_preview_controls() {
        let box_ = default_overlay_box(
            "work".to_string(),
            Viewport {
                w: 1280.0,
                h: 820.0,
            },
            3,
        );

        assert_eq!(box_.x, 840.0);
        assert_eq!(box_.y, 56.0);
        assert_eq!(box_.w, 420.0);
        assert_eq!(box_.h, 340.0);
        assert_eq!(box_.z, 3);
    }

    #[test]
    fn default_overlay_fits_a_narrow_window() {
        let box_ = default_overlay_box("work".to_string(), Viewport { w: 320.0, h: 480.0 }, 3);

        assert_eq!(box_.x, 12.0);
        assert_eq!(box_.y, 56.0);
        assert_eq!(box_.w, 296.0);
        assert_eq!(box_.h, 340.0);
    }
}
