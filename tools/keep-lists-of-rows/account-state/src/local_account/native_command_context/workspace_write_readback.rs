//! Protected readback through the existing selected original record
//! and key decoders. The witness is part of the same sealed result; neither a
//! table snapshot nor an unchecked receipt can authorize disclosure.
use super::{workspace_write as contract, workspace_write_output as output, NativeContext};
use crate::{
    ecma_json::{JsString, Value},
    record_value::KeyState,
};
use rusqlite::Connection;

pub(super) struct ProtectedWorkspaceResult {
    result: Value,
    identity: String,
    witness: output::Witness,
}
impl ProtectedWorkspaceResult {
    pub(super) fn result(&self) -> &Value {
        &self.result
    }
    pub(super) fn identity(&self) -> &str {
        &self.identity
    }
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    if let Value::Object(value) = value {
        value.get(&name.into())
    } else {
        None
    }
}
fn original_identity(value: &str) -> bool {
    value.len() == 67
        && value.starts_with("1f:")
        && value[3..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl NativeContext<'_> {
    /// Read the exact original result and its source witness while the native
    /// owner holds a selected transaction. The caller still matches this
    /// identity with the committed journal receipt and actual execution.
    pub(super) fn protected_workspace_result(
        &self,
        db: &Connection,
    ) -> super::Result<ProtectedWorkspaceResult> {
        self.check(db, &self.binding)
            .map_err(super::journal_error)?;
        if self.binding.operation != contract::OPERATION {
            return Err(crate::cause!(super::Error::Refused));
        }
        let id = format!("resource-command-result:{}", self.binding.permit_id);
        let (kind, record) = self
            .record(db, &id)?
            .ok_or(crate::cause!(super::Error::ProtectedResultUnavailable))?;
        if kind != "resource-command-result" || field(&record, "source_record").is_some() {
            return Err(crate::cause!(super::Error::ProtectedResultUnavailable));
        }
        let Some(Value::Object(sealed)) = field(&record, "value") else {
            return Err(crate::cause!(super::Error::ProtectedResultUnavailable));
        };
        if !crate::record_sealed::is_sealed(sealed) || sealed.get(&"k".into()).is_some() {
            return Err(crate::cause!(super::Error::ProtectedResultUnavailable));
        }
        let KeyState::Present(key) = self.key_state(db, &id)? else {
            return Err(crate::cause!(super::Error::ProtectedResultUnavailable));
        };
        let (opened, _) = crate::record_sealed::open(
            &key,
            &id,
            &JsString::from("value"),
            sealed,
            Default::default(),
        )
        .map_err(|error| crate::carry_cause!(super::Error::ProtectedResultUnavailable, error))?
        .ok_or(crate::cause!(super::Error::ProtectedResultUnavailable))?;
        let result = field(&opened, "result")
            .cloned()
            .ok_or(crate::cause!(super::Error::ProtectedResultUnavailable))?;
        let witness = output::Witness::from_value(
            field(&opened, "workspace_output").ok_or(crate::cause!(super::Error::ProtectedResultUnavailable))?,
        )
        .map_err(|error| crate::carry_cause!(super::Error::ProtectedResultUnavailable, error))?;
        let identity = match field(&opened, "result_identity") {
            Some(Value::String(value)) => value
                .to_rust_string()
                .map_err(|error| crate::carry_cause!(super::Error::ProtectedResultUnavailable, error))?,
            _ => return Err(crate::cause!(super::Error::ProtectedResultUnavailable)),
        };
        if !original_identity(&identity) {
            return Err(crate::cause!(super::Error::ProtectedResultUnavailable));
        }
        output::verify_saved(db, &self.binding.owner, &result, &witness)
            .map_err(|error| crate::carry_cause!(super::Error::ProtectedResultUnavailable, error))?;
        self.check(db, &self.binding)
            .map_err(super::journal_error)?;
        Ok(ProtectedWorkspaceResult {
            result,
            identity,
            witness,
        })
    }

    /// Native calls this after fresh State browser/source/policy admission at
    /// final delivery, then checks that State again before returning words.
    pub(super) fn workspace_final_output_permit(
        &self,
        db: &Connection,
        result: &ProtectedWorkspaceResult,
    ) -> super::Result<output::FinalOutputPermit> {
        self.check(db, &self.binding)
            .map_err(super::journal_error)?;
        let permit = output::final_output_permit_saved(db, &self.binding.owner, &result.result, &result.witness)
            .map_err(|error| crate::carry_cause!(super::Error::ProtectedResultUnavailable, error))?;
        self.check(db, &self.binding)
            .map_err(super::journal_error)?;
        Ok(permit)
    }
}
