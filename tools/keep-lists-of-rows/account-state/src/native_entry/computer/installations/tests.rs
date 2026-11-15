//! A published installation at its computer: only what the account's origins list publishes, each path in its one
//! form, a folder's index, a single-page site, byte ranges, and the bounds. Every file here is made up.
use super::*;
use std::{cell::RefCell, collections::HashMap};

const INSTALL: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SERVICE: &str = "https://computer.example.test";

/// Made-up account files: full name -> (media type, bytes); `down` makes every read unavailable. Counts the reads.
#[derive(Default)]
struct Files {
    kept: HashMap<String, (String, Vec<u8>)>,
    down: bool,
    reads: RefCell<Vec<(String, u64, u64)>>,
}

impl Files {
    fn with(mut self, name: &str, media_type: &str, bytes: &[u8]) -> Self {
        self.kept.insert(name.into(), (media_type.into(), bytes.to_vec()));
        self
    }
    fn published(self, installation: &str) -> Self {
        let list = serde_json::json!({"origins": [{"host": "shop.trillion.run", "installation": installation}]}).to_string();
        self.with("/installations/origins.json", "application/json", list.as_bytes())
    }
}

impl SiteFiles for Files {
    fn read(&self, name: &str, offset: u64, length: u64) -> Read {
        self.reads.borrow_mut().push((name.into(), offset, length));
        if self.down {
            return Read::Unavailable;
        }
        match self.kept.get(name) {
            Some((media_type, bytes)) => {
                let start = (offset as usize).min(bytes.len());
                let end = (start + length as usize).min(bytes.len());
                Read::Found(Window { media_type: media_type.clone(), byte_length: bytes.len() as u64, bytes: bytes[start..end].to_vec() })
            }
            None => Read::Missing,
        }
    }
}

fn site() -> Files {
    Files::default().published(INSTALL)
        .with(&format!("/installations/{INSTALL}/index.html"), "text/html; charset=utf-8", b"<h1>home</h1>")
        .with(&format!("/installations/{INSTALL}/articles/index.html"), "text/html; charset=utf-8", b"<h1>articles</h1>")
        .with(&format!("/installations/{INSTALL}/logo.svg"), "image/svg+xml", b"<svg/>")
        .with(&format!("/installations/{INSTALL}/.well-known/security.txt"), "text/plain", b"contact")
        .with(&format!("/installations/{OTHER}/index.html"), "text/html", b"<h1>not published</h1>")
}

fn get(files: &dyn SiteFiles, installation: &str, target: &str, headers: &[(&str, &str)]) -> Answer {
    get_as(files, installation, Method::GET, target, headers)
}

fn get_as(files: &dyn SiteFiles, installation: &str, method: Method, target: &str, headers: &[(&str, &str)]) -> Answer {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        map.insert(header::HeaderName::from_bytes(name.as_bytes()).unwrap(), HeaderValue::from_str(value).unwrap());
    }
    answer(files, installation, &method, target, &map, SERVICE, false)
}

fn header_of<'a>(answer: &'a Answer, name: header::HeaderName) -> Option<&'a str> {
    answer.headers.iter().find(|(named, _)| *named == name).map(|(_, value)| value.as_str())
}

#[test]
fn a_path_is_read_in_its_one_form() {
    assert_eq!(file_path("/").as_deref(), Some("index.html"));
    assert_eq!(file_path("").as_deref(), Some("index.html"));
    assert_eq!(file_path("/articles/").as_deref(), Some("articles/index.html"));
    assert_eq!(file_path("//a%20b.txt").as_deref(), None, "a space is not in a segment");
    assert_eq!(file_path("/caf%C3%A9.html"), None);
    assert_eq!(file_path("/a+b.css"), None);
    assert_eq!(file_path("/img/logo-2.v1.png").as_deref(), Some("img/logo-2.v1.png"));
    assert_eq!(file_path("/.well-known/security.txt").as_deref(), Some(".well-known/security.txt"));
    for refused in ["/../secret", "/a/../b", "/a//b", "/.env", "/a/./b", "/%2e%2e/x", "/.well-known", "/-x", "/a%2F..%2Fb"] {
        assert_eq!(file_path(refused), None, "{refused}");
    }
}

