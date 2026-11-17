//! The person's files as a read-only WebDAV folder: the port of old trillion's WebDAV module (`handleDav`,
//! ports/account-files-dav.json) and src/dav-xml.mjs (`davResponse`, `davMultistatusBody`, `escapeXml`, `hrefOf`), so Finder, Premiere or any file
//! browser can mount a person's files by the names they were given and open them where they are.
//!
//! This module answers one request already signed in: the account routes decide whose files they are (a personal key
//! as the Basic password, or a read share of the whole account files as a Bearer token, old :23-29;
//! `presented_key` takes the key out of the header) and passes the path below its own prefix. It knows no route: the
//! prefix is the caller's (old `PREFIX`), and the route is the account routes' to list (capabilities.json, their row's
//! `routes`). It is built on the account files' own reads: a name or folder record, `list_tree` pages and `read_range`.
//!
//! Invariants (old :6-10):
//! - A person sees only their own names: the account files opened decides whose names are listed.
//! - Only names whose bytes are stored are listed as files; a named file not yet stored is left out rather than shown
//!   as an empty file an editor would refuse to open.
//! - Read-only here: every method other than OPTIONS, PROPFIND, GET and HEAD is refused by this operation. The writes
//!   (PUT, DELETE, MKCOL, COPY, MOVE) are the account files' separate `dav_write` operation (`dav_write.rs`), so a
//!   right on this one alone never writes.
//! - A read asks the stores for exactly the asked range (`read_range`), and one answer carries at most
//!   `READ_MAX_BYTES` of a file; a client reads a larger file by ranges (it is told `Accept-Ranges: bytes`).

use super::{
    folder_name, names_scope, parent, settings::{settings, word}, text, AccountFiles, Answer, LIVE, FILES, READ_MAX_BYTES,
};
use crate::{refusal_cause::{Cause, CodedError}};
use serde_json::Value;

/// The methods this folder answers (old :22 `allow`).
pub const ALLOW: &str = "OPTIONS, PROPFIND, GET, HEAD";

/// One request below the caller's prefix.
pub struct Request<'a> {
    pub method: &'a str,
    /// The path below the prefix, percent-encoded as it arrived ("" or "/" is the root folder).
    pub path: &'a str,
    /// The `Depth` header, when sent ("0" lists the entry alone).
    pub depth: Option<&'a str>,
    /// The `Range` header, when sent.
    pub range: Option<&'a str>,
}

