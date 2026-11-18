//! Bounded observations from a real local transcript occurrence.
//! Behavioral source: trillion@b6ae0ebf815f2f5271eed34e6e023c7e1767ec04
//! harness/record-every-message.mjs:229-329; exact pinned identities and deltas
//! are in ports/verified-hook-execution-observations.json. The source is
//! read here, never accepted from caller text; the protected journal alone keeps
//! its normalized receipt. This does not intercept or authenticate the tool actor.
use super::*;
use std::{
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
};

pub(crate) struct Verified {
    pub(crate) receipt: Value,
    pub(crate) registration: String,
    pub(crate) registration_kind: String,
    pub(crate) max_references: usize,
    pub(crate) max_id_chars: usize,
    pub(crate) max_bytes: usize,
    path: PathBuf,
    offset: u64,
    bytes: std::sync::Arc<Vec<u8>>,
    head_length: u64,
    head_digest: String,
}
impl Verified {
    pub(crate) fn same_source(&self, other: &Self) -> bool {
        self.path == other.path
            && self.offset == other.offset
            && self.bytes.len() == other.bytes.len()
            && self.head_length == other.head_length
            && self.head_digest == other.head_digest
    }
    /// Repeat at effect and commit. An append is fine; replacement of this occurrence is not.
    pub(crate) fn current(&self) -> bool {
        std::fs::canonicalize(&self.path).is_ok_and(|p| p == self.path)
            && head_digest(&self.path, self.head_length).as_deref() == Some(&self.head_digest)
            && read_occurrence(&self.path, self.offset, self.bytes.len() as u64)
                .is_some_and(|bytes| bytes == *self.bytes)
    }
}
fn refused() -> OperationFailure {
    crate::mcp::InputFault::new(
        "executions",
        "bounded verified local transcript observations for the registered source",
    )
    .into_failure()
}
fn text(value: Option<&Value>, most: usize) -> Option<String> {
    let s = match value? {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    (s.encode_utf16().count() <= most).then_some(s)
}
fn selected<'a>(value: &'a Value, path: &Value) -> Option<&'a Value> {
    let mut v = value;
    for p in path.as_array()? {
        v = match p {
            Value::String(s) => v.get(s)?,
            Value::Number(n) => v.get(n.as_u64()? as usize)?,
            _ => return None,
        };
    }
    Some(v)
}
fn conditions(row: &Value, when: Option<&Value>) -> bool {
    let Some(when) = when else { return true };
    serde_json::from_value::<Vec<Condition>>(when.clone())
        .is_ok_and(|when| transcript::meets(row, &when))
}
fn unwrapped(value: &Value, depth: usize) -> Option<Value> {
    if depth > 4 {
        return None;
    }
    match value {
        Value::String(s) => serde_json::from_str(s)
            .ok()
            .and_then(|v| unwrapped(&v, depth + 1)),
        Value::Array(parts) => parts
            .iter()
            .find(|v| v["type"] == "text")
            .and_then(|v| unwrapped(&v["text"], depth + 1)),
        Value::Object(o) if o.contains_key("structuredContent") => {
            unwrapped(&o["structuredContent"], depth + 1)
        }
        Value::Object(o)
            if o.get("content").is_some_and(Value::is_array)
                && o.keys().all(|k| {
                    ["content", "isError", "structuredContent", "_meta"].contains(&k.as_str())
                }) =>
        {
            unwrapped(&o["content"], depth + 1)
        }
        _ => Some(value.clone()),
    }
}
fn object(value: &Value) -> Option<Value> {
    match value {
        Value::String(s) => serde_json::from_str::<Value>(s)
            .ok()
            .filter(Value::is_object),
        Value::Object(_) => Some(value.clone()),
        _ => None,
    }
}
fn head_digest(path: &std::path::Path, length: u64) -> Option<String> {
    let mut bytes = vec![0; usize::try_from(length).ok()?];
    std::fs::File::open(path)
        .ok()?
        .read_exact(&mut bytes)
        .ok()?;
    Some(
        content_crypto::advanced::blake3::hash(&bytes)
            .to_hex()
            .to_string(),
    )
}
fn read_occurrence(path: &std::path::Path, offset: u64, length: u64) -> Option<Vec<u8>> {
    let mut file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    if offset > 0 {
        file.seek(SeekFrom::Start(offset - 1)).ok()?;
        let mut one = [0];
        file.read_exact(&mut one).ok()?;
        if one[0] != b'\n' {
            return None;
        }
    }
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut bytes = vec![0; usize::try_from(length).ok()?];
    file.read_exact(&mut bytes).ok()?;
    (bytes.last() == Some(&b'\n') && !bytes[..bytes.len() - 1].contains(&b'\n')).then_some(bytes)
}
impl HookRoutes {
    pub(crate) fn execution_observations(
        &self,
        row: &Value,
        harness: &Harness,
        session: &str,
        context: &Map<String, Value>,
    ) -> Result<Vec<Value>, OperationFailure> {
        let limits = &self.settings.execution_references;
        let max = limits["max_references"].as_u64().ok_or_else(refused)? as usize;
        let max_id = limits["max_id_chars"].as_u64().ok_or_else(refused)? as usize;
        let max_label = limits["max_label_chars"].as_u64().ok_or_else(refused)? as usize;
        let max_role = limits["max_role_chars"].as_u64().ok_or_else(refused)? as usize;
        let max_path = limits["max_path_parts"].as_u64().ok_or_else(refused)? as usize;
        let patterns = limits["identity_patterns"]
            .as_array()
            .ok_or_else(refused)?
            .iter()
            .map(|p| regex::Regex::new(p.as_str().unwrap_or("[")))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| refused())?;
        let denied = limits["identity_refusals"]
            .as_array()
            .ok_or_else(refused)?
            .iter()
            .map(|p| regex::Regex::new(p.as_str().unwrap_or("[")))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| refused())?;
        let mut out = Vec::new();
        for rule in &harness.executions {
            if !conditions(row, rule.get("when")) {
                continue;
            }
            let parts = if let Some(path) = rule.get("parts_path") {
                selected(row, path)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
            } else {
                vec![selected(row, rule.get("part_path").unwrap_or(&json!([])))
                    .cloned()
                    .unwrap_or(Value::Null)]
            };
            for part in parts {
                if !conditions(&part, rule.get("part_when")) {
                    continue;
                }
                if selected(&part, &rule["call_id_path"]).is_some_and(|v| {
                    (v.is_string() || v.is_number()) && text(Some(v), max_id).is_none()
                }) {
                    return Err(refused());
                }
                if rule
                    .get("operation_path")
                    .and_then(|p| selected(&part, p))
                    .is_some_and(|v| {
                        (v.is_string() || v.is_number()) && text(Some(v), max_label).is_none()
                    })
                {
                    return Err(refused());
                }
                if context
                    .get("model")
                    .is_some_and(|v| text(Some(v), max_label).is_none())
                {
                    return Err(refused());
                }
                let Some(id) =
                    selected(&part, &rule["call_id_path"]).and_then(|v| text(Some(v), max_id))
                else {
                    continue;
                };
                let input = rule["input_paths"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find_map(|p| selected(&part, p).and_then(object));
                let output = rule
                    .get("result_path")
                    .and_then(|p| selected(&part, p))
                    .and_then(|v| unwrapped(v, 0));
                let mut refs = Vec::<Value>::new();
                for (side, value) in [("input", input.as_ref()), ("result", output.as_ref())] {
                    let Some(value) = value.filter(|v| v.is_object()) else {
                        continue;
                    };
                    for field in limits["fields"].as_array().ok_or_else(refused)? {
                        let selected = selected(value, &field["path"]);
                        let members = if field["each"] == true {
                            selected
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default()
                        } else {
                            vec![selected.cloned().unwrap_or(Value::Null)]
                        };
                        if members.len() > max {
                            return Err(refused());
                        }
                        for (index, member) in members.iter().enumerate() {
                            let Some(candidate) = (if let Some(path) = field.get("ref_path") {
                                selected_fn(member, path)
                            } else {
                                Some(member)
                            }) else {
                                continue;
                            };
                            let Some(candidate) = candidate.as_str().filter(|s| {
                                patterns.first().is_some_and(|p| p.is_match(s))
                                    || patterns.iter().skip(1).any(|p| p.is_match(s))
                                        && !denied.iter().any(|p| p.is_match(s))
                            }) else {
                                continue;
                            };
                            let reference =
                                text(Some(&json!(candidate)), max_id).ok_or_else(refused)?;
                            let declared_role = field
                                .get("role_path")
                                .and_then(|p| selected_fn(member, p))
                                .filter(|v| !v.is_null());
                            if declared_role.is_some_and(|v| !v.is_string()) {
                                return Err(refused());
                            }
                            let role = declared_role
                                .and_then(Value::as_str)
                                .unwrap_or(if side == "result" { "output" } else { "input" });
                            if role.is_empty()
                                || role.encode_utf16().count() > max_role
                                || role.chars().any(|c| c <= '\u{1f}')
                            {
                                return Err(refused());
                            }
                            let mut path = vec![json!(side)];
                            path.extend(field["path"].as_array().ok_or_else(refused)?.clone());
                            if field["each"] == true {
                                path.push(json!(index))
                            }
                            if let Some(p) = field["ref_path"].as_array() {
                                path.extend(p.clone())
                            }
                            if path.len() > max_path
                                || path.iter().any(|p| {
                                    p.as_str()
                                        .is_some_and(|s| s.encode_utf16().count() > max_label)
                                })
                            {
                                return Err(refused());
                            }
                            let mut entry =
                                json!({"ref":reference,"role":role,"basis":"claimed","path":path});
                            if field["each"] == true {
                                entry["ordinal"] = json!(index)
                            }
                            if !refs.contains(&entry) {
                                refs.push(entry)
                            }
                            if refs.len() > max {
                                return Err(refused());
                            }
                        }
                    }
                }
                if serde_json::to_vec(&refs).map_err(|_| refused())?.len()
                    > limits["max_bytes"].as_u64().ok_or_else(refused)? as usize
                {
                    return Err(refused());
                }
                for path in &harness.source_ref_paths {
                    if transcript::at(row, path).is_some_and(|v| {
                        (v.is_string() || v.is_number()) && text(Some(v), max_id).is_none()
                    }) {
                        return Err(refused());
                    }
                }
                let mut observation = Map::new();
                if let Some(output) = &output {
                    for (field, paths) in self
                        .settings
                        .execution_result_fields
                        .as_object()
                        .ok_or_else(refused)?
                    {
                        for path in paths.as_array().ok_or_else(refused)? {
                            if selected(output, path).is_some_and(|v| {
                                (v.is_string() || v.is_number()) && text(Some(v), max_id).is_none()
                            }) {
                                return Err(refused());
                            }
                        }
                        if let Some(value) =
                            paths.as_array().into_iter().flatten().find_map(|p| {
                                selected(output, p).and_then(|v| text(Some(v), max_id))
                            })
                        {
                            observation.insert(field.clone(), json!(value));
                        }
                    }
                }
                let call_id = transcript::digest(
                    &serde_json::to_string(&json!([harness.id, session, id]))
                        .map_err(|_| refused())?,
                );
                let mut receipt = json!({"call_id":call_id,"capture_kind":"host_transcript","origin":"unknown","event_phase":if rule.get("failed_path").and_then(|p|selected(&part,p))==Some(&json!(true)){json!("failed")}else{rule["phase"].clone()},"claimed":{"app":harness.app,"conversation_id":format!("{}:{session}",harness.id),"tool_call_id":id},"references":refs});
                if let Some(operation) = rule
                    .get("operation_path")
                    .and_then(|p| selected(&part, p))
                    .and_then(|v| text(Some(v), max_label))
                {
                    receipt["operation"] = json!(operation)
                }
                let time = transcript::at(row, &harness.time_path)
                    .or_else(|| {
                        harness
                            .time_fallback_path
                            .as_ref()
                            .and_then(|p| transcript::at(row, p))
                    })
                    .and_then(Value::as_str)
                    .and_then(transcript::time_ms);
                if let Some(time) = time {
                    receipt["captured_at"] = json!(chrono::DateTime::from_timestamp_millis(time)
                        .ok_or_else(refused)?
                        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                        .to_string())
                }
                if let Some(source) = harness
                    .source_ref_paths
                    .iter()
                    .find_map(|p| transcript::at(row, p).and_then(|v| text(Some(v), max_id)))
                {
                    receipt["claimed"]["source_ref"] = json!(source)
                }
                if let Some(model) = context.get("model").and_then(|v| text(Some(v), max_label)) {
                    receipt["claimed"]["model"] = json!(model)
                }
                if !observation.is_empty() {
                    receipt["observation"] = Value::Object(observation)
                }
                out.push(receipt);
            }
        }
        Ok(out)
    }
    /// Only the dispatcher may hand these values to the native journal producer.
    pub(crate) fn verify_executions(
        &self,
        input: &Value,
        kind_of: &dyn Fn(&str, &str) -> Option<String>,
        computer: &Computer,
    ) -> Result<Vec<Verified>, OperationFailure> {
        let fields = input.as_object().ok_or_else(refused)?;
        if fields.keys().any(|k| {
            ![
                "harness",
                "event",
                "payload",
                "messages",
                "transcript_recorded",
                "executions",
            ]
            .contains(&k.as_str())
        }) || !input["payload"].is_object()
            || input.get("messages").is_some_and(|v| {
                !v.as_array().is_some_and(|v| {
                    v.len() <= self.settings.client.most_messages && v.iter().all(Value::is_object)
                })
            })
            || input
                .get("transcript_recorded")
                .is_some_and(|v| !v.is_boolean())
        {
            return Err(refused());
        }
        let Some(items) = input.get("executions") else {
            return Ok(Vec::new());
        };
        let items = items
            .as_array()
            .filter(|v| v.len() <= self.settings.client.most_executions)
            .ok_or_else(refused)?;
        let harness = input["harness"]
            .as_str()
            .and_then(|id| self.harness(id))
            .ok_or_else(refused)?;
        if self
            .event_of(harness, input["event"].as_str().unwrap_or(""))
            .as_deref()
            != Some("Stop")
        {
            return Err(refused());
        }
        let session = self.session_of(&input["payload"]).ok_or_else(refused)?;
        let registration_kind = kind_of("harness_hooks", "agent_card").ok_or_else(refused)?;
        let registration = format!("{registration_kind}:session-{}-{session}", harness.id);
        let mut verified = Vec::new();
        let mut cache = std::collections::BTreeMap::new();
        let mut proof_bytes = 0u64;
        for item in items {
            let source = &item["source"];
            let receipt = &item["receipt"];
            if !item.as_object().is_some_and(|v| {
                v.len() == 2 && v.contains_key("receipt") && v.contains_key("source")
            }) || !source.as_object().is_some_and(|v| {
                v.len() == 3
                    && v.keys()
                        .all(|k| ["transcript_path", "offset", "end"].contains(&k.as_str()))
            }) {
                return Err(refused());
            }
            let path = PathBuf::from(source["transcript_path"].as_str().ok_or_else(refused)?);
            let canonical = std::fs::canonicalize(&path).map_err(|_| refused())?;
            if !path.is_absolute()
                || canonical != path
                || transcript::harness_holding(
                    &path,
                    &self.settings.harnesses,
                    computer.env,
                    computer.home.as_deref(),
                )
                .map(|h| &h.id)
                    != Some(&harness.id)
                || transcript::session_of_transcript(
                    &path,
                    &self.settings.harnesses,
                    self.settings.client.head_bytes,
                )
                .as_deref()
                    != Some(&session)
            {
                return Err(refused());
            }
            let offset = source["offset"].as_u64().ok_or_else(refused)?;
            let end = source["end"].as_u64().ok_or_else(refused)?;
            let length = end
                .checked_sub(offset)
                .filter(|n| *n > 0 && *n <= self.settings.client.transcript_row_bytes)
                .ok_or_else(refused)?;
            let cache_key = (path.clone(), offset, length);
            let bytes = match cache.get(&cache_key) {
                Some(bytes) => std::sync::Arc::clone(bytes),
                None => {
                    proof_bytes = proof_bytes
                        .checked_add(length)
                        .filter(|n| *n <= self.settings.client.transcript_row_bytes)
                        .ok_or_else(refused)?;
                    let bytes = std::sync::Arc::new(
                        read_occurrence(&path, offset, length).ok_or_else(refused)?,
                    );
                    cache.insert(cache_key, bytes.clone());
                    bytes
                }
            };
            let head_length = std::fs::metadata(&path)
                .map_err(|_| refused())?
                .len()
                .min(self.settings.client.head_bytes);
            let head_digest = head_digest(&path, head_length).ok_or_else(refused)?;
            let row = serde_json::from_slice(bytes.as_slice()).map_err(|_| refused())?;
            // Carried model is a bounded caller claim, never authenticated actor evidence.
            let mut context = Map::new();
            if let Some(model) = receipt["claimed"].get("model") {
                context.insert("model".into(), model.clone());
            }
            if !self
                .execution_observations(&row, harness, &session, &context)?
                .contains(receipt)
            {
                return Err(refused());
            }
            verified.push(Verified {
                receipt: receipt.clone(),
                registration: registration.clone(),
                registration_kind: registration_kind.clone(),
                max_references: self.settings.execution_references["max_references"]
                    .as_u64()
                    .ok_or_else(refused)? as usize,
                max_id_chars: self.settings.execution_references["max_id_chars"]
                    .as_u64()
                    .ok_or_else(refused)? as usize,
                max_bytes: self.settings.execution_references["max_bytes"]
                    .as_u64()
                    .ok_or_else(refused)? as usize,
                path,
                offset,
                bytes,
                head_length,
                head_digest,
            });
        }
        Ok(verified)
    }
}
fn selected_fn<'a>(v: &'a Value, p: &Value) -> Option<&'a Value> {
    selected(v, p)
}

