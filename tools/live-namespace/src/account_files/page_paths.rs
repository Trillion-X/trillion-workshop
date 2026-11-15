// src/account_files/page_paths.rs
//
// Purpose: The page paths old trillion's signed-in page called, each answered by one operation of a door, as that
// door's own DATA names them (`old_paths` in src/account_files/account-files-routes.json and
// src/record_value/records-routes.json). Old trillion's page reached the person's files at /work/api/namespace/* and
// /work/api/recent-files, and one record at /work/api/records/<id> (Trillion-X/trillion tag
// old-trillion-before-worker-retire: src/worker.mjs:824-827 handed every /work/api/namespace/* path to the account's
// Namespace owner, src/namespace.mjs:2107 handleNamespaceApi and src/namespace-results.mjs:465 handleResultsApi
// answered it; src/work-media.mjs:88-94 answered /recent-files; src/own-resource-compatibility.mjs:276-277 made
// GET /records/<id> the `records:read` command). Old src/file-tools.mjs:125-166 was the AI's tool over each of those
// same paths (list_files called POST /namespace/listing {collection: folder, after, limit}, and so on), and the
// doors' operations are the ports of those tools; so a row here is that tool's call read backwards: the old path and
// the input as the old route took it, made into the operation and the input the tool gave it.
//
// Non-Negotiable Invariants:
// - No path, field or operation is named here: every one is the door's DATA. A row names its method, its path (a
//   `{name}` segment takes one whole non-empty segment, percent-decoded), the exact paths it does not take (`unless`),
//   the operation, and each input field's source.
// - A source reads only what the old route read: a field of the JSON body, the body itself, a query value (the
//   first, as URLSearchParams.get; `:number` makes it a whole number and leaves it out when it is not one, as old
//   `Number(x) || default` did), a path segment, or a constant. An absent source leaves the field out, so the door's
//   own refusal of a missing field is the answer, as the old route's refusal was.
// - A row admits nothing: the page's session admits the call before the door runs it, as for every page call.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::refusal_cause::CodedError;
use serde::Deserialize;
use serde_json::{Map, Value};

/// One old page path and the door operation that answers it.
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct OldPath {
    /// GET or POST.
    method: String,
    /// The path after /work/api, `{name}` segments taking one segment each.
    path: String,
    /// Exact paths this row's pattern would take but leaves to another owner (old trillion answered them elsewhere).
    #[serde(default)]
    unless: Vec<String>,
    /// The pattern a `{name}` segment must match, when the old route refused another (a GET of
    /// /namespace/files/<x> answered 400 unless x was a content identity, so a file name never travels in a URL:
    /// old src/namespace.mjs:2318-2321, test/namespace-no-name-in-urls.test.mjs). A segment that does not match is
    /// refused.
    #[serde(default)]
    segments: std::collections::BTreeMap<String, String>,
    #[serde(skip)]
    patterns: std::sync::OnceLock<Option<Vec<(String, regex::Regex)>>>,
    /// The door operation.
    operation: String,
    /// Each input field and where it comes from: "body", "body:<field>", "query:<name>", "query:<name>:number",
    /// "path:<name>", a list of those (the first present), or {"value": <constant>}.
    #[serde(default)]
    input: Map<String, Value>,
}

/// One door's old page paths, in order: the first row whose method and path match answers.
#[derive(Deserialize, Debug, Default)]
#[serde(transparent)]
pub struct OldPaths(Vec<OldPath>);

