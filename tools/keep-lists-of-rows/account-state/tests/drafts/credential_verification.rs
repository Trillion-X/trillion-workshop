use super::*;
use serde_json::json;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../fixtures/credential-verification/original-js.json")).unwrap()
}

fn policy() -> VerificationPolicy {
    let data = fixtures();
    VerificationPolicy::from_settings(&data["settings"], data["max_memory_bytes"].as_u64().unwrap()).unwrap()
}

#[test]
fn unchanged_original_javascript_vectors_match_real_rust_scrypt_and_nfkc() {
    let data = fixtures();
    assert_eq!(data["synthetic_only"], true);
    let policy = policy();
    let vectors = data["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 19);
    for vector in vectors {
        let record = (!vector["record"].is_null()).then_some(&vector["record"]);
        let actual = if let Some(units) = vector["password_utf16"].as_array() {
            let units = units.iter().map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap()).collect::<Vec<_>>();
            verify_password_utf16(Some(&units), record, &policy)
        } else {
            verify_password(vector["password"].as_str(), record, &policy)
        }.unwrap();
        assert_eq!(actual.matches, vector["expected"].as_bool().unwrap(), "case {}", vector["name"]);
        assert_eq!(actual.needs_rehash, vector["needs_rehash"].as_bool().unwrap(), "case {}", vector["name"]);
        if !vector["original_error"].is_null() {
            // The original accepts its per-field bounds but throws before a
            // >1 GiB allocation. Native performs its current-cost dummy and
            // refuses; neither implementation authenticates this record.
            assert_eq!(vector["name"], "allowed-fields-exceed-runtime-memory");
            assert!(vector["original_error"].as_str().unwrap().contains("maxmem"));
            assert!(!actual.matches);
        }
    }
}

#[test]
fn malformed_and_missing_records_select_exactly_one_current_dummy_derivation() {
    let data = fixtures();
    let policy = policy();
    let current = data["vectors"][0]["record"].clone();
    let mut records = vec![Value::Null, json!({}), json!("not a record")];
    for (field, value) in [
        ("n", json!(1)), ("n", json!(32769)), ("n", json!(32768.5)),
        ("n", json!(1048577)), ("n", json!("32768")),
        ("r", json!(7)), ("r", json!(17)), ("p", json!(0)), ("p", json!(9)),
        ("key_bytes", json!(31)), ("key_bytes", json!(65)),
        ("salt_bytes", json!(15)), ("salt_bytes", json!(65)),
        ("name", json!("another algorithm")),
    ] {
        let mut record = current.clone();
        record["kdf"][field] = value;
        records.push(record);
    }
    for record in records {
        let mut calls = 0;
        let actual = verify_with(Some("synthetic"), Some(&record), &policy, |password, salt, kdf| {
            calls += 1;
            assert_eq!(password, b"synthetic");
            assert_eq!(kdf, &policy.current);
            assert_eq!(salt, vec![0; policy.current.salt_bytes]);
            Ok(Zeroizing::new(vec![0; kdf.key_bytes]))
        }).unwrap();
        assert_eq!(calls, 1);
        assert_eq!(actual, Verification { matches: false, needs_rehash: false });
    }
    for input in [None, Some("")] {
        let actual = verify_with(input, Some(&current), &policy, |_, _, _| panic!("invalid input must not derive")).unwrap();
        assert!(!actual.matches);
    }
}

