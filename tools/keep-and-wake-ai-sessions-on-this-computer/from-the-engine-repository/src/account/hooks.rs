//! The account routes for AI harness hooks. An AI harness (a coding agent's command line or app) runs a command on each of its
//! hook events with the event JSON on stdin; that command is `trillion-local hook APP_FILES_LIST HARNESS EVENT`
//! (`command`), and it reaches this operation, beside the local account routes' records and tools operations, as one ordinary account
//! operation (`hooks.json` `resource`, `operation`) admitted like any other: the person's key, asked again for every
//! step. Moved one to one from trillion harness/register-session.mjs, harness/decisions-since.mjs and
//! harness/record-every-message.mjs, which reached the old account over HTTPS.
//!
//! It owns, and only owns:
//! - `HookRoutes`: the rows of `hooks.json`, and `HookRoutes::receive`, which runs the hook rows of one harness event in order,
//!   each step as a generic records or tools operation of the same caller (`Steps`), and answers the text the harness
//!   adds to the turn and how many of the messages it was given are kept;
//! - `command`: what runs on the computer the harness runs on: it reads the event, reads the transcript from its
//!   cursor (`transcript`), calls the account at the loopback address the app's files list names, with the account key
//!   the account-key settings name (held in memory and sent only in the Authorization header), prints the answer and
//!   moves the cursor past what the account kept. It never fails the harness's turn: anything refused prints nothing.
//!
//! Non-negotiable invariants
//! 1. Nothing here names a harness, a hook, a record kind or a word: they are rows of `hooks.json`. A new harness or
//!    hook is a row.
//! 2. Text is kept exactly as written; a part a harness injected is left out whole, never trimmed or rewritten.
//! 3. A message's record id is its time and the BLAKE3 identity of its conversation, app, speaker, time and text
//!    (trillion src/messages.mjs `idOf`), and it is written only when absent, so a resend is the message already kept.
//! 4. Message and tool-observation cursors move only past their own accepted records.
//!    The protected journal verifies each tool observation against its actual local transcript occurrence.

pub(crate) mod transcript;
pub(crate) mod executions;

use crate::mcp::{Operation, OperationFailure};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::io::Read as _;
use std::sync::OnceLock;
use transcript::{Condition, Harness, Injected, Message, Patterns};
use zeroize::Zeroizing;

/// The declared DATA file this operation is read from.
const DATA: &[u8] = include_bytes!("hooks.json");

/// The hook rows' settings (`hooks.json`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    resource: String,
    operation: String,
    request_key_prefix: String,
    records: RecordsRoutes,
    client: Client,
    session: Session,
    hooks: Vec<Hook>,
    messages: MessageRecords,
    execution_references: Value,
    execution_result_fields: Value,
    words: Words,
    person: Person,
    harnesses: Vec<Harness>,
    injected_text: Vec<Injected>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordsRoutes {
    resource: String,
    read: String,
    write: String,
}

/// What the command does on the harness's computer.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Client {
    time_box_ms: u64,
    max_event_bytes: u64,
    max_answer_bytes: u64,
    most_messages: usize,
    most_executions: usize,
    cursor_folder: String,
    transcript_read_bytes: u64,
    transcript_row_bytes: u64,
    head_bytes: u64,
    prompt_mark_window_ms: i64,
    account_host: String,
    account_path: String,
    protocol_version: String,
    tool: String,
}

/// Where a hook event names its session, its transcript and its folder, and the reader a session is.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Session {
    session_id_pattern: String,
    session_id_paths: Vec<Vec<String>>,
    transcript_paths: Vec<Vec<String>>,
    cwd_paths: Vec<Vec<String>>,
    reader: String,
}

/// One hook row: the event it runs on and its step.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hook {
    id: String,
    event: String,
    step: Step,
    #[serde(default)]
    record: Option<RecordTemplate>,
    #[serde(default)]
    read: Option<UnseenRead>,
    /// For `record-messages`: where the command reads the messages it sends.
    #[serde(default)]
    from: Option<Source>,
}

/// Where a `record-messages` step's messages come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Source {
    Prompt,
    Transcript,
}

/// The generic steps a hook row may run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Step {
    KeepRecord,
    SayRecorded,
    SayUnseen,
    RecordMessages,
}

/// One record a `keep-record` step writes, its id and value filled from the event.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordTemplate {
    /// Where the account's installed tools' model names the record's kind (record_model_policy `Installed::named`):
    /// the hook names no kind. The kind fills the `{type}` hole of `id`.
    kind: NamedKind,
    id: String,
    value: Value,
    description: String,
    description_without_folder: String,
}

/// A kind the installed tools' model names: the text its object section `section` gives `key`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NamedKind {
    section: String,
    key: String,
}

