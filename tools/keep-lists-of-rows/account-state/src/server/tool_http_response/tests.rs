use super::*;
use serde_json::json;

fn no_json(_: Result<Value, crate::refusal_cause::CodedError<String>>, _: Option<crate::refusal_cause::Cause>) -> Result<DomainAnswer, WorkspaceError> {
    panic!("valid text must not go through JSON encoding")
}
fn parts(answer: DomainAnswer) -> (StatusCode, HeaderMap, Vec<u8>) {
    match answer {
        DomainAnswer::Http {
            status,
            headers,
            body,
        } => (status, headers, body),
        _ => panic!("text uses the existing exact-byte HTTP envelope"),
    }
}

#[test]
fn text_download_preserves_utf8_crlf_mime_and_generated_attachment_header() {
    let text = "BEGIN:VCALENDAR\r\nSUMMARY:Sample café\r\nEND:VCALENDAR\r\n";
    let (status, headers, bytes) = parts(answer(Ok(json!({"status":200,"body":text,
        "http":{"format":"text","content_type":"text/calendar; charset=utf-8","download_name":"event.ics"}})), no_json).unwrap());
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, text.as_bytes());
    assert_eq!(
        headers[header::CONTENT_TYPE],
        "text/calendar; charset=utf-8"
    );
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"event.ics\""
    );
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert!(!headers.contains_key(header::SET_COOKIE));
}

#[test]
fn empty_text_and_payload_forbidden_statuses_keep_zero_bytes() {
    for status in [200, 204, 205, 304, 404] {
        let (actual, headers, bytes) = parts(
            answer(
                Ok(json!({"status":status,"body":"","http":{"format":"text"}})),
                no_json,
            )
            .unwrap(),
        );
        assert_eq!(actual.as_u16(), status);
        assert!(bytes.is_empty());
        assert_eq!(headers[header::CONTENT_TYPE], "text/plain; charset=utf-8");
        assert!(!headers.contains_key(header::CONTENT_DISPOSITION));
    }
}

#[test]
fn json_and_run_failures_reach_the_unchanged_json_owner() {
    for original in [
        Ok(json!({"status":201,"body":{"kept":true},"ignored":"legacy metadata"})),
        Ok(json!({"status":200,"body":"a JSON string stays a JSON string"})),
        Ok(json!({"status":204,"body":null})),
        Err(crate::refusal_cause::CodedError::new("the run failed".to_owned())),
    ] {
        let expected = original.clone();
        answer(original, |got, invalid_cause| {
            assert!(invalid_cause.is_none());
            assert_eq!(got, expected);
            Ok(DomainAnswer::Json {
                body: Value::Null,
                next_before: None,
                collection_coverage: None,
            })
        })
        .unwrap();
    }
}

#[test]
fn malformed_text_and_scope_widening_headers_use_the_existing_bad_tool_answer() {
    let mut invalid = vec![
        json!({"status":200,"body":{},"http":{"format":"text"}}),
        json!({"status":200,"body":null,"http":{"format":"text"}}),
        json!({"status":200,"body":"text","http":{"format":"bytes"}}),
        json!({"status":200,"body":"text","http":null}),
        json!({"status":99,"body":"text","http":{"format":"text"}}),
        json!({"status":600,"body":"text","http":{"format":"text"}}),
        json!({"status":200,"body":"text","http":{"format":"text","content_type":"text/html"}}),
        json!({"status":200,"body":"text","headers":{"set-cookie":"session=changed"},"http":{"format":"text"}}),
        json!({"status":200,"body":"text","http":{"format":"text","headers":{"location":"https://example.test"}}}),
        json!({"status":200,"body":"text","http":{"format":"text","content_type":"text/plain\r\nSet-Cookie: nope"}}),
        json!({"status":200,"body":"text","http":{"format":"text","content_type":"not-a-mime"}}),
        json!({"status":200,"body":"text","http":{"format":"text","content_type":"text/plain; charset=utf-7"}}),
        json!({"status":200,"body":"text","http":{"format":"text","content_type":"text/plain; charset=utf-8; CHARSET=utf-8"}}),
        json!({"status":200,"body":"x".repeat(MAX_TEXT_BYTES+1),"http":{"format":"text"}}),
    ];
    for status in [204, 205, 304] {
        invalid.push(json!({"status":status,"body":"not empty","http":{"format":"text"}}));
    }
    for filename in [
        "",
        ".",
        "..",
        "../event.ics",
        "a\\event.ics",
        "a\"; x=y",
        "event.ics\r\nSet-Cookie: no",
        " event.ics",
    ] {
        invalid.push(
            json!({"status":200,"body":"text","http":{"format":"text","download_name":filename}}),
        );
    }
    for result in invalid {
        answer(Ok(result), |got, invalid_cause| {
            let cause = invalid_cause.expect("a malformed reply retains the refusal that rejected its metadata");
            assert_eq!(cause.file(), "src/server/tool_http_response.rs");
            assert_eq!(
                got,
                Ok(Value::Null),
                "invalid metadata must not become a partially accepted response"
            );
            Ok(DomainAnswer::Json {
                body: Value::Null,
                next_before: None,
                collection_coverage: None,
            })
        })
        .unwrap();
    }
}

#[test]
fn active_mime_is_download_only_and_optional_parameters_are_bounded() {
    let (_, headers, body) = parts(answer(Ok(json!({"status":200,"body":"<p>sample</p>",
        "http":{"format":"text","content_type":"text/html; charset=\"UTF-8\"","download_name":"sample.html"}})), no_json).unwrap());
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"sample.html\""
    );
    assert_eq!(body, b"<p>sample</p>");
    assert!(content_type(&"a".repeat(policy().unwrap().max_content_type_bytes + 1)).is_err());
    assert!(disposition(&"a".repeat(policy().unwrap().max_download_name_bytes + 1)).is_err());
}
