// src/host/workspace_domain.rs
//
// Purpose: The percent-decoding of the engine's workspace domain (`decode` of src/workspace_domain.rs at 5fbc2ff4b1), which
// the account files' old page paths and the record routes read a path or form text through.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#[derive(Debug, Clone)]
pub enum WorkspaceError {
    Invalid(crate::refusal_cause::Cause),
}
impl WorkspaceError {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(WorkspaceError);

pub(crate) fn decode(text: &str, form: bool) -> Result<String, WorkspaceError> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let digits = bytes.get(i + 1..i + 3).ok_or(crate::cause!(WorkspaceError::Invalid))?;
            let n = std::str::from_utf8(digits)
                .ok()
                .and_then(|s| u8::from_str_radix(s, 16).ok())
                .ok_or(crate::cause!(WorkspaceError::Invalid))?;
            out.push(n);
            i += 3;
        } else {
            out.push(if form && bytes[i] == b'+' {
                b' '
            } else {
                bytes[i]
            });
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))
}
