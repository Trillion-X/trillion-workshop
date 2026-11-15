// crates/screen-arrangement/src/arrange/publish_arrangement_delta.rs
//
// Publish arrangement changes as machine-readable full/delta/noop replies.

use crate::arrange::screen_arrangement_types::{
    LayoutContainer, LayoutState, LayoutSurface, SurfaceLabel, TabMeta,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum NullableUpdate<T> {
    #[default]
    Unchanged,
    Set {
        value: T,
    },
    Clear,
}

impl<T> NullableUpdate<T> {
    pub fn is_unchanged(&self) -> bool {
        matches!(self, Self::Unchanged)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum LayoutPublication {
    Full { state: LayoutState },
    Delta { delta: LayoutDelta },
    Noop,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDelta {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_cells: Vec<String>,
    pub container_patches: Vec<ContainerPatch>,
    pub tab_patches: Vec<TabPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layouts_changed: Option<Vec<LayoutSurface>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_changed: Option<SurfaceLabel>,
    pub focus_changed: NullableUpdate<String>,
    pub maximize_changed: NullableUpdate<String>,
}

impl LayoutDelta {
    pub fn is_empty(&self) -> bool {
        self.changed_cells.is_empty()
            && self.container_patches.is_empty()
            && self.tab_patches.is_empty()
            && self.layouts_changed.is_none()
            && self.surface_changed.is_none()
            && self.focus_changed.is_unchanged()
            && self.maximize_changed.is_unchanged()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContainerPatch {
    Added { container: LayoutContainer },
    Removed { container_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TabPatch {
    Added {
        group_id: String,
        tab: TabMeta,
    },
    Removed {
        tab_id: String,
        group_id: String,
    },
    Activated {
        group_id: String,
        tab_id: Option<String>,
    },
}

pub fn publish_arrangement_delta(previous: &LayoutState, next: &LayoutState) -> LayoutPublication {
    if previous == next {
        return LayoutPublication::Noop;
    }

    let mut delta = LayoutDelta::default();

    push_changed_cell(
        &mut delta,
        "containers",
        previous.containers != next.containers,
    );
    push_changed_cell(
        &mut delta,
        "tabGroups",
        previous.tab_groups != next.tab_groups,
    );
    push_changed_cell(&mut delta, "tabs", previous.tabs != next.tabs);
    push_changed_cell(&mut delta, "layouts", previous.layouts != next.layouts);
    push_changed_cell(&mut delta, "surface", previous.surface != next.surface);
    push_changed_cell(
        &mut delta,
        "focusedContainerId",
        previous.focused_container_id != next.focused_container_id,
    );
    push_changed_cell(
        &mut delta,
        "maximizedContainerId",
        previous.maximized_container_id != next.maximized_container_id,
    );

    for (id, container) in &next.containers {
        if !previous.containers.contains_key(id) {
            delta.container_patches.push(ContainerPatch::Added {
                container: container.clone(),
            });
        }
    }
    for id in previous.containers.keys() {
        if !next.containers.contains_key(id) {
            delta.container_patches.push(ContainerPatch::Removed {
                container_id: id.clone(),
            });
        }
    }

    for (id, tab) in &next.tabs {
        if !previous.tabs.contains_key(id) {
            let group_id = next
                .tab_groups
                .iter()
                .find_map(|(group_id, group)| {
                    group
                        .tab_ids
                        .iter()
                        .any(|tab_id| tab_id == id)
                        .then(|| group_id.clone())
                })
                .unwrap_or_default();
            delta.tab_patches.push(TabPatch::Added {
                group_id,
                tab: tab.clone(),
            });
        }
    }
    for id in previous.tabs.keys() {
        if !next.tabs.contains_key(id) {
            let group_id = previous
                .tab_groups
                .iter()
                .find_map(|(group_id, group)| {
                    group
                        .tab_ids
                        .iter()
                        .any(|tab_id| tab_id == id)
                        .then(|| group_id.clone())
                })
                .unwrap_or_default();
            delta.tab_patches.push(TabPatch::Removed {
                tab_id: id.clone(),
                group_id,
            });
        }
    }
    for (group_id, group) in &next.tab_groups {
        let previous_active = previous
            .tab_groups
            .get(group_id)
            .and_then(|entry| entry.active_tab_id.clone());
        if previous_active != group.active_tab_id {
            delta.tab_patches.push(TabPatch::Activated {
                group_id: group_id.clone(),
                tab_id: group.active_tab_id.clone(),
            });
        }
    }

    if previous.layouts != next.layouts {
        delta.layouts_changed = Some(next.layouts.clone());
    }
    if previous.surface != next.surface {
        delta.surface_changed = Some(next.surface.clone());
    }
    delta.focus_changed = nullable_change(
        previous.focused_container_id.clone(),
        next.focused_container_id.clone(),
    );
    delta.maximize_changed = nullable_change(
        previous.maximized_container_id.clone(),
        next.maximized_container_id.clone(),
    );

    if delta.is_empty() {
        LayoutPublication::Noop
    } else {
        LayoutPublication::Delta { delta }
    }
}

fn nullable_change<T: PartialEq>(previous: Option<T>, next: Option<T>) -> NullableUpdate<T> {
    if previous == next {
        NullableUpdate::Unchanged
    } else if let Some(value) = next {
        NullableUpdate::Set { value }
    } else {
        NullableUpdate::Clear
    }
}

fn push_changed_cell(delta: &mut LayoutDelta, cell: &str, changed: bool) {
    if changed {
        delta.changed_cells.push(cell.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::{publish_arrangement_delta, LayoutPublication};
    use crate::arrange::screen_arrangement_types::LayoutState;

    #[test]
    fn publishes_changed_cell_for_existing_tab_metadata_change() {
        let previous = LayoutState::default();
        let mut next = previous.clone();
        next.tabs
            .get_mut("surface-default")
            .expect("default tab exists")
            .title = "Renamed".to_string();

        let publication = publish_arrangement_delta(&previous, &next);

        let LayoutPublication::Delta { delta } = publication else {
            panic!("tab metadata changes must publish a delta");
        };
        assert_eq!(delta.changed_cells, vec!["tabs"]);
        assert!(delta.tab_patches.is_empty());
    }

    #[test]
    fn publishes_changed_cell_for_surface_change() {
        let previous = LayoutState::default();
        let mut next = previous.clone();
        next.surface = "canvas".to_string();

        let publication = publish_arrangement_delta(&previous, &next);

        let LayoutPublication::Delta { delta } = publication else {
            panic!("surface changes must publish a delta");
        };
        assert_eq!(delta.changed_cells, vec!["surface"]);
        assert_eq!(delta.surface_changed, Some("canvas".to_string()));
    }
}
