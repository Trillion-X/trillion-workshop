// src/native_boot/tool_label_locale.rs
// Purpose: Name the tool-label locale every boot uses: the engine's own qualified ICU 78.2, the same on a computer and in the hosting app.
// Invariants: One locale per process, opened once from the engine's profile DATA; a refused open is an error, never a different locale.
// Security: Reads no file and no account credential; the profile and ICU are built into the engine.
// AI Assistant Directive: Keep one locale for every boot path; do not add a per-host or per-file source.

use super::Error;
use crate::tool_label_locale::{self as locale, QualifiedLocale};
use std::sync::{Arc, OnceLock};

static ENGINE_LOCALE: OnceLock<Arc<QualifiedLocale>> = OnceLock::new();

/// The engine's qualified tool-label locale. The first call opens it; a refused open is an error and is not
/// replaced by any other locale.
pub fn engine_locale() -> Result<Arc<QualifiedLocale>, Error> {
    if let Some(held) = ENGINE_LOCALE.get() {
        return Ok(held.clone());
    }
    let opened = Arc::new(locale::engine().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?);
    Ok(ENGINE_LOCALE.get_or_init(|| opened).clone())
}
