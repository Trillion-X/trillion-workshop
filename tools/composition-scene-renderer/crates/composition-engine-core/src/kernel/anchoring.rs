//! crates/composition-engine-core/src/kernel/anchoring.rs
//!
//! Pure functions for overlay/popover positioning with flip/slide collision handling.
//! No side effects, no platform dependencies.
//!
//! Ported from: frontends/web/composition-engine/kernel/anchoring.ts

use super::types::{AnchorResult, Placement, Point, Rect, Size};
use serde::{Deserialize, Serialize};

// ============================================================================
// Types
// ============================================================================

/// Alignment along the cross-axis
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Alignment {
    #[default]
    Start,
    Center,
    End,
}

/// Collision handling strategy
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CollisionStrategy {
    None,
    Flip,
    Slide,
    #[default]
    FlipSlide,
}

/// Configuration for anchor positioning
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct AnchorConfig {
    /// Gap between reference and floating element (default: 4)
    pub gap: Option<f64>,
    /// Cross-axis alignment (default: Start)
    pub alignment: Option<Alignment>,
    /// Collision handling strategy (default: FlipSlide)
    pub collision: Option<CollisionStrategy>,
    /// Padding from viewport edges (default: 0)
    pub padding: Option<f64>,
}

impl AnchorConfig {
    pub fn gap(&self) -> f64 {
        self.gap.unwrap_or(4.0)
    }

    pub fn alignment(&self) -> Alignment {
        self.alignment.unwrap_or_default()
    }

    pub fn collision(&self) -> CollisionStrategy {
        self.collision.unwrap_or_default()
    }

    pub fn padding(&self) -> f64 {
        self.padding.unwrap_or(0.0)
    }
}

/// Extended result with flip/shift metadata
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AnchorResultExtended {
    pub origin: Point,
    pub side: Placement,
    pub flipped: bool,
    pub shifted: bool,
}

// ============================================================================
// Core Positioning
// ============================================================================

/// Compute position for a floating element anchored to a reference element.
/// Handles collision detection with automatic flip/slide behavior.
pub fn anchor(
    reference: &Rect,
    floating: &Size,
    viewport: &Rect,
    preferred: &[Placement],
    config: &AnchorConfig,
) -> AnchorResult {
    let gap = config.gap();
    let alignment = config.alignment();
    let collision = config.collision();
    let padding = config.padding();

    // Build ordered list of sides to try (filter out 'auto')
    let order = build_placement_order(preferred);

    // Try each side in order
    for &side in &order {
        let rect = compute_position(reference, floating, side, alignment, gap);
        if fits_in_viewport(&rect, viewport, padding) {
            return AnchorResult {
                origin: Point::new(rect.x, rect.y),
                side,
            };
        }
    }

    // No side fits - apply collision strategy
    let primary_side = order[0];
    let primary_rect = compute_position(reference, floating, primary_side, alignment, gap);

    if collision == CollisionStrategy::None {
        return AnchorResult {
            origin: Point::new(primary_rect.x, primary_rect.y),
            side: primary_side,
        };
    }

    if collision == CollisionStrategy::Flip || collision == CollisionStrategy::FlipSlide {
        let opposite = get_opposite_side(primary_side);
        let flipped_rect = compute_position(reference, floating, opposite, alignment, gap);

        if fits_in_viewport(&flipped_rect, viewport, padding) {
            return AnchorResult {
                origin: Point::new(flipped_rect.x, flipped_rect.y),
                side: opposite,
            };
        }

        if collision == CollisionStrategy::FlipSlide {
            let clamped = clamp_to_viewport(&flipped_rect, viewport, padding);
            return AnchorResult {
                origin: Point::new(clamped.x, clamped.y),
                side: opposite,
            };
        }
    }

    if collision == CollisionStrategy::Slide || collision == CollisionStrategy::FlipSlide {
        let clamped = clamp_to_viewport(&primary_rect, viewport, padding);
        return AnchorResult {
            origin: Point::new(clamped.x, clamped.y),
            side: primary_side,
        };
    }

    AnchorResult {
        origin: Point::new(primary_rect.x, primary_rect.y),
        side: primary_side,
    }
}

