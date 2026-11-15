//! The selected account's side of the door's operations: its reads, writes and
//! wake calls, each for a caller the door's own sign-in admitted
//! (`account::account_routes::Caller`) and checked again at every check they keep.

#[path = "../account/hooks/receipt_dispatch.rs"]
mod hook_receipts;
mod local_workspace;
pub(crate) mod resource_connection_publication;
pub(crate) mod workspace_read;
mod workspace_write;
#[path = "../account/records_result.rs"]
mod records_result;
pub(crate) mod write_result_custody;

use super::SelectedAccount;
#[cfg(test)]
use crate::resource_authority::Route;
use crate::{
    account::{AccountError, AccountResult},
    ecma_json::{self, JsString, Value as EcmaValue},
    mcp::Operation,
    record_canonical,
};

/// The original native command's deterministic address, not a new permit or
/// authorization grant. Full journal binding still belongs to its producer.
pub(crate) struct OriginalMcpCommandIds {
    pub(crate) permit_id: String,
    pub(crate) input_identity: String,
}

fn original_database_identity(value: &EcmaValue) -> AccountResult<String> {
    let identity = record_canonical::identity(
        value,
        Default::default(),
        &mut |left: &JsString, right: &JsString| Ok::<_, ()>(left.units().cmp(right.units())),
    )
    .map_err(|error| crate::carry_cause!(AccountError::InvalidInput, error))?;
    identity
        .strip_prefix("1f:")
        .map(str::to_owned)
        .ok_or(crate::cause!(AccountError::SourceUnavailable))
}

/// The journal binding identity of the account's own record write (`own-record-writes.json`): the original own-record
/// resource command's declared request identity (`own-record-resource-composition.mjs` `identify: databaseInputIdentity`,
/// the same code-unit ordered canonical owner as its permit and input identities above) over
/// `[operation, input, request_key]`, in the `1f:` grammar the command journal keeps. It reads no locale: the generic
/// record write is ready whenever the account's own records are, with or without the selection's tool-label locale.
/// A retry compares this identity, so it is the same for every attempt of one request on every door.
pub(crate) fn own_record_write_identity(
    operation: &str,
    input: &EcmaValue,
    request_key: &str,
) -> AccountResult<String> {
    if request_key.is_empty() || request_key.encode_utf16().count() > 512 {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    let parts = EcmaValue::Array(vec![
        EcmaValue::String(operation.into()),
        input.clone(),
        EcmaValue::String(request_key.into()),
    ]);
    Ok(format!("1f:{}", original_database_identity(&parts)?))
}

#[cfg(test)]
fn original_command_ids(
    owner: &str,
    sign_in: &str,
    route: &Route,
    call: &Operation,
) -> AccountResult<OriginalMcpCommandIds> {
    if owner != route.account_id {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    original_command_ids_at_resource(owner, sign_in, &route.resource_address, call)
}

pub(super) fn original_command_ids_at_resource(
    owner: &str,
    sign_in: &str,
    resource: &str,
    call: &Operation,
) -> AccountResult<OriginalMcpCommandIds> {
    if call.resource != resource
        || call.request_key.is_empty()
        || call.request_key.encode_utf16().count() > 512
    {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    let input = serde_json::to_vec(&call.input).map_err(|error| crate::carry_cause!(AccountError::InvalidInput, error))?;
    let input =
        ecma_json::parse(&input, Default::default()).map_err(|error| crate::carry_cause!(AccountError::InvalidInput, error))?;
    let permit_parts = EcmaValue::Array(
        [owner, sign_in, resource, &call.request_key]
            .into_iter()
            .map(|part| EcmaValue::String(part.into()))
            .collect(),
    );
    Ok(OriginalMcpCommandIds {
        permit_id: format!(
            "resource-command:{}",
            original_database_identity(&permit_parts)?
        ),
        input_identity: original_database_identity(&input)?,
    })
}
#[cfg(test)]

mod command_identity_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn original_native_command_addresses_match_js_owner() {
        let route = Route {
            account_id: "owner-one".into(),
            device_id: "mac-one".into(),
            resource_address: "@own-records".into(),
            generation: "generation-one".into(),
        };
        let call = Operation {
            person_present: None,
            resource: route.resource_address.clone(),
            operation: "records:write".into(),
            request_key: "request-one".into(),
            input: json!({"z":2,"a":{"b":1,"a":[3,2,1]}}),
        };
        let ids = original_command_ids("owner-one", "key:alpha", &route, &call).unwrap();
        assert_eq!(
            ids.input_identity,
            "46241462b61eccaac153f83457e7067cb18ac9a35af5dc59878519f62ebda127"
        );
        assert_eq!(
            ids.permit_id,
            "resource-command:488feaf451fb1f9de8bcd7710fc3f2d4f37058deaf2fa10ea0a9b2cc40c30ec4"
        );
        assert!(original_command_ids("another-owner", "key:alpha", &route, &call).is_err());
        let mut unicode = call.clone();
        unicode.request_key = "é".repeat(300);
        assert!(original_command_ids("owner-one", "key:alpha", &route, &unicode).is_ok());
        unicode.request_key = "😀".repeat(257);
        assert!(original_command_ids("owner-one", "key:alpha", &route, &unicode).is_err());
    }

    /// The account's own record write binds its journal request by code units, never by the tool-label collation:
    /// keys whose collation order differs from their code-unit order ("B" before "a" by code unit, after it by
    /// collation) give the code-unit identity, the same for either key order of the input and for every retry.
    #[test]
    fn own_record_write_identity_is_code_unit_ordered_not_collation_ordered() {
        use crate::native_boot::{
            mcp_workspace_write::original_binding, tool_screens::ToolLabelLocale,
        };
        let parse = |text: &str| ecma_json::parse(text.as_bytes(), Default::default()).unwrap();
        let input = parse(r#"[{"id":"note:one","type":"note","value":{"a":1,"B":2}}]"#);
        let reordered = parse(r#"[{"value":{"B":2,"a":1},"type":"note","id":"note:one"}]"#);
        let identity = own_record_write_identity("records:write", &input, "request-one").unwrap();
        let by_units = original_binding(
            "records:write",
            input.clone(),
            "request-one",
            &mut |left: &JsString, right: &JsString| Ok::<_, ()>(left.units().cmp(right.units())),
        )
        .unwrap();
        assert_eq!(identity, by_units);
        assert_eq!(
            identity,
            own_record_write_identity("records:write", &reordered, "request-one").unwrap()
        );
        assert_eq!(
            identity,
            own_record_write_identity("records:write", &input, "request-one").unwrap()
        );
        let locale = crate::native_boot::tool_label_locale::engine_locale().unwrap();
        let by_collation = original_binding(
            "records:write",
            input.clone(),
            "request-one",
            &mut |left, right| locale.compare(left, right),
        )
        .unwrap();
        assert_ne!(
            identity, by_collation,
            "the collation orders \"a\" before \"B\"; the record write must not"
        );
        assert_ne!(
            identity,
            own_record_write_identity("records:write", &input, "request-two").unwrap()
        );
        assert!(own_record_write_identity("records:write", &input, "").is_err());
        assert!(own_record_write_identity("records:write", &input, &"😀".repeat(257)).is_err());
    }
}