impl HookRoutes {
    pub(super) fn prepare_executions(
        &self,
        harness: &Harness,
        event: &Value,
        computer: &Computer,
    ) -> Option<(Vec<Value>, (String, transcript::Cursor))> {
        if harness.executions.is_empty() {
            return None;
        }
        let path = std::fs::canonicalize(self.transcript_of(event, computer)?).ok()?;
        if transcript::harness_holding(
            &path,
            &self.settings.harnesses,
            computer.env,
            computer.home.as_deref(),
        )
        .map(|h| &h.id)
            != Some(&harness.id)
        {
            return None;
        }
        let session = self.session_of(event).or_else(|| {
            transcript::session_of_transcript(
                &path,
                &self.settings.harnesses,
                self.settings.client.head_bytes,
            )
        })?;
        let folder = self.cursor_folder(computer)?;
        let kept = transcript::read_json::<transcript::Cursor>(&transcript::cursor_path(
            &folder,
            &session,
            ".executions.json",
        ))
        .filter(|c| {
            std::path::Path::new(&c.transcript) == path
                && c.offset <= std::fs::metadata(&path).ok().map_or(0, |m| m.len())
        })
        .unwrap_or_default();
        let page = transcript::rows_from(
            &path,
            kept.offset,
            self.settings.client.transcript_read_bytes,
            self.settings.client.transcript_row_bytes,
        )
        .ok()?;
        if page.blocked {
            return None;
        }
        let mut known = kept.context;
        let mut executions = Vec::new();
        let mut start = kept.offset;
        let mut offset = kept.offset;
        for (row, end) in page.rows.iter().zip(&page.ends) {
            let end = (*end)?;
            let mut next_context = known.clone();
            transcript::carried_context(row, harness, &mut next_context);
            let found = self
                .execution_observations(row, harness, &session, &next_context)
                .ok()?;
            if executions.len() + found.len() > self.settings.client.most_executions {
                break;
            }
            known = next_context;
            for receipt in found {
                executions.push(json!({"receipt":receipt,"source":{"transcript_path":path,"offset":start,"end":end}}));
            }
            offset = end;
            start = end;
        }
        Some((
            executions,
            (
                session,
                transcript::Cursor {
                    transcript: path.to_string_lossy().into_owned(),
                    offset,
                    harness: Some(harness.id.clone()),
                    context: known,
                    ..Default::default()
                },
            ),
        ))
    }
    pub(super) fn settle_executions(
        &self,
        prepared: &Prepared,
        answer: &Value,
        computer: &Computer,
    ) {
        let Some((session, cursor)) = &prepared.execution_advance else {
            return;
        };
        let Some(sent) = prepared.input["executions"].as_array() else {
            return;
        };
        let Some(accepted) = answer["executions_accepted"]
            .as_array()
            .filter(|a| a.len() == sent.len())
        else {
            return;
        };
        if !sent.iter().zip(accepted).all(|(a, b)| {
            a["receipt"]["call_id"] == b["call_id"]
                && a["receipt"]["event_phase"] == b["event_phase"]
        }) {
            return;
        }
        if let Some(folder) = self.cursor_folder(computer) {
            let _ = transcript::write_json(
                &transcript::cursor_path(&folder, session, ".executions.json"),
                cursor,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/account_hook_observations.rs"
    ));
}
