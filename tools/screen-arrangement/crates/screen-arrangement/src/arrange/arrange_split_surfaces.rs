// crates/screen-arrangement/src/arrange/arrange_split_surfaces.rs
//
// Split/tiled arrangement math.
//
// A split keeps, for each child, its length along the split (`sizes`, in the unit `size_unit` names) and optionally
// its own length across it (`cross_sizes`, layout pixels, absent = fills). `keep_lengths` draws pixel lengths exactly
// (the arrangement scrolls) instead of scaling them to fit. Every operation here carries all three with the child they
// belong to, so a pane keeps its geometry when its neighbours change.

use crate::arrange::{
    screen_arrangement_types::{SplitDir, SplitSizeUnit, SplitTreeNode},
    RootPosition,
};

/// A split as its parts, so operations can take one apart and put it back together whole.
struct SplitParts {
    dir: SplitDir,
    sizes: Vec<f64>,
    size_unit: SplitSizeUnit,
    cross_sizes: Vec<Option<f64>>,
    keep_lengths: bool,
    stack_below: Option<f64>,
    children: Vec<SplitTreeNode>,
}

impl SplitParts {
    fn of(node: SplitTreeNode) -> Result<SplitParts, SplitTreeNode> {
        match node {
            SplitTreeNode::Split {
                dir,
                sizes,
                size_unit,
                cross_sizes,
                keep_lengths,
                stack_below,
                children,
            } => Ok(SplitParts {
                dir,
                sizes,
                size_unit,
                cross_sizes,
                keep_lengths,
                stack_below,
                children,
            }),
            leaf => Err(leaf),
        }
    }

    fn node(self) -> SplitTreeNode {
        // A cross length that fills is no length at all: an all-filling split keeps no list.
        let cross_sizes = if self.cross_sizes.iter().all(Option::is_none) {
            Vec::new()
        } else {
            self.cross_sizes
        };
        SplitTreeNode::Split {
            dir: self.dir,
            sizes: self.sizes,
            size_unit: self.size_unit,
            cross_sizes,
            keep_lengths: self.keep_lengths,
            stack_below: self.stack_below,
            children: self.children,
        }
    }

    /// Each child's cross length, one entry per child.
    fn cross_per_child(&self) -> Vec<Option<f64>> {
        (0..self.children.len())
            .map(|index| self.cross_sizes.get(index).copied().flatten())
            .collect()
    }

    fn map_children(
        mut self,
        mut change: impl FnMut(SplitTreeNode) -> SplitTreeNode,
    ) -> SplitParts {
        self.children = self.children.into_iter().map(&mut change).collect();
        self
    }
}

/// A new split of two panes sharing the space equally, as a split always began.
pub fn even_split(dir: SplitDir, children: Vec<SplitTreeNode>) -> SplitTreeNode {
    let count = children.len().max(1) as f64;
    SplitTreeNode::Split {
        dir,
        sizes: vec![1.0 / count; children.len()],
        size_unit: SplitSizeUnit::Share,
        cross_sizes: Vec::new(),
        keep_lengths: false,
        stack_below: None,
        children,
    }
}

fn leaf_is(node: &SplitTreeNode, container_id: &str) -> bool {
    matches!(node, SplitTreeNode::Leaf { container_id: id } if id == container_id)
}

pub fn remove_from_tree(node: Option<SplitTreeNode>, container_id: &str) -> Option<SplitTreeNode> {
    let node = node?;
    let parts = match SplitParts::of(node) {
        Ok(parts) => parts,
        Err(leaf) => {
            return if leaf_is(&leaf, container_id) {
                None
            } else {
                Some(leaf)
            }
        }
    };
    let cross = parts.cross_per_child();
    let mut kept_sizes = Vec::new();
    let mut kept_cross = Vec::new();
    let mut kept = Vec::new();
    for (index, child) in parts.children.into_iter().enumerate() {
        if let Some(child) = remove_from_tree(Some(child), container_id) {
            kept_sizes.push(parts.sizes.get(index).copied().unwrap_or(0.0));
            kept_cross.push(cross[index]);
            kept.push(child);
        }
    }
    match kept.len() {
        0 => None,
        1 => kept.into_iter().next(),
        n => Some(
            SplitParts {
                dir: parts.dir,
                // A pixel size belongs to its pane, so the panes that
                // remain keep theirs and the arrangement gets shorter.
                sizes: match parts.size_unit {
                    SplitSizeUnit::Px => kept_sizes,
                    SplitSizeUnit::Share => vec![1.0 / n as f64; n],
                },
                size_unit: parts.size_unit,
                cross_sizes: kept_cross,
                keep_lengths: parts.keep_lengths,
                stack_below: parts.stack_below,
                children: kept,
            }
            .node(),
        ),
    }
}

