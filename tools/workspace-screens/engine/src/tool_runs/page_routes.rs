// src/tool_runs/page_routes.rs
//
// Purpose: What a page route answered by running Workshop tools draws from their runs, with no route, tool or screen
// named here. Two owners use it (src/local_workspace.rs, which runs the tools for the page's account):
//   - the generic screen host's one screen, GET /work/api/screens/<id> (owner-routes.json `screen-host`): ported one to
//     one from old trillion src/screen-host.mjs handleScreenHost's `/screens/<id>` path and describe() (lines 39-75),
//     src/screen-layout.mjs drawLayout (whole) and src/narrowed-screen.mjs narrowedTo (whole), at
//     old-trillion-before-worker-retire. The screen is the account's Workshop row whose id is the screen's tool id. A
//     `reads` screen ({reads: [{id, tool, input}], shown_when, layout}) runs each read as that tool's run and draws its
//     layout from what they answered, narrowed to what the address asks for; any other screen answers its catalogue
//     row as {surface}; a screen in neither answers 404 {error: "Not found"}.
//   - the `@workshop-routes` family (src/server/tool-routes.json): the tool's result {status, body} is the answer.
//
// Dropped from the old screen host, and why:
//   - withBackingAutomations (src/backing-automations.mjs): it read the person's rules and schedules through the old
//     records resource's automations routes, which the engine does not have (no feature in the engine, the owner
//     2026-10-29 3:00 PM); a screen whose rows name what backs them gets that from its own reads.
//   - the reads run one after another, not at once (Promise.all): each is one tool run of a bounded page request, and
//     the answer is the same.
//   - a read is a run of the account's Workshop (src/tool_runs/tools.rs), whose run journal keeps each run once per
//     request key; old askInMemory kept nothing.
//
// Non-Negotiable Invariants:
//   1. Every computed value is a formula-engine binding evaluated by the one compiled evaluator
//      (tools/formula-engine/crates/formula-engine evaluate_with, the evaluator old src/formula-evaluate.mjs loaded); this only
//      places what it answers, plus the four structural nodes (each, choose, join, apply) drawLayout adds.
//   2. A field whose value is null is left out of a description; a list leaves out its null items.
//   3. Every word, field and kind is DATA (page_routes/screen-host.json); nothing here names a screen, read or field.
//   4. A read or layout that fails answers 502 with its words, as old describe() did; a shown_when that is not true
//      answers 404.
//
// AI Assistant Directive: keep this a one to one port; a behaviour the old files did not have does not belong here.

use crate::workspace::WorkspaceError;
use crate::refusal_cause::CodedError;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

