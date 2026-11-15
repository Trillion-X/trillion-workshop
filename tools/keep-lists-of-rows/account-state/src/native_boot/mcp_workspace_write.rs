//! Original behavior-journal identity of a selected own-record command
//! (`workspace:write`, `records:write`). This is a producer input, not a
//! permit, quota reservation, effect, or result. The caller must retain this
//! witness through the command owner.

use crate::{
    account::{AccountError, AccountResult},
    ecma_json::{JsString, Value},
    record_canonical,
};
use std::cmp::Ordering;

/// Reproduce `resource-behavior-commands.mjs`'s exact
/// `identityOf(canonical([operation, liveInput, request_key]))` under the
/// caller's original locale comparator. There is no bytewise or
/// process-default locale fallback.
pub(super) fn original_binding<F, E>(
    operation: &str,
    input: Value,
    request_key: &str,
    compare: &mut F,
) -> AccountResult<String>
where
    F: FnMut(&JsString, &JsString) -> Result<Ordering, E>,
    E: crate::refusal_cause::Caused,
{
    if request_key.is_empty() || request_key.encode_utf16().count() > 512 {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    record_canonical::identity(
        &Value::Array(vec![
            Value::String(operation.into()),
            input,
            Value::String(request_key.into()),
        ]),
        Default::default(),
        compare,
    )
    .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ecma_json;

    const OPERATION: &str = "workspace:write";

    /// The workspace write this file's pinned identities were taken under.
    fn original_binding<F, E>(input: Value, request_key: &str, compare: &mut F) -> AccountResult<String>
    where
        F: FnMut(&JsString, &JsString) -> Result<Ordering, E>,
    E: crate::refusal_cause::Caused,
    {
        super::original_binding(OPERATION, input, request_key, compare)
    }

    #[test]
    fn behavior_journal_tuple_matches_original_javascript() {
        let input = ecma_json::parse(
            br#"{"writes":[{"address_label":"board","payload":{"a":1}}]}"#,
            Default::default(),
        )
        .unwrap();
        let binding = original_binding(input.clone(), "request:one", &mut |left, right| {
            Ok::<_, ()>(left.units().cmp(right.units()))
        })
        .unwrap();
        assert_eq!(
            binding,
            "1f:915d5cfbf01d8fa5ef6ab6b7b3e4008ee784056547929eabba0f12821d884652"
        );
        assert!(
            original_binding(input.clone(), "", &mut |_, _| Ok::<_, ()>(Ordering::Equal)).is_err()
        );
        assert!(
            original_binding(input, "request:one", &mut |_, _| { Err::<Ordering, _>(()) }).is_err()
        );
        let input = ecma_json::parse(br#"{}"#, Default::default()).unwrap();
        assert!(
            original_binding(input.clone(), &"é".repeat(300), &mut |left, right| {
                Ok::<_, ()>(left.units().cmp(right.units()))
            })
            .is_ok()
        );
        assert!(
            original_binding(input, &"😀".repeat(257), &mut |left, right| {
                Ok::<_, ()>(left.units().cmp(right.units()))
            })
            .is_err()
        );
    }
}