/// Extended anchor function that returns flip/shift metadata.
pub fn anchor_extended(
    reference: &Rect,
    floating: &Size,
    viewport: &Rect,
    preferred: &[Placement],
    config: &AnchorConfig,
) -> AnchorResultExtended {
    let gap = config.gap();
    let alignment = config.alignment();
    let collision = config.collision();
    let padding = config.padding();

    let order = build_placement_order(preferred);
    let primary_side = order[0];
    let primary_rect = compute_position(reference, floating, primary_side, alignment, gap);

    // Try primary position
    if fits_in_viewport(&primary_rect, viewport, padding) {
        return AnchorResultExtended {
            origin: Point::new(primary_rect.x, primary_rect.y),
            side: primary_side,
            flipped: false,
            shifted: false,
        };
    }

    // Try other sides in order
    for side in order.iter().skip(1).copied() {
        let rect = compute_position(reference, floating, side, alignment, gap);
        if fits_in_viewport(&rect, viewport, padding) {
            return AnchorResultExtended {
                origin: Point::new(rect.x, rect.y),
                side,
                flipped: side == get_opposite_side(primary_side),
                shifted: false,
            };
        }
    }

    // Apply collision strategy with metadata
    if collision == CollisionStrategy::Flip || collision == CollisionStrategy::FlipSlide {
        let opposite = get_opposite_side(primary_side);
        let flipped_rect = compute_position(reference, floating, opposite, alignment, gap);

        if fits_in_viewport(&flipped_rect, viewport, padding) {
            return AnchorResultExtended {
                origin: Point::new(flipped_rect.x, flipped_rect.y),
                side: opposite,
                flipped: true,
                shifted: false,
            };
        }

        if collision == CollisionStrategy::FlipSlide {
            let clamped = clamp_to_viewport(&flipped_rect, viewport, padding);
            return AnchorResultExtended {
                origin: Point::new(clamped.x, clamped.y),
                side: opposite,
                flipped: true,
                shifted: true,
            };
        }
    }

    if collision == CollisionStrategy::Slide || collision == CollisionStrategy::FlipSlide {
        let clamped = clamp_to_viewport(&primary_rect, viewport, padding);
        return AnchorResultExtended {
            origin: Point::new(clamped.x, clamped.y),
            side: primary_side,
            flipped: false,
            shifted: true,
        };
    }

    AnchorResultExtended {
        origin: Point::new(primary_rect.x, primary_rect.y),
        side: primary_side,
        flipped: false,
        shifted: false,
    }
}

// ============================================================================
// Internal Helpers
// ============================================================================

fn build_placement_order(preferred: &[Placement]) -> Vec<Placement> {
    let mut order: Vec<Placement> = preferred
        .iter()
        .filter(|&&p| p != Placement::Auto)
        .copied()
        .collect();

    if order.is_empty() {
        order = vec![
            Placement::Bottom,
            Placement::Top,
            Placement::Right,
            Placement::Left,
        ];
    }

    order
}

fn compute_position(
    reference: &Rect,
    floating: &Size,
    side: Placement,
    alignment: Alignment,
    gap: f64,
) -> Rect {
    let (x, y) = match side {
        Placement::Top => {
            let y = reference.y - gap - floating.h;
            let x = compute_aligned_position(reference.x, reference.w, floating.w, alignment);
            (x, y)
        }
        Placement::Bottom => {
            let y = reference.y + reference.h + gap;
            let x = compute_aligned_position(reference.x, reference.w, floating.w, alignment);
            (x, y)
        }
        Placement::Left => {
            let x = reference.x - gap - floating.w;
            let y = compute_aligned_position(reference.y, reference.h, floating.h, alignment);
            (x, y)
        }
        Placement::Right => {
            let x = reference.x + reference.w + gap;
            let y = compute_aligned_position(reference.y, reference.h, floating.h, alignment);
            (x, y)
        }
        Placement::Auto => {
            // Auto should be filtered out, but default to bottom
            let y = reference.y + reference.h + gap;
            let x = compute_aligned_position(reference.x, reference.w, floating.w, alignment);
            (x, y)
        }
    };

    Rect::new(x, y, floating.w, floating.h)
}

fn compute_aligned_position(
    ref_start: f64,
    ref_size: f64,
    floating_size: f64,
    alignment: Alignment,
) -> f64 {
    match alignment {
        Alignment::Start => ref_start,
        Alignment::Center => ref_start + (ref_size - floating_size) / 2.0,
        Alignment::End => ref_start + ref_size - floating_size,
    }
}

fn fits_in_viewport(rect: &Rect, viewport: &Rect, padding: f64) -> bool {
    rect.x >= viewport.x + padding
        && rect.y >= viewport.y + padding
        && rect.x + rect.w <= viewport.x + viewport.w - padding
        && rect.y + rect.h <= viewport.y + viewport.h - padding
}

fn clamp_to_viewport(rect: &Rect, viewport: &Rect, padding: f64) -> Rect {
    let min_x = viewport.x + padding;
    let max_x = viewport.x + viewport.w - padding - rect.w;
    let min_y = viewport.y + padding;
    let max_y = viewport.y + viewport.h - padding - rect.h;

    Rect::new(
        rect.x.max(min_x).min(max_x),
        rect.y.max(min_y).min(max_y),
        rect.w,
        rect.h,
    )
}

