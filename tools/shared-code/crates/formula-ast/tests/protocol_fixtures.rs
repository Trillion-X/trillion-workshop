use formula_ast::lexer::{Lexer, TokenType};
use formula_ast::parser::Parser;
use formula_ast::{
    BindingEvalReply, BindingEvalRequest, FormulaEvalReply, FormulaEvalRequest, FormulaQueryReply,
    FormulaQueryRequest,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn bytes(name: &str) -> Vec<u8> {
    fs::read(fixtures().join(name)).unwrap()
}

fn assert_canonical_round_trip<T>(name: &str)
where
    T: DeserializeOwned + Serialize,
{
    let raw = bytes(name);
    let expected = raw.strip_suffix(b"\n").unwrap_or(&raw);
    let parsed: T = serde_json::from_slice(expected).unwrap();
    assert_eq!(serde_json::to_vec(&parsed).unwrap(), expected);
}

#[test]
fn canonical_protocol_and_legacy_bytes_round_trip_exactly() {
    for name in [
        "query-analyze-v1.json",
        "query-evaluate-v1.json",
        "query-capabilities-v1.json",
        "query-project-source-v1.json",
    ] {
        assert_canonical_round_trip::<FormulaQueryRequest>(name);
    }
    for name in [
        "reply-analyze-v1.json",
        "reply-evaluate-v1.json",
        "reply-capabilities-v1.json",
        "reply-project-source-available-v1.json",
        "reply-project-source-needs-conversion-v1.json",
        "reply-project-source-unavailable-v1.json",
    ] {
        assert_canonical_round_trip::<FormulaQueryReply>(name);
    }
    assert_canonical_round_trip::<FormulaEvalRequest>("legacy-formula-eval.json");
    assert_canonical_round_trip::<FormulaEvalReply>("legacy-formula-eval-reply.json");
    assert_canonical_round_trip::<BindingEvalRequest>("legacy-binding-eval.json");
    assert_canonical_round_trip::<BindingEvalReply>("legacy-binding-eval-reply.json");
}

#[test]
fn unknown_mixed_null_absent_and_non_object_shapes_fail_closed() {
    for name in [
        "mixed-operation-binding.json",
        "mixed-operation-expression.json",
        "unknown-operation.json",
        "unknown-enum-values.json",
        "null-versus-absent.json",
        "malformed-mixed.json",
    ] {
        let raw = bytes(name);
        let query = serde_json::from_slice::<FormulaQueryRequest>(&raw);
        let reply = serde_json::from_slice::<FormulaQueryReply>(&raw);
        assert!(
            query.is_err() && reply.is_err(),
            "{name} unexpectedly decoded"
        );
    }
}

#[test]
fn protocol_version_and_blank_guards_fail_closed() {
    let mut value: Value = serde_json::from_slice(&bytes("query-analyze-v1.json")).unwrap();
    value["protocol_version"] = Value::from(2);
    let request: FormulaQueryRequest = serde_json::from_value(value.clone()).unwrap();
    assert!(request.validate_transport_guards().is_err());

    value["protocol_version"] = Value::from(1);
    value["request_token"] = Value::from(" ");
    let request: FormulaQueryRequest = serde_json::from_value(value).unwrap();
    assert!(request.validate_transport_guards().is_err());
}

#[derive(serde::Deserialize)]
struct ParserFixture {
    source: String,
    tokens: Vec<TokenFixture>,
    diagnostic: Option<DiagnosticFixture>,
    canonical: Option<String>,
}

#[derive(serde::Deserialize)]
struct TokenFixture {
    kind: String,
    char_start: usize,
    char_end: usize,
    utf16_start: u32,
    utf16_end: u32,
    line: usize,
    column: usize,
}

#[derive(serde::Deserialize)]
struct DiagnosticFixture {
    code: String,
    utf16_start: u32,
    utf16_end: u32,
}

#[test]
fn leading_marker_fixture_locks_tokens_positions_and_canonical_round_trip() {
    let fixtures: Vec<ParserFixture> =
        serde_json::from_slice(&bytes("parser-leading-formula-start-v1.json")).unwrap();
    for fixture in fixtures {
        let actual = Lexer::new(&fixture.source)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let visible: Vec<_> = actual
            .iter()
            .filter(|token| token.token_type != TokenType::Eof)
            .collect();
        assert_eq!(visible.len(), fixture.tokens.len(), "{}", fixture.source);
        for (actual, expected) in visible.into_iter().zip(fixture.tokens) {
            assert_eq!(actual.position.line, expected.line);
            assert_eq!(actual.position.column, expected.column);
            assert_eq!(actual.position.offset, expected.char_start);
            let (kind, width) = token_kind_and_width(&actual.token_type);
            assert_eq!(kind, expected.kind);
            assert_eq!(expected.char_end, expected.char_start + width);
            assert_eq!(
                expected.utf16_start,
                fixture
                    .source
                    .chars()
                    .take(expected.char_start)
                    .map(char::len_utf16)
                    .sum::<usize>() as u32
            );
            assert_eq!(
                expected.utf16_end,
                fixture
                    .source
                    .chars()
                    .take(expected.char_end)
                    .map(char::len_utf16)
                    .sum::<usize>() as u32
            );
        }

        let parsed = Parser::new().parse(&fixture.source);
        match (parsed, fixture.canonical) {
            (Ok(ast), Some(canonical)) => assert_eq!(format!("={ast}"), canonical),
            (Ok(_), None)
                if fixture.source.trim().is_empty()
                    || fixture
                        .diagnostic
                        .as_ref()
                        .is_some_and(|diagnostic| diagnostic.code == "syntax.incomplete") => {}
            (Err(_), None) => {}
            (actual, canonical) => panic!(
                "unexpected parser outcome for {:?}: {:?} {:?}",
                fixture.source, actual, canonical
            ),
        }
        if let Some(diagnostic) = fixture.diagnostic {
            assert!(matches!(
                diagnostic.code.as_str(),
                "syntax.incomplete" | "syntax.invalid" | "syntax.duplicate_start"
            ));
            assert!(diagnostic.utf16_start <= diagnostic.utf16_end);
        }
    }
}

fn token_kind_and_width(token: &TokenType) -> (String, usize) {
    match token {
        TokenType::FormulaStart => ("formula_start".to_string(), 1),
        TokenType::Eq => ("equal_equal".to_string(), 2),
        TokenType::Plus => ("plus".to_string(), 1),
        TokenType::Identifier(name) => ("identifier".to_string(), name.chars().count()),
        TokenType::String(value) => ("string".to_string(), value.chars().count() + 2),
        other => panic!("fixture token not supported: {other:?}"),
    }
}
