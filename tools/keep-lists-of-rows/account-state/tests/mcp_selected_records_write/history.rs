// tests/mcp_selected_records_write/history.rs
//
// Purpose: The records door's version history over the live door, included beside controls.rs so it shares its fixture
// (see src/native_boot/mcp_selected_personal/workspace_write.rs). Synthetic records only.

/// The door's version history over the live door: the person's key reads a record's versions newest first and pages
/// them; a key of the account without the `records` scope is refused it (nothing is read), as is a key nobody issued.
#[tokio::test]
async fn history_is_read_by_the_signed_in_person_and_refused_to_an_unissued_key() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let door = crate::record_value::account_routes::Door::shipped().unwrap();
    let history = door.history_operation();
    let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
    let note = |words: &str| json!({"records":[{"id":"note-1","type":"note","value":{"words":words}}]});
    let answer = |reply: &Value| reply["result"]["structuredContent"].clone();
    for (key, words) in [("first", "FIRST_WORDS"), ("second", "SECOND_WORDS")] {
        let (_, made) = reply(&app, door_request(&fixture.token, key, write, note(words))).await;
        assert_eq!(answer(&made)["changed"], true, "{made}");
    }

    let (_, page) = reply(&app, door_request(&fixture.token, "history-1", history, json!({"id":"note-1","limit":1}))).await;
    let page = answer(&page);
    assert_eq!(page["versions"][0]["value"]["words"], "SECOND_WORDS", "{page}");
    assert_eq!(page["versions"][0]["deleted"], false, "{page}");
    let (_, older) = reply(&app, door_request(&fixture.token, "history-2", history,
        json!({"id":"note-1","limit":5,"before_version":page["next"].clone()}))).await;
    assert_eq!(answer(&older)["versions"][0]["value"]["words"], "FIRST_WORDS", "{older}");
    assert_eq!(answer(&older)["next"], Value::Null, "{older}");

    let (status, _) = reply(&app, door_request("nm_0000000000000000000000000000000000000000000000000000000000000000",
        "unissued", history, json!({"id":"note-1","limit":5}))).await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
}
