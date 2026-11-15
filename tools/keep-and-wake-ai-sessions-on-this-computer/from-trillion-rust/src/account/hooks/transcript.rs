//! A harness's transcript, read on the computer the harness runs on: which rows are the person's words, which are the
//! AI's replies, and which text nobody typed. Moved from trillion harness/record-every-message.mjs (`at`, `meets`,
//! `harnessOf`, `injectedAs`, `peerWordsOf`, `wordsOf`, `messagesOf`, `rowsFrom`, `transcriptFor`, `personSpeaksIn`,
//! `withPromptTimes`, the cursor and `recordNew`'s cursor rule) and harness/decisions-since.mjs
//! (`recordingHarnessFor`). Nothing here names a harness, a row shape or a word: they are rows of `hooks.json`.
//!
//! Not moved yet (each is a gap the PR lists): binary attachments (`attachmentSourcesOf`),
//! source-return checks, whole-JSON-document harnesses and the sweep/drain of every transcript.
//! Tool observations use the same row DATA and reader through hooks/executions.rs.

use super::Settings;
use content_crypto::advanced::blake3;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// One condition on a row (`meets`): `{path, is}`, `{path, is_not}`, `{path, one_of}` or `{path, present}`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Condition {
    path: Vec<String>,
    #[serde(default)]
    is: Option<Value>,
    #[serde(default)]
    is_not: Option<Value>,
    #[serde(default)]
    one_of: Option<Vec<Value>>,
    #[serde(default)]
    present: Option<bool>,
}

/// One environment condition (`awaits_transcript_when`): the variable `name` holds exactly `is`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EnvCondition {
    name: String,
    is: String,
}

/// Where a harness keeps its transcripts.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Root {
    folder: String,
    depth: u32,
    #[serde(default)]
    home_variable: Option<String>,
    #[serde(default)]
    home_subfolder: Option<String>,
}

/// A value a harness names once for many rows (the model of a turn).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Carried {
    name: String,
    when: Vec<Condition>,
    path: Vec<String>,
}

/// Where a message rule's words are.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TextRule {
    path: Vec<String>,
    part_types: Vec<String>,
    #[serde(default)]
    content_kinds_path: Option<Vec<String>>,
    #[serde(default)]
    human_kind_prefix: Option<String>,
    #[serde(default)]
    strip_generated_request_prefix: bool,
}

/// Where an AI reply's model is: the carried value named `context`, or the row's own `path`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ModelRule {
    #[serde(default)]
    pub(super) context: Option<String>,
    #[serde(default)]
    path: Option<Vec<String>>,
}

/// A later row that speaks for this one (`superseded_by`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Superseded {
    rows: Vec<SupersedingRow>,
    within_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SupersedingRow {
    when: Vec<Condition>,
    text_path: Vec<String>,
}

/// One kind of message row: who speaks in it, when a row is one, and where its words are.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MessageRule {
    speaker: String,
    when: Vec<Condition>,
    text: TextRule,
    #[serde(default)]
    origin_path: Option<Vec<String>>,
    #[serde(default)]
    model: Option<ModelRule>,
    #[serde(default)]
    await_source: bool,
    #[serde(default)]
    superseded_by: Option<Superseded>,
}

/// One harness's transcript rows (record-every-message.json `harnesses[]`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Harness {
    pub(crate) id: String,
    pub(crate) app: String,
    pub(crate) event_names: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) await_human_transcript: bool,
    #[serde(default)]
    pub(crate) prompt_requires_transcript: bool,
    #[serde(default)]
    pub(super) source_ref_paths: Vec<Vec<String>>,
    #[serde(default)]
    final_reply_when: Vec<Condition>,
    recognized_by: Vec<Condition>,
    #[serde(default)]
    person_when_session: Option<Vec<Condition>>,
    session_id_path: Vec<String>,
    pub(super) time_path: Vec<String>,
    #[serde(default)]
    pub(super) time_fallback_path: Option<Vec<String>>,
    transcript_roots: Vec<Root>,
    #[serde(default)]
    pub(super) context: Vec<Carried>,
    #[serde(default)]
    awaits_transcript_when: Vec<EnvCondition>,
    #[serde(default)]
    awaits_transcript_when_session: Vec<Condition>,
    messages: Vec<MessageRule>,
    #[serde(default)]
    pub(super) executions: Vec<Value>,
}