/// The operation a `say-unseen` step calls, and where its answer's items and their words are.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UnseenRead {
    resource: String,
    operation: String,
    input: Value,
    list_path: Vec<String>,
    said_path: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageRecords {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    identity_chars: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Words {
    recorded_line: String,
    heading: String,
}

/// When a submitted prompt is the person's own words.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Person {
    #[serde(rename = "_what")]
    _what: String,
    not_when: Vec<Vec<Condition>>,
    human_path: Vec<String>,
    human_is: String,
    pub(crate) generated_request_prefix: String,
    pub(crate) generated_request_marker: String,
}

/// The shipped hook rows, read once.
pub(crate) struct HookRoutes {
    settings: Settings,
    patterns: Patterns,
    session_id: regex::Regex,
}

impl HookRoutes {
    pub(crate) fn shipped() -> Result<&'static HookRoutes, crate::refusal_cause::CodedError<&'static str>> {
        static ROUTES: OnceLock<Result<HookRoutes, crate::refusal_cause::CodedError<&'static str>>> = OnceLock::new();
        ROUTES.get_or_init(|| HookRoutes::from_bytes(DATA)).as_ref().map_err(Clone::clone)
    }

    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<HookRoutes, crate::refusal_cause::CodedError<&'static str>> {
        let settings: Settings = serde_json::from_slice(bytes).map_err(|_| crate::refusal_cause::CodedError::new("hooks.json is refused"))?;
        let patterns = Patterns::compile(&settings).ok_or_else(|| crate::refusal_cause::CodedError::new("a hooks.json pattern is refused"))?;
        let session_id = regex::Regex::new(&settings.session.session_id_pattern).map_err(|_| crate::refusal_cause::CodedError::new("the session id pattern is refused"))?;
        let names = |hook: &Hook| settings.harnesses.iter().all(|harness| harness.event_names.contains_key(&hook.event));
        let complete = |hook: &Hook| match hook.step {
            Step::KeepRecord => hook.record.is_some(),
            Step::SayUnseen => hook.read.is_some(),
            Step::RecordMessages => hook.from.is_some(),
            Step::SayRecorded => true,
        };
        if !settings.hooks.iter().all(|hook| names(hook) && complete(hook)) {
            return Err(crate::refusal_cause::CodedError::new("a hook row names an event a harness does not, or misses its step's fields"));
        }
        // The cursor folder is a path in the computer's one home, under an engine row of the home layout.
        if crate::native_entry::home::Home::of(&|_| None, Some(std::path::Path::new("/")))
            .and_then(|home| home.engine_path(&settings.client.cursor_folder).ok()).is_none() {
            return Err(crate::refusal_cause::CodedError::new("the cursor folder is not under an engine entry of the home layout"));
        }
        Ok(HookRoutes { settings, patterns, session_id })
    }

    /// Whether this operation answers this operation.
    pub(crate) fn answers(&self, resource: &str, operation: &str) -> bool {
        resource == self.settings.resource && operation == self.settings.operation
    }

    fn harness(&self, id: &str) -> Option<&Harness> {
        self.settings.harnesses.iter().find(|harness| harness.id == id)
    }

    /// The event a harness calls `name`: the shared name, or the harness's own name for it.
    fn event_of(&self, harness: &Harness, name: &str) -> Option<String> {
        harness.event_names.iter().find(|(shared, own)| *shared == name || *own == name).map(|(shared, _)| shared.clone())
    }

    /// The first non-blank string at one of `paths` in `event`.
    fn first_text(event: &Value, paths: &[Vec<String>]) -> Option<String> {
        paths.iter().find_map(|path| transcript::at(event, path).and_then(Value::as_str)
            .filter(|value| !transcript::js_trim(value).is_empty()).map(str::to_owned))
    }

    /// The session id this event names, when it is a session id (`readerOf`, `registerSession`).
    fn session_of(&self, event: &Value) -> Option<String> {
        Self::first_text(event, &self.settings.session.session_id_paths).filter(|id| self.session_id.is_match(id))
    }

    /// The record id of one message (trillion src/messages.mjs `idOf`, for a message with no device clock): its time
    /// and the first `identity_chars` hex of the BLAKE3 of JSON.stringify of {app, at, conversation_id, speaker,
    /// text}, keys in order.
    pub(crate) fn message_id(&self, message: &Message) -> Option<String> {
        #[derive(serde::Serialize)]
        struct Identity<'a> {
            app: &'a str,
            at: &'a str,
            conversation_id: &'a str,
            speaker: &'a str,
            text: &'a str,
        }
        let field = |name: &str| message.0.get(name).and_then(Value::as_str);
        let identity = Identity { app: field("app")?, at: field("at")?, conversation_id: field("conversation_id")?,
            speaker: field("speaker")?, text: field("text")? };
        let canonical = serde_json::to_string(&identity).ok()?;
        let hash = transcript::digest(&canonical);
        let mut holes = Map::new();
        holes.insert("at".into(), json!(identity.at));
        holes.insert("identity".into(), json!(hash.get(..self.settings.messages.identity_chars)?));
        fill(&json!(self.settings.messages.id), &holes).as_str().map(str::to_owned)
    }

    /// One harness event: the hook rows of its harness and event, in order. `steps` runs each records or tools
    /// operation as the caller who called this operation. A step that is refused says nothing and keeps nothing; the
    /// others still run, as each old hook ran on its own.
    /// `kind_of` answers the kind the account's installed tools' model names in a section under a key, None when no
    /// tool names it (then a `keep-record` step of that kind is refused and keeps nothing).
    pub(crate) fn receive(&self, input: &Value, now: &str, kind_of: &dyn Fn(&str, &str) -> Option<String>,
        steps: &mut dyn FnMut(Operation) -> Result<Value, OperationFailure>) -> Result<Value, OperationFailure> {
        let fault = |field: &str, expected: &str| crate::mcp::InputFault::new(field, expected).into_failure();
        let fields = input.as_object().ok_or_else(|| fault("(input)", "object"))?;
        if let Some(unknown) = fields.keys().find(|key| !["harness", "event", "payload", "messages", "transcript_recorded", "executions"].contains(&key.as_str())) {
            return Err(fault(unknown, "no such field"));
        }
        let harness = fields.get("harness").and_then(Value::as_str).and_then(|id| self.harness(id))
            .ok_or_else(|| fault("harness", "a harness row of hooks.json"))?;
        let event = fields.get("event").and_then(Value::as_str).and_then(|name| self.event_of(harness, name))
            .ok_or_else(|| fault("event", "an event the harness names"))?;
        let payload = fields.get("payload").filter(|payload| payload.is_object()).ok_or_else(|| fault("payload", "object"))?;
        if fields.get("executions").is_some_and(|v| !v.as_array().is_some_and(|v| v.is_empty())) {
            return Err(fault("executions", "verified protected journal ingestion at the native hook dispatcher"));
        }
        let messages = match fields.get("messages") {
            None => Vec::new(),
            Some(Value::Array(items)) if items.len() <= self.settings.client.most_messages => items.iter()
                .map(|item| item.as_object().cloned().map(Message)).collect::<Option<Vec<_>>>()
                .ok_or_else(|| fault("messages", "array of message objects"))?,
            Some(_) => return Err(fault("messages", "array of message objects, at most most_messages")),
        };
        let recorded = match fields.get("transcript_recorded") {
            None => false,
            Some(Value::Bool(recorded)) => *recorded,
            Some(_) => return Err(fault("transcript_recorded", "boolean")),
        };
        let mut said = Vec::new();
        let mut accepted = 0;
        let mut refused = Vec::new();
        let mut call = |resource: &str, operation: &str, input: Value| steps(Operation {
            resource: resource.to_owned(),
            operation: operation.to_owned(),
            request_key: format!("{}:{}", self.settings.request_key_prefix, transcript::digest(&format!("{now}\0{operation}\0{input}"))),
            input,
            person_present: None,
        });
        for hook in self.settings.hooks.iter().filter(|hook| hook.event == event) {
            let done = match hook.step {
                Step::KeepRecord => hook.record.as_ref().map_or(Ok(()), |record| self.keep_record(record, kind_of, harness, payload, now, &mut call)),
                Step::SayRecorded => {
                    if recorded {
                        said.push(self.settings.words.recorded_line.clone());
                    }
                    Ok(())
                }
                Step::SayUnseen => hook.read.as_ref().map_or(Ok(()), |read| self.say_unseen(read, payload, &mut call).map(|lines| {
                    if !lines.is_empty() {
                        said.push(lines);
                    }
                })),
                Step::RecordMessages => self.record_messages(&messages, &mut call).map(|kept| accepted = kept),
            };
            if done.is_err() {
                refused.push(hook.id.clone());
            }
        }
        Ok(json!({"said": said.join("\n"), "accepted": accepted, "refused": refused}))
    }

    /// `keep-record`: one record filled from the event (register-session.mjs `registerSession` and `sessionCard`).
    fn keep_record(&self, record: &RecordTemplate, kind_of: &dyn Fn(&str, &str) -> Option<String>, harness: &Harness, payload: &Value,
        now: &str, call: &mut dyn FnMut(&str, &str, Value) -> Result<Value, OperationFailure>) -> Result<(), OperationFailure> {

        let session_id = self.session_of(payload).ok_or_else(|| OperationFailure { cause: (crate::cause!()).into(), code: "original_input_refused".into(), outcome_unknown: false, detail: None })?;
        let kind = kind_of(&record.kind.section, &record.kind.key).ok_or_else(|| OperationFailure { cause: (crate::cause!()).into(), code: "original_input_refused".into(), outcome_unknown: false, detail: None })?;
        let cwd = Self::first_text(payload, &self.settings.session.cwd_paths);
        let folder = cwd.as_deref().and_then(|cwd| cwd.split('/').rfind(|part| !part.is_empty())).map(str::to_owned);
        let mut holes = Map::new();
        holes.insert("type".into(), json!(kind));
        holes.insert("harness".into(), json!(harness.id));
        holes.insert("app".into(), json!(harness.app));
        holes.insert("session_id".into(), json!(session_id));
        holes.insert("cwd".into(), cwd.map_or(Value::Null, Value::String));
        holes.insert("now".into(), json!(now));
        let description = match &folder {
            Some(folder) => {
                holes.insert("folder".into(), json!(folder));
                fill(&json!(record.description), &holes)
            }
            None => fill(&json!(record.description_without_folder), &holes),
        };
        holes.insert("description".into(), description);
        let id = fill(&json!(record.id), &holes);
        let value = fill(&record.value, &holes);
        call(&self.settings.records.resource, &self.settings.records.write,
            json!({"records": [{"id": id, "type": kind, "value": value}]})).map(|_| ())
    }

    /// `say-unseen`: the decisions since this session last looked (decisions-since.mjs `unseenDecisions` and
    /// `linesFor`): the heading and one line per item that has words; nothing when there are none.
    fn say_unseen(&self, read: &UnseenRead, payload: &Value,
        call: &mut dyn FnMut(&str, &str, Value) -> Result<Value, OperationFailure>) -> Result<String, OperationFailure> {
        let Some(session_id) = Self::first_text(payload, &self.settings.session.session_id_paths) else { return Ok(String::new()) };
        let mut holes = Map::new();
        holes.insert("session_id".into(), json!(session_id));
        let reader = fill(&json!(self.settings.session.reader), &holes);
        holes.insert("reader".into(), reader);
        let answer = call(&read.resource, &read.operation, fill(&read.input, &holes))?;
        Ok(lines_for(&self.settings.words.heading, transcript::at(&answer, &read.list_path), &read.said_path))
    }

    /// `record-messages`: each message kept once. Every message is read first; those absent are written together,
    /// each on condition it is still absent. Answers how many of the leading messages are kept now.
    fn record_messages(&self, messages: &[Message],
        call: &mut dyn FnMut(&str, &str, Value) -> Result<Value, OperationFailure>) -> Result<usize, OperationFailure> {
        let mut absent = Vec::new();
        let mut read = 0;
        for message in messages {
            let Some(id) = self.message_id(message) else { break };
            let Ok(answer) = call(&self.settings.records.resource, &self.settings.records.read, json!({"id": id, "type": self.settings.messages.kind})) else { break };
            if answer.get("value").is_none_or(Value::is_null) {
                absent.push(json!({"id": id, "type": self.settings.messages.kind, "value": Value::Object(message.0.clone()), "expected": null}));
            }
            read += 1;
        }
        if !absent.is_empty() {
            call(&self.settings.records.resource, &self.settings.records.write, json!({"records": absent}))?;
        }
        Ok(read)
    }
}

