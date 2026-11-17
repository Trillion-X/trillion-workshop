// src/host/tool_runs.rs
//
// Purpose: What the record store takes from the engine's tool runs: the computer under this program (`os`) and the tools
// installed for the account, which declare record kinds. This tool runs inside no account's Workshop, so no tool is
// installed for it and no installed tool declares a record kind.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#[path = "os.rs"]
pub mod os;

pub mod tools {
    use serde_json::Value;
    use std::{path::Path, sync::Arc};

    /// The refusal of reading the installed tools: this tool installs none, so it never refuses.
    #[derive(Debug, Clone)]
    pub struct Refused(crate::refusal_cause::Cause);
    impl Refused {
        pub fn cause(&self) -> crate::refusal_cause::Cause {
            self.0.clone()
        }
    }

    /// The Workshop of tools installed for the account this tool serves: none.
    pub struct Workshop;
    impl Workshop {
        /// The rows of the installed tools, or none when none are installed.
        pub fn installed_rows(&self, _: &Path) -> Result<Option<Arc<Vec<Value>>>, Refused> {
            Ok(None)
        }
    }

    pub fn shipped() -> Result<&'static Workshop, Refused> {
        static WORKSHOP: Workshop = Workshop;
        Ok(&WORKSHOP)
    }
}
