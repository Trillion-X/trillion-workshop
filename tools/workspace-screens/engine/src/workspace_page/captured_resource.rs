//! Captured MCP view resource, within the existing workspace-page artifact owner.
//! Uses the parent's pinned file loading and protected-document limits. There is
//! no renderer, alternate file store, account access check or origin registry here.
use super::{
    bounded_file, file, pinned, CapturedFile, OriginSlot, WorkspaceError, MAX_CAPTURE_BYTES,
    MAX_SHELL_BYTES,
};
#[cfg(test)]
use content_crypto::advanced::blake3;
use axum::http::Uri;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

// This is part of the existing captured frontend owner. It binds source-owned
// renderer output; it neither draws HTML nor creates an origin, account or right.

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ResourceOriginKind {
    Base,
    Stylesheet,
    ImportMap,
    WordsOrigin,
    ModuleScript,
}
#[derive(Deserialize)]
struct ResourceOriginSlot {
    kind: ResourceOriginKind,
    #[serde(flatten)]
    slot: OriginSlot,
}

#[derive(Deserialize)]
struct ResourceCapturedFile {
    #[serde(flatten)]
    file: CapturedFile,
    #[serde(default)]
    origin_slots: Vec<ResourceOriginSlot>,
    #[serde(default)]
    meta_origin_paths: Vec<Vec<String>>,
}
#[derive(Deserialize)]
struct ResourceCapture {
    schema: String,
    canonical_origin_marker: String,
    artifacts: BTreeMap<String, ResourceCapturedFile>,
}