/// The lines decisions-since.mjs `linesFor` prints for the items at `list`: the heading and `- <said>` for each item
/// whose words at `said` are a string; "" when there are none.
fn lines_for(heading: &str, list: Option<&Value>, said: &[String]) -> String {
    let lines: Vec<String> = list.and_then(Value::as_array).into_iter().flatten()
        .filter_map(|item| transcript::at(item, said).and_then(Value::as_str)).map(|said| format!("- {said}")).collect();
    if lines.is_empty() {
        return String::new();
    }
    std::iter::once(heading.to_owned()).chain(lines).collect::<Vec<_>>().join("\n")
}

/// Fills `{name}` holes in every string of `template` (wake-sessions.mjs `fill`): a string that is exactly one hole
/// becomes that value itself (null included); a hole with no value stays as written.
fn fill(template: &Value, holes: &Map<String, Value>) -> Value {
    match template {
        Value::String(text) => {
            if let Some(name) = text.strip_prefix('{').and_then(|rest| rest.strip_suffix('}')) {
                if let Some(value) = holes.get(name).filter(|_| name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')) {
                    return value.clone();
                }
            }
            let mut out = String::new();
            let mut rest = text.as_str();
            while let Some(open) = rest.find('{') {
                out.push_str(&rest[..open]);
                let after = &rest[open + 1..];
                match after.find('}').map(|close| (&after[..close], close)) {
                    Some((name, close)) if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && holes.contains_key(name) => {
                        match &holes[name] {
                            Value::String(value) => out.push_str(value),
                            other => out.push_str(&other.to_string()),
                        }
                        rest = &after[close + 1..];
                    }
                    _ => {
                        out.push('{');
                        rest = after;
                    }
                }
            }
            out.push_str(rest);
            Value::String(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(|item| fill(item, holes)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, value)| (key.clone(), fill(value, holes))).collect()),
        other => other.clone(),
    }
}