#[cfg(test)]
mod tests;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    pub(crate) tool_prefix: String,
    screen_field: String,
    screen_kind_field: String,
    reads_kind: String,
    kind_field: String,
    reads: Reads,
    pub(crate) surface_field: String,
    pub(crate) surface_id: String,
    not_found: Value,
    error_field: String,
    pub(crate) most_catalogue_pages: usize,
    route: Route,
    layout: Layout,
    narrowed: Narrowed,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reads {
    list: String,
    id: String,
    tool: String,
    input: String,
    shown_when: String,
    layout: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Route {
    /// The field of a route tool's input that holds the page's admitted account (Round 2 contract B).
    account_id: String,
    status: String,
    body: String,
    result: String,
    error: String,
    not_an_answer: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Layout {
    binding: String,
    each: String,
    each_of: String,
    each_as: String,
    choose: String,
    choose_when: String,
    choose_then: String,
    choose_else: String,
    join: String,
    join_of: String,
    apply: String,
    apply_to: String,
    transform: String,
    args: String,
    apply_binding: Map<String, Value>,
    apply_value: String,
    not_a_list: String,
    context: Context,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Context {
    query: String,
    browser: String,
    /// The page's admitted account, a field every read's input and the layout may bind (Round 2 contract B).
    account_id: String,
    reads: String,
    item: String,
    index: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Narrowed {
    show_section: String,
    show_row: String,
    sections: String,
    rows: String,
    id: String,
    title: String,
    children: String,
    starts_open: String,
    catalog: String,
    lead: String,
    hide_header: String,
    narrowed: String,
    login_prefix: String,
    login_names: Vec<Vec<String>>,
    login_site: Vec<String>,
    quotes: String,
    most_depth: usize,
    words: Value,
}

const DATA: &str = include_str!("page_routes/screen-host.json");

/// The screen host's words, read once.
pub(crate) fn settings() -> Result<&'static Settings, WorkspaceError> {
    static SETTINGS: OnceLock<Option<Settings>> = OnceLock::new();
    SETTINGS
        .get_or_init(|| serde_json::from_str(DATA).ok())
        .as_ref()
        .ok_or(crate::cause!(WorkspaceError::Integrity))
}

/// One screen asked for: its tool id and the address's query as name/value pairs, in order (URLSearchParams).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ScreenAsk {
    pub tool_id: String,
    pub query: Vec<(String, String)>,
    pub browser: Value,
    /// The page's admitted account: the account whose page the reads run for, set by the owner that admitted the page
    /// (src/local_workspace.rs `screen`), never from the address.
    pub account_id: String,
}

/// The screen a `/screens/<rest>` request names (screen-host.mjs:47-50): `rest` decoded as decodeURIComponent, a
/// screen id that is empty or holds `/` is none (404), and the id is its tool id (`tool_prefix` added when missing).
pub(crate) fn screen_tool_id(settings: &Settings, rest: &str) -> Option<String> {
    let id = crate::workspace_domain::decode(rest, false).ok()?;
    if id.is_empty() || id.contains('/') {
        return None;
    }
    Some(if id.starts_with(&settings.tool_prefix) {
        id
    } else {
        format!("{}{id}", settings.tool_prefix)
    })
}

/// A query's name/value pairs, decoded as URLSearchParams does.
pub(crate) fn query_pairs(query: &str) -> Result<Vec<(String, String)>, WorkspaceError> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            Ok((
                crate::workspace_domain::decode(name, true)?,
                crate::workspace_domain::decode(value, true)?,
            ))
        })
        .collect()
}

/// Object.fromEntries(URLSearchParams): each name once, its last value.
pub(crate) fn query_object(pairs: &[(String, String)]) -> Value {
    let mut out = Map::new();
    for (name, value) in pairs {
        out.insert(name.clone(), Value::String(value.clone()));
    }
    Value::Object(out)
}

/// URLSearchParams.get: the first value of `name`.
fn first<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// The screen a Workshop row carries (`screen_field`), when it is a `reads` screen.
pub(crate) fn reads_screen<'a>(settings: &Settings, row: &'a Value) -> Option<&'a Value> {
    let screen = row.get(&settings.screen_field)?;
    (screen
        .get(&settings.screen_kind_field)
        .and_then(Value::as_str)
        == Some(settings.reads_kind.as_str()))
    .then_some(screen)
}

/// What one screen request answers: its status and JSON body.
#[derive(Debug, PartialEq)]
pub(crate) struct Answer {
    pub status: u16,
    pub body: Value,
}

/// 404 {error: "Not found"} (screen-host.mjs NOT_FOUND).
#[track_caller]
pub(crate) fn not_found(settings: &Settings) -> Answer {
    let mut body = match settings.not_found.clone() {
        Value::Object(fields) => fields,
        words => Map::from_iter([(settings.error_field.clone(), words)]),
    };
    let cause = crate::cause!(caller_site: page_route_not_found);
    body.insert("cause".into(), json!(cause.id()));
    crate::quiet_eprintln!("door-refusal code=workshop_page_not_found cause={cause}");
    Answer { status: 404, body: Value::Object(body) }
}

/// A failure's words as the screen host answers them: 502 {error} (screen-host.mjs:72-73).
fn failed(settings: &Settings, words: CodedError<String>) -> Answer {
    crate::quiet_eprintln!("door-refusal code=workshop_page_failed cause={}", words.cause());
    let mut body = Map::new();
    body.insert("cause".into(), Value::String(words.cause().id()));
    body.insert(settings.error_field.clone(), Value::String(words.code));
    Answer {
        status: 502,
        body: Value::Object(body),
    }
}

/// A non-reads screen's answer: its catalogue row as {surface}, or 404 (screen-host.mjs:54-55).
pub(crate) fn surface_answer(settings: &Settings, surface: Option<Value>) -> Answer {
    match surface {
        Some(surface) => {
            let mut body = Map::new();
            body.insert(settings.surface_field.clone(), surface);
            Answer {
                status: 200,
                body: Value::Object(body),
            }
        }
        None => not_found(settings),
    }
}