#[test]
fn only_an_installation_the_accounts_origins_list_names_is_answered() {
    let files = site();
    let home = get(&files, INSTALL, "/", &[]);
    assert_eq!(home.status, StatusCode::OK);
    assert_eq!(home.body, b"<h1>home</h1>");
    let unpublished = get(&files, OTHER, "/", &[]);
    assert_eq!(unpublished.status, StatusCode::NOT_FOUND, "its files exist but the list does not name it");
    assert_eq!(unpublished.body, settings().words.not_published.as_bytes());
    let none = Files::default().with(&format!("/installations/{INSTALL}/index.html"), "text/html", b"x");
    assert_eq!(get(&none, INSTALL, "/", &[]).status, StatusCode::NOT_FOUND, "no list: nothing is published");
    let broken = Files::default().with("/installations/origins.json", "application/json", b"{not json");
    assert_eq!(get(&broken, INSTALL, "/", &[]).status, StatusCode::SERVICE_UNAVAILABLE, "an unreadable list decides nothing");
    let down = Files { down: true, ..Files::default() };
    assert_eq!(get(&down, INSTALL, "/", &[]).status, StatusCode::SERVICE_UNAVAILABLE);
}

#[test]
fn every_answer_carries_its_media_type_and_policies_and_a_page_its_content_policy() {
    let files = site();
    let page = get(&files, INSTALL, "/index.html?utm=1", &[]);
    assert_eq!(header_of(&page, header::CONTENT_TYPE), Some("text/html; charset=utf-8"));
    assert_eq!(header_of(&page, header::X_CONTENT_TYPE_OPTIONS), Some("nosniff"));
    assert_eq!(header_of(&page, header::CACHE_CONTROL), Some("no-store"));
    assert_eq!(header_of(&page, header::REFERRER_POLICY), Some("strict-origin-when-cross-origin"));
    let policy = header_of(&page, header::CONTENT_SECURITY_POLICY).unwrap();
    assert!(policy.contains("connect-src 'self' https://computer.example.test;") && policy.contains("frame-ancestors 'none'"), "{policy}");
    let picture = get(&files, INSTALL, "/logo.svg", &[]);
    assert_eq!(header_of(&picture, header::CONTENT_TYPE), Some("image/svg+xml"));
    assert_eq!(header_of(&picture, header::CONTENT_SECURITY_POLICY), None);
    assert_eq!(get(&files, INSTALL, "/.well-known/security.txt", &[]).body, b"contact");
    assert_eq!(get(&files, INSTALL, "/.env", &[]).status, StatusCode::NOT_FOUND);
    assert_eq!(get(&files, INSTALL, "/missing.css", &[]).status, StatusCode::NOT_FOUND);
}

#[test]
fn a_folder_without_its_slash_goes_on_to_it_and_a_single_page_site_answers_its_pages_with_its_index() {
    let files = site();
    let moved = get(&files, INSTALL, "/articles?page=2", &[]);
    assert_eq!(moved.status, StatusCode::PERMANENT_REDIRECT);
    assert_eq!(header_of(&moved, header::LOCATION), Some("/articles/?page=2"));
    assert_eq!(get(&files, INSTALL, "/articles/", &[]).body, b"<h1>articles</h1>");

    let html = [("accept", "text/html,application/xhtml+xml")];
    let route = get(&files, INSTALL, "/pricing/plans", &html);
    assert_eq!((route.status, route.body.as_slice()), (StatusCode::OK, b"<h1>home</h1>".as_slice()));
    assert_eq!(get(&files, INSTALL, "/pricing/plans", &[]).status, StatusCode::NOT_FOUND, "not a browser asking for a page");
    assert_eq!(get(&files, INSTALL, "/pricing.json", &html).status, StatusCode::NOT_FOUND, "a file with an extension is a file");
    assert_eq!(get(&files, INSTALL, "/api/orders", &html).status, StatusCode::NOT_FOUND, "the site's own API is never its index");
}