/// Where one input field comes from.
enum Source<'a> {
    Body,
    BodyField(&'a str),
    Query(&'a str, bool),
    Segment(&'a str),
    Constant(&'a Value),
}

fn source(text: &str) -> Option<Source<'_>> {
    if text == "body" {
        return Some(Source::Body);
    }
    let (place, rest) = text.split_once(':')?;
    if rest.is_empty() {
        return None;
    }
    match place {
        "body" => Some(Source::BodyField(rest)),
        "path" => Some(Source::Segment(rest)),
        "query" => match rest.split_once(':') {
            None => Some(Source::Query(rest, false)),
            Some((name, "number")) if !name.is_empty() => Some(Source::Query(name, true)),
            _ => None,
        },
        _ => None,
    }
}

/// The sources of one field, in the order they are tried.
fn sources(given: &Value) -> Option<Vec<Source<'_>>> {
    match given {
        Value::String(text) => Some(vec![source(text)?]),
        Value::Array(texts) if !texts.is_empty() => texts.iter().map(|text| text.as_str().and_then(source)).collect(),
        Value::Object(constant) if constant.len() == 1 => constant.get("value").map(|value| vec![Source::Constant(value)]),
        _ => None,
    }
}

fn decode(text: &str, form: bool) -> Result<String, CodedError<()>> {
    crate::workspace_domain::decode(text, form).map_err(|error| CodedError::with_cause((), error.cause()))
}

impl OldPath {
    /// The compiled `segments` patterns, each anchored to the whole segment; none when one does not compile.
    fn patterns(&self) -> Option<&[(String, regex::Regex)]> {
        self.patterns.get_or_init(|| self.segments.iter()
            .map(|(name, pattern)| regex::Regex::new(&format!("^(?:{pattern})$")).ok().map(|compiled| (name.clone(), compiled)))
            .collect()).as_deref()
    }

    fn valid(&self, answers: &dyn Fn(&str) -> bool) -> bool {
        let segments: Vec<&str> = self.path.split('/').skip(1).collect();
        let names: Vec<&str> = segments.iter().filter_map(|segment| segment.strip_prefix('{').and_then(|rest| rest.strip_suffix('}'))).collect();
        matches!(self.method.as_str(), "GET" | "POST")
            && self.path.starts_with('/')
            && !self.path.contains('?')
            && segments.iter().all(|segment| !segment.is_empty())
            && names.iter().all(|name| !name.is_empty())
            && self.unless.iter().all(|path| path.starts_with('/'))
            && self.segments.keys().all(|name| names.contains(&name.as_str()))
            && self.patterns().is_some()
            && answers(&self.operation)
            && self.input.values().all(|given| sources(given).is_some_and(|sources| sources.iter().all(|source| match source {
                Source::Segment(name) => names.contains(name),
                // A GET has no body.
                Source::Body | Source::BodyField(_) => self.method == "POST",
                _ => true,
            })))
    }

    /// The `{name}` segments of `path` when it is this row's path.
    fn captures(&self, path: &str) -> Result<Option<Map<String, Value>>, CodedError<()>> {
        if self.unless.iter().any(|unless| unless == path) {
            return Ok(None);
        }
        let (want, have): (Vec<&str>, Vec<&str>) = (self.path.split('/').collect(), path.split('/').collect());
        if want.len() != have.len() {
            return Ok(None);
        }
        let mut captured = Map::new();
        for (want, have) in want.iter().zip(&have) {
            match want.strip_prefix('{').and_then(|rest| rest.strip_suffix('}')) {
                Some(_) if have.is_empty() => return Ok(None),
                Some(name) => {
                    let segment = decode(have, false)?;
                    let patterns = self.patterns().ok_or_else(|| CodedError::new(()))?;
                    if patterns.iter().any(|(named, pattern)| named == name && !pattern.is_match(&segment)) {
                        return Err(CodedError::new(()));
                    }
                    captured.insert((*name).to_owned(), Value::String(segment));
                }
                None if want == have => {}
                None => return Ok(None),
            }
        }
        Ok(Some(captured))
    }
}

impl OldPaths {
    /// Whether every row is well formed and names an operation `answers` takes.
    pub fn valid(&self, answers: &dyn Fn(&str) -> bool) -> bool {
        self.0.iter().all(|row| row.valid(answers))
    }

    /// The door call one old page request is: `None` when no row takes this method and path (the door's own page
    /// road continues), else the operation and the input the row makes, or a refusal of a path or query that does not
    /// decode. `target` is the path after /work/api with its query; `body` is the JSON body of a POST.
    pub fn call(&self, method: &str, target: &str, body: Option<&Value>) -> Option<Result<(String, Value), CodedError<()>>> {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        for row in self.0.iter().filter(|row| row.method == method) {
            match row.captures(path) {
                Err(error) => return Some(Err(error)),
                Ok(None) => continue,
                Ok(Some(captured)) => return Some(row.input_of(&captured, query, body).map(|input| (row.operation.clone(), input))),
            }
        }
        None
    }

    /// Whether `target` (the path after /work/api, with its query) lies under a first path segment one of these rows
    /// names while no row, under any method, takes its path: such a path was old trillion's page road to this door
    /// alone, and nothing here ports it, so the door has no owner for it (404 no-owner) rather than reading its last
    /// segment as one of the door's own operations. A path a row takes under another method is still this door's
    /// (refused, as old trillion refused it); a path under another first segment (the door's own page road) is left
    /// to the door.
    pub fn unported(&self, target: &str) -> bool {
        let first = |path: &str| path.trim_start_matches('/').split(['/', '?']).next().unwrap_or_default().to_owned();
        let asked = first(target);
        let path = target.split_once('?').map_or(target, |(path, _)| path);
        !asked.is_empty()
            && self.0.iter().any(|row| first(&row.path) == asked)
            && self.0.iter().all(|row| matches!(row.captures(path), Ok(None)))
    }
}

impl OldPath {
    fn input_of(&self, captured: &Map<String, Value>, query: &str, body: Option<&Value>) -> Result<Value, CodedError<()>> {
        let mut asked: Vec<(String, String)> = Vec::new();
        for pair in query.split('&').filter(|pair| !pair.is_empty()) {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            asked.push((decode(name, true)?, decode(value, true)?));
        }
        let body = body.and_then(Value::as_object);
        let mut input = Map::new();
        for (field, given) in &self.input {
            let found = sources(given).unwrap_or_default().into_iter().find_map(|source| match source {
                Source::Body => body.map(|body| Value::Object(body.clone())),
                Source::BodyField(name) => body.and_then(|body| body.get(name)).filter(|value| !value.is_null()).cloned(),
                Source::Segment(name) => captured.get(name).cloned(),
                Source::Constant(value) => Some(value.clone()),
                Source::Query(name, number) => asked.iter().find(|(asked, _)| asked == name).and_then(|(_, value)| match number {
                    false => Some(Value::String(value.clone())),
                    true => value.trim().parse::<u64>().ok().filter(|number| *number > 0).map(Value::from),
                }),
            });
            if let Some(found) = found {
                input.insert(field.clone(), found);
            }
        }
        Ok(Value::Object(input))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_path_refusals_preserve_decode_origins_and_distinguish_pattern_conditions() {
        let rows = paths(json!([{"method":"GET", "path":"/files/{id}", "segments":{"id":"[0-9]+"},
            "operation":"read", "input":{"id":"path:id"}}]));
        let malformed = rows.call("GET", "/files/%zz", None).unwrap().unwrap_err();
        let expected = crate::workspace_domain::decode("%zz", false).unwrap_err().cause();
        assert_eq!(malformed.cause(), expected);
        let private = rows.call("GET", "/files/private-medical-name", None).unwrap().unwrap_err();
        assert_ne!(private.cause(), malformed.cause());
        assert_eq!(private.cause().file(), file!());
        assert!(!private.cause().id().contains("private-medical-name"));
        let query = paths(json!([{"method":"GET", "path":"/files", "operation":"read", "input":{"q":"query:q"}}]));
        assert_eq!(query.call("GET", "/files?q=%zz", None).unwrap().unwrap_err().cause(), expected);
    }

    use serde_json::json;

    fn paths(rows: Value) -> OldPaths {
        serde_json::from_value(rows).unwrap()
    }

    #[test]
    fn a_row_takes_its_method_and_path_and_makes_the_input_from_the_body_query_and_segments() {
        let rows = paths(json!([
            {"method": "POST", "path": "/namespace/listing", "operation": "list_files",
             "input": {"folder": "body:collection", "after": "body:after", "limit": "body:limit"}},
            {"method": "GET", "path": "/namespace/results/{identity}", "operation": "read_file_results",
             "input": {"identity": "path:identity", "kind": "query:kind"}},
            {"method": "GET", "path": "/recent-files", "operation": "recent_files",
             "input": {"limit": "query:limit:number", "before": "query:before"}},
            {"method": "POST", "path": "/namespace/files/lookup", "operation": "find_file",
             "input": {"name_or_identity": ["body:name", "body:identity"]}},
            {"method": "POST", "path": "/namespace/results/{identity}/merge", "operation": "set_file_facts",
             "input": {"identity": "path:identity", "kind": {"value": "facts"}, "whole": "body"}},
            {"method": "GET", "path": "/records/{id}", "unless": ["/records/model"], "operation": "records:read",
             "input": {"id": "path:id"}},
            {"method": "GET", "path": "/namespace/files/{identity}", "segments": {"identity": "1f:[0-9a-f]{2}"},
             "operation": "find_file", "input": {"name_or_identity": "path:identity"}}
        ]));
        assert!(rows.valid(&|_| true));
        assert!(!rows.valid(&|operation| operation != "records:read"), "every operation must be the door's");
        assert_eq!(rows.call("POST", "/namespace/listing", Some(&json!({"collection": "/A", "after": "", "limit": 5, "other": 1}))),
            Some(Ok(("list_files".into(), json!({"folder": "/A", "after": "", "limit": 5})))));
        assert_eq!(rows.call("POST", "/namespace/listing", Some(&json!({}))), Some(Ok(("list_files".into(), json!({})))));
        assert_eq!(rows.call("GET", "/namespace/results/1f%3Aab?kind=transcript&kind=other", None),
            Some(Ok(("read_file_results".into(), json!({"identity": "1f:ab", "kind": "transcript"})))));
        assert_eq!(rows.call("GET", "/recent-files?limit=20&before=x%2By", None),
            Some(Ok(("recent_files".into(), json!({"limit": 20, "before": "x+y"})))));
        // Old `Number(limit) || default`: a limit that is not a whole number above 0 is left to the door's default.
        assert_eq!(rows.call("GET", "/recent-files?limit=abc", None), Some(Ok(("recent_files".into(), json!({})))));
        assert_eq!(rows.call("POST", "/namespace/files/lookup", Some(&json!({"identity": "1f:ab"}))),
            Some(Ok(("find_file".into(), json!({"name_or_identity": "1f:ab"})))));
        assert_eq!(rows.call("POST", "/namespace/files/lookup", Some(&json!({"name": "/a.txt", "identity": "1f:ab"}))),
            Some(Ok(("find_file".into(), json!({"name_or_identity": "/a.txt"})))));
        assert_eq!(rows.call("POST", "/namespace/results/1f%3Aab/merge", Some(&json!({"value": {"a": 1}}))),
            Some(Ok(("set_file_facts".into(), json!({"identity": "1f:ab", "kind": "facts", "whole": {"value": {"a": 1}}})))));
        assert_eq!(rows.call("GET", "/records/%2FFunnels%2Fsales.json", None),
            Some(Ok(("records:read".into(), json!({"id": "/Funnels/sales.json"})))));
        // A path another owner answers, another method, another length or an empty segment is no row's.
        for (method, path) in [("GET", "/records/model"), ("POST", "/recent-files/x"), ("GET", "/namespace/listing"),
            ("GET", "/namespace/results/"), ("GET", "/records/a/b"), ("GET", "/files/list_files")] {
            assert_eq!(rows.call(method, path, None), None, "{method} {path}");
        }
        assert_eq!(rows.call("GET", "/records/%zz", None), Some(Err(CodedError::new(()))), "a segment that does not decode is refused");
        assert_eq!(rows.call("GET", "/namespace/files/1f%3Aab", None), Some(Ok(("find_file".into(), json!({"name_or_identity": "1f:ab"})))));
        // A name in the URL is refused, never looked up (old test/namespace-no-name-in-urls.test.mjs).
        assert_eq!(rows.call("GET", "/namespace/files/%2FPrivate%2FMedical%2FDad%20surgery.pdf", None), Some(Err(CodedError::new(()))));
        assert_eq!(rows.call("GET", "/namespace/files/1f%3Aabc", None), Some(Err(CodedError::new(()))), "the pattern holds the whole segment");
    }

    #[test]
    fn a_path_under_an_old_first_segment_that_no_row_takes_under_any_method_is_unported() {
        let rows = paths(json!([
            {"method": "GET", "path": "/records/{id}", "unless": ["/records/erase"], "operation": "records:read",
             "input": {"id": "path:id"}},
            {"method": "POST", "path": "/namespace/listing", "operation": "list_files"}
        ]));
        // Old trillion's page roads to the door that no row ports: the door has no owner for them (404 no-owner).
        for path in ["/records/erase", "/records/conflicts/x", "/namespace/growing", "/namespace/listing/more"] {
            assert!(rows.unported(path), "{path}");
        }
        // A path a row takes, under any method, stays the door's (a wrong method is refused, as old trillion refused it).
        for path in ["/records/r1?x=1", "/namespace/listing"] {
            assert!(!rows.unported(path), "{path}");
        }
        // The door's own page road is another first segment, left to the door.
        for path in ["/door/records:list", "/files/summary", "/recorded", "/"] {
            assert!(!rows.unported(path), "{path}");
        }
    }

    #[test]
    fn a_malformed_row_is_refused() {
        for row in [
            json!({"method": "PUT", "path": "/a", "operation": "x"}),
            json!({"method": "GET", "path": "a", "operation": "x"}),
            json!({"method": "GET", "path": "/a?b", "operation": "x"}),
            json!({"method": "GET", "path": "/a//b", "operation": "x"}),
            json!({"method": "GET", "path": "/a", "operation": "x", "input": {"f": "body:x"}}),
            json!({"method": "GET", "path": "/a", "operation": "x", "input": {"f": "path:missing"}}),
            json!({"method": "GET", "path": "/a", "operation": "x", "input": {"f": "query:x:text"}}),
            json!({"method": "GET", "path": "/a", "operation": "x", "input": {"f": "elsewhere:x"}}),
            json!({"method": "GET", "path": "/a", "operation": "x", "input": {"f": []}}),
            json!({"method": "GET", "path": "/a", "operation": "x", "input": {"f": {"value": 1, "more": 2}}}),
            json!({"method": "GET", "path": "/a/{b}", "segments": {"c": "x"}, "operation": "x"}),
            json!({"method": "GET", "path": "/a/{b}", "segments": {"b": "("}, "operation": "x"}),
        ] {
            assert!(!paths(json!([row.clone()])).valid(&|_| true), "{row}");
        }
        assert!(serde_json::from_value::<OldPaths>(json!([{"method": "GET", "path": "/a", "operation": "x", "extra": 1}])).is_err());
    }
}