/// A reads screen's description (screen-host.mjs describe, lines 60-75): each read is `read(tool, input)`, its input
/// drawn from the address's query and the asking browser; `shown_when`, when the screen has one, must draw `true`, else
/// 404; the layout is drawn from what the reads answered and narrowed to what the address asks for. A read or a
/// layout that fails answers 502 with its words.
pub(crate) fn describe(
    settings: &Settings,
    screen: &Value,
    ask: &ScreenAsk,
    read: &mut dyn FnMut(&str, &Value) -> Result<Value, CodedError<String>>,
) -> Answer {
    match described(settings, screen, ask, read) {
        Ok(Some(description)) => Answer {
            status: 200,
            body: description,
        },
        Ok(None) => not_found(settings),
        Err(words) => failed(settings, words),
    }
}

fn described(
    settings: &Settings,
    screen: &Value,
    ask: &ScreenAsk,
    read: &mut dyn FnMut(&str, &Value) -> Result<Value, CodedError<String>>,
) -> Result<Option<Value>, CodedError<String>> {
    let names = &settings.layout.context;
    let mut context = Map::new();
    context.insert(names.query.clone(), query_object(&ask.query));
    context.insert(names.browser.clone(), ask.browser.clone());
    context.insert(
        names.account_id.clone(),
        Value::String(ask.account_id.clone()),
    );
    let context = Value::Object(context);
    let fields = &settings.reads;
    let empty = Vec::new();
    let reads = match screen.get(&fields.list) {
        None | Some(Value::Null) => &empty,
        Some(Value::Array(reads)) => reads,
        Some(_) => return Err(CodedError::new(settings.layout.not_a_list.clone())),
    };
    let mut answered = Map::new();
    for one in reads {
        let tool = one
            .get(&fields.tool)
            .and_then(Value::as_str)
            .unwrap_or_default();
        let given = match one.get(&fields.input) {
            None | Some(Value::Null) => json!({}),
            Some(input) => input.clone(),
        };
        let input = draw_layout(settings, &given, &context)?;
        let value = read(tool, &input)?;
        let id = match one.get(&fields.id) {
            Some(Value::String(id)) => id.clone(),
            Some(other) => js_text(other),
            None => "undefined".to_owned(),
        };
        answered.insert(id, value);
    }
    let mut drawn_from = context.as_object().cloned().unwrap_or_default();
    drawn_from.insert(names.reads.clone(), Value::Object(answered));
    let drawn_from = Value::Object(drawn_from);
    if let Some(shown_when) = screen.get(&fields.shown_when) {
        if draw_layout(settings, shown_when, &drawn_from)? != Value::Bool(true) {
            return Ok(None);
        }
    }
    let layout = screen.get(&fields.layout).cloned().unwrap_or(Value::Null);
    let description = draw_layout(settings, &layout, &drawn_from)?;
    Ok(Some(narrowed_to(settings, description, &ask.query)))
}

// ---------------------------------------------------------------------------------------------------------------
// src/screen-layout.mjs, one to one.
// ---------------------------------------------------------------------------------------------------------------

fn kind_of<'a>(settings: &Settings, value: &'a Value) -> Option<&'a str> {
    value.as_object()?.get(&settings.kind_field)?.as_str()
}
fn is_binding(settings: &Settings, value: &Value) -> bool {
    kind_of(settings, value) == Some(settings.layout.binding.as_str())
}
fn structural(settings: &Settings, value: &Value) -> bool {
    let layout = &settings.layout;
    kind_of(settings, value).is_some_and(|kind| {
        [&layout.each, &layout.choose, &layout.join, &layout.apply]
            .iter()
            .any(|name| *name == kind)
    })
}

