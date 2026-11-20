// tests/share_types_override.rs
//
// Purpose: The share route's settings. A computer row renders `share_bytes.types_by_ending` into its share units' settings, so a
// settings file that still names it must load and serve by it: its entries win for their endings, every other ending reads the account
// files' shared `media_type` rules, and a block with no override (the shipped one) serves by the shared rules alone. A bad override is
// refused by `check`. Synthetic data only.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use live_namespace::share_bytes::Config;
use serde_json::{json, Value};

fn block(types_by_ending: Option<Value>) -> Value {
    let mut block = json!({"_what": "t", "listen": "127.0.0.1:7421", "window_bytes": 1048576, "recheck_seconds": 5,
        "inline_types": ["video/", "image/"]});
    if let Some(types) = types_by_ending {
        block["types_by_ending"] = types;
    }
    block
}

#[test]
fn a_settings_file_that_names_types_by_ending_loads_and_serves_by_it() {
    let config: Config = serde_json::from_value(block(Some(json!({".mp4": "video/x-override"})))).unwrap();
    assert!(config.check().is_ok());
    assert_eq!(config.served_type("/Camera/C9058.MP4", "application/octet-stream").1, "video/x-override", "the override wins for its ending");
    assert_eq!(config.served_type("/Camera/clip.mkv", "application/octet-stream").1, "video/x-matroska", "an ending the override does not name reads the shared rules");
    assert_eq!(config.served_type("/Shared/blob.qqq", "application/octet-stream").1, "application/octet-stream");
}

#[test]
fn a_block_with_no_override_serves_by_the_shared_rules() {
    let shipped: Value = serde_json::from_str(include_str!("../settings.json")).unwrap();
    let config: Config = serde_json::from_value(shipped["share_bytes"].clone()).unwrap();
    assert!(config.check().is_ok());
    assert!(config.types_by_ending.is_empty());
    assert_eq!(config.served_type("/Camera/C9058.MP4", "application/octet-stream").1, "video/mp4");
    assert_eq!(config.served_type("/Notes/a.html", "application/octet-stream").1, "text/html");
}

#[test]
fn a_bad_override_is_refused_by_check() {
    let config: Config = serde_json::from_value(block(Some(json!({".mp4": "video"})))).unwrap();
    assert!(config.check().is_err(), "a type with no slash is refused");
    let config: Config = serde_json::from_value(block(Some(json!({"mp4": "video/mp4"})))).unwrap();
    assert!(config.check().is_err(), "an ending with no dot is refused");
}
