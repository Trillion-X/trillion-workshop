// src/account_files/sign_up_hosting.rs
//
// Purpose: the product's sign-up hosting section (`sign_up_hosting` in src/account_files/identity.json `sections`): the
// operator account the email index lives in, and the computers that host sign-ups, each with its https origin and its
// public key. It is read where the product settings are read.
//
// Non-negotiable invariants:
// 1. An absent section, or product settings that cannot be read, is `None`, never a default: nothing is claimed for a
//    product without the section, and the sign-up still goes on.
// 2. A present section is refused whole when it is malformed: unknown fields, an operator address or public key that is
//    not 64 hex, or a hosting origin that is not an https origin with a host and no path, query, user information or fragment.
// 3. The operator account and the hosting public keys are public identifiers, never secrets. A refusal names no value.
//
// Stored values, owned by this file: none; it reads the `sign_up_hosting` section of the product settings.

use super::identity;
use serde::Deserialize;
use serde_json::Value;

/// A refusal to read the section: it is present and breaks invariant 2. Names no value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Malformed(crate::refusal_cause::Cause);

/// One computer that hosts sign-ups: the https origin the forwarder reaches it at. Its public key is fetched from the
/// origin (`GET /computer-key`, src/native_entry/computer/hosting_keys.rs), never written into the settings.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostingComputer {
    pub origin: String,
}

/// The `sign_up_hosting` section.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignUpHosting {
    #[serde(rename = "_what", default)]
    _what: String,
    pub operator_account: String,
    pub hosting_computers: Vec<HostingComputer>,
}

/// The section as `section` holds it: None when the product names none, or the section when it is well formed.
pub fn parse(section: Option<&Value>) -> Result<Option<SignUpHosting>, Malformed> {
    let Some(section) = section else { return Ok(None) };
    let hosting: SignUpHosting = serde_json::from_value(section.clone()).map_err(|_| Malformed(crate::cause!()))?;
    let valid = hex64(&hosting.operator_account) && hosting.hosting_computers.iter().all(|computer| https_origin(&computer.origin));
    if !valid {
        return Err(Malformed(crate::cause!()));
    }
    Ok(Some(hosting))
}

/// The section of the product settings the launcher wrote, or None when there is none or the settings cannot be read.
pub fn read() -> Result<Option<SignUpHosting>, Malformed> {
    parse(identity::section("sign_up_hosting").ok().flatten())
}

fn hex64(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn https_origin(text: &str) -> bool {
    crate::https::reach_of(text).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const OPERATOR: &str = "84d0e3a2c5e228d5cca99a51a816012c17c3249951bf44ccf9c14e67b7cddaa5";

    #[test]
    fn an_absent_section_is_none() {
        assert_eq!(parse(None), Ok(None));
    }

    #[test]
    fn a_well_formed_section_parses_with_or_without_computers() {
        let empty = json!({"operator_account": OPERATOR, "hosting_computers": []});
        assert_eq!(parse(Some(&empty)).unwrap().unwrap().operator_account, OPERATOR);
        let one = json!({"operator_account": OPERATOR, "hosting_computers": [{"origin": "https://computer.example"}]});
        assert_eq!(parse(Some(&one)).unwrap().unwrap().hosting_computers[0].origin, "https://computer.example");
    }

    #[test]
    fn a_malformed_section_is_refused_whole() {
        let unknown = json!({"operator_account": OPERATOR, "hosting_computers": [], "extra": 1});
        assert!(parse(Some(&unknown)).is_err());
        let not_hex = json!({"operator_account": "not hex", "hosting_computers": []});
        assert!(parse(Some(&not_hex)).is_err());
        let plain_http = json!({"operator_account": OPERATOR, "hosting_computers": [{"origin": "http://computer.example"}]});
        assert!(parse(Some(&plain_http)).is_err());
        let with_path = json!({"operator_account": OPERATOR, "hosting_computers": [{"origin": "https://computer.example/x"}]});
        assert!(parse(Some(&with_path)).is_err());
        let with_key = json!({"operator_account": OPERATOR, "hosting_computers": [{"origin": "https://computer.example", "public_key": "ab"}]});
        assert!(parse(Some(&with_key)).is_err(), "a key is never written into the section");
    }
}

// ---- item 3 (product settings drift from main: a place without sign_up_hosting): the drift is named, not silent ----

#[cfg(test)]
mod drift_scenario_tests {
    use super::*;

    /// A place whose product settings have no `sign_up_hosting` section (drift from main) reads it as absent. Absent is
    /// a valid state for a product that does not sign up, so nothing names the drift at boot: the place answers a bare 503
    /// on its sign-up route later. The scenario fails until the boot reports the missing section by name (owner
    /// site-off-hosting, D23-D25).
    fn product_settings_drift_is_named_at_boot_body() -> std::result::Result<(), String> {
        let drifted = br#"{"word":"synthetic-product","site_host":"example.invalid","app_host":"example.invalid","brand_mark_path":"","restore_placeholder_owner":"","sections":{"page_look":{}}}"#.to_vec();
        let absent = crate::account_files::identity::absent_sections_of(drifted).map_err(|_| "the startup parse refused a settings file with no sign_up_hosting section".to_string())?;
        if !absent.contains(&"sign_up_hosting") {
            return Err("the startup parse names no missing sign_up_hosting section".into());
        }
        match parse(None) {
            Ok(None) => Ok(()),
            Ok(Some(_)) => Err("an absent section produced hosting".into()),
            Err(_) => Err("an absent section was refused as malformed".into()),
        }
    }

    #[test]
    fn product_settings_drift_is_named_at_boot() {
        crate::simulation::verdict("product-settings-drift-is-named-at-boot", product_settings_drift_is_named_at_boot_body);
    }
}