/// Every binding and structural node inside a transform's arguments replaced by its value in `context` (resolvedArgs).
fn resolved_args(settings: &Settings, value: &Value, context: &Value) -> Result<Value, CodedError<String>> {
    if is_binding(settings, value) {
        return evaluate_binding(settings, value, context);
    }
    if structural(settings, value) {
        return draw_layout(settings, value, context);
    }
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| resolved_args(settings, item, context))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(fields) => {
            let mut out = Map::new();
            for (key, item) in fields {
                out.insert(key.clone(), resolved_args(settings, item, context)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

/// One binding's value in `context`, its transform's arguments resolved first (evaluateBinding); undefined is null.
fn evaluate_binding(
    settings: &Settings,
    binding: &Value,
    context: &Value,
) -> Result<Value, CodedError<String>> {
    let layout = &settings.layout;
    let mut binding = binding
        .as_object()
        .cloned()
        .ok_or_else(|| CodedError::new(layout.not_a_list.clone()))?;
    if let Some(Value::Array(steps)) = binding.get(&layout.transform).cloned() {
        let mut resolved = Vec::with_capacity(steps.len());
        for step in steps {
            match step.as_object().and_then(|fields| fields.get(&layout.args)) {
                Some(args) => {
                    let mut step = step.as_object().cloned().unwrap_or_default();
                    let args = resolved_args(settings, args, context)?;
                    step.insert(layout.args.clone(), args);
                    resolved.push(Value::Object(step));
                }
                None => resolved.push(step),
            }
        }
        binding.insert(layout.transform.clone(), Value::Array(resolved));
    }
    evaluate(Value::Object(binding), context)
}

/// The compiled formula evaluator (old src/formula-evaluate.mjs evaluateFormula(binding, input)).
fn evaluate(binding: Value, input: &Value) -> Result<Value, CodedError<String>> {
    use formula_engine::{evaluate_with, guards::now_ms, ready};
    ready(&binding)
        .and_then(|prepared| evaluate_with(&prepared, input.clone(), &now_ms))
        .map_err(|refused| CodedError::new(refused.message().to_owned()))
}

/// `layout` with every binding evaluated against `context` (drawLayout).
pub(crate) fn draw_layout(
    settings: &Settings,
    layout: &Value,
    context: &Value,
) -> Result<Value, CodedError<String>> {
    let names = &settings.layout;
    if is_binding(settings, layout) {
        return evaluate_binding(settings, layout, context);
    }
    let fields = match layout {
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                let drawn = draw_layout(settings, item, context)?;
                if !drawn.is_null() {
                    out.push(drawn);
                }
            }
            return Ok(Value::Array(out));
        }
        Value::Object(fields) => fields,
        other => return Ok(other.clone()),
    };
    let kind = kind_of(settings, layout);
    let null = Value::Null;
    if kind == Some(names.each.as_str()) {
        let items = evaluate_binding(
            settings,
            fields.get(&names.each_of).unwrap_or(&null),
            context,
        )?;
        let items = match items {
            Value::Null => return Ok(Value::Array(Vec::new())),
            Value::Array(items) => items,
            _ => return Err(CodedError::new(names.not_a_list.clone())),
        };
        let shape = fields.get(&names.each_as).unwrap_or(&null);
        let mut out = Vec::new();
        for (index, item) in items.into_iter().enumerate() {
            let mut each = context.as_object().cloned().unwrap_or_default();
            each.insert(names.context.item.clone(), item);
            each.insert(names.context.index.clone(), json!(index));
            let drawn = draw_layout(settings, shape, &Value::Object(each))?;
            if !drawn.is_null() {
                out.push(drawn);
            }
        }
        return Ok(Value::Array(out));
    }
    if kind == Some(names.choose.as_str()) {
        let when = evaluate_binding(
            settings,
            fields.get(&names.choose_when).unwrap_or(&null),
            context,
        )?;
        let chosen = if when == Value::Bool(true) {
            fields.get(&names.choose_then)
        } else {
            fields.get(&names.choose_else)
        };
        return match chosen {
            None => Ok(Value::Null),
            Some(chosen) => draw_layout(settings, chosen, context),
        };
    }
    if kind == Some(names.apply.as_str()) {
        let value = draw_layout(
            settings,
            fields.get(&names.apply_to).unwrap_or(&null),
            context,
        )?;
        let mut applied = context.as_object().cloned().unwrap_or_default();
        applied.insert(names.apply_value.clone(), value);
        let mut binding = names.apply_binding.clone();
        binding.insert(
            names.transform.clone(),
            fields.get(&names.transform).cloned().unwrap_or(Value::Null),
        );
        return evaluate_binding(settings, &Value::Object(binding), &Value::Object(applied));
    }
    if kind == Some(names.join.as_str()) {
        let parts = match fields.get(&names.join_of) {
            Some(Value::Array(parts)) => parts,
            _ => return Err(CodedError::new(names.not_a_list.clone())),
        };
        let mut out = Vec::new();
        for part in parts {
            match draw_layout(settings, part, context)? {
                Value::Null => {}
                Value::Array(items) => out.extend(items),
                drawn => out.push(drawn),
            }
        }
        return Ok(Value::Array(out));
    }
    let mut drawn = Map::new();
    for (key, value) in fields {
        let placed = draw_layout(settings, value, context)?;
        if !placed.is_null() {
            drawn.insert(key.clone(), placed);
        }
    }
    Ok(Value::Object(drawn))
}

// ---------------------------------------------------------------------------------------------------------------
// src/narrowed-screen.mjs, one to one.
// ---------------------------------------------------------------------------------------------------------------

/// String(value): how a JavaScript value reads as text.
fn js_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_text(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}
/// String(text ?? ''), trimmed, its surrounding quotes and spaces cut, in lowercase (unquoted).
fn unquoted(settings: &Settings, text: Option<&Value>) -> String {
    let text = match text {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_text(value),
    };
    let cut = |c: char| c.is_whitespace() || settings.narrowed.quotes.contains(c);
    text.trim().trim_matches(cut).to_lowercase()
}
/// Every name an address asks for: the whole value and each comma separated part, unquoted, once each (askedFor).
fn asked_for(settings: &Settings, value: Option<&str>) -> Vec<String> {
    let whole = value.unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    let as_value = |text: &str| Value::String(text.to_owned());
    for name in std::iter::once(unquoted(settings, Some(&as_value(whole)))).chain(
        whole
            .split(',')
            .map(|part| unquoted(settings, Some(&as_value(part)))),
    ) {
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}
fn at<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |value, key| value.as_object()?.get(key))
}
/// A site's host, without `www.`, in lowercase; empty when it is no address (hostOfSite).
fn host_of_site(site: &str) -> String {
    let schemed = {
        let mut chars = site.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && site.find(':').is_some_and(|colon| {
                site[1..colon]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
            })
    };
    let address = if schemed {
        site.to_owned()
    } else {
        format!("https://{site}")
    };
    match url::Url::parse(&address) {
        Ok(parsed) => {
            let host = parsed.host_str().unwrap_or_default().to_lowercase();
            host.strip_prefix("www.").map(str::to_owned).unwrap_or(host)
        }
        Err(_) => String::new(),
    }
}
/// The names a row is asked for by: its title and id, and a saved login's pick, user, site and site host (rowNames).
fn row_names(settings: &Settings, row: &Value) -> Vec<String> {
    let names = &settings.narrowed;
    let login = row
        .get(&names.id)
        .and_then(Value::as_str)
        .is_some_and(|id| id.starts_with(&names.login_prefix));
    let mut out = vec![
        unquoted(settings, row.get(&names.title)),
        unquoted(settings, row.get(&names.id)),
    ];
    if login {
        for path in &names.login_names {
            out.push(unquoted(settings, at(row, path)));
        }
        let site = match at(row, &names.login_site) {
            None | Some(Value::Null) => String::new(),
            Some(site) => js_text(site),
        };
        out.push(unquoted(
            settings,
            Some(&Value::String(host_of_site(&site))),
        ));
    }
    out.retain(|name| !name.is_empty());
    out
}
fn with_open(settings: &Settings, row: &Value, children: Option<Vec<Value>>) -> Value {
    let mut row = row.as_object().cloned().unwrap_or_default();
    if let Some(children) = children {
        row.insert(settings.narrowed.children.clone(), Value::Array(children));
    }
    row.insert(settings.narrowed.starts_open.clone(), Value::Bool(true));
    Value::Object(row)
}
/// The rows asked for, each reached through its real ancestors, opened (matchingRows).
fn matching_rows(
    settings: &Settings,
    rows: &[Value],
    names: &[String],
    depth: usize,
) -> Vec<Value> {
    if depth > settings.narrowed.most_depth {
        return Vec::new();
    }
    rows.iter()
        .filter_map(|row| {
            if row_names(settings, row)
                .iter()
                .any(|name| names.contains(name))
            {
                return Some(with_open(settings, row, None));
            }
            let children = match row.get(&settings.narrowed.children) {
                Some(Value::Array(children)) => matching_rows(settings, children, names, depth + 1),
                _ => Vec::new(),
            };
            (!children.is_empty()).then(|| with_open(settings, row, Some(children)))
        })
        .collect()
}