/// The time now as JavaScript's `toISOString`.
pub(crate) fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ---------------------------------------------------------------------------------------------------------------
// The command on the harness's computer.
// ---------------------------------------------------------------------------------------------------------------

/// What the command reads from this computer: its environment, its home and its clock. Tests give their own.
pub(crate) struct Computer<'a> {
    pub(crate) env: &'a dyn Fn(&str) -> Option<String>,
    pub(crate) home: Option<std::path::PathBuf>,
    pub(crate) now_ms: i64,
}

impl Computer<'_> {
    fn now(&self) -> String {
        chrono::DateTime::from_timestamp_millis(self.now_ms).unwrap_or_default().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
    }
}

/// What the command sends the account for one event, and what it does once the account has answered.
#[derive(Debug, Default)]
pub(crate) struct Prepared {
    pub(crate) input: Value,
    /// For a turn end: the cursor to keep once the account kept every message, and per message the cursor to keep once
    /// the account kept the messages up to it.
    advance: Option<Advance>,
    /// For a prompt: the prompt mark kept before the send.
    prompt_session: Option<String>,
    execution_advance: Option<(String,transcript::Cursor)>,
}

#[derive(Debug)]
struct Advance {
    session_id: String,
    whole: transcript::Cursor,
    each: Vec<transcript::Cursor>,
    /// Per message, the prompt mark it used.
    matched: Vec<Option<usize>>,
}

