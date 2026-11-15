//! crates/composition-engine-core/src/kernel/edge_router.rs
//!
//! # Purpose
//!
//! Compute edge routes (visual paths) from source to target nodes.
//! Routes are determined from node layout frames and anchor points.
//!
//! # Architecture
//!
//! Simple orthogonal routing: direct line from source anchor to target anchor.
//! Future enhancement: multi-point orthogonal or curved paths.
//!
//! # Non-Negotiable Invariants
//!
//! 1. **Route uses anchor points** — if anchor is center, use node center; if top/bottom/left/right, use that edge
//! 2. **Deterministic** — same inputs always produce same route
//! 3. **Physics-only** — no Society vocabulary
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

use std::collections::HashMap;

use super::types::{Anchor, EdgeConnection, EdgeRoute, LayoutFrame, Point, ID};

// ============================================================================
// Edge Router
// ============================================================================

/// Computes edge routes from node frames and connections.
pub struct EdgeRouter;

impl EdgeRouter {
    /// Compute all edge routes for a set of connections.
    ///
    /// # Arguments
    ///
    /// * `connections` - Edge connections to route
    /// * `frames` - Node layout frames (ID -> frame)
    ///
    /// # Returns
    ///
    /// Vector of routes (one per connection)
    pub fn compute_routes(
        connections: &[EdgeConnection],
        frames: &HashMap<ID, LayoutFrame>,
    ) -> Vec<EdgeRoute> {
        connections
            .iter()
            .filter_map(|conn| Self::compute_single_route(conn, frames))
            .collect()
    }

    /// Compute a single edge route.
    fn compute_single_route(
        conn: &EdgeConnection,
        frames: &HashMap<ID, LayoutFrame>,
    ) -> Option<EdgeRoute> {
        let source_frame = frames.get(&conn.source_id)?;
        let target_frame = frames.get(&conn.target_id)?;

        let source_point = Self::anchor_point(source_frame, conn.source_anchor);
        let target_point = Self::anchor_point(target_frame, conn.target_anchor);

        Some(EdgeRoute {
            edge_id: conn.edge_id.clone(),
            source_id: conn.source_id.clone(),
            target_id: conn.target_id.clone(),
            points: vec![source_point, target_point],
        })
    }