/// Where a new pane goes beside its target: halving the target (`Half`), or at its own length while every pane keeps
/// its size and the arrangement grows (`Beside`, with the new pane's length and the target's drawn length).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NewPaneLength {
    Half,
    Beside { new_px: f64, target_px: f64 },
}

pub fn insert_adjacent(
    node: SplitTreeNode,
    target_container_id: &str,
    new_container_id: &str,
    dir: SplitDir,
    position: RootPosition,
) -> SplitTreeNode {
    insert_new_pane(
        node,
        target_container_id,
        new_container_id,
        dir,
        position,
        NewPaneLength::Half,
    )
}

pub fn insert_new_pane(
    node: SplitTreeNode,
    target_container_id: &str,
    new_container_id: &str,
    dir: SplitDir,
    position: RootPosition,
    length: NewPaneLength,
) -> SplitTreeNode {
    let new_leaf = || SplitTreeNode::Leaf {
        container_id: new_container_id.to_string(),
    };
    let mut parts = match SplitParts::of(node) {
        Ok(parts) => parts,
        Err(leaf) => {
            if !leaf_is(&leaf, target_container_id) {
                return leaf;
            }
            let (children, sizes) = match (position, length) {
                (RootPosition::Before, NewPaneLength::Half) => {
                    (vec![new_leaf(), leaf], vec![0.5, 0.5])
                }
                (RootPosition::After, NewPaneLength::Half) => {
                    (vec![leaf, new_leaf()], vec![0.5, 0.5])
                }
                (RootPosition::Before, NewPaneLength::Beside { new_px, target_px }) => {
                    (vec![new_leaf(), leaf], vec![new_px, target_px])
                }
                (RootPosition::After, NewPaneLength::Beside { new_px, target_px }) => {
                    (vec![leaf, new_leaf()], vec![target_px, new_px])
                }
            };
            let beside = matches!(length, NewPaneLength::Beside { .. });
            return SplitParts {
                dir,
                sizes,
                size_unit: if beside {
                    SplitSizeUnit::Px
                } else {
                    SplitSizeUnit::Share
                },
                cross_sizes: Vec::new(),
                keep_lengths: beside,
                stack_below: None,
                children,
            }
            .node();
        }
    };
    let direct_target = parts
        .children
        .iter()
        .position(|child| leaf_is(child, target_container_id));
    if let (Some(at), true) = (direct_target, parts.dir == dir) {
        let insert_at = match position {
            RootPosition::Before => at,
            RootPosition::After => at + 1,
        };
        let mut cross = parts.cross_per_child();
        match length {
            // Added beside: every pane keeps the length it is drawn at now (shares become the pixels they stand for,
            // read from the target's drawn length) and the new pane takes its own; the split keeps them all exactly.
            NewPaneLength::Beside { new_px, target_px } => {
                if parts.size_unit.is_share() {
                    let target_share = parts
                        .sizes
                        .get(at)
                        .copied()
                        .filter(|share| *share > 0.0)
                        .unwrap_or(1.0);
                    let per_share = target_px / target_share;
                    parts.sizes = parts.sizes.iter().map(|share| share * per_share).collect();
                    parts.size_unit = SplitSizeUnit::Px;
                }
                parts.sizes.insert(insert_at.min(parts.sizes.len()), new_px);
                parts.keep_lengths = true;
            }
            // In a pixel split running the same way, split in half means exactly that: the target gives up half
            // its length to the new pane and every other pane keeps its own (kept lengths or drawn in proportion).
            NewPaneLength::Half if parts.size_unit == SplitSizeUnit::Px => {
                let half = parts.sizes.get(at).copied().unwrap_or(0.0) / 2.0;
                if let Some(target) = parts.sizes.get_mut(at) {
                    *target = half;
                }
                parts.sizes.insert(insert_at.min(parts.sizes.len()), half);
            }
            NewPaneLength::Half => {
                return parts
                    .map_children(|child| {
                        insert_new_pane(
                            child,
                            target_container_id,
                            new_container_id,
                            dir,
                            position,
                            length,
                        )
                    })
                    .node();
            }
        }
        cross.insert(insert_at.min(cross.len()), None);
        parts.cross_sizes = cross;
        parts.children.insert(insert_at, new_leaf());
        return parts.node();
    }
    parts
        .map_children(|child| {
            insert_new_pane(
                child,
                target_container_id,
                new_container_id,
                dir,
                position,
                length,
            )
        })
        .node()
}

