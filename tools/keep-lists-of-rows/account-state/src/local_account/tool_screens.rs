//! LocalAccount mount for the existing tool-screen physical reader.
//!
//! This adapter retains the already selected browser own-record source for the
//! whole operation. It does not create a reader, select a path or account, or
//! duplicate projection and authority policy.

use super::LocalAccount;
use crate::{
    ecma_json::JsString,
    tool_fact_page,
    workspace_tool_screens::{
        self, CurrentToolScreenAuthority, Failure, Limits, ToolScreenPage, ToolScreenProjection,
    },
};
use std::sync::{atomic::AtomicBool, Arc};

impl LocalAccount {
    /// Compose one provisional tool-screen page from the same selected current
    /// browser own-record source used by the existing workspace record reader.
    /// The held snapshot is always finished before any page can be disclosed.
    pub fn current_tool_screen_page(
        &mut self,
        session_id: &str,
        authority: &mut impl CurrentToolScreenAuthority,
        request: &tool_fact_page::PageRequest,
        read_limits: &tool_fact_page::Limits,
        projection: &ToolScreenProjection,
        host: &JsString,
        limits: &Limits,
        cancel: Arc<AtomicBool>,
    ) -> Result<ToolScreenPage, Failure> {
        let mut source = self
            .current_record_source(session_id, cancel.clone())
            .map_err(|error| crate::carry_cause!(Failure::Source, error))?;
        let provisional = workspace_tool_screens::read_tool_screen_page(
            &mut source,
            authority,
            request,
            read_limits,
            projection,
            host,
            limits,
            &cancel,
        );
        if source.finish().is_err() {
            return Err(crate::cause!(Failure::Source));
        }
        provisional
    }
}