/// One text a harness or another AI puts into a chat that nobody typed, and who it is kept as.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Injected {
    kept_as: String,
    pattern: String,
}

/// The compiled injected-text rows and the generated-request prefix.
pub(crate) struct Patterns {
    injected: Vec<(String, Regex)>,
    generated_request: Regex,
    generated_marker: String,
}

impl Patterns {
    pub(crate) fn compile(settings: &Settings) -> Option<Self> {
        let injected = settings.injected_text.iter()
            .map(|row| Regex::new(&row.pattern).ok().map(|pattern| (row.kept_as.clone(), pattern)))
            .collect::<Option<Vec<_>>>()?;
        Some(Patterns {
            injected,
            generated_request: Regex::new(&settings.person.generated_request_prefix).ok()?,
            generated_marker: settings.person.generated_request_marker.clone(),
        })
    }

    /// Who an injected text is kept as, or none when nobody injected it (`injectedAs`).
    pub(crate) fn injected_as(&self, text: &str) -> Option<&str> {
        self.injected.iter().find(|(_, pattern)| pattern.is_match(text)).map(|(kept, _)| kept.as_str())
    }
}

/// The value at `path` in `row`, or none when any step is missing (`at`).
pub(crate) fn at<'a>(row: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(row, |value, key| match value {
        Value::Object(fields) => fields.get(key),
        Value::Array(items) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    })
}

/// Whether `row` meets every condition (`meets`). A missing value is never equal to anything, and is "not" anything.
pub(crate) fn meets(row: &Value, conditions: &[Condition]) -> bool {
    conditions.iter().all(|condition| {
        let value = at(row, &condition.path);
        if let Some(present) = condition.present {
            return value.is_some_and(|value| !value.is_null()) == present;
        }
        if let Some(one_of) = &condition.one_of {
            return value.is_some_and(|value| one_of.contains(value));
        }
        if let Some(is) = &condition.is {
            return value == Some(is);
        }
        if let Some(is_not) = &condition.is_not {
            return value != Some(is_not);
        }
        true
    })
}

/// The harness that wrote these rows, or none (`harnessOf`).
pub(crate) fn harness_of<'a>(rows: &[Value], harnesses: &'a [Harness]) -> Option<&'a Harness> {
    harnesses.iter().find(|harness| rows.iter().any(|row| meets(row, &harness.recognized_by)))
}

/// JavaScript's `String.prototype.trim` (white space and line terminators, the byte-order mark among them).
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// The text parts of a row's text field: a string is one part; an array keeps the parts whose type is one of `types`
/// (an untyped part is `text`) and whose `text` is a string.
fn parts_of(value: Option<&Value>, types: &[String]) -> Vec<String> {
    match value {
        Some(Value::String(text)) => vec![text.clone()],
        Some(Value::Array(parts)) => parts.iter().filter_map(|part| {
            let kind = part.get("type").and_then(Value::as_str).unwrap_or("text");
            (types.iter().any(|allowed| allowed == kind)).then(|| part.get("text").and_then(Value::as_str)).flatten().map(str::to_owned)
        }).collect(),
        _ => Vec::new(),
    }
}

/// The words in a person's row that another AI session passed on into the chat (`peerWordsOf`); "" when none.
pub(crate) fn peer_words_of(value: Option<&Value>, rule: &TextRule, patterns: &Patterns) -> String {
    parts_of(value, &rule.part_types).into_iter()
        .filter(|text| !js_trim(text).is_empty() && patterns.injected_as(text) == Some("peer"))
        .collect::<Vec<_>>().join("\n")
}