pub fn swap_in_tree(node: SplitTreeNode, a: &str, b: &str) -> SplitTreeNode {
    match SplitParts::of(node) {
        Ok(parts) => parts.map_children(|child| swap_in_tree(child, a, b)).node(),
        Err(SplitTreeNode::Leaf { container_id }) => {
            let next = if container_id == a {
                b.to_string()
            } else if container_id == b {
                a.to_string()
            } else {
                container_id
            };
            SplitTreeNode::Leaf { container_id: next }
        }
        Err(other) => other,
    }
}

pub fn collect_leaf_ids(node: Option<&SplitTreeNode>) -> Vec<String> {
    match node {
        None => Vec::new(),
        Some(SplitTreeNode::Leaf { container_id }) => vec![container_id.clone()],
        Some(SplitTreeNode::Split { children, .. }) => children
            .iter()
            .flat_map(|child| collect_leaf_ids(Some(child)))
            .collect(),
    }
}

/// Change the split at `path`, leaving every other split as it is.
fn change_split_at_path(
    node: SplitTreeNode,
    path: &[usize],
    change: &mut dyn FnMut(SplitParts) -> SplitParts,
) -> SplitTreeNode {
    let parts = match SplitParts::of(node) {
        Ok(parts) => parts,
        Err(leaf) => return leaf,
    };
    match path.split_first() {
        None => change(parts).node(),
        Some((&head, rest)) => {
            let mut index = 0;
            parts
                .map_children(|child| {
                    let at = index;
                    index += 1;
                    if at == head {
                        change_split_at_path(child, rest, change)
                    } else {
                        child
                    }
                })
                .node()
        }
    }
}

/// Record the sizes of the split at `path`. Shares are normalised to sum to
/// one; pixel sizes are each pane's own length and are kept exactly.
pub fn update_sizes_at_path(
    node: SplitTreeNode,
    path: &[usize],
    new_sizes: &[f64],
    new_unit: SplitSizeUnit,
) -> SplitTreeNode {
    change_split_at_path(node, path, &mut |mut parts| {
        let valid = new_sizes.len() == parts.children.len()
            && new_sizes.iter().all(|size| size.is_finite() && *size > 0.0);
        if !valid {
            return parts;
        }
        parts.sizes = new_sizes.to_vec();
        if new_unit.is_share() {
            normalize_sizes(&mut parts.sizes);
        }
        parts.size_unit = new_unit;
        parts
    })
}

/// Record one child's length across the split at `path`, in layout pixels; `None` lets it fill the split again.
pub fn update_cross_at_path(
    node: SplitTreeNode,
    path: &[usize],
    index: usize,
    length: Option<f64>,
) -> SplitTreeNode {
    change_split_at_path(node, path, &mut |mut parts| {
        if index >= parts.children.len() || length.is_some_and(|px| !px.is_finite() || px <= 0.0) {
            return parts;
        }
        let mut cross = parts.cross_per_child();
        cross[index] = length;
        parts.cross_sizes = cross;
        parts
    })
}