/// One screen's description narrowed to what the address asks for (`show_section`, `show_row`): narrowedTo.
pub(crate) fn narrowed_to(
    settings: &Settings,
    description: Value,
    query: &[(String, String)],
) -> Value {
    let names = &settings.narrowed;
    let sections = asked_for(settings, first(query, &names.show_section));
    let rows = asked_for(settings, first(query, &names.show_row));
    if sections.is_empty() && rows.is_empty() {
        return description;
    }
    let all: Vec<Value> = match description.get(&names.sections) {
        Some(Value::Array(all)) => all.clone(),
        _ => Vec::new(),
    };
    let found: Vec<Value> = if sections.is_empty() {
        Vec::new()
    } else {
        all.iter()
            .filter(|section| sections.contains(&unquoted(settings, section.get(&names.id))))
            .cloned()
            .collect()
    };
    let kept: Vec<Value> = (if found.is_empty() { &all } else { &found })
        .iter()
        .map(|section| match section.get(&names.rows) {
            Some(Value::Array(section_rows)) if !rows.is_empty() => {
                let mut plain = section.as_object().cloned().unwrap_or_default();
                plain.remove(&names.catalog);
                plain.insert(
                    names.rows.clone(),
                    Value::Array(matching_rows(settings, section_rows, &rows, 0)),
                );
                Value::Object(plain)
            }
            _ => section.clone(),
        })
        .filter(|section| {
            rows.is_empty()
                || section
                    .get(&names.rows)
                    .and_then(Value::as_array)
                    .is_some_and(|rows| !rows.is_empty())
        })
        .collect();
    let shown = if kept.is_empty() { found.clone() } else { kept };
    if shown.is_empty() || (rows.is_empty() && found.is_empty()) {
        return description;
    }
    let mut rest = description.as_object().cloned().unwrap_or_default();
    rest.remove(&names.lead);
    rest.insert(names.hide_header.clone(), Value::Bool(true));
    rest.insert(names.narrowed.clone(), names.words.clone());
    rest.insert(names.sections.clone(), Value::Array(shown));
    Value::Object(rest)
}

