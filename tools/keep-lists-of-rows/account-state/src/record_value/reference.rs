//! Canonical lookup keys for exact record references. Ports old trillion
//! `src/record-model-tools.mjs:73-101` (`nativeInspectionAddress`,
//! `inspectionRecordId`). This changes an index address, never the source's
//! claimed reference. Address spellings are installed model DATA. A declared
//! alias reads only its exact current declaration, opened under the caller's
//! normal supply; it never searches names.
use super::{read, Error, Limits, Result, Supply};
use crate::{ecma_json::JsString, record_model_policy::Installed};

/// Resolve the existing public address conventions against the installed model
/// and current logical records. Missing declarations retain the exact alias;
/// unavailable or refused reads remain failures, never fabricated absence.
pub fn canonical_lookup(
    requested: &str,
    supply: &mut impl Supply,
    installed: &Installed,
    limits: Limits,
) -> Result<String> {
    let id = requested.trim();
    if id.is_empty() {
        return Err(crate::cause!(Error::Invalid));
    }
    if let Some(readers) = installed
        .json()
        .get("native_inspection")
        .and_then(|v| v.get("readers"))
    {
        for reader in readers.as_array().ok_or(crate::cause!(Error::Source))? {
            let pattern = reader
                .get("pattern")
                .and_then(serde_json::Value::as_str)
                .ok_or(crate::cause!(Error::Source))?;
            let pattern = regex::Regex::new(pattern).map_err(|error| crate::carry_cause!(Error::Source, error))?;
            if pattern.is_match(id) {
                let replacement = reader
                    .get("canonical")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("$&");
                // The installed declarations use numbered captures and `$&`
                // for the whole match (ECMAScript); Rust names that match $0.
                let replacement = replacement.replace("$&", "${0}");
                return Ok(pattern.replace(id, replacement.as_str()).into_owned());
            }
        }
    }
    let files =
        crate::account_files::account_routes::AccountFilesDoor::shipped().ok_or(crate::cause!(Error::Source))?;
    if let Some(identity) = files.canonical_reference(id) {
        return Ok(identity.to_owned());
    }
    if let Some(rules) = installed.json().get("reference_lookup") {
        for rule in rules.as_array().ok_or(crate::cause!(Error::Source))? {
            let text = |field: &str| {
                rule.get(field)
                    .and_then(serde_json::Value::as_str)
                    .ok_or(crate::cause!(Error::Source))
            };
            let pattern = regex::Regex::new(text("pattern")?).map_err(|error| crate::carry_cause!(Error::Source, error))?;
            if !pattern.is_match(id) {
                continue;
            }
            let fill = |replacement: &str| {
                pattern
                    .replace(id, replacement.replace("$&", "${0}").as_str())
                    .into_owned()
            };
            if let Some(canonical) = rule.get("canonical") {
                return Ok(fill(canonical.as_str().ok_or(crate::cause!(Error::Source))?));
            }
            let declaration = fill(text("declaration")?);
            let row = fill(text("row")?);
            let join = text("join")?;
            let Some(definition) = read(&declaration, supply, installed.open_policy(), limits)?
            else {
                return Ok(id.to_owned());
            };
            let mut model = crate::record_write_model::Model::from_product_data(
                installed.data(),
                installed.data(),
            )
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            let declared = model
                .declare(
                    &JsString::from(definition.record_type()),
                    &JsString::from(declaration),
                    definition.value(),
                )
                .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            return match declared {
                Some(kind) => Ok(format!(
                    "{}{join}{row}",
                    kind.to_rust_string().map_err(|error| crate::carry_cause!(Error::Source, error))?
                )),
                None => Ok(id.to_owned()),
            };
        }
    }
    Ok(id.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        legacy_records::StoredRecord,
        record_value::{CurrentKeys, KeyState},
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct Values {
        records: BTreeMap<String, StoredRecord>,
        reads: Vec<String>,
        unavailable: bool,
    }
    impl Values {
        fn put(&mut self, id: &str, kind: &str, value: serde_json::Value) {
            self.records.insert(
                id.into(),
                StoredRecord {
                    id: id.into(),
                    record_type: kind.into(),
                    sequence: "fixture-sequence".into(),
                    value_json: value.to_string(),
                    meta_json: None,
                    protected_key_present: false,
                },
            );
        }
    }
    impl CurrentKeys for Values {
        fn assert_current(&mut self) -> Result<()> {
            if self.unavailable {
                Err(crate::cause!(Error::Source))
            } else {
                Ok(())
            }
        }
        fn key(&mut self, _: &str) -> Result<KeyState> {
            panic!("these fixture records have no sealed fields")
        }
    }
    impl Supply for Values {
        fn stored(&mut self, id: &str) -> Result<Option<StoredRecord>> {
            self.reads.push(id.into());
            if self.unavailable {
                return Err(crate::cause!(Error::Source));
            }
            Ok(self.records.get(id).cloned())
        }
    }

    #[test]
    fn lookup_keys_use_exact_current_declarations_without_rewriting_source_addresses() {
        let model = crate::record_model_policy::list_rule_model();
        let mut values = Values::default();
        values.put(
            "list:fixture-sources",
            "list",
            json!({"row_type":"arbitrary-source-kind","name":"Misleading display name"}),
        );
        let file = format!("1f:{}", "c".repeat(64));
        for (requested, expected) in [
            (format!("file:{file}"), file.clone()),
            (
                format!("FILE:{}", file.to_ascii_uppercase()),
                file.to_ascii_uppercase(),
            ),
            (file.clone(), file),
            (
                "future-resource:exact:identity".into(),
                "future-resource:exact:identity".into(),
            ),
        ] {
            assert_eq!(
                canonical_lookup(&requested, &mut values, model, Limits::default()).unwrap(),
                expected
            );
        }
        assert!(
            values.reads.is_empty(),
            "file and future addresses perform no owner read"
        );
        let requested = "list:fixture-sources:rows:first:exact";
        assert_eq!(
            canonical_lookup(requested, &mut values, model, Limits::default()).unwrap(),
            "record:arbitrary-source-kind:first:exact"
        );
        assert_eq!(values.reads, ["list:fixture-sources"]);
        values.put(
            "list:fixture-sources",
            "list",
            json!({"row_type":"a-different-kind"}),
        );
        assert_eq!(
            canonical_lookup(requested, &mut values, model, Limits::default()).unwrap(),
            "record:a-different-kind:first:exact"
        );
    }

    #[test]
    fn absent_declarations_keep_aliases_but_unavailable_declarations_refuse() {
        let model = crate::record_model_policy::list_rule_model();
        let mut values = Values::default();
        let requested = "list:missing:rows:first";
        assert_eq!(
            canonical_lookup(requested, &mut values, model, Limits::default()).unwrap(),
            requested
        );
        values.unavailable = true;
        assert_eq!(
            canonical_lookup(requested, &mut values, model, Limits::default()),
            Err(crate::cause!(Error::Source))
        );
    }

    #[test]
    fn native_address_normalization_uses_installed_declarations() {
        let model = Installed::from_rows(
            &[json!({"record_model":{"native_inspection":{"readers":[
                {"pattern":"^(?:fixture-alias:)?(fixture-native:[a-z]+)$","canonical":"$1"}
            ]}}})],
            true,
        )
        .unwrap();
        let mut values = Values::default();
        assert_eq!(
            canonical_lookup(
                "fixture-alias:fixture-native:abc",
                &mut values,
                &model,
                Limits::default()
            )
            .unwrap(),
            "fixture-native:abc"
        );
        assert!(values.reads.is_empty());
    }
}
