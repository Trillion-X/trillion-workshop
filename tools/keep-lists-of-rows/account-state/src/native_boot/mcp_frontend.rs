//! Original MCP capture supplied by the existing selected frontend descriptor.
//! No renderer, origin, account or entitlement is created here. The selected
//! source reader checks its exact pinned receipt; the shared capture owner
//! checks fixed sibling names, document/resource pins and typed origin fields.

use super::{Error, Frontend, MCP_CAPTURE};
use crate::workspace_page::CapturedMcpResource;
use std::{ffi::OsStr, sync::Arc};

impl Frontend {
    /// Open the original MCP document through the same retained artifact owner.
    /// Missing optional supply remains absent. A renamed receipt cannot borrow
    /// capture.json's sibling interpretation or become a second loader route.
    pub fn open_mcp_resource(&self) -> Result<Option<Arc<CapturedMcpResource>>, Error> {
        let Some(source) = self.file(MCP_CAPTURE) else {
            return Ok(None);
        };
        source.read()?;
        if source.path.file_name() != Some(OsStr::new("capture.json")) {
            return Err(crate::cause!(Error::Invalid));
        }
        let root = source.path.parent().ok_or(crate::cause!(Error::Invalid))?;
        CapturedMcpResource::open(root, &source.pin.blake3)
            .map(|resource| Some(Arc::new(resource)))
            .map_err(|error| Error::Unavailable(error.cause()))
    }
}
