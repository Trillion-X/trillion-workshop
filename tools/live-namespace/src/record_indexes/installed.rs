//! The field indexes of the tools installed for one account.
//!
//! Each tool's row declares the indexes of the kinds it keeps (its `record_model.indexes`); they are read from the
//! joined model of the account's installed tools (record_model_policy `installed`), and none is named here.
//! Parsing stays bounded by `Indexes::from_json` and does not mint readiness or source authority.
//!
//! Ports old trillion parts/record-log/do-work/record-log-store.mjs `recordLogStore({indexes})`, fed from the one
//! shipped src/record-indexes.json; dropped: that one file (docs/PRINCIPLES.md rule 5).

use super::{Error, Indexes, Result};
use std::path::Path;

/// The indexes the account's installed tools declare, refusing malformed or oversized DATA, or a model that refuses.
pub fn installed_indexes(state_root: &Path) -> Result<Indexes> {
    let installed = crate::record_model_policy::installed(state_root).map_err(|_| Error::Invalid("record model unavailable", crate::cause!()))?;
    let bytes = serde_json::to_vec(&serde_json::json!({"indexes": installed.indexes()}))?;
    Indexes::from_json(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_indexes_are_the_installed_tools_and_two_alike_refuse() {
        let state = crate::record_model_policy::state_with_tool_model(json!({"kinds": [{"type": "note"}],
            "indexes": [{"type": "note", "name": "by-day", "paths": [["day"]]}]}));
        let indexes = installed_indexes(state.path()).unwrap();
        assert!(indexes.declared("note", "by-day").is_ok());
        assert!(indexes.declared("note", "by-week").is_err());
        // A state folder with no tools installed declares no index.
        let bare = tempfile::tempdir().unwrap();
        assert!(installed_indexes(bare.path()).unwrap().declared("note", "by-day").is_err());
        let twice = crate::record_model_policy::state_with_tool_model(json!({"indexes": [
            {"type": "note", "name": "by-day", "paths": [["day"]]}, {"type": "note", "name": "by-day", "paths": [["at"]]}]}));
        assert!(installed_indexes(twice.path()).is_err());
    }
}