impl HookRoutes {
    /// The cursor folder in this computer's one home (src/native_entry/home.rs): `cursor_folder` is an entry of the home
    /// and a path inside it. None when the computer has no home, so the command keeps nothing anywhere else.
    fn cursor_folder(&self, computer: &Computer) -> Option<std::path::PathBuf> {
        crate::native_entry::home::Home::of(computer.env, computer.home.as_deref())?
            .engine_path(&self.settings.client.cursor_folder).ok()
    }

    fn transcript_of(&self, event: &Value, computer: &Computer) -> Option<std::path::PathBuf> {
        Self::first_text(event, &self.settings.session.transcript_paths).map(std::path::PathBuf::from).filter(|path| path.is_file())
            .or_else(|| Self::first_text(event, &self.settings.session.session_id_paths).and_then(|session| transcript::transcript_for(
                &session, &self.session_id, &self.settings.harnesses, computer.env, computer.home.as_deref())))
    }

    /// Whether this event's transcript is one a harness row here records (decisions-since.mjs `recordedHere`).
    pub(crate) fn recorded_here(&self, event: &Value, computer: &Computer) -> bool {
        let named = Self::first_text(event, &self.settings.session.transcript_paths).map(std::path::PathBuf::from)
            .or_else(|| Self::first_text(event, &self.settings.session.session_id_paths).and_then(|session| transcript::transcript_for(
                &session, &self.session_id, &self.settings.harnesses, computer.env, computer.home.as_deref())));
        named.is_some_and(|path| transcript::harness_holding(&path, &self.settings.harnesses, computer.env, computer.home.as_deref()).is_some())
    }

    /// Whether a prompt event is the person's own words (decisions-since.mjs `fromThePerson`).
    pub(crate) fn said_by_the_person(&self, event: &Value) -> bool {
        event.get("prompt").and_then(Value::as_str).is_some_and(|prompt| !transcript::js_trim(prompt).is_empty()
            && !self.settings.person.not_when.iter().any(|conditions| transcript::meets(event, conditions))
            && self.patterns.injected_as(prompt).is_none())
    }

    /// What to send the account for one event of `harness` named `event_name` (the shared or the harness's own name).
    pub(crate) fn prepare(&self, harness_id: &str, event_name: &str, event: &Value, computer: &Computer) -> Option<Prepared> {
        let harness = self.harness(harness_id)?;
        let shared = self.event_of(harness, event_name)?;
        let hooks: Vec<&Hook> = self.settings.hooks.iter().filter(|hook| hook.event == shared).collect();
        let mut input = json!({"harness": harness.id, "event": shared, "payload": event});
        let mut prepared = Prepared::default();
        if hooks.iter().any(|hook| hook.step == Step::SayRecorded) {
            input["transcript_recorded"] = json!(self.recorded_here(event, computer));
        }
        let mut messages = Vec::new();
        for hook in hooks.iter().filter(|hook| hook.step == Step::RecordMessages) {
            match hook.from {
                Some(Source::Prompt) => if let Some((message, session)) = self.submitted_prompt(harness, event, computer) {
                    prepared.prompt_session = Some(session);
                    messages.push(message);
                },
                Some(Source::Transcript) => if let Some((read, advance)) = self.transcript_messages(harness, event, computer) {
                    prepared.advance = Some(advance);
                    messages.extend(read);
                },
                None => {}
            }
        }
        if hooks.iter().any(|hook| hook.from == Some(Source::Transcript)) {
            if let Some((executions,advance))=self.prepare_executions(harness,event,computer) {
                input["executions"]=Value::Array(executions);
                if self.session_of(&input["payload"]).is_none(){input["payload"]["session_id"]=json!(advance.0);}
                prepared.execution_advance=Some(advance);
            }
        }
        if !messages.is_empty() {
            input["messages"] = Value::Array(messages.into_iter().map(|message| Value::Object(message.0)).collect());
        }
        prepared.input = input;
        Some(prepared)
    }