    /// Get the point on a node frame for a given anchor.
    fn anchor_point(frame: &LayoutFrame, anchor: Anchor) -> Point {
        let x = frame.rect.x;
        let y = frame.rect.y;
        let w = frame.rect.w;
        let h = frame.rect.h;

        match anchor {
            Anchor::Top => Point::new(x + w / 2.0, y),
            Anchor::Bottom => Point::new(x + w / 2.0, y + h),
            Anchor::Left => Point::new(x, y + h / 2.0),
            Anchor::Right => Point::new(x + w, y + h / 2.0),
            Anchor::Center => Point::new(x + w / 2.0, y + h / 2.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_frame(x: f64, y: f64, w: f64, h: f64) -> LayoutFrame {
        LayoutFrame {
            rect: super::super::types::Rect::new(x, y, w, h),
            baseline: 0.0,
            measured_size: super::super::types::Size::new(w, h),
        }
    }

    #[test]
    fn test_edge_router_simple_route() {
        let mut frames = HashMap::new();
        frames.insert("node1".to_string(), make_frame(0.0, 0.0, 100.0, 100.0));
        frames.insert("node2".to_string(), make_frame(200.0, 0.0, 100.0, 100.0));

        let conn = EdgeConnection {
            edge_id: "edge1".to_string(),
            source_id: "node1".to_string(),
            target_id: "node2".to_string(),
            source_anchor: Anchor::Right,
            target_anchor: Anchor::Left,
        };

        let route = EdgeRouter::compute_single_route(&conn, &frames).unwrap();

        // Source anchor right: (100, 50)
        assert_eq!(route.points[0].x, 100.0);
        assert_eq!(route.points[0].y, 50.0);

        // Target anchor left: (200, 50)
        assert_eq!(route.points[1].x, 200.0);
        assert_eq!(route.points[1].y, 50.0);
    }

    #[test]
    fn test_edge_router_center_anchor() {
        let mut frames = HashMap::new();
        frames.insert("node1".to_string(), make_frame(0.0, 0.0, 100.0, 100.0));
        frames.insert("node2".to_string(), make_frame(200.0, 200.0, 100.0, 100.0));

        let conn = EdgeConnection {
            edge_id: "edge1".to_string(),
            source_id: "node1".to_string(),
            target_id: "node2".to_string(),
            source_anchor: Anchor::Center,
            target_anchor: Anchor::Center,
        };

        let route = EdgeRouter::compute_single_route(&conn, &frames).unwrap();

        // Source center: (50, 50)
        assert_eq!(route.points[0].x, 50.0);
        assert_eq!(route.points[0].y, 50.0);

        // Target center: (250, 250)
        assert_eq!(route.points[1].x, 250.0);
        assert_eq!(route.points[1].y, 250.0);
    }

    #[test]
    fn test_edge_router_missing_node() {
        let frames = HashMap::new();

        let conn = EdgeConnection {
            edge_id: "edge1".to_string(),
            source_id: "node1".to_string(),
            target_id: "node2".to_string(),
            source_anchor: Anchor::Center,
            target_anchor: Anchor::Center,
        };

        let route = EdgeRouter::compute_single_route(&conn, &frames);
        assert!(route.is_none());
    }

    #[test]
    fn test_edge_router_compute_routes() {
        let mut frames = HashMap::new();
        frames.insert("node1".to_string(), make_frame(0.0, 0.0, 100.0, 100.0));
        frames.insert("node2".to_string(), make_frame(200.0, 0.0, 100.0, 100.0));
        frames.insert("node3".to_string(), make_frame(0.0, 200.0, 100.0, 100.0));

        let connections = vec![
            EdgeConnection {
                edge_id: "edge1".to_string(),
                source_id: "node1".to_string(),
                target_id: "node2".to_string(),
                source_anchor: Anchor::Center,
                target_anchor: Anchor::Center,
            },
            EdgeConnection {
                edge_id: "edge2".to_string(),
                source_id: "node1".to_string(),
                target_id: "node3".to_string(),
                source_anchor: Anchor::Center,
                target_anchor: Anchor::Center,
            },
        ];

        let routes = EdgeRouter::compute_routes(&connections, &frames);
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].edge_id, "edge1");
        assert_eq!(routes[1].edge_id, "edge2");
    }

    #[test]
    fn test_edge_router_all_anchors() {
        let mut frames = HashMap::new();
        frames.insert("center".to_string(), make_frame(0.0, 0.0, 100.0, 100.0));
        frames.insert("top".to_string(), make_frame(0.0, 200.0, 100.0, 100.0));
        frames.insert("bottom".to_string(), make_frame(0.0, 400.0, 100.0, 100.0));
        frames.insert("left".to_string(), make_frame(200.0, 0.0, 100.0, 100.0));
        frames.insert("right".to_string(), make_frame(400.0, 0.0, 100.0, 100.0));

        let connections = vec![
            EdgeConnection {
                edge_id: "to_top".to_string(),
                source_id: "center".to_string(),
                target_id: "top".to_string(),
                source_anchor: Anchor::Top,
                target_anchor: Anchor::Center,
            },
            EdgeConnection {
                edge_id: "to_bottom".to_string(),
                source_id: "center".to_string(),
                target_id: "bottom".to_string(),
                source_anchor: Anchor::Bottom,
                target_anchor: Anchor::Center,
            },
            EdgeConnection {
                edge_id: "to_left".to_string(),
                source_id: "center".to_string(),
                target_id: "left".to_string(),
                source_anchor: Anchor::Left,
                target_anchor: Anchor::Center,
            },
            EdgeConnection {
                edge_id: "to_right".to_string(),
                source_id: "center".to_string(),
                target_id: "right".to_string(),
                source_anchor: Anchor::Right,
                target_anchor: Anchor::Center,
            },
        ];

        let routes = EdgeRouter::compute_routes(&connections, &frames);
        assert_eq!(routes.len(), 4);

        // Check that all routes have 2 points (source and target)
        for route in &routes {
            assert_eq!(route.points.len(), 2);
        }
    }

    #[test]
    fn test_edge_router_zero_sized_nodes() {
        let mut frames = HashMap::new();
        frames.insert("node1".to_string(), make_frame(0.0, 0.0, 0.0, 0.0));
        frames.insert("node2".to_string(), make_frame(100.0, 100.0, 0.0, 0.0));

        let conn = EdgeConnection {
            edge_id: "edge1".to_string(),
            source_id: "node1".to_string(),
            target_id: "node2".to_string(),
            source_anchor: Anchor::Center,
            target_anchor: Anchor::Center,
        };

        let route = EdgeRouter::compute_single_route(&conn, &frames).unwrap();
        assert_eq!(route.points[0].x, 0.0);
        assert_eq!(route.points[0].y, 0.0);
        assert_eq!(route.points[1].x, 100.0);
        assert_eq!(route.points[1].y, 100.0);
    }

    #[test]
    fn test_edge_router_large_distance() {
        let mut frames = HashMap::new();
        frames.insert("node1".to_string(), make_frame(0.0, 0.0, 100.0, 100.0));
        frames.insert(
            "node2".to_string(),
            make_frame(10000.0, 10000.0, 100.0, 100.0),
        );

        let conn = EdgeConnection {
            edge_id: "edge1".to_string(),
            source_id: "node1".to_string(),
            target_id: "node2".to_string(),
            source_anchor: Anchor::Center,
            target_anchor: Anchor::Center,
        };

        let route = EdgeRouter::compute_single_route(&conn, &frames).unwrap();
        let dx = route.points[1].x - route.points[0].x;
        let dy = route.points[1].y - route.points[0].y;
        assert!(dx > 0.0);
        assert!(dy > 0.0);
    }

    #[test]
    fn test_edge_router_overlapping_nodes() {
        let mut frames = HashMap::new();
        let frame = make_frame(0.0, 0.0, 100.0, 100.0);
        frames.insert("node1".to_string(), frame.clone());
        frames.insert("node2".to_string(), frame);

        let conn = EdgeConnection {
            edge_id: "edge1".to_string(),
            source_id: "node1".to_string(),
            target_id: "node2".to_string(),
            source_anchor: Anchor::Center,
            target_anchor: Anchor::Center,
        };

        let route = EdgeRouter::compute_single_route(&conn, &frames).unwrap();
        // Centers should be the same
        assert_eq!(route.points[0].x, route.points[1].x);
        assert_eq!(route.points[0].y, route.points[1].y);
    }

    #[test]
    fn test_edge_router_empty_connections() {
        let frames = HashMap::new();
        let connections = vec![];

        let routes = EdgeRouter::compute_routes(&connections, &frames);
        assert!(routes.is_empty());
    }

    #[test]
    fn test_edge_router_partial_frames() {
        let mut frames = HashMap::new();
        frames.insert("node1".to_string(), make_frame(0.0, 0.0, 100.0, 100.0));
        // node2 frame missing

        let connections = vec![
            EdgeConnection {
                edge_id: "edge1".to_string(),
                source_id: "node1".to_string(),
                target_id: "node2".to_string(),
                source_anchor: Anchor::Center,
                target_anchor: Anchor::Center,
            },
            EdgeConnection {
                edge_id: "edge2".to_string(),
                source_id: "node1".to_string(),
                target_id: "node1".to_string(),
                source_anchor: Anchor::Center,
                target_anchor: Anchor::Center,
            },
        ];

        let routes = EdgeRouter::compute_routes(&connections, &frames);
        // Only edge2 should be routed (both nodes exist)
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].edge_id, "edge2");
    }
}