pub fn normalize_sizes(sizes: &mut [f64]) {
    let total: f64 = sizes.iter().sum();
    if total > 0.0 {
        for size in sizes {
            *size /= total;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(id: &str) -> SplitTreeNode {
        SplitTreeNode::Leaf {
            container_id: id.to_string(),
        }
    }

    #[test]
    fn remove_from_tree_collapses_single_child_splits() {
        let tree = SplitTreeNode::Split {
            dir: SplitDir::Row,
            sizes: vec![0.5, 0.5],
            size_unit: SplitSizeUnit::Share,
            cross_sizes: Vec::new(),
            keep_lengths: false,
            stack_below: None,
            children: vec![leaf("a"), leaf("b")],
        };

        assert_eq!(remove_from_tree(Some(tree), "a"), Some(leaf("b")));
    }

    #[test]
    fn insert_adjacent_creates_a_split_at_the_target_leaf() {
        let result = insert_adjacent(leaf("a"), "a", "b", SplitDir::Column, RootPosition::After);
        assert!(matches!(result, SplitTreeNode::Split { .. }));
    }

    #[test]
    fn insert_adjacent_can_place_the_new_leaf_before_the_target_leaf() {
        let result = insert_adjacent(leaf("a"), "a", "b", SplitDir::Row, RootPosition::Before);
        assert!(matches!(
            result,
            SplitTreeNode::Split { children, .. }
                if matches!(&children[0], SplitTreeNode::Leaf { container_id } if container_id == "b")
                    && matches!(&children[1], SplitTreeNode::Leaf { container_id } if container_id == "a")
        ));
    }

    fn px_row(sizes: Vec<f64>, ids: &[&str]) -> SplitTreeNode {
        SplitTreeNode::Split {
            dir: SplitDir::Row,
            sizes,
            size_unit: SplitSizeUnit::Px,
            cross_sizes: Vec::new(),
            keep_lengths: false,
            stack_below: None,
            children: ids.iter().map(|id| leaf(id)).collect(),
        }
    }

    fn kept_row(sizes: Vec<f64>, cross: Vec<Option<f64>>, ids: &[&str]) -> SplitTreeNode {
        SplitTreeNode::Split {
            dir: SplitDir::Row,
            sizes,
            size_unit: SplitSizeUnit::Px,
            cross_sizes: cross,
            keep_lengths: true,
            stack_below: None,
            children: ids.iter().map(|id| leaf(id)).collect(),
        }
    }

    #[test]
    fn a_pixel_resize_keeps_every_other_pane_at_its_exact_size() {
        let tree = px_row(vec![400.0, 500.0, 600.0], &["a", "b", "c"]);
        let resized = update_sizes_at_path(tree, &[], &[700.0, 500.0, 600.0], SplitSizeUnit::Px);
        assert_eq!(resized, px_row(vec![700.0, 500.0, 600.0], &["a", "b", "c"]));
    }

    #[test]
    fn a_share_layout_becomes_pixels_on_its_first_pane_resize() {
        let tree = SplitTreeNode::Split {
            dir: SplitDir::Row,
            sizes: vec![0.5, 0.5],
            size_unit: SplitSizeUnit::Share,
            cross_sizes: Vec::new(),
            keep_lengths: false,
            stack_below: None,
            children: vec![leaf("a"), leaf("b")],
        };
        let resized = update_sizes_at_path(tree, &[], &[900.0, 500.0], SplitSizeUnit::Px);
        assert_eq!(resized, px_row(vec![900.0, 500.0], &["a", "b"]));
    }

    #[test]
    fn sizes_that_do_not_name_every_pane_change_nothing() {
        let tree = px_row(vec![400.0, 500.0], &["a", "b"]);
        assert_eq!(
            update_sizes_at_path(tree.clone(), &[], &[700.0], SplitSizeUnit::Px),
            tree
        );
    }

    #[test]
    fn closing_a_pixel_pane_keeps_the_others_sizes() {
        let tree = px_row(vec![400.0, 500.0, 600.0], &["a", "b", "c"]);
        assert_eq!(
            remove_from_tree(Some(tree), "b"),
            Some(px_row(vec![400.0, 600.0], &["a", "c"]))
        );
    }

    #[test]
    fn split_in_half_halves_a_pixel_pane_and_keeps_the_others() {
        let tree = px_row(vec![400.0, 500.0], &["a", "b"]);
        let result = insert_adjacent(tree, "a", "n", SplitDir::Row, RootPosition::After);
        assert_eq!(result, px_row(vec![200.0, 200.0, 500.0], &["a", "n", "b"]));
    }

    #[test]
    fn split_in_half_in_a_split_that_keeps_lengths_still_halves() {
        let tree = kept_row(vec![984.0, 480.0], vec![None, None], &["a", "b"]);
        let result = insert_adjacent(tree, "a", "n", SplitDir::Row, RootPosition::After);
        assert_eq!(
            result,
            kept_row(vec![492.0, 492.0, 480.0], Vec::new(), &["a", "n", "b"])
        );
    }

    #[test]
    fn pixel_sizes_round_trip_through_saved_layout_data() {
        let tree = px_row(vec![400.0, 500.0], &["a", "b"]);
        let saved = serde_json::to_value(&tree).expect("serialize");
        assert_eq!(saved["sizeUnit"], "px");
        let restored: SplitTreeNode = serde_json::from_value(saved).expect("deserialize");
        assert_eq!(restored, tree);
        let legacy: SplitTreeNode = serde_json::from_value(serde_json::json!({
            "kind": "split", "dir": "row", "sizes": [0.5, 0.5],
            "children": [{"kind": "leaf", "containerId": "a"}, {"kind": "leaf", "containerId": "b"}]
        }))
        .expect("legacy layout");
        assert!(matches!(
            legacy,
            SplitTreeNode::Split {
                size_unit: SplitSizeUnit::Share,
                ..
            }
        ));
    }

    #[test]
    fn a_pane_added_beside_a_lone_pane_keeps_its_drawn_length_and_takes_its_own() {
        let result = insert_new_pane(
            leaf("a"),
            "a",
            "n",
            SplitDir::Row,
            RootPosition::After,
            NewPaneLength::Beside {
                new_px: 480.0,
                target_px: 1200.0,
            },
        );
        assert_eq!(
            result,
            kept_row(vec![1200.0, 480.0], Vec::new(), &["a", "n"])
        );
    }

    #[test]
    fn a_pane_added_beside_turns_shares_into_the_pixels_they_stand_for() {
        let tree = SplitTreeNode::Split {
            dir: SplitDir::Row,
            sizes: vec![0.25, 0.75],
            size_unit: SplitSizeUnit::Share,
            cross_sizes: Vec::new(),
            keep_lengths: false,
            stack_below: None,
            children: vec![leaf("a"), leaf("b")],
        };
        let result = insert_new_pane(
            tree,
            "a",
            "n",
            SplitDir::Row,
            RootPosition::Before,
            NewPaneLength::Beside {
                new_px: 300.0,
                target_px: 400.0,
            },
        );
        assert_eq!(
            result,
            kept_row(vec![300.0, 400.0, 1200.0], Vec::new(), &["n", "a", "b"])
        );
    }

    #[test]
    fn a_pane_added_below_a_row_pane_nests_a_kept_column_there() {
        let tree = px_row(vec![400.0, 500.0], &["a", "b"]);
        let result = insert_new_pane(
            tree,
            "b",
            "n",
            SplitDir::Column,
            RootPosition::After,
            NewPaneLength::Beside {
                new_px: 360.0,
                target_px: 700.0,
            },
        );
        let SplitTreeNode::Split { children, .. } = result else {
            panic!("split")
        };
        assert_eq!(
            children[1],
            SplitTreeNode::Split {
                dir: SplitDir::Column,
                sizes: vec![700.0, 360.0],
                size_unit: SplitSizeUnit::Px,
                cross_sizes: Vec::new(),
                keep_lengths: true,
                stack_below: None,
                children: vec![leaf("b"), leaf("n")],
            }
        );
    }

    #[test]
    fn a_cross_length_is_kept_per_pane_and_follows_it_through_inserts_and_closes() {
        let tree = px_row(vec![400.0, 500.0, 600.0], &["a", "b", "c"]);
        let tall = update_cross_at_path(tree, &[], 1, Some(900.0));
        assert_eq!(
            tall,
            SplitTreeNode::Split {
                dir: SplitDir::Row,
                sizes: vec![400.0, 500.0, 600.0],
                size_unit: SplitSizeUnit::Px,
                cross_sizes: vec![None, Some(900.0), None],
                keep_lengths: false,
                stack_below: None,
                children: vec![leaf("a"), leaf("b"), leaf("c")],
            }
        );
        let added = insert_adjacent(tall, "a", "n", SplitDir::Row, RootPosition::After);
        let SplitTreeNode::Split { cross_sizes, .. } = &added else {
            panic!("split")
        };
        assert_eq!(cross_sizes, &vec![None, None, Some(900.0), None]);
        let closed = remove_from_tree(Some(added), "b").expect("tree");
        let SplitTreeNode::Split { cross_sizes, .. } = &closed else {
            panic!("split")
        };
        assert!(
            cross_sizes.is_empty(),
            "the only cross length left with its pane"
        );
    }

    #[test]
    fn a_cross_length_set_back_to_fill_leaves_no_list_and_a_bad_length_changes_nothing() {
        let tree = px_row(vec![400.0, 500.0], &["a", "b"]);
        let tall = update_cross_at_path(tree.clone(), &[], 0, Some(300.0));
        assert_eq!(update_cross_at_path(tall.clone(), &[], 0, None), tree);
        assert_eq!(
            update_cross_at_path(tall.clone(), &[], 0, Some(f64::NAN)),
            tall
        );
        assert_eq!(
            update_cross_at_path(tall.clone(), &[], 7, Some(200.0)),
            tall
        );
    }

    #[test]
    fn cross_lengths_and_kept_lengths_round_trip_through_saved_layout_data() {
        let tree = kept_row(vec![400.0, 500.0], vec![Some(300.0), None], &["a", "b"]);
        let saved = serde_json::to_value(&tree).expect("serialize");
        assert_eq!(saved["crossSizes"], serde_json::json!([300.0, null]));
        assert_eq!(saved["keepLengths"], true);
        let restored: SplitTreeNode = serde_json::from_value(saved).expect("deserialize");
        assert_eq!(restored, tree);
        let plain = serde_json::to_value(px_row(vec![1.0, 2.0], &["a", "b"])).expect("serialize");
        assert!(plain.get("crossSizes").is_none() && plain.get("keepLengths").is_none());
    }
}
