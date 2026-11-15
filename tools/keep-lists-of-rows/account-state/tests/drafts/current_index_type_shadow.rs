use serde_json::json;
// Real typed index, kept checkpoint, canonical stamps and original tail replay.
fn page_for(body: serde_json::Value, limits: CurrentIndexLimits) -> (Fixture, record_indexes::Result<(CurrentIndexPage, crate::scan::ReadWork)>) {
    let f=Fixture::new(3,Some(body.to_string()),false);
    let result=query(&f,&Query{limit:10,..Default::default()},limits);
    (f,result)
}
fn contains(page:&CurrentIndexPage,id:&str)->bool{page.entries.iter().any(|entry|entry.id==id)}
#[test]
fn implicit_nonrequested_whole_and_patch_shadow_old_requested_index_without_root() {
    let (_,result)=page_for(json!([
        {"id":"decision:00000","type":"message","value":{"created_at":"changed","text":"private"}},
        {"id":"decision:00000","type":"message","set":{"text":"later"}}
    ]),Default::default());
    let (page,work)=result.unwrap();
    assert_eq!(page.entries.len(),2);assert!(!contains(&page,"decision:00000"));
    assert_eq!(page.work.dirty_records,1);assert_eq!(work.rows_written,0);
}
#[test]
fn later_requested_type_restores_original_root_and_replays_prefix() {
    let (_,result)=page_for(json!([
        {"id":"decision:00000","type":"message","value":{"created_at":"changed","old":"retained"}},
        {"id":"decision:00000","type":"decision","set":{"title":"again"}}
    ]),Default::default());
    let (page,work)=result.unwrap();assert_eq!(page.entries.len(),3);
    assert!(contains(&page,"decision:00000"));assert_eq!(work.rows_written,0);
    let entry=page.entries.iter().find(|entry|entry.id=="decision:00000").unwrap();
    assert!(entry.values==vec![json!("changed")],"fallback must retain the earlier whole's indexed field");
}
#[test]
fn later_explicit_older_stamp_cannot_restore_old_requested_type() {
    let (_,result)=page_for(json!([
        {"id":"decision:00000","type":"message","value":{"created_at":"changed"}},
        {"id":"decision:00000","type":"decision","set":{"created_at":"must-not-win"},"at":"0"}
    ]),Default::default());
    let (page,_)=result.unwrap();assert_eq!(page.entries.len(),2);assert!(!contains(&page,"decision:00000"));
}
#[test]
fn explicit_older_nonrequested_whole_and_untyped_patch_still_need_prior_state() {
    for body in [
        json!([{"id":"decision:00000","type":"message","value":{"created_at":"changed"},"at":"0"}]),
        json!([{"id":"decision:00000","set":{"created_at":"changed"}}]),
    ] {
        let (_,result)=page_for(body,Default::default());let(page,_)=result.unwrap();
        assert!(contains(&page,"decision:00000"));
    }
}
#[test]
fn malformed_deferred_events_are_refused_and_never_become_missing() {
    for body in [
        json!([{"id":"decision:00000","type":"message","value":false}]),
        json!([{"id":"decision:00000","type":"message","value":{}},{"id":"decision:00000","type":"message","unset":false}]),
    ] {
        let (_,result)=page_for(body,Default::default());assert!(result.is_err());
    }
}
#[test]
fn tight_staging_limit_falls_back_without_changing_output_or_writing() {
    let body=json!([{"id":"decision:00000","type":"message","value":{"created_at":"changed"},"unused":"x".repeat(20000)}]);
    // Existing checkpoint has ~8KiB unrelated field; raw event is larger than
    // this cap, but original canonical projection and final output still fit.
    let (_,result)=page_for(body,CurrentIndexLimits{held_bytes:16000,..Default::default()});
    let(page,work)=result.unwrap();assert_eq!(page.entries.len(),2);assert!(!contains(&page,"decision:00000"));assert_eq!(work.rows_written,0);
}
#[test]
fn discarded_validation_projection_and_restored_root_cannot_escape_held_bound() {
    let mut fields=serde_json::Map::new();for at in 0..12 {fields.insert(format!("f{at}"),json!(1));}
    let (_,result)=page_for(json!([{"id":"decision:00000","type":"message","value":fields}]),CurrentIndexLimits{held_bytes:1024,..Default::default()});
    assert!(result.is_err(),"the temporary canonical validation value model is real held work");
    let (_,result)=page_for(json!([
        {"id":"decision:00000","type":"message","value":{"created_at":"small"}},
        {"id":"decision:00000","type":"decision","set":{"title":"again"}}
    ]),CurrentIndexLimits{held_bytes:2000,..Default::default()});
    assert!(result.is_err(),"restored ~8KiB old root must refuse before the small prefix can shrink it");
}
#[test]
fn shadow_prefix_remove_purge_and_restore_keep_canonical_index_membership() {
    for deletion in [json!({"id":"decision:00000","remove":true}),json!({"id":"decision:00000","purge":true})] {
        let first=json!({"id":"decision:00000","type":"unregistered-kind","value":{"created_at":"changed"}});
        let (_,result)=page_for(json!([first.clone(),deletion.clone()]),Default::default());
        assert!(!contains(&result.unwrap().0,"decision:00000"));
        let restore=json!({"id":"decision:00000","type":"decision","value":{"created_at":"restored"}});
        let (_,result)=page_for(json!([first,deletion,restore]),Default::default());
        let(page,_)=result.unwrap();let entry=page.entries.iter().find(|entry|entry.id=="decision:00000").unwrap();
        assert_eq!(entry.values,vec![json!("restored")]);
    }
}
#[test]
fn missing_type_keeps_prior_type_and_unknown_or_malformed_metadata_never_infers_exclusion() {
    let (_,result)=page_for(json!([{"id":"decision:00000","value":{"created_at":"without-type"}}]),Default::default());
    assert!(contains(&result.unwrap().0,"decision:00000"));
    for metadata in [json!({"floor_kind":"unknown"}),json!({"stamps":false}),json!({"removed":9}),json!({"at":false})] {
        let first=json!({"id":"decision:00000","type":"message","value":{"created_at":"changed"}});
        let mut later=json!({"id":"decision:00000","type":"message","set":{"created_at":"later"}});
        for(key,value)in metadata.as_object().unwrap(){later.as_object_mut().unwrap().insert(key.clone(),value.clone());}
        let (_,result)=page_for(json!([first,later]),Default::default());assert!(result.is_err());
    }
}
