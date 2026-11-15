// src/tool_label_locale.rs
//
// Purpose: Give the engine's tool screens and rules the one qualified collation from crates/icu-collation.
// Invariants: The same ICU 78.2 locale on a computer and in the hosting app. Every refusal is a fixed Failure.
// Security: No file, no path, no dynamic loading; the ICU owner is the icu-collation crate.
// AI Assistant Directive: Keep this adapter thin. Put ICU calls in crates/icu-collation.

use crate::{native_boot::tool_screens::ToolLabelLocale, workspace_tool_screens::Failure};
use std::cmp::Ordering;

mod text;

pub use icu_collation::Profile;

/// The engine's collation, qualified against its profile, as the tool screens and rules use it.
pub struct QualifiedLocale {
    collation: icu_collation::Collation,
}

impl ToolLabelLocale for QualifiedLocale {
    fn assert_current(&self) -> Result<(), Failure> {
        // Nothing on disk can change under a statically linked library.
        Ok(())
    }

    fn compare(
        &self,
        left: &crate::ecma_json::JsString,
        right: &crate::ecma_json::JsString,
    ) -> Result<Ordering, Failure> {
        self.collation.compare(left.units(), right.units()).map_err(|error| failure(error))
    }
}

#[track_caller]
fn failure(error: icu_collation::Error) -> Failure {
    match error {
        icu_collation::Error::Source => crate::cause!(caller: Failure::Source),
        icu_collation::Error::Bounds => crate::cause!(caller: Failure::Bounds),
    }
}

/// The engine's own profile, parsed.
pub fn engine_profile() -> Result<Profile, Failure> {
    icu_collation::engine_profile().map_err(|error| failure(error))
}

/// The engine's tool-label locale.
pub fn engine() -> Result<QualifiedLocale, Failure> {
    icu_collation::Collation::engine()
        .map(|collation| QualifiedLocale { collation })
        .map_err(|error| failure(error))
}

/// Qualify the linked ICU against an exact profile.
pub fn open(profile: &Profile) -> Result<QualifiedLocale, Failure> {
    icu_collation::Collation::open(profile)
        .map(|collation| QualifiedLocale { collation })
        .map_err(|error| failure(error))
}
