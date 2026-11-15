//! Adopted source-derived controls for the original toolSurfaces/titleOf projection.
//!
//! The native owner adopted this file into Cargo's integration test targets.
//! It tests the pure projection and actual selected physical-page
//! composition; no fixture, descriptor, or passing control grants production rights.
//! Source oracle: the retired snapshot's .local/rust-frontend-contract-20261025/
//! luna-tool-screen-projection/oracle-cases.json (15 cases).

use rusqlite::{params, Connection, OpenFlags};
use content_crypto::advanced::blake3;
use std::{
    cmp::Ordering,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering},
        Arc,
    },
};
use tempfile::TempDir;
use trillion_local::{
    ecma_json::{self, JsString, Value},
    import::ReadLimits,
    record_source::{RecordSourceWitness, SnapshotRecordSql},
    tool_fact_page::{self, PageRequest},
    workspace_tool_screens::{
        read_tool_screen_page, CurrentToolScreenAuthority, Failure, Limits, Placement,
        ToolScreenProjection,
    },
};

fn value(input: &str) -> Value {
    ecma_json::parse(input.as_bytes(), ecma_json::Limits::default()).expect("fixture JSON")
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&JsString::from(name)),
        _ => None,
    }
}
fn text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.to_rust_string().expect("scalar test string")),
        _ => None,
    }
}
fn pin(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
fn projection(shipped: &str) -> ToolScreenProjection {
    let surfaces = format!(r#"{{"surfaces":[{shipped}]}}"#);
    let looks = r#"{"screen_icon":"Wrench","tool_surface_defaults":{"package_entry":{"package_name":"trillion","entry_name":"tool-screen"},"placement_labels":["trillion"],"material_target":"component:trillion-tool-screen"}}"#;
    ToolScreenProjection::from_sources(
        surfaces.as_bytes(),
        &pin(surfaces.as_bytes()),
        looks.as_bytes(),
        &pin(looks.as_bytes()),
        &Limits::default(),
    )
    .expect("pinned screen DATA")
}
fn project(projection: &ToolScreenProjection, cards: &str) -> Vec<Value> {
    let cards = match value(cards) {
        Value::Array(cards) => cards,
        _ => panic!("fixture cards must be an array"),
    };
    projection
        .project_cards(&cards, &Limits::default(), &AtomicBool::new(false))
        .expect("projection succeeds")
        .0
}

#[test]
fn title_of_obeys_order_trim_id_filter_and_capitalization() {
    let card = value(
        r#"{"tool_id":"unused","title":"action_name","name":" count letters ","label":"Fallback"}"#,
    );
    let title = trillion_local::workspace_tool_screens::title_of(&card).unwrap();
    assert_eq!(title.title.to_rust_string().unwrap(), "Count letters");
    assert_eq!(title.service, None);

    let title = trillion_local::workspace_tool_screens::title_of(&value(
        r#"{"tool_id":"agentmail-list_messages","label":"tool:ignored"}"#,
    ))
    .unwrap();
    assert_eq!(title.title.to_rust_string().unwrap(), "List messages");
    assert_eq!(
        title.service.unwrap().to_rust_string().unwrap(),
        "Agentmail"
    );

    let title = trillion_local::workspace_tool_screens::title_of(&value(
        r#"{"tool_id":"unused","title":"Alpha-Beta"}"#,
    ))
    .unwrap();
    assert_eq!(title.title.to_rust_string().unwrap(), "Alpha-Beta");
    assert!(title.service.is_none());

    let title = trillion_local::workspace_tool_screens::title_of(&value(
        r#"{"tool_id":"x","title":"  ","name":"name_id","label":"Pretty label"}"#,
    ))
    .unwrap();
    assert_eq!(title.title.to_rust_string().unwrap(), "Pretty label");

    for (source, expected) in [
        (r#"{"tool_id":"x","title":"count"}"#, "Count"),
        (r#"{"tool_id":"x","title":"iMessage"}"#, "iMessage"),
    ] {
        let title = trillion_local::workspace_tool_screens::title_of(&value(source)).unwrap();
        assert_eq!(title.title.to_rust_string().unwrap(), expected);
    }
}

#[test]
fn dynamic_label_icon_and_about_use_nullish_not_truthy_fallbacks() {
    let projection = projection("");
    let rows = project(
        &projection,
        r#"[
        {"tool_id":"alpha","next_call":{},"label":"Alpha tool","description":"card description","job":"job","screen":{"label":null,"icon":null,"about":null}},
        {"tool_id":"beta","next_call":{},"screen":{"label":"","icon":"","about":""}},
        {"tool_id":"gamma","next_call":{},"screen":{"label":false,"icon":0,"about":[]}}
    ]"#,
    );
    assert_eq!(
        text(field(&rows[0], "label")).as_deref(),
        Some("Alpha tool")
    );
    assert_eq!(text(field(&rows[0], "icon")).as_deref(), Some("Wrench"));
    assert_eq!(
        text(field(&rows[0], "description")).as_deref(),
        Some("card description")
    );
    assert_eq!(
        field(&rows[1], "label"),
        Some(&Value::String(JsString::from("")))
    );
    assert_eq!(
        field(&rows[1], "icon"),
        Some(&Value::String(JsString::from("")))
    );
    assert_eq!(
        field(&rows[1], "description"),
        Some(&Value::String(JsString::from("")))
    );
    assert_eq!(field(&rows[2], "label"), Some(&Value::Bool(false)));
    assert_eq!(field(&rows[2], "icon"), Some(&Value::Number(0.0)));
    assert_eq!(field(&rows[2], "description"), Some(&Value::Array(vec![])));
}

#[test]
fn eligible_filter_uses_js_truthiness_and_object_screen_shape() {
    let projection = projection("");
    let rows = project(
        &projection,
        r#"[
        {"tool_id":"","next_call":{},"screen":{"kind":"parts"}},
        {"tool_id":"false-call","next_call":false,"screen":false},
        {"tool_id":"array-screen","screen":[]},
        {"tool_id":"object-screen","screen":{}}
    ]"#,
    );
    assert_eq!(rows.len(), 2);
    assert_eq!(
        text(field(&rows[0], "label")).as_deref(),
        Some("Array screen")
    );
    assert_eq!(
        text(field(&rows[1], "label")).as_deref(),
        Some("Object screen")
    );
}

#[test]
fn asked_filters_strings_but_keeps_empty_filtered_array_and_blank_strings() {
    let projection = projection("");
    let rows = project(
        &projection,
        r#"[
        {"tool_id":"filtered","next_call":{},"screen":{"asked":[null,7]}},
        {"tool_id":"blank","next_call":{},"screen":{"asked":["",false,"ask"]}},
        {"tool_id":"empty","next_call":{},"screen":{"asked":[]}}
    ]"#,
    );
    assert_eq!(field(&rows[0], "asked"), Some(&Value::Array(vec![])));
    assert_eq!(field(&rows[1], "asked"), Some(&value(r#"["","ask"]"#)));
    assert!(field(&rows[2], "asked").is_none());
}

#[test]
fn source_group_is_nonempty_string_only_and_metadata_has_distinct_exists_rules() {
    let projection = projection("");
    let rows = project(
        &projection,
        r#"[
        {"tool_id":"empty-group","next_call":{},"listed_on":"","screen":{"group":"","new_until":""}},
        {"tool_id":"group","next_call":{},"listed_on":"2026-01-02","screen":{"group":"folder","new_until":"until","asked":["ask"]}}
    ]"#,
    );
    assert_eq!(field(&rows[0], "listed_on"), None);
    assert_eq!(
        field(&rows[0], "sidebar_new_until"),
        Some(&Value::String(JsString::from("")))
    );
    assert_eq!(
        field(&rows[0], "source"),
        Some(&value(r#"{"kind":"tool","tool_id":"empty-group"}"#))
    );
    assert_eq!(
        field(&rows[1], "listed_on"),
        Some(&Value::String(JsString::from("2026-01-02")))
    );
    assert_eq!(
        field(&rows[1], "source"),
        Some(&value(
            r#"{"kind":"tool","tool_id":"group","group":"folder"}"#
        ))
    );
}

#[test]
fn app_entry_replacement_preserves_shipped_mount_and_metadata_then_overrides_tool_words() {
    let shipped = r#"{"id":"screen-id","surface_id":"screen-id","kind":"placeable-surface","route_paths":["/old","/shared"],"route_prefix":"/items/","route_input":"id","route_item_input":"row","package_entry":{"package_name":"trillion","entry_name":"guide"},"surface_input":{"screen":"guide","fixed":true},"material_target":"component:guide","placement_order_key":"old-order","listed_on":"old-date","sidebar_new_until":"old-until","asked":["old-ask"],"actions":["preserved"]}"#;
    let rows = project(
        &projection(shipped),
        r#"[
        {"tool_id":"replacement","next_call":{},"listed_on":"2026-01-02","screen":{"kind":"app-entry","entry":"guide","replaces":"screen-id","label":"New label","icon":"Pin","about":"New about","asked":["ask"],"group":"folder"}}
    ]"#,
    );
    let row = &rows[0];
    assert_eq!(text(field(row, "id")).as_deref(), Some("screen-id"));
    assert_eq!(text(field(row, "surface_id")).as_deref(), Some("screen-id"));
    assert_eq!(
        field(row, "package_entry"),
        Some(&value(
            r#"{"package_name":"trillion","entry_name":"guide"}"#
        ))
    );
    assert_eq!(
        field(row, "surface_input"),
        Some(&value(r#"{"screen":"guide","fixed":true}"#))
    );
    assert_eq!(
        text(field(row, "material_target")).as_deref(),
        Some("component:guide")
    );
    assert_eq!(
        field(row, "route_paths"),
        Some(&value(r#"["/old","/shared","/use/replacement"]"#))
    );
    assert_eq!(text(field(row, "route_prefix")).as_deref(), Some("/items/"));
    assert_eq!(text(field(row, "route_input")).as_deref(), Some("id"));
    assert_eq!(text(field(row, "route_item_input")).as_deref(), Some("row"));
    assert_eq!(
        text(field(row, "placement_order_key")).as_deref(),
        Some("old-order")
    );
    assert_eq!(field(row, "actions"), Some(&value(r#"["preserved"]"#)));
    assert_eq!(text(field(row, "label")).as_deref(), Some("New label"));
    assert_eq!(text(field(row, "icon")).as_deref(), Some("Pin"));
    assert_eq!(
        text(field(row, "description")).as_deref(),
        Some("New about")
    );
    assert_eq!(
        field(row, "source"),
        Some(&value(
            r#"{"kind":"tool","tool_id":"replacement","group":"folder"}"#
        ))
    );
    assert_eq!(field(row, "asked"), Some(&value(r#"["ask"]"#)));
    assert_eq!(text(field(row, "listed_on")).as_deref(), Some("2026-01-02"));
    assert_eq!(
        text(field(row, "sidebar_new_until")).as_deref(),
        Some("old-until")
    );
}

#[test]
fn ordinary_replacement_uses_tool_screen_mount_and_keeps_unset_shipped_optionals() {
    let shipped = r#"{"id":"screen-id","route_paths":["/old"],"route_prefix":"/p/","route_input":"id","package_entry":{"package_name":"trillion","entry_name":"guide"},"surface_input":{"screen":"guide"},"material_target":"component:guide","asked":["shipped"],"listed_on":"shipped-date","sidebar_new_until":"shipped-until"}"#;
    let rows = project(
        &projection(shipped),
        r#"[
        {"tool_id":"tool:custom","next_call":{},"screen":{"kind":"module","replaces":"screen-id","label":"Custom","about":"About"}}
    ]"#,
    );
    let row = &rows[0];
    assert_eq!(
        field(row, "route_paths"),
        Some(&value(r#"["/old","/use/custom"]"#))
    );
    assert_eq!(
        field(row, "package_entry"),
        Some(&value(
            r#"{"package_name":"trillion","entry_name":"tool-screen"}"#
        ))
    );
    assert_eq!(
        field(row, "surface_input"),
        Some(&value(r#"{"tool_id":"tool:custom"}"#))
    );
    assert_eq!(
        text(field(row, "material_target")).as_deref(),
        Some("component:trillion-tool-screen")
    );
    assert_eq!(field(row, "asked"), Some(&value(r#"["shipped"]"#)));
    assert_eq!(
        text(field(row, "listed_on")).as_deref(),
        Some("shipped-date")
    );
    assert_eq!(
        text(field(row, "sidebar_new_until")).as_deref(),
        Some("shipped-until")
    );
}

#[test]
fn empty_dates_do_not_override_but_filtered_asked_empty_array_does() {
    let shipped = r#"{"id":"screen-id","route_paths":["/old"],"package_entry":{"entry_name":"guide"},"surface_input":{"screen":"guide"},"material_target":"old-target","listed_on":"old-date","sidebar_new_until":"old-until","asked":["old-ask"]}"#;
    let rows = project(
        &projection(shipped),
        r#"[
        {"tool_id":"tool:custom","next_call":{},"listed_on":"","screen":{"replaces":"screen-id","new_until":"","asked":[false]}}
    ]"#,
    );
    let row = &rows[0];
    assert_eq!(text(field(row, "listed_on")).as_deref(), Some("old-date"));
    assert_eq!(
        text(field(row, "sidebar_new_until")).as_deref(),
        Some("old-until")
    );
    assert_eq!(field(row, "asked"), Some(&Value::Array(vec![])));
}

#[test]
fn replacement_routes_are_stably_deduplicated_shipped_first() {
    let shipped = r#"{"id":"screen-id","route_paths":["/shared","/old","/shared"],"package_entry":{"entry_name":"guide"}}"#;
    let rows = project(
        &projection(shipped),
        r#"[
        {"tool_id":"shared","next_call":{},"screen":{"replaces":"screen-id"}}
    ]"#,
    );
    assert_eq!(
        field(&rows[0], "route_paths"),
        Some(&value(r#"["/shared","/old","/use/shared"]"#))
    );
}

#[test]
fn own_tool_route_encodes_once_and_lone_surrogate_refuses_like_encodeuricomponent() {
    let projection = projection("");
    let rows = project(
        &projection,
        r#"[{"tool_id":"tool:a b/c%2Fé","next_call":{}}]"#,
    );
    let paths = field(&rows[0], "route_paths").unwrap();
    assert_eq!(paths, &value(r#"["/use/a%20b%2Fc%252F%C3%A9"]"#));
    let empty = project(&projection, r#"[{"tool_id":"tool:","next_call":{}}]"#);
    assert_eq!(
        field(&empty[0], "route_paths"),
        Some(&value(r#"["/use/"]"#))
    );
    let malformed = value(r#"[{"tool_id":"tool:\ud800","next_call":{}}]"#);
    let Value::Array(cards) = malformed else {
        unreachable!()
    };
    assert!(matches!(
        projection.project_cards(&cards, &Limits::default(), &AtomicBool::new(false)),
        Err(Failure::Invalid(_, _))
    ));
}

#[test]
fn actual_incident_surface_and_look_data_drive_known_screen_replacement() {
    // These are the identified source DATA files: the retired snapshot's
    // captured surfaces and an engine-owned synthetic mount template. They are not
    // a full effective shared catalog capture; this control covers the actual
    // projection consumer only.
    let incident = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/retired-snapshot/workspace-rust-shell/surfaces.json");
    // The synthetic DATA supplies only the mount template and icon; preserve the old capsule as
    // historical evidence, never mutate its captured bytes or pretend it has it.
    let surfaces = std::fs::read(incident).expect("identified incident surfaces DATA");
    let looks: &[u8] = include_bytes!("fixtures/workshop-looks.json");
    let projection = ToolScreenProjection::from_sources(
        &surfaces,
        "5aec454846589650cfd42b43349af3a07745cc56015dd4ee4b182348266b3fac",
        &looks,
        "bf3fa8e4dc1b0f38ffed8973da10877cfdf312ea7d6b32966b9a1171667e2ea7",
        &Limits::default(),
    )
    .expect("actual incident DATA remains byte-pinned and accepted");
    let rows = project(
        &projection,
        r#"[{"tool_id":"tool:screen-write","next_call":{},"screen":{"kind":"parts","replaces":"trillion.write","label":"Write from tool"}}]"#,
    );
    let row = &rows[0];
    assert_eq!(text(field(row, "id")).as_deref(), Some("trillion.write"));
    assert_eq!(
        field(row, "route_paths"),
        Some(&value(r#"["/write","/use/screen-write"]"#))
    );
    assert_eq!(
        field(row, "package_entry"),
        Some(&value(
            r#"{"package_name":"trillion","entry_name":"tool-screen"}"#
        ))
    );
}

#[test]
fn mount_identity_is_selected_data_and_missing_or_malformed_template_refuses() {
    let surfaces = br#"{"surfaces":[]}"#;
    let looks = br#"{"screen_icon":"Compass","tool_surface_defaults":{"package_entry":{"package_name":"other-market","entry_name":"custom-host"},"placement_labels":["desktop","marketplace"],"material_target":"component:other-host"}}"#;
    let projection = ToolScreenProjection::from_sources(
        surfaces,
        &pin(surfaces),
        looks,
        &pin(looks),
        &Limits::default(),
    )
    .unwrap();
    let rows = project(&projection, r#"[{"tool_id":"tool:custom","next_call":{}}]"#);
    let row = &rows[0];
    assert_eq!(
        field(row, "package_entry"),
        Some(&value(
            r#"{"package_name":"other-market","entry_name":"custom-host"}"#
        ))
    );
    assert_eq!(
        field(row, "placement_labels"),
        Some(&value(r#"["desktop","marketplace"]"#))
    );
    assert_eq!(
        field(row, "material_target"),
        Some(&Value::String("component:other-host".into()))
    );
    assert_eq!(
        field(row, "route_paths"),
        Some(&value(r#"["/use/custom"]"#))
    );
    for invalid in [
        r#"{"screen_icon":"Wrench"}"#,
        r#"{"screen_icon":"Wrench","tool_surface_defaults":null}"#,
        r#"{"screen_icon":"Wrench","tool_surface_defaults":{"package_entry":{"package_name":"x","entry_name":"y"},"placement_labels":[],"material_target":"component:x"}}"#,
        r#"{"screen_icon":"Wrench","tool_surface_defaults":{"package_entry":{"package_name":"x"},"placement_labels":["x"],"material_target":"component:x"}}"#,
    ] {
        assert!(matches!(
            ToolScreenProjection::from_sources(
                surfaces,
                &pin(surfaces),
                invalid.as_bytes(),
                &pin(invalid.as_bytes()),
                &Limits::default()
            ),
            Err(Failure::Integrity(_))
        ));
    }
    // A real historical captured input retains its original pin and bytes;
    // it cannot silently acquire a current mount template or use a fallback.
    let historical = std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "tests/fixtures/retired-snapshot/frontend-contract/src/workshop-looks.json",
    )).expect("retained historical Workshop looks");
    assert_eq!(
        pin(&historical),
        "a9e36aa4e60208e8efe79d582618ef73d2f34529bf99e8e414510b7516f438cc"
    );
    assert!(matches!(
        ToolScreenProjection::from_sources(
            surfaces,
            &pin(surfaces),
            &historical,
            &pin(&historical),
            &Limits::default()
        ),
        Err(Failure::Integrity(_))
    ));
}

struct PhysicalFixture {
    _dir: TempDir,
    path: PathBuf,
}
impl PhysicalFixture {
    fn new(entity: &str, raw: &str) -> Self {
        Self::new_rows(&[(entity, raw)])
    }
    fn new_rows(rows: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workshop.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE workshop_facts(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL); CREATE INDEX workshop_facts_current ON workshop_facts(entity,seq); CREATE TABLE workshop_current(entity TEXT PRIMARY KEY,seq INTEGER NOT NULL,kind TEXT,scope TEXT,due INTEGER,expires INTEGER) WITHOUT ROWID; CREATE TABLE workshop_current_filled(id INTEGER PRIMARY KEY CHECK(id=1),after TEXT NOT NULL,done INTEGER NOT NULL); INSERT INTO workshop_current_filled VALUES(1,'',1);").unwrap();
        for (entity, raw) in rows {
            db.execute(
                "INSERT INTO workshop_facts(at,entity,value) VALUES('fixture',?,?)",
                params![entity, raw],
            )
            .unwrap();
            let seq = db.last_insert_rowid();
            db.execute(
                "INSERT INTO workshop_current(entity,seq) VALUES(?,?)",
                params![entity, seq],
            )
            .unwrap();
        }
        db.close().unwrap();
        Self { _dir: dir, path }
    }
    fn source(&self, cancel: Arc<AtomicBool>) -> SnapshotRecordSql<impl RecordSourceWitness> {
        let db = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        SnapshotRecordSql::begin(
            db,
            ReadLimits {
                rows: 4096,
                result_bytes: 32 * 1024 * 1024,
                cell_bytes: 8 * 1024 * 1024,
                ..Default::default()
            },
            || Ok(()),
            cancel,
        )
        .unwrap()
    }
}

#[derive(Default)]
struct Authority {
    assertions: AtomicUsize,
    catalog_assertions: AtomicUsize,
    catalog_identity: Option<String>,
    observed_catalog_identity: Option<String>,
    revoke_at_assertion: Option<usize>,
}
impl Authority {
    fn for_catalog(bytes: &[u8]) -> Self {
        Self {
            assertions: AtomicUsize::new(0),
            catalog_assertions: AtomicUsize::new(0),
            catalog_identity: Some(pin(bytes)),
            observed_catalog_identity: None,
            revoke_at_assertion: None,
        }
    }
}
impl CurrentToolScreenAuthority for Authority {
    fn assert_current(&mut self) -> Result<(), Failure> {
        let call = self.assertions.fetch_add(1, AtomicOrdering::SeqCst) + 1;
        if self.revoke_at_assertion == Some(call) {
            return Err(trillion_local::cause!(Failure::Source));
        }
        Ok(())
    }
    fn assert_shared_catalog(&mut self, identity: &str) -> Result<(), Failure> {
        self.catalog_assertions.fetch_add(1, AtomicOrdering::SeqCst);
        self.observed_catalog_identity = Some(identity.to_owned());
        if self.catalog_identity.as_deref() == Some(identity) {
            Ok(())
        } else {
            Err(trillion_local::cause!(Failure::Source))
        }
    }
    fn placements(&mut self) -> Result<Vec<Placement>, Failure> {
        Ok(vec![Placement {
            id: JsString::from("local-placement"),
            label: JsString::from("Local"),
            reachable_from: vec![JsString::from("local")],
        }])
    }
    fn compare_labels(&mut self, left: &JsString, right: &JsString) -> Result<Ordering, Failure> {
        // This synthetic comparator is valid only for the explicit ASCII fixtures below.
        // It makes no claim about production locale collation.
        if !left
            .to_rust_string()
            .map_err(|_| trillion_local::cause!(Failure::Source))?
            .is_ascii()
            || !right
                .to_rust_string()
                .map_err(|_| trillion_local::cause!(Failure::Source))?
                .is_ascii()
        {
            return Err(trillion_local::cause!(Failure::Source));
        }
        Ok(left.cmp(right))
    }
}

fn read_page(
    fixture: &PhysicalFixture,
    projection: &ToolScreenProjection,
    shared: &[u8],
    after: &str,
    limit: usize,
) -> trillion_local::workspace_tool_screens::ToolScreenPage {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = fixture.source(cancel.clone());
    let mut authority = Authority::for_catalog(shared);
    let page = read_tool_screen_page(
        &mut source,
        &mut authority,
        &PageRequest {
            after: after.to_owned(),
            limit,
        },
        &tool_fact_page::Limits::default(),
        projection,
        &JsString::from("local"),
        &Limits::default(),
        &cancel,
    )
    .unwrap();
    source.finish().unwrap();
    page
}

#[test]
fn physical_selected_page_admits_screen_parts_without_invoke_and_excludes_other_screen_shapes() {
    let good = r#"{"kind":"ai-tool-descriptor","id":"tool:saved","status":"active","label":"Saved tool","listed_on":"today","screen":{"kind":"parts","replaces":"shipped","label":"Saved screen","group":"folder"}}"#;
    let fixture = PhysicalFixture::new("tool:saved", good);
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = fixture.source(cancel.clone());
    let shared = br#"[]"#;
    let mut authority = Authority::for_catalog(shared);
    let projection = projection(r#"{"id":"shipped","route_paths":["/shipped"],"route_prefix":"/old/","route_input":"id","package_entry":{"entry_name":"guide"},"surface_input":{"screen":"guide"},"material_target":"guide-target"}"#)
        .with_shared_catalog(shared, &pin(shared), &Limits::default()).unwrap();
    let page = read_tool_screen_page(
        &mut source,
        &mut authority,
        &PageRequest {
            after: String::new(),
            limit: 10,
        },
        &tool_fact_page::Limits::default(),
        &projection,
        &JsString::from("local"),
        &Limits::default(),
        &cancel,
    )
    .unwrap();
    source.finish().unwrap();
    assert_eq!(page.surfaces.len(), 1);
    assert_eq!(
        authority.observed_catalog_identity.as_deref(),
        Some(pin(shared).as_str())
    );
    assert_eq!(
        field(&page.surfaces[0], "id"),
        Some(&Value::String(JsString::from("shipped")))
    );
    assert_eq!(
        field(&page.surfaces[0], "route_paths"),
        Some(&value(r#"["/shipped","/use/saved"]"#))
    );
    assert_eq!(
        field(&page.surfaces[0], "source"),
        Some(&value(
            r#"{"kind":"tool","tool_id":"tool:saved","group":"folder"}"#
        ))
    );
    assert!(
        authority.assertions.load(AtomicOrdering::SeqCst) >= 4,
        "current owner is checked before and around the physical read"
    );
}

#[test]
fn physical_selected_page_requires_parts_for_screen_only_but_keeps_runnable_tool_cards() {
    let not_parts = r#"{"kind":"ai-tool-descriptor","id":"tool:not-parts","status":"active","label":"Not parts","screen":{"kind":"module"}}"#;
    let fixture = PhysicalFixture::new("tool:not-parts", not_parts);
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = fixture.source(cancel.clone());
    let shared = br#"[]"#;
    let mut authority = Authority::for_catalog(shared);
    let projection = projection("")
        .with_shared_catalog(shared, &pin(shared), &Limits::default())
        .unwrap();
    let page = read_tool_screen_page(
        &mut source,
        &mut authority,
        &PageRequest {
            after: String::new(),
            limit: 10,
        },
        &tool_fact_page::Limits::default(),
        &projection,
        &JsString::from("local"),
        &Limits::default(),
        &cancel,
    )
    .unwrap();
    source.finish().unwrap();
    assert!(page.surfaces.is_empty());

    let runnable = r#"{"kind":"ai-tool-descriptor","id":"tool:runnable","status":"active","label":"Runnable","placements":["local-placement"],"invoke":{"kind":"http"},"screen":{"kind":"module"}}"#;
    let fixture = PhysicalFixture::new("tool:runnable", runnable);
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = fixture.source(cancel.clone());
    let mut authority = Authority::for_catalog(shared);
    let page = read_tool_screen_page(
        &mut source,
        &mut authority,
        &PageRequest {
            after: String::new(),
            limit: 10,
        },
        &tool_fact_page::Limits::default(),
        &projection,
        &JsString::from("local"),
        &Limits::default(),
        &cancel,
    )
    .unwrap();
    source.finish().unwrap();
    assert_eq!(
        page.surfaces.len(),
        1,
        "a current runnable descriptor remains eligible through its invoke"
    );
    assert_eq!(
        field(&page.surfaces[0], "route_paths"),
        Some(&value(r#"["/use/runnable"]"#))
    );
}

#[test]
fn physical_page_keeps_raw_cursor_filters_shared_duplicates_and_includes_shared_only_first_page() {
    let rows = [
        (
            "tool:a",
            r#"{"kind":"ai-tool-descriptor","id":"tool:shared","status":"active","screen":{"kind":"parts"}}"#,
        ),
        (
            "tool:b",
            r#"{"kind":"ai-tool-descriptor","id":"tool:saved","status":"active","label":"Saved","screen":{"kind":"parts"}}"#,
        ),
    ];
    let fixture = PhysicalFixture::new_rows(&rows);
    let shared = br#"[{"kind":"ai-tool-descriptor","id":"tool:shared","status":"active","label":"Shared","screen":{"kind":"parts"}}]"#;
    let projection = projection("")
        .with_shared_catalog(shared, &pin(shared), &Limits::default())
        .unwrap();

    // The physical first row is filtered as a shared duplicate, but the cursor
    // remains the raw entity cursor so the next request reaches tool:b.
    let first = read_page(&fixture, &projection, shared, "", 1);
    assert_eq!(first.next.as_deref(), Some("tool:a"));
    assert_eq!(first.surfaces.len(), 1);
    assert_eq!(
        text(field(&first.surfaces[0], "id")).as_deref(),
        Some("tool:shared")
    );

    // Shared catalog rows appear only on the first physical page.
    let second = read_page(&fixture, &projection, shared, "tool:a", 1);
    assert_eq!(second.next, None);
    assert_eq!(second.surfaces.len(), 1);
    assert_eq!(
        text(field(&second.surfaces[0], "id")).as_deref(),
        Some("tool:saved")
    );
}

#[test]
fn physical_page_omits_inactive_deleted_secret_and_unknown_placement_rows() {
    let rows = [
        (
            "tool:deleted",
            r#"{"kind":"ai-tool-descriptor","id":"tool:deleted","status":"deleted","screen":{"kind":"parts"}}"#,
        ),
        (
            "tool:inactive",
            r#"{"kind":"ai-tool-descriptor","id":"tool:inactive","status":"active","screen":{"kind":"parts"}}"#,
        ),
        (
            "tool:paused",
            r#"{"kind":"ai-tool-descriptor","id":"tool:paused","status":"paused","screen":{"kind":"parts"}}"#,
        ),
        (
            "tool:secret",
            r#"{"kind":"ai-tool-descriptor","id":"tool:secret","api_token_value":"secret","screen":{"kind":"parts"}}"#,
        ),
        (
            "tool:unknown",
            r#"{"kind":"ai-tool-descriptor","id":"tool:unknown","placements":["missing-placement"],"invoke":{"kind":"read"}}"#,
        ),
        (
            "tool:valid",
            r#"{"kind":"ai-tool-descriptor","id":"tool:valid","status":"active","screen":{"kind":"parts"}}"#,
        ),
    ];
    let fixture = PhysicalFixture::new_rows(&rows);
    let shared = br#"[{"kind":"ai-tool-descriptor","id":"tool:inactive","status":"paused","screen":{"kind":"parts"}}]"#;
    let projection = projection("")
        .with_shared_catalog(shared, &pin(shared), &Limits::default())
        .unwrap();
    let page = read_page(&fixture, &projection, shared, "", 10);
    assert_eq!(page.surfaces.len(), 1);
    assert_eq!(
        text(field(&page.surfaces[0], "id")).as_deref(),
        Some("tool:valid")
    );
}

#[test]
fn shared_utf16_label_is_preserved_as_metadata_without_synthetic_collation_claim() {
    let fixture = PhysicalFixture::new(
        "tool:row",
        r#"{"kind":"ai-tool-descriptor","id":"tool:row","status":"active","screen":{"kind":"parts"}}"#,
    );
    let shared = r#"[{"kind":"ai-tool-descriptor","id":"tool:emoji","status":"active","label":"A 😀","screen":{"kind":"parts"}}]"#.as_bytes();
    let projection = projection("")
        .with_shared_catalog(shared, &pin(shared), &Limits::default())
        .unwrap();
    let page = read_page(&fixture, &projection, shared, "", 10);
    let emoji = page
        .surfaces
        .iter()
        .find(|row| text(field(row, "id")).as_deref() == Some("tool:emoji"))
        .expect("shared emoji label row");
    assert_eq!(
        field(emoji, "label"),
        Some(&Value::String(JsString::from("A 😀")))
    );
}

#[test]
fn missing_or_mismatched_full_effective_catalog_witness_refuses_page_read() {
    // This is a synthetic complete catalog fixture, not a claim that the shipped
    // screen-record file alone represents every effective shared tool/default.
    let descriptor = r#"{"kind":"ai-tool-descriptor","id":"tool:screen","status":"active","screen":{"kind":"parts"}}"#;
    let fixture = PhysicalFixture::new("tool:screen", descriptor);
    let cancel = Arc::new(AtomicBool::new(false));
    let shared = br#"[]"#;
    let missing_catalog = projection("");
    let mut source = fixture.source(cancel.clone());
    let mut authority = Authority::for_catalog(shared);
    let result = read_tool_screen_page(
        &mut source,
        &mut authority,
        &PageRequest {
            after: String::new(),
            limit: 10,
        },
        &tool_fact_page::Limits::default(),
        &missing_catalog,
        &JsString::from("local"),
        &Limits::default(),
        &cancel,
    );
    assert!(matches!(result, Err(Failure::Integrity(_))));
    assert_eq!(authority.catalog_assertions.load(AtomicOrdering::SeqCst), 0);
    source.finish().unwrap();

    let projection = projection("")
        .with_shared_catalog(shared, &pin(shared), &Limits::default())
        .unwrap();

    for expected in [
        None,
        Some(pin(br#"[{"id":"different-effective-catalog"}]"#)),
    ] {
        let mut source = fixture.source(cancel.clone());
        let mut authority = Authority {
            catalog_identity: expected,
            ..Default::default()
        };
        let result = read_tool_screen_page(
            &mut source,
            &mut authority,
            &PageRequest {
                after: String::new(),
                limit: 10,
            },
            &tool_fact_page::Limits::default(),
            &projection,
            &JsString::from("local"),
            &Limits::default(),
            &cancel,
        );
        assert!(matches!(result, Err(Failure::Source(_))));
        assert_eq!(authority.catalog_assertions.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(
            authority.observed_catalog_identity.as_deref(),
            Some(pin(shared).as_str())
        );
        source.finish().unwrap();
    }
}

#[test]
fn current_authority_revoked_before_disclosure_returns_only_refusal() {
    let descriptor = r#"{"kind":"ai-tool-descriptor","id":"tool:screen","status":"active","screen":{"kind":"parts"}}"#;
    let fixture = PhysicalFixture::new("tool:screen", descriptor);
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = fixture.source(cancel.clone());
    let shared = br#"[]"#;
    let projection = projection("")
        .with_shared_catalog(shared, &pin(shared), &Limits::default())
        .unwrap();
    let mut authority = Authority::for_catalog(shared);
    // The fourth current-owner check is the final check after projection and
    // before returning the provisional page to a caller.
    authority.revoke_at_assertion = Some(4);
    let result = read_tool_screen_page(
        &mut source,
        &mut authority,
        &PageRequest {
            after: String::new(),
            limit: 10,
        },
        &tool_fact_page::Limits::default(),
        &projection,
        &JsString::from("local"),
        &Limits::default(),
        &cancel,
    );
    assert!(matches!(result, Err(Failure::Source(_))));
    assert_eq!(authority.assertions.load(AtomicOrdering::SeqCst), 4);
    source.finish().unwrap();
}

#[test]
fn output_and_cancellation_bounds_return_no_partial_projection() {
    let projection = projection("");
    let Value::Array(cards) = value(r#"[{"tool_id":"a useful screen","next_call":{}}]"#) else {
        unreachable!()
    };
    let small = Limits {
        output_bytes: 2,
        ..Default::default()
    };
    assert!(matches!(
        projection.project_cards(&cards, &small, &AtomicBool::new(false)),
        Err(Failure::Bounds(_))
    ));
    assert!(matches!(
        projection.project_cards(&cards, &Limits::default(), &AtomicBool::new(true)),
        Err(Failure::Cancelled(_))
    ));
}