/// The words a row's text field holds, without the parts a harness injected; "" when none are left (`wordsOf`).
pub(crate) fn words_of(value: Option<&Value>, rule: &TextRule, patterns: &Patterns) -> String {
    parts_of(value, &rule.part_types).into_iter().map(|text| {
        if rule.strip_generated_request_prefix && patterns.generated_request.is_match(&text) {
            return match text.find(&patterns.generated_marker) {
                Some(start) => text[start + patterns.generated_marker.len()..].trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}').to_owned(),
                None => String::new(),
            };
        }
        text
    }).filter(|text| !js_trim(text).is_empty() && patterns.injected_as(text).is_none())
        .collect::<Vec<_>>().join("\n")
}

/// A time as JavaScript's `new Date(time).toISOString()`, or none when `Date.parse` would not read it.
pub(crate) fn iso_time(text: &str) -> Option<String> {
    let parsed = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    Some(parsed.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// Milliseconds since the epoch of a time, or none.
pub(crate) fn time_ms(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|time| time.timestamp_millis())
}

/// One message read from a transcript, as it is kept: the fields of record-every-message.mjs's messages.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Message(pub(crate) Map<String, Value>);

impl Message {
    pub(crate) fn speaker(&self) -> &str {
        self.0.get("speaker").and_then(Value::as_str).unwrap_or("")
    }
    pub(crate) fn text(&self) -> &str {
        self.0.get("text").and_then(Value::as_str).unwrap_or("")
    }
    pub(crate) fn at(&self) -> &str {
        self.0.get("at").and_then(Value::as_str).unwrap_or("")
    }
}

/// Where message i's row ends and the carried context at that row.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Mark {
    pub(crate) offset: Option<u64>,
    pub(crate) context: Map<String, Value>,
}

/// A row whose sender is not known yet (`await_source`), kept in the cursor until a later row says who sent it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Deferred {
    pub(crate) row: Value,
    pub(crate) offset: Option<u64>,
}

/// What `messages_of` found.
#[derive(Debug, Default)]
pub(crate) struct Found {
    pub(crate) messages: Vec<Message>,
    pub(crate) marks: Vec<Mark>,
    pub(crate) context: Map<String, Value>,
    pub(crate) deferred: Vec<Deferred>,
}