/// One answer: status, headers and body.
#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
impl Response {
    #[track_caller]
    pub(super) fn new(status: u16, headers: &[(&str, &str)], body: impl Into<Vec<u8>>) -> Self {
        Self::with_cause(status, headers, body, crate::cause!(caller_site: dav response_refused))
    }
    /// A failed response retains its actual parser or operation origin while keeping its status and words.
    pub(super) fn with_cause(status: u16, headers: &[(&str, &str)], body: impl Into<Vec<u8>>, cause: Cause) -> Self {
        let mut response = Self { status, headers: headers.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect(), body: body.into() };
        if status >= 400 {
            response.headers.push(("x-trillion-refusal-cause".into(), cause.id().to_owned()));
            crate::quiet_eprintln!("dav-refusal status={status} cause={cause}");
        }
        response
    }
    /// The value of header `name`, when set.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(held, _)| held.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

/// The key a request presents (old :24-28): the password of a Basic sign-in (any user name), or
/// a Bearer token, trimmed. None when it presents neither.
pub fn presented_key(authorization: &str) -> Option<String> {
    use base64::prelude::{BASE64_STANDARD as BASE64, *};
    let (scheme, rest) = authorization.split_once(' ')?;
    let key = if scheme.eq_ignore_ascii_case("basic") {
        let decoded = String::from_utf8(BASE64.decode(rest.trim()).ok()?).ok()?;
        decoded.split_once(':')?.1.to_owned()
    } else if scheme.eq_ignore_ascii_case("bearer") {
        rest.to_owned()
    } else {
        return None;
    };
    let key = key.trim();
    (!key.is_empty()).then(|| key.to_owned())
}

/// The answer to OPTIONS (old :22): no sign-in needed. It names the writes too (`dav_write.rs`), which the door
/// answers as the account files' `dav_write` operation; a key that may not write is refused there, not here.
pub fn options() -> Response {
    Response::new(200, &[("dav", "1, 2"), ("allow", super::dav_write::ALLOW_ALL), ("ms-author-via", "DAV")], Vec::new())
}

/// The answer to a request that presents no key the sign-in admits (old :30).
pub fn sign_in() -> Response {
    Response::new(401, &[("www-authenticate", "Basic realm=\"Your files\"")], word("dav_sign_in"))
}

/// Text as XML character data or an attribute value (old src/dav-xml.mjs:4 `escapeXml`).
pub fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// One path segment as JavaScript's `encodeURIComponent` writes it.
fn encode_segment(segment: &str) -> String {
    let mut encoded = String::new();
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// A name's address below `prefix`, each segment encoded (old src/dav-xml.mjs:5 `hrefOf`).
pub fn href_of(name: &str, prefix: &str) -> String {
    format!("{prefix}{}", name.split('/').map(encode_segment).collect::<Vec<_>>().join("/"))
}

/// A percent-encoded path as text; None when it does not decode to UTF-8 (old `decodeURIComponent`, which throws).
pub(super) fn decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok().filter(|text| !text.contains('\0'))
}

/// What one name is: a folder, or a stored file.
pub enum Entry {
    Folder,
    File { identity: String, byte_length: u64, modified_at_ms: Option<i64>, media_type: Option<String> },
}

/// One `<D:response>` for a name (old src/dav-xml.mjs:8-14 `davResponse`).
pub fn dav_response(name: &str, entry: &Entry, prefix: &str) -> String {
    let props = match entry {
        Entry::Folder => "<D:resourcetype><D:collection/></D:resourcetype>".to_owned(),
        Entry::File { identity, byte_length, modified_at_ms, .. } => {
            let modified = modified_at_ms
                .filter(|at| *at != 0)
                .and_then(chrono::DateTime::from_timestamp_millis)
                .map(|at| format!("<D:getlastmodified>{}</D:getlastmodified>", at.format("%a, %d %b %Y %H:%M:%S GMT")))
                .unwrap_or_default();
            format!("<D:resourcetype/><D:getcontentlength>{byte_length}</D:getcontentlength><D:getetag>\"{}\"</D:getetag>{modified}", escape_xml(identity))
        }
    };
    let display = if name == "/" { "" } else { name.rsplit('/').next().unwrap_or_default() };
    let href = match entry {
        Entry::Folder if name != "/" => href_of(&format!("{name}/"), prefix),
        _ => href_of(name, prefix),
    };
    format!(
        "<D:response><D:href>{}</D:href><D:propstat><D:prop><D:displayname>{}</D:displayname>{props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
        escape_xml(&href),
        escape_xml(display)
    )
}

/// The whole multistatus body (old src/dav-xml.mjs:16 `davMultistatusBody`).
pub fn multistatus_body(responses: &[String]) -> String {
    format!("<?xml version=\"1.0\" encoding=\"utf-8\"?><D:multistatus xmlns:D=\"DAV:\">{}</D:multistatus>", responses.concat())
}

/// The asked byte range of a file `length` bytes long: `bytes=a-b`, `bytes=a-` or `bytes=-n` (one range). None
/// when there is no Range header; Err when the range is not in the file.
pub(crate) fn asked_range(range: Option<&str>, length: u64) -> Result<Option<(u64, u64)>, CodedError<()>> {
    let Some(range) = range else { return Ok(None) };
    let spec = range.trim().strip_prefix("bytes=").ok_or_else(|| CodedError::new(()))?;
    if spec.contains(',') {
        return Err(CodedError::new(()));
    }
    let (start, end) = spec.split_once('-').ok_or_else(|| CodedError::new(()))?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", "") => return Err(CodedError::new(())),
        ("", last) => {
            let last: u64 = last.parse().map_err(|_| CodedError::new(()))?;
            (length.saturating_sub(last), length.checked_sub(1).ok_or_else(|| CodedError::new(()))?)
        }
        (start, "") => (start.parse().map_err(|_| CodedError::new(()))?, length.checked_sub(1).ok_or_else(|| CodedError::new(()))?),
        (start, end) => (start.parse().map_err(|_| CodedError::new(()))?, end.parse::<u64>().map_err(|_| CodedError::new(()))?.min(length.saturating_sub(1))),
    };
    if start > end || start >= length {
        return Err(CodedError::new(()));
    }
    Ok(Some((start, end)))
}