    /// The prompt the person just submitted, kept before the AI works (record-every-message.mjs
    /// `recordSubmittedPrompt`), with its prompt mark kept first so the turn-end pass keeps the same time.
    fn submitted_prompt(&self, harness: &Harness, event: &Value, computer: &Computer) -> Option<(Message, String)> {
        let session_id = self.session_of(event)?;
        let prompt = event.get("prompt").or_else(|| event.get("input")).and_then(Value::as_str)?;
        if !self.said_by_the_person(event) {
            return None;
        }
        let window = self.settings.client.prompt_mark_window_ms;
        let near = |at: &str| transcript::time_ms(at).is_some_and(|at| (at - computer.now_ms).abs() < window);
        let human = transcript::at(event, &self.settings.person.human_path).and_then(Value::as_str) == Some(self.settings.person.human_is.as_str());
        let path = self.transcript_of(event, computer);
        if let Some(path) = &path {
            let folder = self.cursor_folder(computer)?;
            let cursor: Option<transcript::Cursor> = transcript::read_json(&transcript::cursor_path(&folder, &session_id, ".json"));
            let from = cursor.filter(|cursor| std::path::Path::new(&cursor.transcript) == path).map_or(0, |cursor| cursor.offset);
            let rows = transcript::rows_from(path, from, self.settings.client.transcript_read_bytes, self.settings.client.transcript_row_bytes).ok()?.rows;
            // The harness the command was run for, as the old hook's --harness named it.
            let found_harness = harness;
            if !transcript::person_speaks_in(path, found_harness, self.settings.client.head_bytes) {
                return None;
            }
            let said = transcript::messages_of(&rows, found_harness, &session_id, &Map::new(), &[], true, &self.patterns).messages;
            let same = |message: &Message| message.text() == prompt || transcript::js_trim(message.text()) == transcript::js_trim(prompt)
                || prompt.contains(&format!("{}\n{}", self.settings.person.generated_request_marker, message.text()));
            if said.iter().any(|message| message.speaker() == "peer" && same(message) && near(message.at())) {
                return None;
            }
            let verified = said.into_iter().filter(|message| message.speaker() == "person" && same(message) && near(message.at()))
                .min_by_key(|message| transcript::time_ms(message.at()).map_or(i64::MAX, |at| (at - computer.now_ms).abs()));
            if let Some(verified) = verified {
                return Some((verified, session_id));
            }
            if found_harness.prompt_requires_transcript || transcript::awaits_transcript(found_harness, computer.env)
                || transcript::session_awaits_transcript(path, found_harness, self.settings.client.head_bytes)
                || (found_harness.await_human_transcript && !human) {
                return None;
            }
        }
        if harness.prompt_requires_transcript || transcript::awaits_transcript(harness, computer.env)
            || (harness.await_human_transcript && !human && path.is_none()) {
            return None;
        }
        let at = computer.now();
        let folder = self.cursor_folder(computer)?;
        let marks_path = transcript::cursor_path(&folder, &session_id, ".prompts.json");
        let mut marks: Vec<transcript::PromptMark> = transcript::read_json(&marks_path).unwrap_or_default();
        marks.push(transcript::PromptMark { digest: transcript::digest(prompt), at: at.clone() });
        transcript::write_json(&marks_path, &marks).ok()?;
        let mut message = Map::new();
        message.insert("conversation_id".into(), json!(format!("{}:{session_id}", harness.id)));
        message.insert("app".into(), json!(harness.app));
        message.insert("speaker".into(), json!("person"));
        message.insert("text".into(), json!(prompt));
        message.insert("at".into(), json!(at));
        Some((Message(message), session_id))
    }