/// The text of a superseding row's field: a string, or the `text` parts of an array joined by lines.
fn plain_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts.iter().map(|part| part.get("text").and_then(Value::as_str).unwrap_or("")).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// The messages in a run of rows, in order, and the harness context after them (`messagesOf`). `ends[i]` is where row
/// i ends in the transcript, when known.
pub(crate) fn messages_of(rows: &[Value], harness: &Harness, session_id: &str, context: &Map<String, Value>,
    ends: &[Option<u64>], person_speaks: bool, patterns: &Patterns) -> Found {
    let mut found = Found { context: context.clone(), ..Found::default() };
    let conversation = format!("{}:{session_id}", harness.id);
    for (index, row) in rows.iter().enumerate() {
        for carried in &harness.context {
            if meets(row, &carried.when) {
                if let Some(Value::String(value)) = at(row, &carried.path) {
                    if !value.is_empty() {
                        found.context.insert(carried.name.clone(), Value::String(value.clone()));
                    }
                }
            }
        }
        let Some(rule) = harness.messages.iter().find(|candidate| meets(row, &candidate.when)) else { continue };
        if rule.speaker == "person" && !person_speaks {
            continue;
        }
        if let Some(superseded) = &rule.superseded_by {
            let words = at(row, &rule.text.path).and_then(Value::as_str).map(js_trim).unwrap_or("").to_owned();
            let start = at(row, &harness.time_path).and_then(Value::as_str).and_then(time_ms);
            let mut spoken = false;
            for later in rows.iter().skip(index + 1) {
                if words.is_empty() || spoken {
                    break;
                }
                let gap = match (start, at(later, &harness.time_path).and_then(Value::as_str).and_then(time_ms)) {
                    (Some(start), Some(then)) => Some(then - start),
                    _ => None,
                };
                // Rows are written in time order, give or take a turn's own clock. A gap JavaScript reads as NaN never
                // stops the walk and never counts as near.
                if !rule.await_source && gap.is_some_and(|gap| gap > 2 * superseded.within_ms) {
                    break;
                }
                spoken = (rule.await_source || gap.is_some_and(|gap| gap.abs() <= superseded.within_ms))
                    && superseded.rows.iter().any(|candidate| meets(later, &candidate.when) && plain_text(at(later, &candidate.text_path)).contains(&words));
            }
            if spoken {
                continue;
            }
        }
        let mut content = at(row, &rule.text.path).cloned();
        if let Some(kinds_path) = &rule.text.content_kinds_path {
            if let Some(Value::Array(kinds)) = at(row, kinds_path) {
                let prefix = rule.text.human_kind_prefix.as_deref().unwrap_or("");
                let human = |kind: Option<&Value>| kind.and_then(Value::as_str).is_some_and(|kind| kind.starts_with(prefix));
                content = Some(match content {
                    Some(Value::Array(parts)) if parts.len() == kinds.len() => Value::Array(parts.into_iter().zip(kinds.iter())
                        .filter(|(_, kind)| human(Some(kind))).map(|(part, _)| part).collect()),
                    Some(Value::String(text)) if kinds.len() == 1 && human(kinds.first()) => Value::String(text),
                    _ => Value::Array(Vec::new()),
                });
            }
        }
        let text = words_of(content.as_ref(), &rule.text, patterns);
        let time = at(row, &harness.time_path).or_else(|| harness.time_fallback_path.as_ref().and_then(|path| at(row, path)))
            .and_then(Value::as_str).and_then(iso_time);
        let source_ref = harness.source_ref_paths.iter().find_map(|path| at(row, path).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned))
            .or_else(|| ends.get(index).copied().flatten().map(|end| format!("transcript-row:{end}")));
        let mark = Mark { offset: ends.get(index).copied().flatten(), context: found.context.clone() };
        // Words another AI session passed on into the person's row: kept as the peer's own message at the row's time.
        let passed_on = if rule.speaker == "person" && !rule.await_source { peer_words_of(content.as_ref(), &rule.text, patterns) } else { String::new() };
        if let (false, Some(time)) = (passed_on.is_empty(), &time) {
            let mut message = Map::new();
            message.insert("conversation_id".into(), json!(conversation));
            message.insert("app".into(), json!(harness.app));
            message.insert("speaker".into(), json!("peer"));
            message.insert("text".into(), json!(passed_on));
            message.insert("at".into(), json!(time));
            if let Some(source_ref) = &source_ref {
                message.insert("source_ref".into(), json!(format!("{source_ref}:peer")));
            }
            found.messages.push(Message(message));
            found.marks.push(mark.clone());
        }
        let Some(time) = time else { continue };
        if text.is_empty() {
            continue;
        }
        // Unknown origin stays recoverable on disk. Time or the absence of a later row is never evidence of a person.
        if rule.await_source {
            found.deferred.push(Deferred { row: row.clone(), offset: ends.get(index).copied().flatten() });
            continue;
        }
        let model = match &rule.model {
            Some(ModelRule { context: Some(name), .. }) => found.context.get(name).and_then(Value::as_str).map(str::to_owned),
            Some(ModelRule { path: Some(path), .. }) => at(row, path).and_then(Value::as_str).map(str::to_owned),
            _ => None,
        };
        let origin = rule.origin_path.as_ref().and_then(|path| at(row, path)).and_then(Value::as_str).filter(|origin| !origin.is_empty());
        let mut message = Map::new();
        message.insert("conversation_id".into(), json!(conversation));
        message.insert("app".into(), json!(harness.app));
        message.insert("speaker".into(), json!(rule.speaker));
        message.insert("text".into(), json!(text));
        message.insert("at".into(), json!(time));
        if let (true, Some(origin)) = (rule.speaker == "person", origin) {
            message.insert("origin".into(), json!(origin));
        }
        if rule.speaker == "ai" && meets(row, &harness.final_reply_when) {
            message.insert("final_reply".into(), json!(true));
        }
        if let Some(source_ref) = source_ref {
            message.insert("source_ref".into(), json!(source_ref));
        }
        if let Some(model) = model.filter(|model| !model.is_empty()) {
            message.insert("model".into(), json!(model));
        }
        found.messages.push(Message(message));
        found.marks.push(mark);
    }
    found
}