// ---------------------------------------------------------------------------------------------------------------
// The @workshop-routes family's answer.
// ---------------------------------------------------------------------------------------------------------------

/// The answer of a Workshop route tool's run (src/server/tool-routes.json): the run's selected result
/// {status, body} is the page's answer. A run that failed, or a result that is not {status, body} with a status a
/// response may carry, answers 502 with its words, as a screen read that fails does.
/// A Workshop route tool's input with the page's admitted account in it (`route.account_id`, Round 2 contract B):
/// set by the engine over whatever the request held, so no address or body can name another account.
pub(crate) fn with_account(settings: &Settings, mut request: Value, account: &str) -> Value {
    if let Some(fields) = request.as_object_mut() {
        fields.insert(
            settings.route.account_id.clone(),
            Value::String(account.to_owned()),
        );
    }
    request
}

pub(crate) fn route_answer(settings: &Settings, ran: Result<Value, CodedError<String>>, invalid_cause: Option<crate::refusal_cause::Cause>) -> Answer {
    let result = match ran {
        Ok(result) => result,
        Err(words) => return failed(settings, words),
    };
    let route = &settings.route;
    let status = result
        .get(&route.status)
        .and_then(Value::as_u64)
        .filter(|status| (200..=599).contains(status));
    match (status, result.get(&route.body)) {
        (Some(status), Some(body)) => Answer {
            status: status as u16,
            body: body.clone(),
        },
        _ => failed(settings, CodedError::with_cause(route.not_an_answer.clone(), invalid_cause.unwrap_or_else(|| crate::cause!(condition: route_result_not_an_http_answer)))),
    }
}

/// What one finished run answered (src/tool_runs/tools.rs `Ran::answer`): its selected `result`, or its `error` words.
pub(crate) fn run_result(settings: &Settings, answer: &Value) -> Result<Value, CodedError<String>> {
    let route = &settings.route;
    if let Some(error) = answer.get(&route.error) {
        return Err(CodedError::new(match error {
            Value::String(words) => words.clone(),
            other => other.to_string(),
        }));
    }
    answer
        .get(&route.result)
        .cloned()
        .ok_or_else(|| CodedError::new(route.not_an_answer.clone()))
}