    /// Everything new in one session's transcript since its cursor (record-every-message.mjs `recordNew`, its message
    /// part), at most `most_messages`, and the cursor each count of kept messages moves to.
    fn transcript_messages(&self, harness: &Harness, event: &Value, computer: &Computer) -> Option<(Vec<Message>, Advance)> {
        let path = self.transcript_of(event, computer)?;
        let session_id = Self::first_text(event, &self.settings.session.session_id_paths)
            .or_else(|| transcript::session_of_transcript(&path, &self.settings.harnesses, self.settings.client.head_bytes))?;
        let folder = self.cursor_folder(computer)?;
        let size = std::fs::metadata(&path).ok()?.len();
        let kept = transcript::read_json::<transcript::Cursor>(&transcript::cursor_path(&folder, &session_id, ".json"))
            .filter(|cursor| std::path::Path::new(&cursor.transcript) == path && cursor.offset <= size)
            .unwrap_or_else(|| transcript::Cursor { transcript: path.to_string_lossy().into_owned(), ..Default::default() });
        let read = transcript::rows_from(&path, kept.offset, self.settings.client.transcript_read_bytes, self.settings.client.transcript_row_bytes).ok()?;
        if read.blocked {
            return None;
        }
        let harness = kept.harness.as_deref().and_then(|id| self.harness(id))
            .or_else(|| transcript::harness_of(&read.rows, &self.settings.harnesses)).unwrap_or(harness);
        let mut rows: Vec<Value> = kept.deferred.iter().map(|item| item.row.clone()).collect();
        let mut ends: Vec<Option<u64>> = kept.deferred.iter().map(|item| item.offset).collect();
        rows.extend(read.rows.iter().cloned());
        ends.extend(read.ends.iter().copied());
        let person_speaks = transcript::person_speaks_in(&path, harness, self.settings.client.head_bytes);
        let found = transcript::messages_of(&rows, harness, &session_id, &kept.context, &ends, person_speaks, &self.patterns);
        let marks: Vec<transcript::PromptMark> = transcript::read_json(&transcript::cursor_path(&folder, &session_id, ".prompts.json")).unwrap_or_default();
        let (mut messages, mut matched) = transcript::with_prompt_times(found.messages, &marks, self.settings.client.prompt_mark_window_ms);
        let deferred = |upto: Option<u64>| found.deferred.iter().filter(|item| upto.is_none_or(|upto| item.offset.is_none_or(|offset| offset <= upto)))
            .map(|item| transcript::DeferredRow { row: item.row.clone(), offset: item.offset }).collect::<Vec<_>>();
        let cursor_at = |offset: u64, context: Map<String, Value>, upto: Option<u64>| transcript::Cursor {
            transcript: path.to_string_lossy().into_owned(), offset, harness: Some(harness.id.clone()), context, deferred: deferred(upto) };
        let mut each: Vec<transcript::Cursor> = found.marks.iter()
            .map(|mark| cursor_at(mark.offset.unwrap_or(kept.offset), mark.context.clone(), mark.offset)).collect();
        let mut whole = cursor_at(read.offset, found.context.clone(), None);
        let most = self.settings.client.most_messages;
        if messages.len() > most {
            // The rest goes on the next pass, from the cursor of the last message sent now.
            messages.truncate(most);
            matched.truncate(most);
            each.truncate(most);
            whole = each.last().cloned().unwrap_or(whole);
        }
        Some((messages, Advance { session_id, whole, each, matched }))
    }

    /// After the account answered: the cursor moves past the messages it kept, and the prompt marks they used are spent.
    pub(crate) fn settle(&self, prepared: &Prepared, accepted: usize, computer: &Computer) {
        let Some(folder) = self.cursor_folder(computer) else { return };
        let _ = &prepared.prompt_session;
        let Some(advance) = &prepared.advance else { return };
        let sent = accepted.min(advance.each.len());
        let path = transcript::cursor_path(&folder, &advance.session_id, ".json");
        if sent == advance.each.len() {
            let _ = transcript::write_json(&path, &advance.whole);
        } else if sent > 0 {
            let _ = transcript::write_json(&path, &advance.each[sent - 1]);
        }
        let spent: std::collections::BTreeSet<usize> = advance.matched.iter().take(sent).flatten().copied().collect();
        if !spent.is_empty() {
            let marks_path = transcript::cursor_path(&folder, &advance.session_id, ".prompts.json");
            let marks: Vec<transcript::PromptMark> = transcript::read_json(&marks_path).unwrap_or_default();
            let left: Vec<_> = marks.into_iter().enumerate().filter(|(index, _)| !spent.contains(index)).map(|(_, mark)| mark).collect();
            let _ = transcript::write_json(&marks_path, &left);
        }
    }
}