#[test]
fn only_page_reads_are_answered_and_a_head_reads_no_bytes() {
    let files = site();
    let post = get_as(&files, INSTALL, Method::POST, "/", &[]);
    assert_eq!(post.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(header_of(&post, header::ALLOW), Some("GET, HEAD"));
    files.reads.borrow_mut().clear();
    let head = get_as(&files, INSTALL, Method::HEAD, "/logo.svg", &[]);
    assert_eq!(head.status, StatusCode::OK);
    assert!(head.body.is_empty());
    assert_eq!(header_of(&head, header::CONTENT_TYPE), Some("image/svg+xml"));
    let reads = files.reads.borrow();
    assert_eq!(reads.last().unwrap(), &(format!("/installations/{INSTALL}/logo.svg"), 0, 0));
}

#[test]
fn a_large_file_is_read_in_bounded_reads_and_answered_by_byte_range_past_one_answer() {
    let settings = settings();
    let large = vec![7u8; (settings.read_bytes * 2 + 5) as usize];
    let files = site().with(&format!("/installations/{INSTALL}/video.mp4"), "video/mp4", &large);
    let whole = get(&files, INSTALL, "/video.mp4", &[]);
    assert_eq!(whole.status, StatusCode::OK);
    assert_eq!(whole.body.len(), large.len(), "three reads of at most read_bytes");
    assert!(files.reads.borrow().iter().all(|(_, _, length)| *length <= settings.read_bytes));

    let part = get(&files, INSTALL, "/video.mp4", &[("range", "bytes=10-19")]);
    assert_eq!(part.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(part.body.len(), 10);
    assert_eq!(header_of(&part, header::CONTENT_RANGE), Some(format!("bytes 10-19/{}", large.len()).as_str()));
    let past = get(&files, INSTALL, "/video.mp4", &[("range", &format!("bytes={}-", large.len()))]);
    assert_eq!(past.status, StatusCode::RANGE_NOT_SATISFIABLE);

    let huge = vec![1u8; (settings.most_answer_bytes + 1) as usize];
    let files = site().with(&format!("/installations/{INSTALL}/huge.bin"), "application/octet-stream", &huge);
    assert_eq!(get(&files, INSTALL, "/huge.bin", &[]).status, StatusCode::PAYLOAD_TOO_LARGE);
    // The forwarder, which streams the rest by range, is answered the first window and the file's size instead.
    let streamed = answer(&files, INSTALL, &Method::GET, "/huge.bin", &HeaderMap::new(), SERVICE, true);
    assert_eq!((streamed.status, streamed.body.len() as u64, streamed.whole), (StatusCode::OK, settings.most_answer_bytes, Some(huge.len() as u64)));
    let ranged = answer(&files, INSTALL, &Method::GET, "/huge.bin", &HeaderMap::from_iter([(header::RANGE, HeaderValue::from_static("bytes=5-9"))]), SERVICE, true);
    assert_eq!((ranged.status, ranged.whole), (StatusCode::PARTIAL_CONTENT, None), "a range read is never a streamed whole");
    let open_range = get(&files, INSTALL, "/huge.bin", &[("range", "bytes=0-")]);
    assert_eq!(open_range.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(open_range.body.len() as u64, settings.most_answer_bytes, "one answer at most");
}

#[test]
fn the_origins_list_becomes_the_accounts_signed_row() {
    let key = crate::account::computers::AccountKey::from_secret_text(&"07".repeat(32)).unwrap();
    let list = serde_json::json!({"origins": [
        {"host": "Old.Trillion.Run", "installation": INSTALL, "moved_to": "shop.trillion.run"},
        {"host": "shop.trillion.run", "installation": INSTALL}]}).to_string();
    let files = Files::default().with("/installations/origins.json", "application/json", list.as_bytes());
    let Published::Origins(origins, bytes) = published(&files) else { panic!("a list") };
    assert_eq!(bytes, list.as_bytes());
    let row = origins_row(&origins, 5, &key).unwrap();
    assert!(row.believed(&key.address()));
    assert_eq!(row.revision, 5);
    assert_eq!(row.origins[0].host, "old.trillion.run");
    assert_eq!(published(&Files::default()), Published::None);
    let bad = Files::default().with("/installations/origins.json", "application/json", br#"{"origins": [{"host": "x"}]}"#);
    assert_eq!(published(&bad), Published::Unreadable);
    let refused = vec![Origin { host: "shop.trillion.run".into(), installation: "not-hex".into(), moved_to: None }];
    assert!(origins_row(&refused, 1, &key).is_none());
}

#[test]
fn the_forwarders_answer_is_kept_as_a_state_the_persons_tools_read() {
    assert_eq!(told_json(&Told::Answering(2), 7), serde_json::json!({"state": "answering", "hosts": 2, "told_at_ms": 7}));
    assert_eq!(told_json(&Told::Refused("host_taken".into()), 7), serde_json::json!({"state": "refused", "why": "host_taken", "told_at_ms": 7}));
    assert_eq!(settings().told_file, "/installations/origins-told.json");
    assert_eq!(crate::forwarder::origins::not_believed_word(), "origins_not_believed");
    assert_eq!(told_of(200, b"{\"state\":\"taken\"}", 3), Some(Told::Answering(3)));
    assert_eq!(told_of(409, b"{\"error\":\"host_taken\"}", 3), Some(Told::Refused("host_taken".into())));
    assert_eq!(told_of(409, b"{\"error\":\"origins_not_believed\"}", 3), None, "not admitted yet: posted again");
    assert_eq!(told_of(503, b"{\"error\":\"unavailable\"}", 3), None);
    assert_eq!(told_of(409, b"not json", 3), None);
}
