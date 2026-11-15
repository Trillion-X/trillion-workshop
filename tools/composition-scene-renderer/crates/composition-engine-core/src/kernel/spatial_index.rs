//! crates/composition-engine-core/src/kernel/spatial_index.rs
//!
//! # Purpose
//!
//! Spatial index for viewport culling (visibility determination) via bounding box queries.
//! Used during render() to determine which nodes are visible in the current viewport
//! (O(log n + visible) instead of O(total)).
//!
//! # Implementation Notes
//!
//! Uses a brute-force Vec-based approach (linear scan). At max_scene_nodes=10,000,
//! linear scan is fast enough. Do NOT add external crates — use what's available.
//!
//! # Non-Negotiable Invariants
//!
//! 1. **O(n) query for small n** — Linear scan is acceptable at 10K nodes
//! 2. **Kept in sync with scene tree** — insert/remove/update called whenever
//!    a node's position changes
//! 3. **Query returns node IDs only** — Host looks up other node data separately
//! 4. **Physics-only** — No Society vocabulary
//!
//! # Platform Portability
//!
//! Pure Rust, no platform dependencies. Compiles to WASM and native.
//!
//! # AI Directive
//!
//! The extensive documentation in this codebase is a critical design feature.
//! You are FORBIDDEN from simplifying or removing it. Your mandate is to
//! MAINTAIN and EXTEND this level of meticulous detail.

use std::collections::HashSet;

use super::types::{Camera, Rect, Size, ID};

// ============================================================================
// Spatial Index Entry
// ============================================================================

/// Entry in the spatial index (node ID + bounding rect).
#[derive(Debug, Clone, PartialEq)]
struct SpatialEntry {
    /// Node ID
    pub id: ID,
    /// Bounding rectangle in world coordinates
    pub envelope: Rect,
}

// ============================================================================
// Spatial Index
// ============================================================================

/// Spatial index for viewport culling using brute-force linear scan.
///
/// At max_scene_nodes=10,000, linear scan query + intersection test is
/// fast enough for real-time render. If this becomes a bottleneck, upgrade
/// to R-tree or quadtree.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpatialIndex {
    /// All indexed entries (node ID + bounding rect)
    entries: Vec<SpatialEntry>,
}

impl SpatialIndex {
    /// Create a new empty spatial index.
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// Insert a node into the index.
    pub fn insert(&mut self, id: ID, envelope: Rect) {
        // Check if already exists (shouldn't happen, but be safe)
        if !self.entries.iter().any(|e| e.id == id) {
            self.entries.push(SpatialEntry { id, envelope });
        }
    }

    /// Remove a node from the index.
    pub fn remove(&mut self, id: &str) {
        self.entries.retain(|e| e.id != id);
    }

    /// Update a node's bounding rect (remove + re-insert).
    pub fn update(&mut self, id: &str, envelope: Rect) {
        self.remove(id);
        self.insert(id.to_string(), envelope);
    }

    /// Query for all visible nodes (O(n) linear scan).
    ///
    /// Returns node IDs of all entries whose bounding boxes intersect with
    /// the query rect (expanded by margin).
    pub fn query_visible(&self, camera: &Camera, viewport: Size, margin: f64) -> HashSet<ID> {
        let query_rect = camera.visible_rect(viewport);
        let expanded = Rect {
            x: query_rect.x - margin,
            y: query_rect.y - margin,
            w: query_rect.w + margin * 2.0,
            h: query_rect.h + margin * 2.0,
        };

        self.entries
            .iter()
            .filter(|entry| entry.envelope.intersects(&expanded))
            .map(|entry| entry.id.clone())
            .collect()
    }

    /// Clear the index.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Get the number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Check if empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spatial_index_insert_remove() {
        let mut idx = SpatialIndex::new();
        idx.insert("node1".to_string(), Rect::new(0.0, 0.0, 100.0, 100.0));
        assert_eq!(idx.len(), 1);

