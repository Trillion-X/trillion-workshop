//! The old hooks' own test cases, moved one to one: trillion test/record-every-message.test.mjs (transcript reading,
//! cursor, prompt intake), test/decision-notices.test.mjs and test/decisions-since-held-line.test.mjs (the decisions
//! said into a turn) and test/wake-sessions.test.mjs (`registerSession`). The hook rows run here over an in-memory
//! records store standing in for the account's own records operations; the command's loopback call is not run here.

use super::transcript::{self, harness_of, messages_of, words_of, Message};
use super::*;
use std::collections::BTreeMap;
use std::io::Write as _;

const SESSION: &str = "8c5a4d75-c324-4633-aa0a-986edabfc1d5";
const CODEX: &str = "01a0e619-c450-7b11-8126-d66630c52dda";

fn routes() -> &'static HookRoutes {
    HookRoutes::shipped().expect("hooks.json reads")
}

fn harness(id: &str) -> &'static Harness {
    routes().harness(id).expect("a harness row")
}

/// The Claude Code base row: a person typed it (origin human).
fn base(fields: Value) -> Value {
    let mut row = json!({"isSidechain": false, "userType": "external", "entrypoint": "cli", "sessionId": SESSION, "origin": {"kind": "human"}});
    for (key, value) in fields.as_object().unwrap() {
        row[key] = value.clone();
    }
    row
}