impl AccountFiles {
    /// What `name` is: the root folder, a folder record, or a name whose bytes are stored. None otherwise.
    pub(super) fn dav_entry(&self, name: &str) -> Answer<Option<(Entry, Option<crate::store::Record>)>> {
        if name == "/" {
            return Ok(Some((Entry::Folder, None)));
        }
        if let Some(named) = self.get(&names_scope(parent(name)), name)? {
            let Some(file) = text(&named.value, "file") else { return Ok(None) };
            let Some(file) = self.get(FILES, file)? else { return Ok(None) };
            let entry = Entry::File {
                identity: file.id.clone(),
                byte_length: file.value.get("byte_length").and_then(Value::as_u64).unwrap_or(0),
                modified_at_ms: named.value.get("modified_at_ms").and_then(Value::as_i64),
                media_type: text(&file.value, "media_type").map(str::to_owned),
            };
            return Ok(Some((entry, Some(file))));
        }
        Ok(self.get(&LIVE.folders(parent(name)), name)?.map(|_| (Entry::Folder, None)))
    }

    /// Answer one signed-in request below `prefix` (old :21-52 `handleDav`).
    pub fn dav(&self, prefix: &str, request: &Request<'_>) -> Answer<Response> {
        if request.method.eq_ignore_ascii_case("OPTIONS") {
            return Ok(options());
        }
        let Some(decoded) = decode(request.path) else { return Ok(Response::new(404, &[], word("dav_not_found"))) };
        let name = folder_name(if decoded.is_empty() { "/" } else { &decoded });
        let Some((entry, file)) = self.dav_entry(&name)? else { return Ok(Response::new(404, &[], word("dav_not_found"))) };
        let method = request.method.to_ascii_uppercase();
        if method == "GET" || method == "HEAD" {
            let (Entry::File { identity, byte_length, media_type, .. }, Some(file)) = (&entry, file) else {
                return Ok(Response::new(405, &[("allow", "OPTIONS, PROPFIND")], word("dav_folder")));
            };
            let etag = format!("\"{identity}\"");
            let media = media_type.clone().unwrap_or_else(|| "application/octet-stream".to_owned());
            let (status, start, end) = match asked_range(request.range, *byte_length) {
                Err(error) => {
                    let whole = format!("bytes */{byte_length}");
                    return Ok(Response::with_cause(416, &[("content-range", &whole), ("accept-ranges", "bytes")], word("dav_range"), error.cause()));
                }
                Ok(Some((start, end))) => (206, start, end.min(start + READ_MAX_BYTES - 1)),
                Ok(None) if *byte_length > READ_MAX_BYTES => {
                    // One answer carries at most READ_MAX_BYTES: a larger file is read by ranges.
                    let whole = format!("bytes */{byte_length}");
                    return Ok(Response::new(416, &[("content-range", &whole), ("accept-ranges", "bytes")], word("dav_range")));
                }
                Ok(None) => (200, 0, byte_length.saturating_sub(1)),
            };
            let length = if *byte_length == 0 { 0 } else { end - start + 1 };
            let mut headers = vec![
                ("content-type".to_owned(), media),
                ("content-length".to_owned(), length.to_string()),
                ("accept-ranges".to_owned(), "bytes".to_owned()),
                ("etag".to_owned(), etag),
            ];
            if status == 206 {
                headers.push(("content-range".to_owned(), format!("bytes {start}-{end}/{byte_length}")));
            }
            let body = if method == "HEAD" || length == 0 { Vec::new() } else { self.read_range(&file, start, length)? };
            return Ok(Response { status, headers, body });
        }
        if method != "PROPFIND" {
            return Ok(Response::new(405, &[("allow", ALLOW)], word("dav_read_only")));
        }
        let limits = &settings().dav;
        let mut responses = vec![dav_response(&name, &entry, prefix)];
        if matches!(entry, Entry::Folder) && request.depth != Some("0") {
            let mut after: Option<String> = None;
            loop {
                let page = self.list_tree(&LIVE, Some(&name), after.as_deref(), Some(limits.list_page))?;
                if after.is_none() {
                    for folder in page["folders"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                        responses.push(dav_response(folder, &Entry::Folder, prefix));
                    }
                }
                for row in page["names"].as_array().into_iter().flatten() {
                    if responses.len() >= limits.list_limit {
                        break;
                    }
                    if row["stored"] != Value::Bool(true) {
                        continue;
                    }
                    let entry = Entry::File {
                        identity: row["identity"].as_str().unwrap_or("empty").to_owned(),
                        byte_length: row["byte_length"].as_u64().unwrap_or(0),
                        modified_at_ms: row["modified_at_ms"].as_i64(),
                        media_type: None,
                    };
                    responses.push(dav_response(row["name"].as_str().unwrap_or_default(), &entry, prefix));
                }
                after = page["next_after"].as_str().map(str::to_owned);
                if after.is_none() || responses.len() >= limits.list_limit {
                    break;
                }
            }
        }
        Ok(Response::new(207, &[("content-type", "application/xml; charset=utf-8"), ("dav", "1, 2")], multistatus_body(&responses)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A cause hashes by its site (file, line, column, condition); its interior mutability is a cached text that no hash reads.
    #[allow(clippy::mutable_key_type)]
    #[test]
    fn range_refusals_retain_each_condition_in_the_http_header_without_the_range() {
        let mut causes = std::collections::HashSet::new();
        for range in ["private=0-1", "bytes=0-1,3-4", "bytes=-private", "bytes=8-3"] {
            let error = asked_range(Some(range), 10).unwrap_err();
            assert!(causes.insert(error.cause()), "different range conditions keep different sites");
            let response = Response::with_cause(416, &[("content-range", "bytes */10")], b"original words".to_vec(), error.cause());
            assert_eq!(response.status, 416);
            assert_eq!(response.body, b"original words");
            let received = Cause::from_wire(response.header("x-trillion-refusal-cause").unwrap()).unwrap();
            assert_eq!(received, error.cause());
            assert!(!received.id().contains("private"));
        }
    }


    #[test]
    fn a_name_is_written_as_one_dav_response_in_the_old_words() {
        let file = Entry::File { identity: "1f:ab".into(), byte_length: 12, modified_at_ms: Some(0), media_type: None };
        assert_eq!(
            dav_response("/Notes/a & b.txt", &file, "/files"),
            "<D:response><D:href>/files/Notes/a%20%26%20b.txt</D:href><D:propstat><D:prop><D:displayname>a &amp; b.txt</D:displayname><D:resourcetype/><D:getcontentlength>12</D:getcontentlength><D:getetag>\"1f:ab\"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
        );
        let dated = Entry::File { identity: "1f:ab".into(), byte_length: 1, modified_at_ms: Some(1_700_000_000_000), media_type: None };
        assert!(dav_response("/a", &dated, "").contains("<D:getlastmodified>Tue, 14 Nov 2023 22:13:20 GMT</D:getlastmodified>"));
        assert!(dav_response("/Notes", &Entry::Folder, "").starts_with("<D:response><D:href>/Notes/</D:href><D:propstat><D:prop><D:displayname>Notes</D:displayname><D:resourcetype><D:collection/></D:resourcetype>"));
        assert!(dav_response("/", &Entry::Folder, "/p").contains("<D:href>/p/</D:href><D:propstat><D:prop><D:displayname></D:displayname>"));
        assert_eq!(multistatus_body(&["<x/>".into()]), "<?xml version=\"1.0\" encoding=\"utf-8\"?><D:multistatus xmlns:D=\"DAV:\"><x/></D:multistatus>");
        assert_eq!(escape_xml("<\"&>"), "&lt;&quot;&amp;&gt;");
    }

    #[test]
    fn the_key_is_the_basic_password_or_the_bearer_token() {
        use base64::prelude::{BASE64_STANDARD as BASE64, *};
        assert_eq!(presented_key(&format!("Basic {}", BASE64.encode("anyone:tk_key:with:colons "))).as_deref(), Some("tk_key:with:colons"));
        assert_eq!(presented_key("Bearer share-1").as_deref(), Some("share-1"));
        assert_eq!(presented_key("bearer  "), None);
        assert_eq!(presented_key("Basic !!"), None);
        assert_eq!(presented_key("Digest x"), None);
        assert_eq!(presented_key(""), None);
    }

    #[test]
    fn a_range_is_one_span_inside_the_file() {
        assert_eq!(asked_range(None, 10), Ok(None));
        assert_eq!(asked_range(Some("bytes=2-4"), 10), Ok(Some((2, 4))));
        assert_eq!(asked_range(Some("bytes=8-"), 10), Ok(Some((8, 9))));
        assert_eq!(asked_range(Some("bytes=-3"), 10), Ok(Some((7, 9))));
        assert_eq!(asked_range(Some("bytes=5-99"), 10), Ok(Some((5, 9))));
        assert!(asked_range(Some("bytes=10-"), 10).is_err());
        assert!(asked_range(Some("bytes=4-2"), 10).is_err());
        assert!(asked_range(Some("bytes=0-1,3-4"), 10).is_err());
        assert!(asked_range(Some("items=0-1"), 10).is_err());
    }

    #[test]
    fn a_path_decodes_as_utf8_or_is_not_found() {
        assert_eq!(decode("/Notes/a%20b.txt").as_deref(), Some("/Notes/a b.txt"));
        assert_eq!(decode("/caf%C3%A9").as_deref(), Some("/café"));
        assert_eq!(decode("/%FF"), None);
        assert_eq!(decode("/%2"), None);
        assert_eq!(decode("/a%00"), None);
    }
}