#[test]
fn record_bounds_and_runtime_ceiling_cannot_be_chosen_by_untrusted_record() {
    let data = fixtures();
    let policy = policy();
    let mut record = data["vectors"][0]["record"].clone();
    record["kdf"]["n"] = json!(1048576);
    record["kdf"]["r"] = json!(16);
    assert!(policy.allowed(&parse_kdf(&record["kdf"]).unwrap()));
    let mut calls = 0;
    let result = verify_with(Some("synthetic"), Some(&record), &policy, |_, _, kdf| {
        calls += 1;
        assert_eq!(kdf, &policy.current);
        Ok(Zeroizing::new(vec![0; kdf.key_bytes]))
    }).unwrap();
    assert_eq!(calls, 1);
    assert!(!result.matches);

    let mut settings = data["settings"].clone();
    settings["kdf"]["n"] = json!(32769);
    assert!(matches!(VerificationPolicy::from_settings(&settings, u64::MAX), Err(VerificationError::InvalidPolicy(_))));
    assert!(matches!(VerificationPolicy::from_settings(&data["settings"], 1024), Err(VerificationError::InvalidPolicy(_))));
    let mut settings = data["settings"].clone();
    settings["kdf_bounds"]["r"] = json!([16, 8]);
    assert!(matches!(VerificationPolicy::from_settings(&settings, u64::MAX), Err(VerificationError::InvalidPolicy(_))));
}

#[test]
fn integer_json_numbers_and_extra_record_metadata_preserve_original_compatibility() {
    let data = fixtures();
    let policy = policy();
    let mut record = data["vectors"][0]["record"].clone();
    record["kdf"]["r"] = json!(8.0);
    record["user_id"] = json!("synthetic-fixture-only");
    record["email"] = json!("fixture@example.invalid");
    assert!(verify_password(data["vectors"][0]["password"].as_str(), Some(&record), &policy).unwrap().matches);
}

#[test]
fn derivation_error_refuses_instead_of_becoming_a_success_or_fallback() {
    let policy = policy();
    assert_eq!(verify_with(Some("synthetic"), None, &policy, |_, _, _| {
        Err(trillion_local::cause!(VerificationError::DerivationFailed))
    }), Err(trillion_local::cause!(VerificationError::DerivationFailed)));
}


fn independent() -> Value {
    serde_json::from_str(include_str!("../fixtures/credential-verification/original-normalization-and-memory.json")).unwrap()
}

/// The exact bytes the verifier hands to scrypt, captured through the real
/// owner path rather than a reimplementation of NFKC in the test.
fn kdf_input(policy: &VerificationPolicy, units: &[u16]) -> Vec<u8> {
    let mut seen = Vec::new();
    verify_utf16_with(Some(units), None, policy, |password, _, kdf| {
        seen = password.to_vec();
        Ok(Zeroizing::new(vec![0; kdf.key_bytes]))
    }).unwrap();
    seen
}

#[test]
fn every_scalar_and_lone_surrogate_sequence_reaches_scrypt_as_original_v8_nfkc_textencoder_bytes() {
    let data = independent();
    assert_eq!(data["synthetic_only"], true);
    let changed: std::collections::HashMap<u32, &str> = data["nfkc_changed"].as_array().unwrap().iter()
        .map(|row| (u32::try_from(row[0].as_u64().unwrap()).unwrap(), row[1].as_str().unwrap())).collect();
    assert!(changed.len() > 4000);
    let policy = policy();
    let mut buffer = [0u16; 2];
    for scalar in (1..=0x10ffffu32).filter_map(char::from_u32) {
        let units = scalar.encode_utf16(&mut buffer);
        let expected = changed.get(&(scalar as u32)).map(|hex| base16ct::lower::decode_vec(hex).unwrap())
            .unwrap_or_else(|| scalar.to_string().into_bytes());
        assert_eq!(kdf_input(&policy, units), expected, "U+{:04X}", scalar as u32);
    }
    let sequences = data["sequences"].as_array().unwrap();
    assert_eq!(sequences.len(), 4000);
    let mut surrogate_rows = 0;
    for row in sequences {
        let units: Vec<u16> = row[0].as_array().unwrap().iter().map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap()).collect();
        surrogate_rows += usize::from(char::decode_utf16(units.iter().copied()).any(|unit| unit.is_err()));
        assert_eq!(kdf_input(&policy, &units), base16ct::lower::decode_vec(row[1].as_str().unwrap()).unwrap(), "{units:04X?}");
    }
    assert!(surrogate_rows > 1000);
}