        idx.remove("node1");
        assert_eq!(idx.len(), 0);
    }

    #[test]
    fn test_spatial_index_query_visible() {
        let mut idx = SpatialIndex::new();
        idx.insert("node1".to_string(), Rect::new(0.0, 0.0, 100.0, 100.0));
        idx.insert("node2".to_string(), Rect::new(200.0, 200.0, 100.0, 100.0));
        idx.insert("node3".to_string(), Rect::new(50.0, 50.0, 100.0, 100.0));

        let camera = Camera {
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 1.0,
        };
        let viewport = Size::new(800.0, 600.0);
        let visible = idx.query_visible(&camera, viewport, 0.0);

        // At pan(0,0) zoom 1.0, visible world is [0,0] to [800,600]
        // node1 [0,0,100,100] — within viewport ✓
        // node2 [200,200,100,100] — within viewport ✓
        // node3 [50,50,100,100] — within viewport ✓
        assert!(visible.contains("node1"));
        assert!(visible.contains("node2"));
        assert!(visible.contains("node3"));
    }

    #[test]
    fn test_spatial_index_query_with_margin() {
        let mut idx = SpatialIndex::new();
        idx.insert("node1".to_string(), Rect::new(850.0, 0.0, 100.0, 100.0));

        let camera = Camera {
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 1.0,
        };
        let viewport = Size::new(800.0, 600.0);

        // Without margin: should not be visible
        let visible_no_margin = idx.query_visible(&camera, viewport, 0.0);
        assert!(!visible_no_margin.contains("node1"));

        // With margin: should be visible
        let visible_with_margin = idx.query_visible(&camera, viewport, 200.0);
        assert!(visible_with_margin.contains("node1"));
    }

    #[test]
    fn test_spatial_index_update() {
        let mut idx = SpatialIndex::new();
        idx.insert("node1".to_string(), Rect::new(0.0, 0.0, 100.0, 100.0));
        idx.update("node1", Rect::new(200.0, 200.0, 100.0, 100.0));
        assert_eq!(idx.len(), 1);

        let camera = Camera {
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 1.0,
        };
        let viewport = Size::new(800.0, 600.0);
        let visible = idx.query_visible(&camera, viewport, 0.0);

        // At pan(0,0) zoom 1.0, visible world is [0,0] to [800,600]
        // node1 moved to [200,200,100,100] — still within viewport
        assert!(visible.contains("node1"));
    }

    #[test]
    fn test_spatial_index_rect_intersects() {
        let rect1 = Rect::new(0.0, 0.0, 100.0, 100.0);
        let rect2 = Rect::new(50.0, 50.0, 100.0, 100.0);
        let rect3 = Rect::new(200.0, 200.0, 100.0, 100.0);

        assert!(rect1.intersects(&rect2));
        assert!(rect2.intersects(&rect1));
        assert!(!rect1.intersects(&rect3));
        assert!(!rect3.intersects(&rect1));
    }

    #[test]
    fn test_spatial_index_camera_transformations() {
        let camera = Camera {
            pan_x: 100.0,
            pan_y: 50.0,
            zoom: 2.0,
        };

        // World point (0, 0) should map to screen (100, 50) at zoom 2x
        let world_point = super::super::types::Point::new(0.0, 0.0);
        let screen_point = camera.world_to_screen(world_point);
        assert_eq!(screen_point.x, 100.0);
        assert_eq!(screen_point.y, 50.0);

        // Screen point (100, 50) should map back to world (0, 0)
        let back_to_world = camera.screen_to_world(screen_point);
        assert!((back_to_world.x - world_point.x).abs() < 0.001);
        assert!((back_to_world.y - world_point.y).abs() < 0.001);
    }

    #[test]
    fn test_spatial_index_empty_query() {
        let idx = SpatialIndex::new();
        let camera = Camera::default();
        let viewport = Size::new(800.0, 600.0);
        let visible = idx.query_visible(&camera, viewport, 0.0);
        assert!(visible.is_empty());
    }

    #[test]
    fn test_spatial_index_multiple_nodes() {
        let mut idx = SpatialIndex::new();
        for i in 0..100 {
            let x = (i % 10) as f64 * 100.0;
            let y = (i / 10) as f64 * 100.0;
            idx.insert(format!("node{}", i), Rect::new(x, y, 50.0, 50.0));
        }
        assert_eq!(idx.len(), 100);

        // Grid: 10 cols × 10 rows, each node at (x*100, y*100) with size 50×50
        // Nodes span from [0,0] to [950,950]
        // At pan(0,0) zoom 1.0, visible world is [0,0] to [800,600]
        // This includes:
        // - Cols 0-7 (x: 0-700, all have nodes within 800)
        // - Rows 0-5 (y: 0-500, all fit in 600)
        // That's 8 × 6 = 48 nodes visible
        let camera = Camera::default();
        let viewport = Size::new(800.0, 600.0);
        let visible = idx.query_visible(&camera, viewport, 0.0);
        assert!(visible.len() >= 48 && visible.len() <= 56);
    }

    #[test]
    fn test_spatial_index_zoom_affects_visibility() {
        let mut idx = SpatialIndex::new();
        idx.insert("far".to_string(), Rect::new(5000.0, 5000.0, 50.0, 50.0));
        idx.insert("near".to_string(), Rect::new(50.0, 50.0, 50.0, 50.0));

        // At zoom 1.0, visible world is [(0-0)/1, (0-0)/1] to [(800-0)/1, (600-0)/1] = [0,0] to [800,600]
        // far [5000,5000,50,50] — NOT visible
        // near [50,50,50,50] — visible
        let camera1 = Camera {
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 1.0,
        };
        let viewport = Size::new(800.0, 600.0);
        let visible1 = idx.query_visible(&camera1, viewport, 0.0);
        assert!(!visible1.contains("far"));
        assert!(visible1.contains("near"));

        // At zoom 10.0 (MORE zoomed in), visible world is [0/10,0/10] to [800/10,600/10] = [0,0] to [80,60]
        // far [5000,5000,50,50] — NOT visible (way out of bounds)
        // near [50,50,50,50] overlaps [0,0,80,60] at [50,50,80,60] — visible (partial overlap)
        let camera2 = Camera {
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 10.0,
        };
        let visible2 = idx.query_visible(&camera2, viewport, 0.0);
        assert!(!visible2.contains("far"));
        assert!(visible2.contains("near"));

        // At zoom 0.1 (zoomed OUT), visible world is [0/0.1,0/0.1] to [800/0.1,600/0.1] = [0,0] to [8000,6000]
        // far [5000,5000,50,50] — visible
        // near [50,50,50,50] — visible
        let camera3 = Camera {
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 0.1,
        };
        let visible3 = idx.query_visible(&camera3, viewport, 0.0);
        assert!(visible3.contains("far"));
        assert!(visible3.contains("near"));
    }

    #[test]
    fn test_spatial_index_pan_affects_visibility() {
        let mut idx = SpatialIndex::new();
        idx.insert("node1".to_string(), Rect::new(0.0, 0.0, 50.0, 50.0));
        idx.insert("node2".to_string(), Rect::new(1000.0, 1000.0, 50.0, 50.0));

        // With pan(0,0) zoom 1.0, visible world is [0,0] to [800,600]
        // node1 [0,0,50,50] — visible
        // node2 [1000,1000,50,50] — not visible
        let camera1 = Camera {
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 1.0,
        };
        let viewport = Size::new(800.0, 600.0);
        let visible1 = idx.query_visible(&camera1, viewport, 0.0);
        assert!(visible1.contains("node1"));
        assert!(!visible1.contains("node2"));

        // With pan(-1000,-1000) zoom 1.0:
        // visible_rect top-left: screen(0,0) → world((0-(-1000))/1, (0-(-1000))/1) = (1000, 1000)
        // visible_rect bottom-right: screen(800,600) → world((800-(-1000))/1, (600-(-1000))/1) = (1800, 1600)
        // So visible world is [1000,1000] to [1800,1600]
        // node1 [0,0,50,50] — not visible (left of visible world)
        // node2 [1000,1000,50,50] — visible
        let camera2 = Camera {
            pan_x: -1000.0,
            pan_y: -1000.0,
            zoom: 1.0,
        };
        let visible2 = idx.query_visible(&camera2, viewport, 0.0);
        assert!(!visible2.contains("node1"));
        assert!(visible2.contains("node2"));
    }

    #[test]
    fn test_spatial_index_boundary_conditions() {
        let mut idx = SpatialIndex::new();
        // Node exactly at viewport edge
        idx.insert("edge".to_string(), Rect::new(800.0, 0.0, 10.0, 10.0));
        // Node just outside viewport
        idx.insert("outside".to_string(), Rect::new(810.0, 0.0, 10.0, 10.0));

        let camera = Camera::default();
        let viewport = Size::new(800.0, 600.0);
        let visible = idx.query_visible(&camera, viewport, 0.0);
        // Edge node should not be visible (outside exact bounds)
        assert!(!visible.contains("edge"));
        assert!(!visible.contains("outside"));
    }

    #[test]
    fn test_spatial_index_duplicate_insert() {
        let mut idx = SpatialIndex::new();
        idx.insert("node1".to_string(), Rect::new(0.0, 0.0, 100.0, 100.0));
        assert_eq!(idx.len(), 1);

        // Insert same ID again - should not duplicate
        idx.insert("node1".to_string(), Rect::new(200.0, 200.0, 100.0, 100.0));
        assert_eq!(idx.len(), 1);
    }

    #[test]
    fn test_spatial_index_remove_nonexistent() {
        let mut idx = SpatialIndex::new();
        idx.insert("node1".to_string(), Rect::new(0.0, 0.0, 100.0, 100.0));

        // Remove non-existent node (should not panic)
        idx.remove("node2");
        assert_eq!(idx.len(), 1);

        idx.remove("node1");
        assert_eq!(idx.len(), 0);
    }

    #[test]
    fn test_spatial_index_clear() {
        let mut idx = SpatialIndex::new();
        for i in 0..10 {
            idx.insert(
                format!("node{}", i),
                Rect::new(i as f64 * 100.0, 0.0, 50.0, 50.0),
            );
        }
        assert_eq!(idx.len(), 10);

        idx.clear();
        assert_eq!(idx.len(), 0);
        assert!(idx.is_empty());
    }
}