/// The account key the launcher's product settings name (`secret_home`, src/secrets.rs `KeychainItem::shipped`): the
/// Keychain item through its helper (src/tool_runs/os.rs `SecretStore`; a computer without one has no key). Held in
/// memory only. The old key file (`key_file`) went with the old JS settings.
fn account_key() -> Option<Zeroizing<String>> {
    use crate::tool_runs::os::{SecretStore, This};
    let kept = crate::secrets::KeychainItem::shipped().ok()?;
    let key = This::find(&kept.program, &kept.item, None, kept.missing_status)
        .ok().flatten().and_then(|output| String::from_utf8(output.to_vec()).ok()).map(Zeroizing::new)?;
    let trimmed = Zeroizing::new(key.trim().to_owned());
    (!trimmed.is_empty()).then_some(trimmed)
}

/// One call over the loopback MCP route (tools/call of the resource operation tool), within `deadline`, through the
/// engine's one HTTP client (src/https.rs). Answers the operation's `structuredContent`, or none for anything else.
pub(crate) fn call_account(hooks: &HookRoutes, port: u16, key: &str, input: &Value, request_key: &str, deadline: std::time::Instant) -> Option<Value> {
    let client = &hooks.settings.client;
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": client.tool, "arguments": {
        "resource": hooks.settings.resource, "operation": hooks.settings.operation, "request_key": request_key, "input": input}}});
    let body = serde_json::to_vec(&body).ok()?;
    let address: std::net::SocketAddr = format!("{}:{port}", client.account_host).parse().ok()?;
    if !address.ip().is_loopback() {
        return None;
    }
    let url = url::Url::parse(&format!("http://{address}{}", client.account_path)).ok()?;
    let authorization = Zeroizing::new(format!("Bearer {key}"));
    let headers = [
        ("authorization", authorization.as_str()),
        ("content-type", "application/json"),
        ("accept", "application/json, text/event-stream"),
        ("mcp-protocol-version", client.protocol_version.as_str()),
    ];
    let wait = deadline.checked_duration_since(std::time::Instant::now()).filter(|left| !left.is_zero())?;
    let limit = usize::try_from(client.max_answer_bytes).ok()?;
    let answer = crate::https::request(&crate::https::Ask { method: "POST", url: &url, headers: &headers, body: &body }, limit, wait).ok()?;
    if answer.status != 200 {
        return None;
    }
    let reply: Value = serde_json::from_slice(&answer.body).ok()?;
    let result = reply.get("result")?;
    (result.get("isError") != Some(&Value::Bool(true))).then(|| result.get("structuredContent").cloned()).flatten()
}

/// `trillion-local hook APP_FILES_LIST HARNESS EVENT`, the event JSON on stdin. Prints what the account says for the turn and
/// nothing else; every refusal is silent and the exit is 0, so a harness's turn is never held up or failed by it.
pub fn command(args: &[String], stdin: &mut dyn std::io::Read, out: &mut dyn std::io::Write) -> Result<(), Box<dyn std::error::Error>> {
    const USAGE: &str = "usage: trillion-local hook APP_FILES_LIST HARNESS EVENT < EVENT_JSON";
    let [app_files_list, harness, event_name] = args else { return Err(crate::refusal_cause::CodedError::new(USAGE).into()) };
    let Ok(hooks) = HookRoutes::shipped() else { return Ok(()) };
    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_millis(hooks.settings.client.time_box_ms);
    let mut bytes = Vec::new();
    if std::io::Read::take(stdin, hooks.settings.client.max_event_bytes + 1).read_to_end(&mut bytes).is_err()
        || bytes.len() as u64 > hooks.settings.client.max_event_bytes {
        return Ok(());
    }
    let event: Value = if bytes.iter().all(u8::is_ascii_whitespace) { json!({}) } else {
        match serde_json::from_slice(&bytes) { Ok(event @ Value::Object(_)) => event, _ => return Ok(()) }
    };
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let env = |name: &str| std::env::var(name).ok();
    let computer = Computer { env: &env, home: home.clone(), now_ms: chrono::Utc::now().timestamp_millis() };
    let Some(prepared) = hooks.prepare(harness, event_name, &event, &computer) else { return Ok(()) };
    let Ok(port) = crate::native_boot::app_port(std::path::Path::new(app_files_list)) else { return Ok(()) };
    let Some(key) = account_key() else { return Ok(()) };
    let request_key = format!("{}:{}", hooks.settings.request_key_prefix, transcript::digest(&prepared.input.to_string()));
    let Some(answer) = call_account(hooks, port, &key, &prepared.input, &request_key, deadline) else { return Ok(()) };
    drop(key);
    let accepted = answer.get("accepted").and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok()).unwrap_or(0);
    hooks.settle(&prepared, accepted, &computer);
    hooks.settle_executions(&prepared,&answer,&computer);
    if let Some(said) = answer.get("said").and_then(Value::as_str).filter(|said| !said.is_empty()) {
        let _ = writeln!(out, "{said}");
    }
    Ok(())
}

#[cfg(test)]
mod tests;