#[test]
fn original_records_with_normalization_sensitive_utf16_passwords_verify_and_rehash() {
    let data = independent();
    let policy = policy();
    let records = data["records"].as_array().unwrap();
    assert_eq!(records.len(), 5);
    let units = |value: &Value| value.as_array().unwrap().iter().map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap()).collect::<Vec<_>>();
    for row in records {
        for field in ["password_utf16", "equivalent_utf16"] {
            let actual = verify_password_utf16(Some(&units(&row[field])), Some(&row["record"]), &policy).unwrap();
            // p = 1 is allowed but older than the current p = 3.
            assert_eq!(actual, Verification { matches: true, needs_rehash: true }, "{} {field}", row["name"]);
        }
        let mut other = units(&row["password_utf16"]);
        other.push(u16::from(b'x'));
        assert!(!verify_password_utf16(Some(&other), Some(&row["record"]), &policy).unwrap().matches);
    }
}

#[test]
fn record_memory_ceiling_matches_noble_maxmem_refusal_across_every_allowed_cost() {
    let data = independent();
    let policy = policy();
    let grid = data["memory_grid"].as_array().unwrap();
    assert_eq!(grid.len(), 6 * 9 * 8);
    let mut refused = 0;
    for row in grid {
        let kdf = Kdf { name: "scrypt".into(), n: row[0].as_u64().unwrap(), r: row[1].as_u64().unwrap() as u32,
            p: row[2].as_u64().unwrap() as u32, key_bytes: 32, salt_bytes: 16 };
        assert!(policy.allowed(&kdf), "{row}");
        let noble_refuses = row[3].as_bool().unwrap();
        refused += usize::from(noble_refuses);
        assert_eq!(!policy.fits_work_limit(&kdf), noble_refuses, "{row}");
    }
    assert!(refused > 0 && refused < grid.len());
}

#[test]
fn a_made_record_has_the_original_bytes_for_the_same_salt_and_verifies() {
    let data = fixtures();
    let policy = policy();
    let vector = &data["vectors"][0];
    let password = vector["password"].as_str().unwrap();
    let salt = base16ct::lower::decode_vec(vector["record"]["salt"].as_str().unwrap()).unwrap();
    assert_eq!(make_record_with_salt(password, &salt, &policy).unwrap(), vector["record"]);
    assert_eq!(make_record_with_salt(password, &salt[..salt.len() - 1], &policy), Err(trillion_local::cause!(VerificationError::InvalidPolicy)));
    let made = make_password_record(password, &policy).unwrap();
    assert_ne!(made["salt"], vector["record"]["salt"], "each record has its own salt");
    assert!(verify_password(Some(password), Some(&made), &policy).unwrap().matches);
}

#[test]
fn different_policy_conditions_keep_distinct_source_causes_through_serialization() {
    let data = fixtures();
    let missing_kdf = VerificationPolicy::from_settings(&json!({}), u64::MAX).err().expect("missing kdf");
    let mut no_bounds = data["settings"].clone();
    no_bounds.as_object_mut().unwrap().remove("kdf_bounds");
    let missing_bounds = VerificationPolicy::from_settings(&no_bounds, u64::MAX).err().expect("missing bounds");
    assert!(matches!(missing_kdf, VerificationError::InvalidPolicy(_)));
    assert!(matches!(missing_bounds, VerificationError::InvalidPolicy(_)));
    assert_ne!(missing_kdf.cause(), missing_bounds.cause());
    for refused in [missing_kdf, missing_bounds] {
        let cause = refused.cause();
        assert_eq!(cause.file(), "src/account/credential_verification.rs");
        assert_eq!(cause.condition(), "VerificationError::InvalidPolicy");
        let wire = serde_json::to_string(&cause).unwrap();
        let replayed: crate::refusal_cause::Cause = serde_json::from_str(&wire).unwrap();
        assert_eq!(replayed, cause);
    }
}
