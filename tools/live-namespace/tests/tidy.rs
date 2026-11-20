// tests/tidy.rs
//
// Purpose: A tidy-up of a person's files (src/account_files/tidy.rs) through the account files' calls, over a byte port in
// memory: a grounded suggestion is kept and an ungrounded one refused with why; the person's choices; one tidy-up that moves
// a file into a folder and records its title; a suggestion whose evidence changed since is left out as stale; undo puts every
// file back and is refused once a file changed since; a tidy-up a call stopped part way is finished by the next call. The old
// Worker's contract (the old src/file-tidy.mjs) is the answer shape. Synthetic data only.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod account_files_common;

use account_files_common::{account_files, write};
use live_namespace::account_files::{tidy::TIDY_UPS, AccountFiles};
use live_namespace::store::Mutation;
use serde_json::{json, Value};

fn call(files: &mut AccountFiles, tool: &str, input: Value) -> Value {
    files.call(tool, &input).expect("a tool").expect("answered")
}

fn transcript(files: &mut AccountFiles, identity: &str, words: &str) {
    let recorded = call(files, "record_file_results", json!({"results": [{"identity": identity, "kind": "transcript", "value": {"text": words}}]}));
    assert_eq!(recorded["recorded"], 1, "{recorded}");
}

fn named(files: &mut AccountFiles, folder: &str) -> Vec<String> {
    call(files, "list_files", json!({"folder": folder}))["names"].as_array().unwrap().iter().map(|row| row["name"].as_str().unwrap().to_owned()).collect()
}

fn title(files: &mut AccountFiles, identity: &str) -> Option<String> {
    let read = call(files, "read_file_results", json!({"identity": identity, "kind": "title"}));
    read["results"].as_array().unwrap().first().and_then(|row| row["value"]["title"].as_str()).map(str::to_owned)
}

#[test]
fn a_grounded_suggestion_is_applied_as_one_tidy_up_and_undone() {
    let (mut files, _, _) = account_files();
    let forehand = write(&mut files, "/Inbox/C9058.MP4", b"forehand bytes");
    let serve = write(&mut files, "/Inbox/C9059.MP4", b"serve bytes");
    transcript(&mut files, &forehand, "Side view of my forehand at the Austin courts, working on the racket drop.");
    transcript(&mut files, &serve, "Practising the kick serve toss from the baseline.");

    let proposed = call(&mut files, "tidy_propose", json!({"produced_by": "test", "items": [
        {"name": "/Inbox/C9058.MP4", "title": "Forehand racket drop, side view", "folder": "/Tennis/Forehand", "evidence": ["transcript"], "reason": "the transcript names it"},
        {"name": "/Inbox/C9059.MP4", "title": "Backhand slice volleys tournament", "evidence": ["transcript"]},
        {"name": "/Inbox/C9059.MP4", "folder": "/Tennis/Serve", "evidence": ["transcript"]},
        {"name": "/Inbox/nothing.MP4", "title": "Anything", "evidence": ["transcript"]},
        {"name": "/Inbox/C9058.MP4", "title": "Forehand", "evidence": ["summary"]},
        {"name": "/Inbox/C9058.MP4", "evidence": ["transcript"]},
    ]}));
    assert_eq!(proposed["proposed"].as_array().unwrap().len(), 2, "{proposed}");
    let refused: Vec<(u64, String)> = proposed["refused"].as_array().unwrap().iter().map(|row| (row["index"].as_u64().unwrap(), row["reason"].as_str().unwrap().to_owned())).collect();
    assert_eq!(refused.iter().map(|(index, _)| *index).collect::<Vec<_>>(), [1, 3, 4, 5], "{proposed}");
    assert!(refused[0].1.contains("backhand"), "an ungrounded title says which words are missing: {}", refused[0].1);
    assert!(refused[1].1.contains("No file"), "{}", refused[1].1);
    assert!(refused[2].1.contains("summary"), "{}", refused[2].1);
    let again = call(&mut files, "tidy_propose", json!({"items": [{"name": "/Inbox/C9058.MP4", "title": "Forehand racket drop, side view", "folder": "/Tennis/Forehand", "evidence": ["transcript"], "reason": "the transcript names it"}]}));
    assert_eq!(again["unchanged"], 1, "the same suggestion again is kept once");

    let listed = call(&mut files, "tidy_list", json!({}));
    assert_eq!(listed["counts"]["review"], 2, "{listed}");
    let ids: Vec<String> = listed["proposals"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap().to_owned()).collect();
    let decided = call(&mut files, "tidy_decide", json!({"decisions": [{"id": ids[0], "choice": "accept"}, {"id": ids[1], "choice": "accept"}, {"id": "tidy:none", "choice": "accept"}, {"id": ids[0], "choice": "maybe"}]}));
    assert_eq!((decided["decided"].as_u64(), decided["refused"].as_array().unwrap().len()), (Some(2), 2), "{decided}");

    // The serve's evidence changes after its suggestion: it is left out of the tidy-up as stale.
    transcript(&mut files, &serve, "A different take: return of serve drills.");
    let applied = call(&mut files, "tidy_apply", json!({"name": "Tennis clips"}));
    assert_eq!(applied["applied"], 1, "{applied}");
    assert_eq!(applied["refused"].as_array().unwrap().len(), 1, "{applied}");
    assert!(applied["refused"][0]["reason"].as_str().unwrap().contains("transcript"), "{applied}");
    let tidy_up = applied["tidy_up"].as_str().unwrap().to_owned();
    assert_eq!(named(&mut files, "/Tennis/Forehand"), ["/Tennis/Forehand/C9058.MP4"]);
    assert_eq!(named(&mut files, "/Inbox"), ["/Inbox/C9059.MP4"]);
    assert_eq!(title(&mut files, &forehand).as_deref(), Some("Forehand racket drop, side view"));
    let listed = call(&mut files, "tidy_list", json!({}));
    assert_eq!((listed["counts"]["applied"].as_u64(), listed["counts"]["stale"].as_u64()), (Some(1), Some(1)), "{listed}");
    assert_eq!(listed["can_undo"], json!(tidy_up));
    let applied_row = listed["proposals"].as_array().unwrap().iter().find(|row| row["state"] == "applied").unwrap();
    assert_eq!(applied_row["tidy_up"]["id"], json!(tidy_up), "a suggestion names its tidy-up as the screen reads it");
    let nothing = call(&mut files, "tidy_apply", json!({}));
    assert!(nothing["error"].as_str().unwrap().contains("Nothing is accepted"), "{nothing}");

    let history = call(&mut files, "tidy_history", json!({}));
    assert_eq!(history["tidy_ups"][0]["name"], "Tennis clips");
    assert_eq!(history["tidy_ups"][0]["can_undo"], true);

    let undone = call(&mut files, "tidy_undo", json!({}));
    assert_eq!((undone["undone"].as_str(), undone["changes"].as_u64()), (Some(tidy_up.as_str()), Some(1)), "{undone}");
    assert_eq!(named(&mut files, "/Inbox"), ["/Inbox/C9058.MP4", "/Inbox/C9059.MP4"]);
    assert_eq!(title(&mut files, &forehand), None, "a title the file did not have before is removed");
    let twice = call(&mut files, "tidy_undo", json!({"id": tidy_up}));
    assert!(twice["error"].as_str().unwrap().contains("already undone"), "{twice}");
    assert!(call(&mut files, "tidy_undo", json!({}))["error"].as_str().unwrap().contains("no tidy-up"));
}