fn get_opposite_side(side: Placement) -> Placement {
    match side {
        Placement::Top => Placement::Bottom,
        Placement::Bottom => Placement::Top,
        Placement::Left => Placement::Right,
        Placement::Right => Placement::Left,
        Placement::Auto => Placement::Bottom, // Default
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_viewport() -> Rect {
        Rect::new(0.0, 0.0, 800.0, 600.0)
    }

    fn make_reference() -> Rect {
        Rect::new(400.0, 300.0, 100.0, 40.0) // Center of viewport
    }

    fn make_floating() -> Size {
        Size::new(200.0, 100.0)
    }

    #[test]
    fn test_anchor_bottom() {
        let viewport = make_viewport();
        let reference = make_reference();
        let floating = make_floating();

        let result = anchor(
            &reference,
            &floating,
            &viewport,
            &[Placement::Bottom],
            &AnchorConfig::default(),
        );

        assert_eq!(result.side, Placement::Bottom);
        assert_eq!(result.origin.y, reference.y + reference.h + 4.0); // Below reference + gap
    }

    #[test]
    fn test_anchor_top() {
        let viewport = make_viewport();
        let reference = make_reference();
        let floating = make_floating();

        let result = anchor(
            &reference,
            &floating,
            &viewport,
            &[Placement::Top],
            &AnchorConfig::default(),
        );

        assert_eq!(result.side, Placement::Top);
        assert_eq!(result.origin.y, reference.y - 4.0 - floating.h); // Above reference - gap
    }

    #[test]
    fn test_anchor_flip() {
        let viewport = Rect::new(0.0, 0.0, 800.0, 600.0);
        // Reference near bottom of viewport
        let reference = Rect::new(400.0, 550.0, 100.0, 40.0);
        let floating = Size::new(200.0, 100.0);

        let result = anchor(
            &reference,
            &floating,
            &viewport,
            &[Placement::Bottom],
            &AnchorConfig::default(),
        );

        // Should flip to top since bottom doesn't fit
        assert_eq!(result.side, Placement::Top);
    }

    #[test]
    fn test_anchor_alignment_center() {
        let viewport = make_viewport();
        let reference = make_reference();
        let floating = make_floating();

        let config = AnchorConfig {
            alignment: Some(Alignment::Center),
            ..Default::default()
        };

        let result = anchor(
            &reference,
            &floating,
            &viewport,
            &[Placement::Bottom],
            &config,
        );

        // Center aligned
        let expected_x = reference.x + (reference.w - floating.w) / 2.0;
        assert_eq!(result.origin.x, expected_x);
    }

    #[test]
    fn test_anchor_alignment_end() {
        let viewport = make_viewport();
        let reference = make_reference();
        let floating = make_floating();

        let config = AnchorConfig {
            alignment: Some(Alignment::End),
            ..Default::default()
        };

        let result = anchor(
            &reference,
            &floating,
            &viewport,
            &[Placement::Bottom],
            &config,
        );

        // End aligned
        let expected_x = reference.x + reference.w - floating.w;
        assert_eq!(result.origin.x, expected_x);
    }

    #[test]
    fn test_anchor_extended_metadata() {
        let viewport = Rect::new(0.0, 0.0, 800.0, 600.0);
        // Reference near bottom - will need flip
        let reference = Rect::new(400.0, 550.0, 100.0, 40.0);
        let floating = Size::new(200.0, 100.0);

        let result = anchor_extended(
            &reference,
            &floating,
            &viewport,
            &[Placement::Bottom],
            &AnchorConfig::default(),
        );

        assert!(result.flipped);
        assert_eq!(result.side, Placement::Top);
    }

    #[test]
    fn test_anchor_slide() {
        let viewport = Rect::new(0.0, 0.0, 800.0, 600.0);
        // Reference at left edge
        let reference = Rect::new(0.0, 300.0, 100.0, 40.0);
        let floating = Size::new(200.0, 100.0);

        let config = AnchorConfig {
            collision: Some(CollisionStrategy::Slide),
            alignment: Some(Alignment::Start),
            ..Default::default()
        };

        let result = anchor_extended(
            &reference,
            &floating,
            &viewport,
            &[Placement::Left],
            &config,
        );

        // Left placement won't fit, should slide
        assert!(result.shifted || result.origin.x >= 0.0);
    }

    #[test]
    fn test_get_opposite_side() {
        assert_eq!(get_opposite_side(Placement::Top), Placement::Bottom);
        assert_eq!(get_opposite_side(Placement::Bottom), Placement::Top);
        assert_eq!(get_opposite_side(Placement::Left), Placement::Right);
        assert_eq!(get_opposite_side(Placement::Right), Placement::Left);
    }

    #[test]
    fn test_build_placement_order() {
        // Filters out Auto
        let order = build_placement_order(&[Placement::Auto, Placement::Top, Placement::Bottom]);
        assert_eq!(order, vec![Placement::Top, Placement::Bottom]);

        // Defaults when empty
        let order = build_placement_order(&[Placement::Auto]);
        assert_eq!(
            order,
            vec![
                Placement::Bottom,
                Placement::Top,
                Placement::Right,
                Placement::Left
            ]
        );
    }

    #[test]
    fn test_fits_in_viewport() {
        let viewport = Rect::new(0.0, 0.0, 800.0, 600.0);

        let inside = Rect::new(100.0, 100.0, 200.0, 100.0);
        assert!(fits_in_viewport(&inside, &viewport, 0.0));

        let outside = Rect::new(-50.0, 100.0, 200.0, 100.0);
        assert!(!fits_in_viewport(&outside, &viewport, 0.0));

        let with_padding = Rect::new(5.0, 5.0, 200.0, 100.0);
        assert!(!fits_in_viewport(&with_padding, &viewport, 10.0));
    }
}