/// The complete rows read from `offset` (`rowsFrom` for a JSON-lines transcript): at most `read_bytes` (a row up to
/// `row_bytes`), never the rest of the file.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Rows {
    pub(crate) rows: Vec<Value>,
    pub(crate) ends: Vec<Option<u64>>,
    pub(crate) offset: u64,
    pub(crate) more: bool,
    /// A row longer than the bounded reader takes: nothing passes it.
    pub(crate) blocked: bool,
}

pub(crate) fn rows_from(path: &Path, offset: u64, read_bytes: u64, row_bytes: u64) -> std::io::Result<Rows> {
    let mut file = crate::io_operation!((std::fs::File::open(path)).map_err(std::io::Error::from))?;
    let size = crate::io_operation!((file.metadata()).map_err(std::io::Error::from))?.len();
    let start = if offset > size { 0 } else { offset };
    let remaining = size - start;
    let bounded = read_bytes > 0;
    let mut length = if bounded { remaining.min(read_bytes) } else { remaining };
    let row_limit = if row_bytes > 0 { length.max(row_bytes) } else { length };
    let mut bytes;
    loop {
        bytes = vec![0; crate::io_operation!((usize::try_from(length).map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(std::io::Error::other("too long"), _refusal_io_cause) })).map_err(std::io::Error::from))?];
        crate::io_operation!((file.seek(SeekFrom::Start(start))).map_err(std::io::Error::from))?;
        let mut read = 0;
        while read < bytes.len() {
            match crate::io_operation!((file.read(&mut bytes[read..])).map_err(std::io::Error::from))? {
                0 => break,
                n => read += n,
            }
        }
        bytes.truncate(read);
        if bytes.contains(&b'\n') || length >= remaining || length >= row_limit {
            break;
        }
        length = remaining.min(row_limit).min((length + 1).max(length * 2));
    }
    let end = bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1);
    if bounded && end == 0 && remaining > bytes.len() as u64 {
        return Ok(Rows { offset: start, more: true, blocked: true, ..Rows::default() });
    }
    let mut rows = Vec::new();
    let mut ends = Vec::new();
    let mut from = 0;
    while from < end {
        let stop = from + bytes[from..end].iter().position(|byte| *byte == b'\n').unwrap_or(end - from - 1);
        if let Ok(row) = serde_json::from_slice::<Value>(&bytes[from..stop]) {
            rows.push(row);
            ends.push(Some(start + stop as u64 + 1));
        }
        from = stop + 1;
    }
    let more = bounded && start + (end as u64) < size && (bytes.len() as u64) < remaining;
    Ok(Rows { rows, ends, offset: start + end as u64, more, blocked: false })
}

/// The first complete rows of a transcript, read in growing pieces up to `most` bytes until `enough` holds
/// (`headRows`).
pub(crate) fn head_rows(path: &Path, most: u64, enough: impl Fn(&[Value]) -> bool) -> Vec<Value> {
    let Ok(mut file) = std::fs::File::open(path) else { return Vec::new() };
    let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let mut length: u64 = 65_536;
    loop {
        let take = size.min(length).min(most);
        let mut bytes = vec![0; usize::try_from(take).unwrap_or(0)];
        if file.seek(SeekFrom::Start(0)).is_err() || file.read_exact(&mut bytes).is_err() {
            return Vec::new();
        }
        let end = bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1);
        let rows: Vec<Value> = bytes[..end].split(|byte| *byte == b'\n').filter(|line| !line.is_empty())
            .filter_map(|line| serde_json::from_slice(line).ok()).collect();
        if enough(&rows) || take >= size || take >= most {
            return rows;
        }
        length *= 4;
    }
}

/// The session id a transcript names in its head, by the harness that wrote it (`sessionOfTranscript`), for a
/// backfill whose event names only the transcript.
pub(crate) fn session_of_transcript(path: &Path, harnesses: &[Harness], head_bytes: u64) -> Option<String> {
    let named = |rows: &[Value]| harness_of(rows, harnesses).and_then(|harness| rows.iter()
        .find_map(|row| at(row, &harness.session_id_path).and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned)));
    named(&head_rows(path, head_bytes, |rows| named(rows).is_some()))
}

