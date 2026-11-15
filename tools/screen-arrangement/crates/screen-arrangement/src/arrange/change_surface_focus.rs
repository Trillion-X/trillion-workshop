// crates/screen-arrangement/src/arrange/change_surface_focus.rs
//
// Focus transition logic for screen-arrangement.

use crate::arrange::screen_arrangement_types::LayoutState;

pub fn focus_container(mut state: LayoutState, container_id: String) -> LayoutState {
    if state.containers.contains_key(&container_id) {
        state.focused_container_id = Some(container_id);
    }
    state
}

pub fn unfocus_container(mut state: LayoutState) -> LayoutState {
    state.focused_container_id = None;
    state
}

pub fn toggle_maximize(mut state: LayoutState, container_id: String) -> LayoutState {
    if state.maximized_container_id.as_deref() == Some(container_id.as_str()) {
        state.maximized_container_id = None;
    } else if state.containers.contains_key(&container_id) {
        state.maximized_container_id = Some(container_id);
    }
    state
}