/// Rows shaped like ~/.claude/projects/<project>/<session>.jsonl (the old test's claudeRows).
fn claude_rows() -> Vec<Value> {
    vec![
        json!({"type": "custom-title", "sessionId": SESSION, "customTitle": "x"}),
        base(json!({"type": "user", "isMeta": true, "timestamp": "2026-09-27T18:19:28.357Z", "message": {"role": "user", "content": "<system-reminder>\nThe user named this session \"x\".\n</system-reminder>"}})),
        base(json!({"type": "user", "timestamp": "2026-09-27T18:19:20.677Z", "origin": {"kind": "human"}, "message": {"role": "user", "content": "You own what an AI sees  when it connects.\n\nRead your brief first."}})),
        base(json!({"type": "user", "entrypoint": "sdk-cli", "promptSource": "sdk", "timestamp": "2026-09-27T18:19:21.000Z", "message": {"role": "user", "content": "Reply with exactly OK."}})),
        base(json!({"type": "assistant", "timestamp": "2026-09-27T18:19:43.943Z", "message": {"model": "claude-opus-5-5", "id": "msg_1", "role": "assistant", "content": [{"type": "thinking", "thinking": "", "signature": "abc"}]}})),
        base(json!({"type": "assistant", "timestamp": "2026-09-27T18:19:45.087Z", "message": {"model": "claude-opus-5-5", "id": "msg_1", "role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}}]}})),
        base(json!({"type": "user", "timestamp": "2026-09-27T18:20:25.373Z", "toolUseResult": {"stdout": "a"}, "message": {"role": "user", "content": [{"tool_use_id": "toolu_1", "type": "tool_result", "content": "a\nb"}]}})),
        base(json!({"type": "attachment", "timestamp": "2026-09-27T18:20:26.000Z", "attachment": {"type": "hook_success", "content": "ok"}})),
        base(json!({"type": "attachment", "timestamp": "2026-09-27T18:21:19.612Z", "attachment": {"type": "queued_command", "prompt": "<cross-session-message from=\"uds:/tmp/x.sock\">\nhello\n</cross-session-message>"}})),
        base(json!({"type": "attachment", "timestamp": "2026-09-27T18:22:00.000Z", "attachment": {"type": "queued_command", "origin": {"kind": "human"}, "prompt": "also do the other thing"}})),
        base(json!({"type": "assistant", "uuid": "claude-commentary-row", "timestamp": "2026-09-27T18:22:05.762Z", "message": {"model": "claude-opus-5-5", "id": "msg_2", "role": "assistant", "content": [{"type": "text", "text": "Now reading the tools folder code."}]}})),
        base(json!({"type": "assistant", "timestamp": "2026-09-27T19:08:28.028Z", "message": {"model": "<synthetic>", "id": "x", "role": "assistant", "content": [{"type": "text", "text": "API Error: 500"}]}})),
        base(json!({"uuid": "image-user-row", "type": "user", "timestamp": "2026-09-28T00:25:38.933Z", "message": {"role": "user", "content": [{"type": "text", "text": "why do i need to refresh[Image #2]"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBOR"}}]}})),
        base(json!({"type": "user", "isMeta": true, "timestamp": "2026-09-28T00:25:38.933Z", "message": {"role": "user", "content": [{"type": "text", "text": "[Image: source: /private/tmp/2.png]"}]}})),
        base(json!({"type": "user", "isCompactSummary": true, "timestamp": "2026-09-28T03:42:31.839Z", "message": {"role": "user", "content": "This session is being continued from a previous conversation."}})),
        base(json!({"isSidechain": true, "type": "assistant", "timestamp": "2026-09-28T03:43:00.000Z", "message": {"model": "claude-opus-5-5", "role": "assistant", "content": [{"type": "text", "text": "a subagent speaking"}]}})),
        base(json!({"type": "user", "timestamp": "2026-09-28T03:44:00.000Z", "message": {"role": "user", "content": "<task-notification>\n<task-id>b1</task-id>\n</task-notification>"}})),
    ]
}

/// Rows shaped like ~/.codex/sessions/<y>/<m>/<d>/rollout-<time>-<session>.jsonl (the old test's codexRows).
fn codex_rows() -> Vec<Value> {
    vec![
        json!({"timestamp": "2026-09-28T03:40:50.486Z", "type": "session_meta", "payload": {"session_id": CODEX, "id": CODEX, "cwd": "/x", "originator": "Codex Desktop", "source": "vscode"}}),
        json!({"timestamp": "2026-09-28T03:40:59.300Z", "type": "response_item", "payload": {"type": "message", "id": "msg_a", "role": "developer", "content": [{"type": "input_text", "text": "<skills_instructions>\n## Skills"}]}}),
        json!({"timestamp": "2026-09-28T03:40:59.300Z", "type": "turn_context", "payload": {"turn_id": "t1", "model": "gpt-6", "cwd": "/x"}}),
        json!({"timestamp": "2026-09-28T03:40:59.300Z", "type": "response_item", "payload": {"type": "message", "id": "msg_b", "role": "user", "content": [{"type": "input_text", "text": "<recommended_plugins>\n- Dropbox"}, {"type": "input_text", "text": "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nx"}, {"type": "input_text", "text": "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>"}]}}),
        json!({"timestamp": "2026-09-28T03:41:00.100Z", "type": "response_item", "payload": {"type": "message", "id": "msg_c", "role": "user", "content": [{"type": "input_text", "text": "Append the line '<!-- probe -->' at the end."}]}}),
        json!({"timestamp": "2026-09-28T03:41:00.200Z", "type": "event_msg", "payload": {"type": "user_message", "message": "Append the line '<!-- probe -->' at the end."}}),
        json!({"timestamp": "2026-09-28T03:41:10.000Z", "type": "response_item", "payload": {"type": "reasoning", "summary": []}}),
        json!({"timestamp": "2026-09-28T03:41:20.000Z", "type": "response_item", "payload": {"type": "custom_tool_call", "name": "apply_patch", "call_id": "c1", "input": "*** Begin Patch"}}),
        json!({"timestamp": "2026-09-28T03:41:30.000Z", "type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "c1", "output": "refused"}}),
        json!({"timestamp": "2026-09-28T03:41:49.490Z", "type": "response_item", "payload": {"type": "message", "id": "msg_d", "role": "assistant", "content": [{"type": "output_text", "text": "Before changing files, decide it with Trillion."}], "phase": "final_answer"}}),
    ]
}

fn messages(rows: &[Value], harness: &Harness, session: &str) -> Vec<Message> {
    messages_of(rows, harness, session, &Map::new(), &[], true, &routes().patterns).messages
}

fn field<'a>(message: &'a Message, name: &str) -> Option<&'a Value> {
    message.0.get(name)
}

fn lines(rows: &[Value]) -> String {
    rows.iter().map(|row| format!("{row}\n")).collect()
}

fn text_rule(types: &[&str]) -> transcript::TextRule {
    serde_json::from_value(json!({"path": [], "part_types": types})).unwrap()
}

// --- test/record-every-message.test.mjs ---

#[test]
fn a_claude_code_transcript_yields_the_persons_messages_and_the_ais_replies_verbatim_and_nothing_injected() {
    let rows = claude_rows();
    let found = harness_of(&rows, &routes().settings.harnesses).unwrap();
    assert_eq!(found.app, "Claude Code");
    let said = messages(&rows, found, SESSION);
    let seen: Vec<(&str, &str, &str)> = said.iter().map(|m| (m.speaker(), m.text(), m.at())).collect();
    assert_eq!(seen, vec![
        ("person", "You own what an AI sees  when it connects.\n\nRead your brief first.", "2026-09-27T18:19:20.677Z"),
        ("person", "also do the other thing", "2026-09-27T18:22:00.000Z"),
        ("ai", "Now reading the tools folder code.", "2026-09-27T18:22:05.762Z"),
        ("person", "why do i need to refresh[Image #2]", "2026-09-28T00:25:38.933Z"),
    ]);
    assert!(said.iter().all(|m| field(m, "conversation_id") == Some(&json!(format!("claude-code:{SESSION}"))) && field(m, "app") == Some(&json!("Claude Code"))));
    assert_eq!(field(&said[2], "model"), Some(&json!("claude-opus-5-5")));
    assert_eq!(field(&said[2], "source_ref"), Some(&json!("claude-commentary-row")));
    assert_eq!(field(&said[0], "model"), None);
    assert_eq!(field(&said[3], "source_ref"), Some(&json!("image-user-row")));
}

#[test]
fn a_codex_transcript_yields_the_persons_words_and_the_reply_with_the_model_its_turn_named() {
    let rows = codex_rows();
    let found = harness_of(&rows, &routes().settings.harnesses).unwrap();
    assert_eq!(found.app, "Codex");
    let said = messages(&rows, found, CODEX);
    let seen: Vec<(Option<&Value>, &str, &str, Option<&Value>)> = said.iter()
        .map(|m| (field(m, "conversation_id"), m.speaker(), m.text(), field(m, "model"))).collect();
    let conversation = json!(format!("codex:{CODEX}"));
    assert_eq!(seen, vec![
        (Some(&conversation), "person", "Append the line '<!-- probe -->' at the end.", None),
        (Some(&conversation), "ai", "Before changing files, decide it with Trillion.", Some(&json!("gpt-6"))),
    ]);
    assert_eq!(field(&said[1], "source_ref"), Some(&json!("msg_d")), "the final reply keeps its exact transcript row identity");
}

#[test]
fn codex_commentary_and_final_replies_each_keep_their_own_transcript_row_identity() {
    let rows = vec![
        json!({"timestamp": "2026-10-03T05:04:29Z", "type": "response_item", "payload": {"type": "message", "id": "msg_commentary", "role": "assistant", "phase": "commentary", "content": [{"type": "output_text", "text": "Checking the live service."}]}}),
        json!({"timestamp": "2026-10-03T05:04:51Z", "type": "response_item", "payload": {"type": "message", "id": "msg_final", "role": "assistant", "phase": "final_answer", "content": [{"type": "output_text", "text": "The change is live."}]}}),
    ];
    let said = messages(&rows, harness("codex"), CODEX);
    let seen: Vec<(&str, Option<&Value>)> = said.iter().map(|m| (m.text(), field(m, "source_ref"))).collect();
    assert_eq!(seen, vec![("Checking the live service.", Some(&json!("msg_commentary"))), ("The change is live.", Some(&json!("msg_final")))]);
}

#[test]
fn only_finished_codex_and_claude_replies_are_marked_final() {
    let codex = |id: &str, phase: &str| json!({"timestamp": "2026-10-06T21:00:00Z", "type": "response_item", "payload": {"type": "message", "id": id, "role": "assistant", "phase": phase, "content": [{"type": "output_text", "text": phase}]}});
    let replies = messages(&[codex("progress", "commentary"), codex("final", "final_answer")], harness("codex"), CODEX);
    assert_eq!(replies.iter().map(|m| field(m, "final_reply").cloned()).collect::<Vec<_>>(), vec![None, Some(json!(true))]);
    let claude = |uuid: &str, stop: Value| base(json!({"uuid": uuid, "type": "assistant", "timestamp": "2026-10-06T21:00:00Z", "message": {"model": "claude", "stop_reason": stop, "content": [{"type": "text", "text": uuid}]}}));
    let replies = messages(&[claude("progress", Value::Null), claude("final", json!("end_turn"))], harness("claude-code"), SESSION);
    assert_eq!(replies.iter().map(|m| field(m, "final_reply").cloned()).collect::<Vec<_>>(), vec![None, Some(json!(true))]);
}

#[test]
fn scheduled_and_goal_continuation_text_is_not_misclassified_as_founder_speech() {
    let shape = text_rule(&["input_text"]);
    let patterns = &routes().patterns;
    for text in [
        "<heartbeat>\n  <automation_id>follow-through</automation_id>\n</heartbeat>",
        "<codex_internal_context source=\"goal\">Continue the goal</codex_internal_context>",
        "<codex_delegation>Agent status</codex_delegation>",
        "<hook_prompt hook_run_id=\"stop:6:/work/sample/.codex/hooks.json\">Stop blocked.</hook_prompt>",
    ] {
        assert_eq!(words_of(Some(&json!([{"type": "input_text", "text": text}])), &shape, patterns), "", "{text}");
    }
    // The look-ahead the old row held is its own alternative here: a hook_prompt with no run id is the person's.
    assert_eq!(words_of(Some(&json!([{"type": "input_text", "text": "<hook_prompt>mine</hook_prompt>"}])), &shape, patterns), "<hook_prompt>mine</hook_prompt>");
}

#[test]
fn codex_compaction_context_is_not_a_founder_turn_while_the_same_text_in_a_real_user_row_is() {
    let text = "Another language model started to solve this problem and produced a summary of its thinking process.";
    let context = json!({"timestamp": "2026-09-29T16:50:00Z", "type": "compacted", "payload": {"message": text}});
    let person = json!({"timestamp": "2026-09-29T16:50:01Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}});
    assert!(messages(&[context], harness("codex"), CODEX).is_empty());
    assert_eq!(messages(&[person], harness("codex"), CODEX)[0].text(), text);
}

#[test]
fn codex_ambient_ui_content_cannot_become_a_person_message_while_typed_words_still_can() {
    let row = json!({"timestamp": "2026-10-01T10:00:00Z", "type": "response_item", "payload": {"type": "message", "role": "user",
        "content": [{"type": "input_text", "text": "the page the app showed"}, {"type": "input_text", "text": "fix the button"}],
        "internal_chat_message_metadata_passthrough": {"content_item_kinds": ["ambient.page", "user.text"]}}});
    let said = messages(&[row], harness("codex"), CODEX);
    assert_eq!(said.iter().map(Message::text).collect::<Vec<_>>(), vec!["fix the button"]);
    let generated = json!({"timestamp": "2026-10-01T10:00:01Z", "type": "response_item", "payload": {"type": "message", "role": "user",
        "content": [{"type": "input_text", "text": "# Files mentioned by the user:\n- a.rs\n\n## My request:\nship it"}]}});
    assert_eq!(messages(&[generated], harness("codex"), CODEX)[0].text(), "ship it");
}

#[test]
fn a_message_another_ai_session_sent_is_not_recorded_as_the_persons_words() {
    let parts = text_rule(&["text"]);
    for tag in ["teammate-message teammate_id=\"x\"", "cross-session-message from=\"uds:/tmp/a.sock\""] {
        let name = tag.split(' ').next().unwrap();
        let text = format!("Another Claude session sent a message:\n<{tag}>\n{{\"type\":\"idle_notification\"}}\n</{name}>");
        assert_eq!(words_of(Some(&json!(text)), &parts, &routes().patterns), "");
    }
    let mine = "Another Claude session sent a message? No, I wrote this myself.";
    assert_eq!(words_of(Some(&json!(mine)), &parts, &routes().patterns), mine);
}

#[test]
fn a_queued_message_another_ai_sent_or_the_prompt_a_program_gave_is_never_kept_as_the_persons_words() {
    let queued = |content: &str, at: &str| json!({"type": "queue-operation", "operation": "enqueue", "timestamp": at, "sessionId": SESSION, "content": content});
    let taken = |at: &str| json!({"type": "queue-operation", "operation": "dequeue", "timestamp": at, "sessionId": SESSION});
    let peer = "<agent-message from=\"patterns-to-trillion\">\nThe proof passed.\n</agent-message>";
    let program = "This is a connection test.";
    let rows = vec![
        queued(peer, "2026-10-06T14:11:25.541Z"), taken("2026-10-06T14:11:25.566Z"),
        base(json!({"type": "user", "isMeta": true, "promptSource": "system", "origin": {"kind": "peer"}, "timestamp": "2026-10-06T14:11:25.570Z", "message": {"role": "user", "content": format!("Another Claude session sent a message:\n{peer}")}})),
        queued(program, "2026-10-06T14:09:36.235Z"), taken("2026-10-06T14:09:36.237Z"),
        base(json!({"type": "user", "entrypoint": "sdk-cli", "promptSource": "sdk", "timestamp": "2026-10-06T14:09:36.300Z", "message": {"role": "user", "content": program}})),
        queued(peer, "2026-10-03T23:30:22.977Z"),
        base(json!({"type": "attachment", "timestamp": "2026-10-03T23:30:22.977Z", "attachment": {"type": "queued_command", "origin": {"kind": "peer"}, "prompt": peer}})),
        queued("also check the phone view", "2026-10-06T14:20:00.000Z"), taken("2026-10-06T14:26:00.000Z"),
    ];
    let persons: Vec<String> = messages(&rows, harness("claude-code"), SESSION).into_iter().filter(|m| m.speaker() == "person").map(|m| m.text().to_owned()).collect();
    assert!(persons.is_empty(), "an unsourced queue row is retained, never attributed by absence of evidence: {persons:?}");
}

#[test]
fn another_ais_message_still_waiting_in_the_queue_is_never_kept_as_the_persons_words() {
    let rows = vec![json!({"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-10-07T07:56:04.779Z", "sessionId": SESSION, "content": "<agent-message from=\"a6aa48f2479da6cda\">\nThe store-month deploy blocker is fixed.\n</agent-message>"})];
    assert!(messages(&rows, harness("claude-code"), SESSION).is_empty());
}

#[test]
fn the_prompts_a_wake_gives_an_ai_for_trillion_work_are_never_kept_as_the_persons_words() {
    let row = |content: &str, at: &str| base(json!({"type": "user", "origin": {"kind": "human"}, "timestamp": at, "message": {"role": "user", "content": content}}));
    let rows = vec![
        row("<trillion-message from=\"Trillion\" handoff_id=\"h_0123456789abcdef01234567\">\nTake the job.\n</trillion-message>", "2026-10-07T21:00:00.000Z"),
        row("and the phone view too", "2026-10-07T21:09:00.000Z"),
    ];
    let persons: Vec<String> = messages(&rows, harness("claude-code"), SESSION).into_iter().filter(|m| m.speaker() == "person").map(|m| m.text().to_owned()).collect();
    assert_eq!(persons, vec!["and the phone view too"]);
}

#[test]
fn untyped_text_parts_count_as_text() {
    assert_eq!(words_of(Some(&json!([{"text": "plain words"}])), &text_rule(&["text"]), &routes().patterns), "plain words");
}

#[test]
fn a_program_started_codex_run_holds_no_words_of_the_person() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join(format!("{CODEX}.jsonl"));
    let mut rows = codex_rows();
    rows[0]["payload"]["source"] = json!("exec");
    std::fs::write(&path, lines(&rows)).unwrap();
    assert!(!transcript::person_speaks_in(&path, harness("codex"), 1 << 20));
    rows[0]["payload"]["source"] = json!("cli");
    std::fs::write(&path, lines(&rows)).unwrap();
    assert!(transcript::person_speaks_in(&path, harness("codex"), 1 << 20));
}

// --- The hook rows over an in-memory records store, and the command's cursor ---

/// The account's records operations over a map, as the local account answers them; `refuse_writes` refuses every write.
#[derive(Default)]
struct Records {
    kept: BTreeMap<String, Value>,
    refuse_writes: bool,
    notices: Option<Value>,
    calls: Vec<Operation>,
}

impl Records {
    fn step(&mut self, call: Operation) -> Result<Value, OperationFailure> {
        let refused = |code: &str| OperationFailure { cause: (crate::cause!()).into(), code: code.into(), outcome_unknown: false, detail: None };
        self.calls.push(call.clone());
        match (call.resource.as_str(), call.operation.as_str()) {
            ("@own-records", "records:read") => {
                let id = call.input["id"].as_str().unwrap();
                Ok(json!({"id": id, "type": call.input["type"], "value": self.kept.get(id).map_or(Value::Null, |row| row["value"].clone())}))
            }
            ("@own-records", "records:write") => {
                if self.refuse_writes {
                    return Err(refused("current_source_unavailable"));
                }
                let items = call.input["records"].as_array().unwrap();
                if items.iter().any(|item| item.get("expected") == Some(&Value::Null) && self.kept.contains_key(item["id"].as_str().unwrap())) {
                    return Err(refused("record_write_conflict"));
                }
                for item in items {
                    self.kept.insert(item["id"].as_str().unwrap().to_owned(), item.clone());
                }
                Ok(json!({"changed": items.len()}))
            }
            (_, "tools:run") => self.notices.clone().ok_or_else(|| refused("tool_unavailable")),
            _ => Err(refused("no_such_operation")),
        }
    }

    fn messages(&self) -> Vec<Value> {
        self.kept.values().filter(|row| row["type"] == "message").map(|row| row["value"].clone()).collect()
    }
}

/// A computer for the command: no environment, a home in `folder`, a fixed clock.
fn computer_at<'a>(folder: &std::path::Path, env: &'a dyn Fn(&str) -> Option<String>, now: &str) -> Computer<'a> {
    Computer { env, home: Some(folder.to_path_buf()), now_ms: transcript::time_ms(now).unwrap() }
}

/// The installed tools' model of these tests: the kind a session's card is kept as is a made-up one.
const CARDS: &dyn Fn(&str, &str) -> Option<String> =
    &|section, key| (section == "harness_hooks" && key == "agent_card").then(|| "session-card".to_owned());

const NO_ENV: &dyn Fn(&str) -> Option<String> = &|_| None;

/// One hook event, end to end but for the loopback call: prepare, the account's answer, the cursor settled.
fn turn(records: &mut Records, harness: &str, event_name: &str, event: &Value, computer: &Computer) -> Value {
    let account = routes();
    let prepared = account.prepare(harness, event_name, event, computer).expect("prepared");
    let answer = account.receive(&prepared.input, &computer.now(), CARDS, &mut |call| records.step(call)).expect("answered");
    account.settle(&prepared, answer["accepted"].as_u64().unwrap() as usize, computer);
    answer
}

fn sorted_texts(records: &Records) -> Vec<(String, String)> {
    let mut seen: Vec<(String, String)> = records.messages().iter().map(|m| (m["at"].as_str().unwrap().to_owned(), m["text"].as_str().unwrap().to_owned())).collect();
    seen.sort();
    seen
}

#[test]
fn each_turn_end_keeps_only_what_is_new() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join(format!("{SESSION}.jsonl"));
    let rows = claude_rows();
    std::fs::write(&path, lines(&rows[..7])).unwrap();
    let computer = computer_at(folder.path(), NO_ENV, "2026-09-28T04:00:00.000Z");
    // A backfill names only the transcript: the session id is read from it.
    let mut records = Records::default();
    assert_eq!(turn(&mut records, "claude-code", "Stop", &json!({"transcript_path": path}), &computer)["accepted"], 1);
    let event = json!({"session_id": SESSION, "transcript_path": path});
    std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(lines(&rows[7..11]).as_bytes()).unwrap();
    assert_eq!(turn(&mut records, "claude-code", "Stop", &event, &computer)["accepted"], 2);
    assert_eq!(sorted_texts(&records).into_iter().map(|(_, text)| text).collect::<Vec<_>>(),
        vec!["You own what an AI sees  when it connects.\n\nRead your brief first.", "also do the other thing", "Now reading the tools folder code."]);
    let writes = records.calls.iter().filter(|call| call.operation == "records:write").count();
    assert_eq!(turn(&mut records, "claude-code", "Stop", &event, &computer)["accepted"], 0, "nothing new is sent again");
    assert_eq!(records.calls.iter().filter(|call| call.operation == "records:write").count(), writes);
}

#[test]
fn a_half_written_last_line_waits_for_the_next_turn_end() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join(format!("{CODEX}.jsonl"));
    let whole = lines(&codex_rows());
    std::fs::write(&path, &whole[..whole.len() - 40]).unwrap();
    let computer = computer_at(folder.path(), NO_ENV, "2026-09-28T04:00:00.000Z");
    let event = json!({"session_id": CODEX, "transcript_path": path});
    let mut records = Records::default();
    turn(&mut records, "codex", "stop", &event, &computer);
    assert_eq!(records.messages().iter().map(|m| m["speaker"].clone()).collect::<Vec<_>>(), vec![json!("person")]);
    std::fs::write(&path, &whole).unwrap();
    turn(&mut records, "codex", "stop", &event, &computer);
    let mut kept: Vec<(Value, Value)> = records.messages().iter().map(|m| (m["speaker"].clone(), m.get("model").cloned().unwrap_or(Value::Null))).collect();
    kept.sort_by_key(|(speaker, _)| speaker.to_string());
    assert_eq!(kept, vec![(json!("ai"), json!("gpt-6")), (json!("person"), Value::Null)]);
}

#[test]
fn a_refused_send_leaves_the_cursor_so_the_same_messages_go_again_next_time() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join(format!("{SESSION}.jsonl"));
    std::fs::write(&path, lines(&claude_rows())).unwrap();
    let computer = computer_at(folder.path(), NO_ENV, "2026-09-28T04:00:00.000Z");
    let event = json!({"session_id": SESSION, "transcript_path": path});
    let mut records = Records { refuse_writes: true, ..Records::default() };
    let refused = turn(&mut records, "claude-code", "Stop", &event, &computer);
    assert_eq!(refused["accepted"], 0);
    assert_eq!(refused["refused"], json!(["transcript"]));
    records.refuse_writes = false;
    assert_eq!(turn(&mut records, "claude-code", "Stop", &event, &computer)["accepted"], 4);
    assert_eq!(records.messages().len(), 4);
}

#[test]
fn a_message_kept_twice_is_one_record_with_its_time_and_identity_as_its_id() {
    let message = Message(json!({"conversation_id": "codex:x", "app": "Codex", "speaker": "person", "text": "Fix this", "at": "2026-09-28T03:00:00.000Z"}).as_object().unwrap().clone());
    let id = routes().message_id(&message).unwrap();
    // src/messages.mjs idOf: message:<at>:<first 24 hex of BLAKE3 of the sorted-key JSON>.
    let identity = transcript::digest(r#"{"app":"Codex","at":"2026-09-28T03:00:00.000Z","conversation_id":"codex:x","speaker":"person","text":"Fix this"}"#);
    assert_eq!(id, format!("message:2026-09-28T03:00:00.000Z:{}", &identity[..24]));
    let mut records = Records::default();
    let input = json!({"harness": "codex", "event": "Stop", "payload": {}, "messages": [Value::Object(message.0.clone())]});
    for _ in 0..2 {
        let answer = routes().receive(&input, "2026-09-28T03:00:01.000Z", CARDS, &mut |call| records.step(call)).unwrap();
        assert_eq!(answer["accepted"], 1);
    }
    assert_eq!(records.kept.len(), 1);
}

#[test]
fn no_transcript_or_one_no_harness_wrote_sends_nothing() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("other.jsonl");
    std::fs::write(&path, lines(&[json!({"hello": "world"})])).unwrap();
    let computer = computer_at(folder.path(), NO_ENV, "2026-09-28T04:00:00.000Z");
    let mut records = Records::default();
    assert_eq!(turn(&mut records, "claude-code", "Stop", &json!({"transcript_path": path, "session_id": "abcdef12"}), &computer)["accepted"], 0);
    assert_eq!(turn(&mut records, "claude-code", "Stop", &json!({"session_id": "no-such-session-0000"}), &computer)["accepted"], 0);
    assert!(records.kept.is_empty());
}

#[test]
fn claude_prompt_time_retry_keeps_one_identity_and_codex_prompt_intake_requires_the_transcript() {
    // Claude Code: the prompt is kept at once with the time it was submitted; the turn end finds its row and keeps the
    // same time, so it is one message.
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join(format!("{SESSION}.jsonl"));
    std::fs::write(&path, lines(&claude_rows()[..1])).unwrap();
    let computer = computer_at(folder.path(), NO_ENV, "2026-09-29T13:00:00.000Z");
    let event = json!({"hook_event_name": "UserPromptSubmit", "transcript_path": path, "session_id": SESSION, "prompt": "Do this now", "origin": {"kind": "human"}});
    let mut records = Records::default();
    assert_eq!(turn(&mut records, "claude-code", "UserPromptSubmit", &event, &computer)["accepted"], 1);
    let row = base(json!({"type": "user", "timestamp": "2026-09-29T13:00:02.000Z", "message": {"role": "user", "content": "Do this now"}}));
    std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(lines(&[row]).as_bytes()).unwrap();
    assert_eq!(turn(&mut records, "claude-code", "Stop", &event, &computer)["accepted"], 1);
    assert_eq!(sorted_texts(&records), vec![("2026-09-29T13:00:00.000Z".to_owned(), "Do this now".to_owned())], "the retry carries the exact prompt-time identity");
    assert_eq!(turn(&mut records, "claude-code", "Stop", &event, &computer)["accepted"], 0);

    // Codex: no prompt is kept before its transcript row; with the row there, the row's own time is kept.
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join(format!("{CODEX}.jsonl"));
    let prompt = "Append the line '<!-- probe -->' at the end.";
    std::fs::write(&path, lines(&codex_rows()[..1])).unwrap();
    let event = json!({"transcript_path": path, "session_id": CODEX, "prompt": prompt});
    let computer = computer_at(folder.path(), NO_ENV, "2026-09-29T13:00:00.000Z");
    let mut records = Records::default();
    assert_eq!(turn(&mut records, "codex", "userPromptSubmit", &event, &computer)["accepted"], 0, "Codex waits for its row");
    let mut row = codex_rows()[4].clone();
    row["timestamp"] = json!("2026-09-29T13:00:02.000Z");
    std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(lines(&[row]).as_bytes()).unwrap();
    assert_eq!(turn(&mut records, "codex", "userPromptSubmit", &event, &computer)["accepted"], 1);
    assert_eq!(turn(&mut records, "codex", "stop", &event, &computer)["accepted"], 1, "the turn end reads it again and finds it kept");
    assert_eq!(sorted_texts(&records), vec![("2026-09-29T13:00:02.000Z".to_owned(), prompt.to_owned())]);
}

#[test]
fn repeating_the_same_human_words_in_one_session_remains_a_new_prompt() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join(format!("{SESSION}.jsonl"));
    std::fs::write(&path, lines(&claude_rows()[..1])).unwrap();
    let event = json!({"transcript_path": path, "session_id": SESSION, "prompt": "Again", "origin": {"kind": "human"}});
    let mut records = Records::default();
    let row = |at: &str| base(json!({"type": "user", "timestamp": at, "message": {"role": "user", "content": "Again"}}));
    let append = |row: Value| std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(lines(&[row]).as_bytes()).unwrap();
    turn(&mut records, "claude-code", "UserPromptSubmit", &event, &computer_at(folder.path(), NO_ENV, "2026-09-29T13:00:00.000Z"));
    append(row("2026-09-29T13:00:01.000Z"));
    turn(&mut records, "claude-code", "Stop", &event, &computer_at(folder.path(), NO_ENV, "2026-09-29T13:00:02.000Z"));
    turn(&mut records, "claude-code", "UserPromptSubmit", &event, &computer_at(folder.path(), NO_ENV, "2026-09-29T13:00:30.000Z"));
    append(row("2026-09-29T13:00:31.000Z"));
    turn(&mut records, "claude-code", "Stop", &event, &computer_at(folder.path(), NO_ENV, "2026-09-29T13:00:32.000Z"));
    assert_eq!(sorted_texts(&records).into_iter().map(|(at, _)| at).collect::<Vec<_>>(), vec!["2026-09-29T13:00:00.000Z", "2026-09-29T13:00:30.000Z"]);
}

#[test]
fn an_sdk_or_agent_prompt_is_never_kept_as_the_persons_words() {
    let folder = tempfile::tempdir().unwrap();
    let computer = computer_at(folder.path(), NO_ENV, "2026-09-29T13:00:00.000Z");
    let mut records = Records::default();
    for event in [
        json!({"session_id": SESSION, "prompt": "Run diagnostics", "promptSource": "sdk", "entrypoint": "sdk-cli", "origin": {"kind": "human"}}),
        json!({"session_id": SESSION, "prompt": "<codex_delegation>Agent task</codex_delegation>", "origin": {"kind": "human"}}),
        json!({"session_id": SESSION, "prompt": "hello", "origin": {"kind": "peer"}}),
    ] {
        assert_eq!(turn(&mut records, "claude-code", "UserPromptSubmit", &event, &computer)["accepted"], 0);
    }
    assert!(records.kept.is_empty());
}

// --- test/decision-notices.test.mjs and test/decisions-since-held-line.test.mjs ---

#[test]
fn the_prompt_hook_says_the_decisions_since_the_session_last_looked() {
    let folder = tempfile::tempdir().unwrap();
    let computer = computer_at(folder.path(), NO_ENV, "2026-09-29T13:00:00.000Z");
    let event = json!({"session_id": "abc", "hook_event_name": "UserPromptSubmit", "prompt": "go", "promptSource": "sdk"});
    let mut records = Records { notices: Some(json!({"notices": [{"kind": "decision", "said": "Decided in ChatGPT: \"Price?\". Chosen: $29."}]})), ..Records::default() };
    let answer = turn(&mut records, "claude-code", "UserPromptSubmit", &event, &computer);
    let asked = records.calls.iter().find(|call| call.operation == "tools:run").unwrap();
    assert_eq!(asked.input["input"], json!({"reader": "session:abc"}));
    let said = answer["said"].as_str().unwrap();
    assert!(said.starts_with("Decided in this person's Trillion"), "{said}");
    assert!(said.ends_with("\n- Decided in ChatGPT: \"Price?\". Chosen: $29."), "{said}");
    assert_eq!(lines_for("heading", Some(&json!([])), &["said".to_owned()]), "");
    // A reader named under payload counts too; no session id names no reader and asks nothing.
    let mut records = Records { notices: Some(json!({"notices": []})), ..Records::default() };
    turn(&mut records, "claude-code", "UserPromptSubmit", &json!({"payload": {"session_id": "xyz"}}), &computer);
    assert_eq!(records.calls.iter().find(|call| call.operation == "tools:run").unwrap().input["input"], json!({"reader": "session:xyz"}));
    let mut records = Records::default();
    let quiet = turn(&mut records, "claude-code", "UserPromptSubmit", &json!({}), &computer);
    assert_eq!(quiet["said"], "");
    assert!(records.calls.is_empty());
    // A refused read says nothing; the turn goes on.
    let mut records = Records::default();
    assert_eq!(turn(&mut records, "claude-code", "UserPromptSubmit", &event, &computer)["said"], "");
}

#[test]
fn a_session_whose_transcript_is_recorded_is_told_not_to_record_it_again() {
    let folder = tempfile::tempdir().unwrap();
    let home = folder.path();
    let beta = tempfile::tempdir().unwrap();
    let beta_home = beta.path().to_string_lossy().into_owned();
    let env = move |name: &str| (name == "CODEX_HOME").then(|| beta_home.clone());
    let computer = computer_at(home, &env, "2026-09-29T13:00:00.000Z");
    let under = |path: std::path::PathBuf| json!({"transcript_path": path});
    assert!(routes().recorded_here(&under(home.join(".claude/projects/x/abc.jsonl")), &computer));
    assert!(routes().recorded_here(&under(beta.path().join("sessions/2026/09/28/r.jsonl")), &computer));
    assert!(!routes().recorded_here(&under(home.join(".claude/projectsX/abc.jsonl")), &computer));
    assert!(!routes().recorded_here(&json!({}), &computer));
    // A hook event with only a session id still finds its transcript.
    std::fs::create_dir_all(home.join(".claude/projects/project")).unwrap();
    std::fs::write(home.join(format!(".claude/projects/project/{SESSION}.jsonl")), "{}\n").unwrap();
    assert!(routes().recorded_here(&json!({"session_id": SESSION}), &computer));
    let mut records = Records { notices: Some(json!({"notices": [{"said": "Decided."}]})), ..Records::default() };
    let event = json!({"session_id": "abc", "prompt": "go", "promptSource": "sdk", "transcript_path": home.join(".claude/projects/x/abc.jsonl")});
    let said = turn(&mut records, "claude-code", "UserPromptSubmit", &event, &computer)["said"].as_str().unwrap().to_owned();
    assert!(said.starts_with("This session's messages are recorded in Trillion automatically; do not call record_messages for them.\nDecided in this person's Trillion"), "{said}");
}

#[test]
fn the_prompt_hook_never_prints_a_held_line_a_held_thing_arrives_as_a_notice() {
    let settings: Value = serde_json::from_slice(DATA).unwrap();
    assert!(settings["words"].get("held_line").is_none());
    let folder = tempfile::tempdir().unwrap();
    let computer = computer_at(folder.path(), NO_ENV, "2026-09-29T13:00:00.000Z");
    let event = json!({"session_id": "s1", "prompt": "fix the build", "promptSource": "sdk"});
    let held = json!({"key": "asks:meta", "title": "Sign in to Facebook once and allow Trillion"});
    let mut records = Records { notices: Some(json!({"notices": [], "held": held})), ..Records::default() };
    assert_eq!(turn(&mut records, "claude-code", "UserPromptSubmit", &event, &computer)["said"], "", "a held thing alone prints nothing");
    let notice = json!({"said": "Your AI opened something for you to do: Sign in to Facebook once and allow Trillion"});
    let mut records = Records { notices: Some(json!({"notices": [notice], "held": held})), ..Records::default() };
    let said = turn(&mut records, "claude-code", "UserPromptSubmit", &event, &computer)["said"].as_str().unwrap().to_owned();
    assert!(said.contains("Sign in to Facebook once and allow Trillion"));
    assert!(!said.contains("tool:take-me-there") && !said.contains("Open your reply") && !said.contains("Held for the person"));
}

// --- test/wake-sessions.test.mjs registerSession, harness/register-session.mjs ---

#[test]
fn a_session_that_starts_is_registered_with_its_harness_under_its_own_agent_id() {
    let folder = tempfile::tempdir().unwrap();
    let computer = computer_at(folder.path(), NO_ENV, "2026-09-29T13:00:00.000Z");
    let mut records = Records::default();
    turn(&mut records, "codex", "sessionStart", &json!({"session_id": "0199aaaa-bbbb", "cwd": "/work/sample"}), &computer);
    let row = &records.kept["session-card:session-codex-0199aaaa-bbbb"];
    assert_eq!(row["type"], "session-card");
    assert_eq!(row["value"]["agent_id"], "session-codex-0199aaaa-bbbb");
    assert_eq!(row["value"]["source_id"], "codex:0199aaaa-bbbb");
    assert_eq!(row["value"]["name"], "Codex");
    assert_eq!(row["value"]["description"], "A Codex session on this computer, in sample.");
    assert_eq!(row["value"]["delivery"], json!({"stream": true}));
    assert_eq!(row["value"]["cwd"], "/work/sample");
    assert_eq!(row["value"]["registered_at"], "2026-09-29T13:00:00.000Z");
    // Registering again refreshes the same row; no folder says none.
    turn(&mut records, "claude-code", "SessionStart", &json!({"sessionId": "abcdef12-3456"}), &computer);
    let row = &records.kept["session-card:session-claude-code-abcdef12-3456"];
    assert_eq!(row["value"]["description"], "A Claude Code session on this computer.");
    assert_eq!(row["value"]["cwd"], Value::Null);
    assert_eq!(records.kept.len(), 2);
}

#[test]
fn a_session_id_that_is_not_one_or_a_harness_with_no_row_registers_nothing() {
    let mut records = Records::default();
    let answer = routes().receive(&json!({"harness": "codex", "event": "SessionStart", "payload": {"session_id": "short"}}), "2026-09-29T13:00:00.000Z", CARDS, &mut |call| records.step(call)).unwrap();
    assert_eq!(answer["refused"], json!(["session"]));
    assert!(records.kept.is_empty());
    let unknown = routes().receive(&json!({"harness": "no-such-harness", "event": "SessionStart", "payload": {}}), "now", CARDS, &mut |call| records.step(call));
    assert_eq!(unknown.unwrap_err().code, "original_input_refused");
    let extra = routes().receive(&json!({"harness": "codex", "event": "SessionStart", "payload": {}, "colour": "red"}), "now", CARDS, &mut |call| records.step(call));
    assert_eq!(extra.unwrap_err().detail, Some(json!({"field": "colour", "expected": "no such field"})));
    // No installed tool names the card's kind: the step is refused and keeps nothing.
    let none = routes().receive(&json!({"harness": "codex", "event": "SessionStart", "payload": {"session_id": "0199aaaa-bbbb"}}), "now", &|_, _| None, &mut |call| records.step(call)).unwrap();
    assert_eq!(none["refused"], json!(["session"]));
    assert!(records.kept.is_empty());
}

#[test]
fn a_new_harness_or_hook_is_a_row() {
    let mut settings: Value = serde_json::from_slice(DATA).unwrap();
    let mut row = settings["harnesses"][1].clone();
    row["id"] = json!("other-agent");
    row["app"] = json!("Other Agent");
    settings["harnesses"].as_array_mut().unwrap().push(row);
    let account = HookRoutes::from_bytes(&serde_json::to_vec(&settings).unwrap()).unwrap();
    let mut records = Records::default();
    account.receive(&json!({"harness": "other-agent", "event": "sessionStart", "payload": {"session_id": "0199aaaa-cccc"}}), "now", CARDS, &mut |call| records.step(call)).unwrap();
    assert!(records.kept.contains_key("session-card:session-other-agent-0199aaaa-cccc"));
    // A hook naming an event a harness does not name is refused when the rows are read.
    settings["hooks"][0]["event"] = json!("NoSuchEvent");
    assert!(HookRoutes::from_bytes(&serde_json::to_vec(&settings).unwrap()).is_err());
}

#[test]
fn the_command_prints_nothing_and_succeeds_when_the_account_cannot_be_reached() {
    let folder = tempfile::tempdir().unwrap();
    let app_files_list = folder.path().join("absent-app_files_list.json");
    let mut out = Vec::new();
    let args = [app_files_list.to_string_lossy().into_owned(), "claude-code".to_owned(), "UserPromptSubmit".to_owned()];
    command(&args, &mut std::io::Cursor::new(br#"{"session_id":"abc","prompt":"go","promptSource":"sdk"}"#.to_vec()), &mut out).unwrap();
    assert!(out.is_empty());
    command(&args, &mut std::io::Cursor::new(b"not json".to_vec()), &mut out).unwrap();
    assert!(out.is_empty());
    assert!(command(&args[..2], &mut std::io::empty(), &mut out).is_err(), "a wrong command line says its usage");
}

/// (b) for the engine's hook command, the engine's writer of the home's `hooks` entry: a turn end run against a
/// temporary person home makes only layout rows in the computer's one home and nothing else in the person's home; with
/// the one home setting it writes in the folder that setting names and nothing in the person's home; and a hooks.json
/// whose cursor folder names an entry with no engine row is refused when it is read.
#[test]
fn the_hook_command_writes_only_under_its_homes_listed_entries() {
    use crate::native_entry::home::{layout, undeclared_entries, Home};
    let person = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let path = elsewhere.path().join(format!("{SESSION}.jsonl"));
    std::fs::write(&path, lines(&claude_rows()[..7])).unwrap();
    let event = json!({"session_id": SESSION, "transcript_path": path});
    let computer = computer_at(person.path(), NO_ENV, "2026-09-28T04:00:00.000Z");
    assert_eq!(turn(&mut Records::default(), "claude-code", "Stop", &event, &computer)["accepted"], 1);
    let home = Home::of(NO_ENV, Some(person.path())).unwrap();
    assert!(home.engine_path("hooks/record-every-message").unwrap().join(format!("{SESSION}.json")).is_file(), "the cursor is kept");
    assert!(undeclared_entries(home.root()).is_empty(), "{:?}", undeclared_entries(home.root()));
    let outside: Vec<String> = std::fs::read_dir(person.path()).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(outside, [layout().default_name()], "the hook command wrote outside its home");

    let chosen = tempfile::tempdir().unwrap();
    let other_person = tempfile::tempdir().unwrap();
    let chosen_text = chosen.path().to_string_lossy().into_owned();
    let set = move |name: &str| (name == layout().setting).then(|| chosen_text.clone());
    let computer = computer_at(other_person.path(), &set, "2026-09-28T04:00:00.000Z");
    assert_eq!(turn(&mut Records::default(), "claude-code", "Stop", &event, &computer)["accepted"], 1);
    assert!(chosen.path().join("hooks/record-every-message").join(format!("{SESSION}.json")).is_file());
    assert_eq!(std::fs::read_dir(other_person.path()).unwrap().count(), 0, "nothing in the person's home when the setting names the home");

    let mut settings: Value = serde_json::from_slice(DATA).unwrap();
    for unlisted in ["listen-test-abc/cursors", "kept/cursors", "~/.trillion/hooks/record-every-message", "hooks/../kept"] {
        settings["client"]["cursor_folder"] = json!(unlisted);
        assert!(HookRoutes::from_bytes(&serde_json::to_vec(&settings).unwrap()).is_err(), "{unlisted}");
    }
}