#[test]
fn undo_is_refused_once_a_file_it_moved_changed_since() {
    let (mut files, _, _) = account_files();
    let clip = write(&mut files, "/Inbox/clip.mov", b"clip bytes");
    transcript(&mut files, &clip, "Kitchen conversation about the pizza truck.");
    let proposed = call(&mut files, "tidy_propose", json!({"items": [{"name": "/Inbox/clip.mov", "folder": "/Austin/Pizza", "evidence": ["transcript"]}]}));
    let id = proposed["proposed"][0]["id"].as_str().unwrap().to_owned();
    call(&mut files, "tidy_decide", json!({"decisions": [{"id": id, "choice": "accept"}]}));
    assert_eq!(call(&mut files, "tidy_apply", json!({}))["applied"], 1);
    let moved = call(&mut files, "move_names", json!({"from": "/Austin/Pizza/clip.mov", "to": "/Austin/clip.mov"}));
    assert!(moved.get("error").is_none(), "{moved}");
    let refused = call(&mut files, "tidy_undo", json!({}));
    assert!(refused["error"].as_str().unwrap().contains("/Austin/Pizza/clip.mov"), "{refused}");
    assert_eq!(named(&mut files, "/Austin"), ["/Austin/clip.mov"], "nothing was undone");
}

#[test]
fn a_tidy_up_left_part_way_is_finished_by_the_next_call() {
    let (mut files, _, _) = account_files();
    let clip = write(&mut files, "/Inbox/talk.mp4", b"talk bytes");
    transcript(&mut files, &clip, "Late night talk under the lights.");
    let proposed = call(&mut files, "tidy_propose", json!({"items": [{"name": "/Inbox/talk.mp4", "title": "Late night talk", "folder": "/Lights", "evidence": ["transcript"]}]}));
    let id = proposed["proposed"][0]["id"].as_str().unwrap().to_owned();
    call(&mut files, "tidy_decide", json!({"decisions": [{"id": id, "choice": "accept"}]}));
    let applied = call(&mut files, "tidy_apply", json!({}));
    let tidy_up = applied["tidy_up"].as_str().unwrap().to_owned();
    // As if a call stopped after writing its plan and taking its steps, before marking the tidy-up applied.
    let store = files.store.clone();
    let (version, row) = store.held_record_with_version(TIDY_UPS, &tidy_up).unwrap();
    let mut value = row.unwrap().value;
    value["state"] = json!("applying");
    store.mutate(TIDY_UPS, Mutation { id: tidy_up.clone(), expected_version: version, request_key: "test:left".into(), deleted: false, value }).unwrap();
    assert_eq!(call(&mut files, "tidy_list", json!({}))["can_undo"], Value::Null, "a tidy-up part way is not undone");
    let finished = call(&mut files, "tidy_undo", json!({}));
    assert_eq!(finished["finished_first"], json!(tidy_up), "{finished}");
    assert_eq!(finished["answer"]["applied"], 1, "its steps already taken are skipped: {finished}");
    assert_eq!(named(&mut files, "/Lights"), ["/Lights/talk.mp4"]);
    let undone = call(&mut files, "tidy_undo", json!({}));
    assert_eq!(undone["undone"], json!(tidy_up), "{undone}");
    assert_eq!(named(&mut files, "/Inbox"), ["/Inbox/talk.mp4"]);
}