/// Whether the person's words can be in this session at all (`personSpeaksIn`): a harness row may say which sessions
/// the person types into, by conditions on the row that names the session.
pub(crate) fn person_speaks_in(path: &Path, harness: &Harness, head_bytes: u64) -> bool {
    let Some(conditions) = &harness.person_when_session else { return true };
    let rows = head_rows(path, head_bytes, |rows| rows.iter().any(|row| meets(row, &harness.recognized_by)));
    rows.iter().find(|row| meets(row, &harness.recognized_by)).is_none_or(|row| meets(row, conditions))
}

/// Whether the harness data says this process runs a session whose prompts are trusted only from the transcript.
pub(crate) fn awaits_transcript(harness: &Harness, env: &dyn Fn(&str) -> Option<String>) -> bool {
    harness.awaits_transcript_when.iter().any(|item| env(&item.name).as_deref() == Some(item.is.as_str()))
}

/// Whether the transcript's head marks it a session whose prompts are trusted only from their rows.
pub(crate) fn session_awaits_transcript(path: &Path, harness: &Harness, head_bytes: u64) -> bool {
    let conditions = &harness.awaits_transcript_when_session;
    !conditions.is_empty() && head_rows(path, head_bytes, |rows| rows.iter().any(|row| meets(row, conditions))).iter().any(|row| meets(row, conditions))
}

/// `~` at the start of a path is the person's home.
pub(crate) fn expand(path: &str, home: Option<&Path>) -> PathBuf {
    match (path.strip_prefix('~'), home) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        _ => PathBuf::from(path),
    }
}

/// The folder a transcript root names: under its home variable when that is set, else its folder.
fn root_folder(root: &Root, env: &dyn Fn(&str) -> Option<String>, home: Option<&Path>) -> PathBuf {
    match root.home_variable.as_deref().and_then(env).filter(|value| !value.is_empty()) {
        Some(home_variable) => Path::new(&home_variable).join(root.home_subfolder.as_deref().unwrap_or("")),
        None => expand(&root.folder, home),
    }
}

/// A path made plain without touching the disk: `.` and `..` resolved (`path.resolve` on an absolute path).
fn plain(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => { out.pop(); }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// The harness whose transcript roots hold this transcript, or none (`recordingHarnessFor`).
pub(crate) fn harness_holding<'a>(transcript: &Path, harnesses: &'a [Harness], env: &dyn Fn(&str) -> Option<String>,
    home: Option<&Path>) -> Option<&'a Harness> {
    let canonical = std::fs::canonicalize(transcript).ok();
    let file = canonical.clone().unwrap_or_else(|| plain(transcript));
    harnesses.iter().find(|harness| harness.transcript_roots.iter().any(|root| {
        let root=root_folder(root,env,home);
        // A configuration notice may name a transcript not created yet. Keep
        // both paths lexical then; real occurrences compare canonical roots.
        let folder = if canonical.is_some() {std::fs::canonicalize(&root).unwrap_or_else(|_|plain(&root))}else{plain(&root)};
        file != folder && file.starts_with(&folder)
    }))
}

/// The transcript a session id names under the harnesses' roots, the newest when several match (`transcriptFor`).
pub(crate) fn transcript_for(session_id: &str, pattern: &Regex, harnesses: &[Harness], env: &dyn Fn(&str) -> Option<String>,
    home: Option<&Path>) -> Option<PathBuf> {
    if !pattern.is_match(session_id) {
        return None;
    }
    fn walk(folder: &Path, depth: u32, session_id: &str, best: &mut Option<(PathBuf, std::time::SystemTime)>) {
        let Ok(entries) = std::fs::read_dir(folder) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() && depth > 0 {
                walk(&path, depth - 1, session_id, best);
            } else if kind.is_file() && name.ends_with(".jsonl") && name.contains(session_id) {
                let time = entry.metadata().and_then(|meta| meta.modified()).unwrap_or(std::time::UNIX_EPOCH);
                if best.as_ref().is_none_or(|(_, kept)| time > *kept) {
                    *best = Some((path, time));
                }
            }
        }
    }
    let mut best = None;
    for harness in harnesses {
        for root in &harness.transcript_roots {
            walk(&root_folder(root, env, home), root.depth, session_id, &mut best);
        }
    }
    best.map(|(path, _)| path)
}

