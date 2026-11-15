//! Transport-neutral eligible read plans from the original workspace planner.
//! No route/query parser, browser authority or execution receipt is created.
#[cfg(test)]
use super::{read_input, ReadInput};
#[cfg(test)]
use crate::workspace::WorkspaceError;
#[cfg(test)]
pub(crate) enum Plan { Records, Viewer, ShowRules }
#[cfg(test)]
pub(crate) fn plan(operation: &str, input: &serde_json::Value) -> Result<Plan, WorkspaceError> {
    match read_input(operation, input)? {
        ReadInput::Records(_) => Ok(Plan::Records),
        ReadInput::Viewer => Ok(Plan::Viewer),
        ReadInput::ShowRules => Ok(Plan::ShowRules),
        // Every existing action/specialized source keeps its own typed
        // admission. Private presentation reach does not replace those checks.
        _ => Err(crate::cause!(WorkspaceError::Unavailable)),
    }
}