/// Syntax-checked origin supplied by the actual host composition, not by an app
/// argument. This type grants no network/account authority. Its crate-only
/// constructor must be called with the canonical origin already admitted by
/// the native listener or public ingress owner; the capture cannot admit one.
pub struct ResourceOrigin(String);
impl ResourceOrigin {
    pub(crate) fn from_admitted(origin: &str) -> Result<Self, WorkspaceError> {
        let uri: Uri = origin.parse().map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
        let scheme = uri.scheme_str().ok_or(crate::cause!(WorkspaceError::Invalid))?;
        let authority = uri.authority().ok_or(crate::cause!(WorkspaceError::Invalid))?;
        let port_suffix = authority
            .as_str()
            .strip_prefix(authority.host())
            .ok_or(crate::cause!(WorkspaceError::Invalid))?;
        if !port_suffix.is_empty() {
            let port: u16 = port_suffix
                .strip_prefix(':')
                .ok_or(crate::cause!(WorkspaceError::Invalid))?
                .parse()
                .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
            if port == 0 {
                return Err(crate::cause!(WorkspaceError::Invalid));
            }
        }
        if !matches!(scheme, "http" | "https")
            || authority.host().is_empty()
            || authority.port_u16() == Some(0)
            || origin.len() > 1024
            || origin != format!("{scheme}://{authority}")
            || !origin.is_ascii()
            || origin.bytes().any(|b| b <= 32 || b == 127)
            || origin.contains(['<', '>', '&', '"', '\'', '\\', '@', '%', '?', '#'])
        {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        Ok(Self(origin.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Unchanged original renderer document and full resource metadata, after
/// binding only their recorded origin fields. The caller may pass text and
/// resource["_meta"] to the MCP presentation owner. No credential belongs here.
pub struct BoundCapturedMcpResource {
    pub text: String,
    pub resource: Value,
}

/// A pinned output of the existing screenResources/aiAppViewDocument producer.
/// Opening proves artifact bytes and the typed binding contract only. The
/// native selected-frontend owner still owns source/build checks and look;
/// this loader cannot promote an old/default-look capture to a current one.
pub struct CapturedMcpResource {
    source: String,
    marker: String,
    slots: Vec<ResourceOriginSlot>,
    resource: Value,
}

const RESOURCE_CSP_PATHS: [&[&str]; 6] = [
    &["ui", "csp", "resourceDomains"],
    &["ui", "csp", "connectDomains"],
    &["ui", "csp", "frameDomains"],
    &["openai/widgetCSP", "resource_domains"],
    &["openai/widgetCSP", "connect_domains"],
    &["openai/widgetCSP", "frame_domains"],
];

fn resource_json_script(
    source: &str,
    start: &str,
) -> Result<(std::ops::Range<usize>, Value), WorkspaceError> {
    if source.matches(start).count() != 1 {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    let begin = source.find(start).ok_or(crate::cause!(WorkspaceError::Integrity))? + start.len();
    let end = begin
        + source[begin..]
            .find("</script>")
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
    let value = serde_json::from_str(&source[begin..end]).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    Ok((begin..end, value))
}
fn resource_attribute(source: &str, start: &str) -> Result<std::ops::Range<usize>, WorkspaceError> {
    if source.matches(start).count() != 1 {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    let begin = source.find(start).ok_or(crate::cause!(WorkspaceError::Integrity))? + start.len();
    let end = begin + source[begin..].find('"').ok_or(crate::cause!(WorkspaceError::Integrity))?;
    if !source[end..].starts_with("\">") {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    Ok(begin..end)
}
fn resource_meta_path<'a>(meta: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(meta, |value, name| value.get(*name))
}
fn resource_meta_path_mut<'a>(meta: &'a mut Value, path: &[&str]) -> Option<&'a mut Value> {
    let mut value = meta;
    for name in path {
        value = value.get_mut(*name)?;
    }
    Some(value)
}

impl CapturedMcpResource {
    pub fn open(root: impl AsRef<Path>, capture_identity: &str) -> Result<Self, WorkspaceError> {
        let root = root.as_ref();
        // Root custody comes from the selected frontend owner. Reject a link
        // at that root as well as the leaf links rejected by the shared loader.
        if !std::fs::symlink_metadata(root)
            .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?
            .is_dir()
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        // The actual capture is 104,678 bytes because it records every bound value and
        // carried asset pin. It uses the existing protected-document bound;
        // the older small workspace shell capture retains MAX_CAPTURE_BYTES.
        let receipt = bounded_file(&root.join("capture.json"), MAX_SHELL_BYTES)?;
        pinned(&receipt, capture_identity, MAX_SHELL_BYTES)?;
        let mut capture: ResourceCapture =
            serde_json::from_slice(&receipt).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        if capture.schema != "trillion.mcp-app-screen-capture/v1" || capture.artifacts.len() != 2 {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        // The marker is source DATA, but it must be safe in every context it
        // occupies. It is not an admitted host for the running page or a selected look.
        ResourceOrigin::from_admitted(&capture.canonical_origin_marker)?;
        let mut document = capture
            .artifacts
            .remove("screen.html")
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        let resource = capture
            .artifacts
            .remove("resource.json")
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        if document.file.canonical_origin_slot.is_some()
            || !document.meta_origin_paths.is_empty()
            || resource.file.canonical_origin_slot.is_some()
            || !resource.origin_slots.is_empty()
            || resource.meta_origin_paths
                != RESOURCE_CSP_PATHS
                    .iter()
                    .map(|p| p.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>())
                    .collect::<Vec<_>>()
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let source = String::from_utf8(file(root, "screen.html", &document.file, MAX_SHELL_BYTES)?)
            .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let resource: Value = serde_json::from_slice(&file(
            root,
            "resource.json",
            &resource.file,
            MAX_CAPTURE_BYTES,
        )?)
        .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        if resource.get("mimeType").and_then(Value::as_str) != Some("text/html;profile=mcp-app")
            || !resource
                .get("uri")
                .and_then(Value::as_str)
                .is_some_and(|s| {
                    s.starts_with("ui://") && s.len() <= 1024 && !s.chars().any(char::is_whitespace)
                })
            || !resource
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
            || !resource.get("_meta").is_some_and(Value::is_object)
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let resource_uri: Uri = resource["uri"]
            .as_str()
            .ok_or(crate::cause!(WorkspaceError::Integrity))?
            .parse()
            .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        if resource_uri.scheme_str() != Some("ui") || resource_uri.authority().is_none() {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let marker = capture.canonical_origin_marker;
        let slots = std::mem::take(&mut document.origin_slots);
        Self::validate_document(&source, &marker, &slots)?;
        let meta = resource.get("_meta").ok_or(crate::cause!(WorkspaceError::Integrity))?;
        for path in RESOURCE_CSP_PATHS {
            if resource_meta_path(meta, path) != Some(&json!([marker])) {
                return Err(crate::cause!(WorkspaceError::Integrity));
            }
        }
        if serde_json::to_string(&resource)
            .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?
            .matches(&marker)
            .count()
            != RESOURCE_CSP_PATHS.len()
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        Ok(Self {
            source,
            marker,
            slots,
            resource,
        })
    }

    fn validate_document(
        source: &str,
        marker: &str,
        slots: &[ResourceOriginSlot],
    ) -> Result<(), WorkspaceError> {
        let origin_prefix = format!("{marker}/");
        let base = resource_attribute(source, "<base href=\"")?;
        let stylesheet = resource_attribute(source, "<link rel=\"stylesheet\" href=\"")?;
        let module = resource_attribute(source, "<script type=\"module\" src=\"")?;
        let (imports, import_map) = resource_json_script(source, "<script type=\"importmap\">")?;
        // The original words script carries an id after its MIME type.
        let words_tag = "<script type=\"application/json\"";
        if source.matches(words_tag).count() != 1 {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let words_begin = source.find(words_tag).ok_or(crate::cause!(WorkspaceError::Integrity))?;
        let words_content = words_begin
            + source[words_begin..]
                .find('>')
                .ok_or(crate::cause!(WorkspaceError::Integrity))?
            + 1;
        let words_end = words_content
            + source[words_content..]
                .find("</script>")
                .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        let words: Value = serde_json::from_str(&source[words_content..words_end])
            .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let words_range = words_content..words_end;
        if &source[base.clone()] != origin_prefix.as_str()
            || !source[stylesheet.clone()].starts_with(&origin_prefix)
            || !source[module.clone()].starts_with(&origin_prefix)
            || words.get("origin").and_then(Value::as_str) != Some(marker)
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let map = import_map
            .get("imports")
            .and_then(Value::as_object)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        for address in map.values() {
            if !address
                .as_str()
                .is_some_and(|s| s.starts_with(&origin_prefix) && s.matches(marker).count() == 1)
            {
                return Err(crate::cause!(WorkspaceError::Integrity));
            }
        }
        let positions: Vec<_> = source
            .match_indices(marker)
            .map(|(offset, _)| offset)
            .collect();
        if positions.len() != slots.len() || positions.is_empty() {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let mut import_count = 0;
        let mut base_count = 0;
        let mut style_count = 0;
        let mut words_count = 0;
        let mut module_count = 0;
        let mut end = 0;
        for (slot, expected_offset) in slots.iter().zip(positions) {
            let after = slot
                .slot
                .offset
                .checked_add(slot.slot.length)
                .ok_or(crate::cause!(WorkspaceError::Integrity))?;
            let range = match slot.kind {
                ResourceOriginKind::Base => {
                    base_count += 1;
                    &base
                }
                ResourceOriginKind::Stylesheet => {
                    style_count += 1;
                    &stylesheet
                }
                ResourceOriginKind::ImportMap => {
                    import_count += 1;
                    &imports
                }
                ResourceOriginKind::WordsOrigin => {
                    words_count += 1;
                    &words_range
                }
                ResourceOriginKind::ModuleScript => {
                    module_count += 1;
                    &module
                }
            };
            if slot.slot.expected != marker
                || slot.slot.length != marker.len()
                || slot.slot.offset != expected_offset
                || slot.slot.offset < end
                || source.get(slot.slot.offset..after) != Some(marker)
                || slot.slot.offset < range.start
                || after > range.end
            {
                return Err(crate::cause!(WorkspaceError::Integrity));
            }
            end = after;
        }
        if base_count != 1
            || style_count != 1
            || words_count != 1
            || module_count != 1
            || import_count != map.len()
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        Ok(())
    }

    pub fn resource_uri(&self) -> &str {
        // Validated once with the selected, pinned resource metadata.
        self.resource["uri"]
            .as_str()
            .expect("validated resource URI")
    }

    pub fn bind(
        &self,
        origin: &ResourceOrigin,
    ) -> Result<BoundCapturedMcpResource, WorkspaceError> {
        if origin.as_str() == self.marker {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        let removed = self
            .slots
            .len()
            .checked_mul(self.marker.len())
            .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
        let inserted = self
            .slots
            .len()
            .checked_mul(origin.as_str().len())
            .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
        let wanted = self
            .source
            .len()
            .checked_sub(removed)
            .and_then(|n| n.checked_add(inserted))
            .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
        if wanted > MAX_SHELL_BYTES {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        let mut text = String::with_capacity(wanted);
        let mut at = 0;
        for slot in &self.slots {
            text.push_str(&self.source[at..slot.slot.offset]);
            text.push_str(origin.as_str());
            at = slot.slot.offset + slot.slot.length;
        }
        text.push_str(&self.source[at..]);
        let mut resource = self.resource.clone();
        let meta = resource.get_mut("_meta").ok_or(crate::cause!(WorkspaceError::Integrity))?;
        for path in RESOURCE_CSP_PATHS {
            *resource_meta_path_mut(meta, path).ok_or(crate::cause!(WorkspaceError::Integrity))? =
                json!([origin.as_str()]);
        }
        Ok(BoundCapturedMcpResource { text, resource })
    }
}

#[cfg(test)]
mod captured_mcp_resource_controls {
    use super::*;
    use std::fs;

    const DOCUMENT: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/mcp-app-resource/screen.html"
    ));
    const RESOURCE: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/mcp-app-resource/resource.json"
    ));
    const CAPTURE: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/mcp-app-resource/capture.json"
    ));
    const CAPTURE_PIN: &str = "0418c6d252fd1c50c683651a980bbd5a97ed988d68ec1af4c85b6040e7587bd4";

    struct Fixture {
        root: tempfile::TempDir,
        pin: String,
    }
    impl Fixture {
        fn actual() -> Self {
            let root = tempfile::tempdir().unwrap();
            for (name, bytes) in [
                ("screen.html", DOCUMENT),
                ("resource.json", RESOURCE),
                ("capture.json", CAPTURE),
            ] {
                fs::write(root.path().join(name), bytes).unwrap();
            }
            Self {
                root,
                pin: CAPTURE_PIN.into(),
            }
        }
        fn read_capture(&self) -> Value {
            serde_json::from_slice(&fs::read(self.root.path().join("capture.json")).unwrap())
                .unwrap()
        }
        fn write_capture(&mut self, value: Value) {
            let bytes = serde_json::to_vec(&value).unwrap();
            self.pin = blake3::hash(&bytes).to_hex().to_string();
            fs::write(self.root.path().join("capture.json"), bytes).unwrap();
        }
        fn mutate_capture(&mut self, change: impl FnOnce(&mut Value)) {
            let mut value = self.read_capture();
            change(&mut value);
            self.write_capture(value);
        }
        fn replace_artifact(&mut self, name: &str, bytes: &[u8]) {
            fs::write(self.root.path().join(name), bytes).unwrap();
            self.mutate_capture(|value| {
                value["artifacts"][name]["bytes"] = json!(bytes.len());
                value["artifacts"][name]["blake3"] =
                    json!(blake3::hash(bytes).to_hex().to_string());
            });
        }
        fn mutate_resource(&mut self, change: impl FnOnce(&mut Value)) {
            let mut resource: Value = serde_json::from_slice(RESOURCE).unwrap();
            change(&mut resource);
            self.replace_artifact("resource.json", &serde_json::to_vec(&resource).unwrap());
        }
        fn open(&self) -> Result<CapturedMcpResource, WorkspaceError> {
            CapturedMcpResource::open(self.root.path(), &self.pin)
        }
    }

    #[test]
    fn actual_original_capture_binds_all_slots_and_only_recorded_metadata() {
        assert_eq!(blake3::hash(CAPTURE).to_hex().as_str(), CAPTURE_PIN);
        assert_eq!(DOCUMENT.len(), 106_994);
        let capture: Value = serde_json::from_slice(CAPTURE).unwrap();
        assert_eq!(
            capture["artifacts"]["screen.html"]["origin_slots"]
                .as_array()
                .unwrap()
                .len(),
            258
        );
        let fixture = Fixture::actual();
        let resource = fixture.open().unwrap();
        let original = std::str::from_utf8(DOCUMENT).unwrap();
        let marker = capture["canonical_origin_marker"].as_str().unwrap();
        for origin in ["http://127.0.0.1:7189", "https://app.example.test"] {
            let bound = resource
                .bind(&ResourceOrigin::from_admitted(origin).unwrap())
                .unwrap();
            // The producer receipt already compares these bound values to a second
            // actual renderer invocation. This independent test oracle checks
            // that the Rust binding changes no other document bytes.
            assert_eq!(bound.text, original.replace(marker, origin));
            assert!(!bound.text.contains(marker));
            let mut expected: Value = serde_json::from_slice(RESOURCE).unwrap();
            for path in capture["artifacts"]["resource.json"]["meta_origin_paths"]
                .as_array()
                .unwrap()
            {
                let mut value = &mut expected["_meta"];
                for name in path.as_array().unwrap() {
                    value = &mut value[name.as_str().unwrap()];
                }
                *value = json!([origin]);
            }
            assert_eq!(bound.resource, expected);
            assert_eq!(resource.resource_uri(), expected["uri"].as_str().unwrap());
        }
    }

    #[test]
    fn current_c_renderer_capture_uses_the_same_loader_without_document_reconstruction() {
        const CURRENT_DOCUMENT: &[u8] = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mcp-app-resource-current-c/screen.html"
        ));
        const CURRENT_RESOURCE: &[u8] = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mcp-app-resource-current-c/resource.json"
        ));
        const CURRENT_CAPTURE: &[u8] = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/mcp-app-resource-current-c/capture.json"
        ));
        const PIN: &str = "3350a34fd3d4d51c78ffbe7585c91ba4babfd7ebd7264da6acd8e31ae47bf17c";
        assert_eq!(CURRENT_DOCUMENT.len(), 101_225);
        assert_eq!(blake3::hash(CURRENT_CAPTURE).to_hex().as_str(), PIN);
        let root = tempfile::tempdir().unwrap();
        for (name, bytes) in [
            ("screen.html", CURRENT_DOCUMENT),
            ("resource.json", CURRENT_RESOURCE),
            ("capture.json", CURRENT_CAPTURE),
        ] {
            fs::write(root.path().join(name), bytes).unwrap();
        }
        let resource = CapturedMcpResource::open(root.path(), PIN).unwrap();
        let capture: Value = serde_json::from_slice(CURRENT_CAPTURE).unwrap();
        let marker = capture["canonical_origin_marker"].as_str().unwrap();
        let original = std::str::from_utf8(CURRENT_DOCUMENT).unwrap();
        for origin in ["http://127.0.0.1:7189", "https://app.example.test"] {
            let bound = resource
                .bind(&ResourceOrigin::from_admitted(origin).unwrap())
                .unwrap();
            assert_eq!(bound.text, original.replace(marker, origin));
            assert!(!bound.text.contains(marker));
            let mut expected: Value = serde_json::from_slice(CURRENT_RESOURCE).unwrap();
            for path in RESOURCE_CSP_PATHS {
                *resource_meta_path_mut(&mut expected["_meta"], path).unwrap() = json!([origin]);
            }
            assert_eq!(bound.resource, expected);
            assert_eq!(resource.resource_uri(), expected["uri"].as_str().unwrap());
        }
    }

    #[test]
    fn missing_duplicate_reordered_mistyped_and_out_of_range_slots_refuse() {
        let changes: [fn(&mut Value); 6] = [
            |v| {
                v["artifacts"]["screen.html"]["origin_slots"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            },
            |v| {
                let first = v["artifacts"]["screen.html"]["origin_slots"][0].clone();
                v["artifacts"]["screen.html"]["origin_slots"][1] = first;
            },
            |v| {
                v["artifacts"]["screen.html"]["origin_slots"]
                    .as_array_mut()
                    .unwrap()
                    .swap(0, 1);
            },
            |v| {
                v["artifacts"]["screen.html"]["origin_slots"][0]["kind"] = json!("import-map");
            },
            |v| {
                v["artifacts"]["screen.html"]["origin_slots"][0]["kind"] = json!("unknown-context");
            },
            |v| {
                v["artifacts"]["screen.html"]["origin_slots"][0]["offset"] = json!(u64::MAX);
            },
        ];
        for change in changes {
            let mut fixture = Fixture::actual();
            fixture.mutate_capture(change);
            assert!(fixture.open().is_err());
        }
    }

    #[test]
    fn a_re_pinned_unclassified_document_marker_does_not_become_a_replacement() {
        let mut fixture = Fixture::actual();
        let capture = fixture.read_capture();
        let marker = capture["canonical_origin_marker"].as_str().unwrap();
        let mut bytes = DOCUMENT.to_vec();
        bytes.extend_from_slice(format!("<!--{marker}-->").as_bytes());
        fixture.replace_artifact("screen.html", &bytes);
        assert!(fixture.open().is_err());
    }

    #[test]
    fn csp_paths_values_and_unclassified_metadata_marker_are_all_checked() {
        let mut fixture = Fixture::actual();
        fixture.mutate_capture(|v| {
            v["artifacts"]["resource.json"]["meta_origin_paths"]
                .as_array_mut()
                .unwrap()
                .pop();
        });
        assert!(fixture.open().is_err());
        let mut fixture = Fixture::actual();
        fixture.mutate_resource(|v| {
            v["_meta"]["ui"]["csp"]["resourceDomains"] = json!(["https://other.example"]);
        });
        assert!(fixture.open().is_err());
        let mut fixture = Fixture::actual();
        let marker = fixture.read_capture()["canonical_origin_marker"].clone();
        fixture.mutate_resource(|v| {
            v["_meta"]["openai/widgetDescription"] = marker;
        });
        assert!(fixture.open().is_err());
    }

    #[test]
    fn program_resource_metadata_and_fixed_artifact_names_are_not_user_choices() {
        let mut fixture = Fixture::actual();
        fixture.mutate_resource(|v| {
            v["mimeType"] = json!("text/plain");
        });
        assert!(fixture.open().is_err());
        let mut fixture = Fixture::actual();
        fixture.mutate_capture(|v| {
            let extra = v["artifacts"]["screen.html"].clone();
            v["artifacts"]["../outside.html"] = extra;
        });
        assert!(fixture.open().is_err());
        let mut fixture = Fixture::actual();
        fixture.mutate_capture(|v| {
            v["schema"] = json!("another-schema");
        });
        assert!(fixture.open().is_err());
    }

    #[test]
    fn capture_and_artifact_pins_remain_mandatory() {
        let fixture = Fixture::actual();
        assert!(CapturedMcpResource::open(fixture.root.path(), &"0".repeat(64)).is_err());
        let mut bytes = DOCUMENT.to_vec();
        bytes[0] = b'X';
        fs::write(fixture.root.path().join("screen.html"), bytes).unwrap();
        assert!(fixture.open().is_err());
    }

    #[cfg(owner_files = "posix")]
    #[test]
    fn same_byte_symlink_at_an_artifact_or_capture_root_refuses() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::actual();
        fs::write(fixture.root.path().join("same-bytes"), DOCUMENT).unwrap();
        fs::remove_file(fixture.root.path().join("screen.html")).unwrap();
        symlink(
            fixture.root.path().join("same-bytes"),
            fixture.root.path().join("screen.html"),
        )
        .unwrap();
        assert!(fixture.open().is_err());
        let fixture = Fixture::actual();
        let other = tempfile::tempdir().unwrap();
        let linked = other.path().join("linked-root");
        symlink(fixture.root.path(), &linked).unwrap();
        assert!(CapturedMcpResource::open(&linked, &fixture.pin).is_err());
    }

    #[test]
    fn runtime_origin_cannot_escape_html_json_or_csp_contexts_or_default_to_marker() {
        for origin in [
            "https://user:pass@example.test",
            "https://example.test/path",
            "http://127.0.0.1:0",
            "https://example.test:bad",
            "https://example.test:65536",
            "https://example.test?x",
            "https://example.test#x",
            "https://example.test\\other",
            "https://example.test\"",
            "https://example.test/",
        ] {
            assert!(
                ResourceOrigin::from_admitted(origin).is_err(),
                "accepted {origin}"
            );
        }
        let fixture = Fixture::actual();
        let resource = fixture.open().unwrap();
        let marker = resource.marker.clone();
        assert!(resource
            .bind(&ResourceOrigin::from_admitted(&marker).unwrap())
            .is_err());
    }
}