/// The hex BLAKE3 of a text (`promptDigest`).
pub(crate) fn digest(text: &str) -> String {
    blake3::hash(text.as_bytes()).to_hex().to_string()
}

/// One prompt's kept time: a prompt sent before its transcript row, so the later pass keeps that same time.
#[derive(Clone, Debug, PartialEq, serde::Serialize, Deserialize)]
pub(crate) struct PromptMark {
    pub(crate) digest: String,
    pub(crate) at: String,
}

/// The person's messages given their prompt marks' times (`withPromptTimes`): each mark is used once, by the first
/// message with its words within `window_ms`. Answers the messages and, per message, the mark it used.
pub(crate) fn with_prompt_times(messages: Vec<Message>, marks: &[PromptMark], window_ms: i64) -> (Vec<Message>, Vec<Option<usize>>) {
    let mut used = std::collections::BTreeSet::new();
    let mut matched = Vec::new();
    let corrected = messages.into_iter().map(|mut message| {
        if message.speaker() != "person" {
            matched.push(None);
            return message;
        }
        let words = digest(message.text());
        let when = time_ms(message.at());
        let found = marks.iter().enumerate().position(|(index, mark)| !used.contains(&index) && mark.digest == words
            && matches!((time_ms(&mark.at), when), (Some(a), Some(b)) if (a - b).abs() < window_ms));
        matched.push(found);
        if let Some(index) = found {
            used.insert(index);
            message.0.insert("at".into(), json!(marks[index].at));
        }
        message
    }).collect();
    (corrected, matched)
}

/// Where one session's cursor and prompt marks are kept.
pub(crate) fn cursor_path(folder: &Path, session_id: &str, suffix: &str) -> PathBuf {
    let name: String = session_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    folder.join(format!("{name}{suffix}"))
}

/// One session's transcript cursor: the transcript, the byte offset past the last kept message, the harness, the
/// carried context and the rows still waiting for their sender.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, Deserialize)]
pub(crate) struct Cursor {
    pub(crate) transcript: String,
    pub(crate) offset: u64,
    #[serde(default)]
    pub(crate) harness: Option<String>,
    #[serde(default)]
    pub(crate) context: Map<String, Value>,
    #[serde(default)]
    pub(crate) deferred: Vec<DeferredRow>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, Deserialize)]
pub(crate) struct DeferredRow {
    pub(crate) row: Value,
    pub(crate) offset: Option<u64>,
}

/// A JSON file, or none when it is absent or unreadable.
pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Writes a JSON file whole: a part file renamed over it (0600, its folder 0700).
pub(crate) fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    // Owner-only files (src/tool_runs/os.rs `OwnerFiles`): a computer without them keeps no transcript.
    use crate::tool_runs::os::{Open, OwnerFiles, This};
    if let Some(folder) = path.parent() {
        crate::io_operation!((This::make_folder(folder, 0o700, true)).map_err(std::io::Error::from))?;
    }
    let part = path.with_extension(format!("{}.part", std::process::id()));
    let bytes = crate::io_operation!((serde_json::to_vec(value).map_err(std::io::Error::other)).map_err(std::io::Error::from))?;
    let mut file = crate::io_operation!((This::open(std::fs::OpenOptions::new().write(true).create(true).truncate(true), &part, Open::owner_only(0o600))).map_err(std::io::Error::from))?;
    crate::io_operation!((std::io::Write::write_all(&mut file, &bytes)).map_err(std::io::Error::from))?;
    crate::io_operation!(std::fs::rename(part, path))
}

/// The transcript's declared context, carried for the bounded observation reader too.
pub(super) fn carried_context(row:&Value,harness:&Harness,known:&mut Map<String,Value>) {
    for item in &harness.context {if meets(row,&item.when) {if let Some(value)=at(row,&item.path).filter(|v|v.is_string()){known.insert(item.name.clone(),value.clone());}}}
}
