// Purpose: Supply rule-binding text operations from the qualified collation (crates/icu-collation).
// Invariants: explicit locale only (the profile's, or root for default lowercase), never the process default;
//   bounded output; a failed ICU call is a refusal.
// Security: never expose partial output.

use super::QualifiedLocale;
use crate::{
    ecma_json::JsString,
    rule_bindings::{Error, Result, TextSemantics},
    workspace_tool_screens::catalog,
};
use icu_collation::MAX_PROBE_UNITS;

#[track_caller]
fn refused(error: icu_collation::Error) -> Error {
    match error {
        icu_collation::Error::Bounds => crate::cause!(caller: Error::Bounds),
        icu_collation::Error::Source => crate::cause!(caller: Error::Unsupported),
    }
}

impl QualifiedLocale {
    /// Unicode uppercase in the profile's explicit locale. This is the checked primitive for callers matching
    /// `String.prototype.toLocaleUpperCase()`.
    pub fn to_locale_uppercase(&self, value: &JsString) -> Result<JsString> {
        self.collation.uppercase(value.units()).map(JsString::from_units).map_err(|error| refused(error))
    }

    /// Unicode default lowercase. The collator locale never changes String.toLowerCase.
    pub fn to_default_lowercase(&self, value: &JsString) -> Result<JsString> {
        self.collation.default_lowercase(value.units()).map(JsString::from_units).map_err(|error| refused(error))
    }

    fn lowercase(&self, value: &JsString) -> Result<JsString> {
        self.collation.lowercase(value.units()).map(JsString::from_units).map_err(|error| refused(error))
    }

    fn trim_empty(&self, value: &JsString) -> Result<bool> {
        if value.len() > MAX_PROBE_UNITS {
            return Err(crate::cause!(Error::Bounds));
        }
        // The catalog's ECMAScript WhiteSpace/LineTerminator set. Rust char::is_whitespace differs (e.g. U+0085).
        Ok(value.units().iter().all(|unit| catalog::js_space(*unit)))
    }
}

impl TextSemantics for QualifiedLocale {
    fn to_locale_lowercase(&mut self, value: &JsString) -> Result<JsString> {
        self.lowercase(value)
    }

    fn trim_is_empty(&mut self, value: &JsString) -> Result<bool> {
        self.trim_empty(value)
    }
}

// Native startup already shares this qualified owner with the tool-screen comparator; rule compilation borrows the
// same collation, and its calls stay serialized by the collator's mutex.
impl TextSemantics for &QualifiedLocale {
    fn to_locale_lowercase(&mut self, value: &JsString) -> Result<JsString> {
        self.lowercase(value)
    }

    fn trim_is_empty(&mut self, value: &JsString) -> Result<bool> {
        self.trim_empty(value)
    }
}
