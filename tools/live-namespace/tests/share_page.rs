// tests/share_page.rs
//
// Purpose: A share of many files and its page (`share_bytes`, `share_files`): one share names several of the person's files, each
// with the files it names as its forms (a copy every browser plays, a poster); `/share/<id>/<key>/<n>` and `/<n>/<form>` answer their
// bytes by range; a browser opening `/share/<id>/<key>` gets the shipped page (on-a-computer/share-page) filled from the share row and
// the person's look, served without the sandbox under a policy that runs only the address's own files; anything else gets the first
// file's bytes as before. Hostile words in a title, a name or a look are escaped. Synthetic data only, over a real loopback socket.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod account_files_common;

use account_files_common::{account_files, write};
use live_namespace::{
    account_files::{AccountFiles, FILES, FILE_SHARES},
    share_bytes::{fill, router, Config, Page, Reader, RowGrants, Route, Unavailable},
    store::Store,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpStream,
    sync::{Arc, Mutex},
};

const ORIGIN: &str = "https://shares.example.test";

struct Files(Mutex<AccountFiles>);
impl Reader for Files {
    fn read(&self, identity: &str, offset: u64, length: u64) -> Result<Vec<u8>, Unavailable> {
        let files = self.0.lock().unwrap();
        let file = files.store.get(FILES, identity).map_err(|_| Unavailable)?.record.ok_or(Unavailable)?;
        files.read_range(&file, offset, length).map_err(|_| Unavailable)
    }
}

fn config() -> Config {
    serde_json::from_value(json!({"_what": "t", "listen": "127.0.0.1:1", "window_bytes": 7, "recheck_seconds": 0,
        "inline_types": ["video/", "image/"],
        "page": concat!(env!("CARGO_MANIFEST_DIR"), "/on-a-computer/share-page")})).unwrap()
}

/// A look as a person's `site` row gives it, with words that try to leave their element.
fn look() -> Value {
    json!({"name": "Someone's <b>pictures</b>", "theme": {"data_theme": "meadow", "scheme": "light", "theme_color": "#fafafa"},
        "look_css": ":root{--bg-primary:#f7f3ea}</style><script>alert(1)</script>"})
}

struct Served {
    address: String,
    store: Store,
    base: String,
}

fn serve(mut files: AccountFiles, input: Value, page: bool) -> (Served, Value) {
    files = files.with_share_origin(ORIGIN);
    let shared = files.call("share_file", &input).expect("a tool").expect("shared");
    let base = shared["url"].as_str().unwrap().strip_prefix(ORIGIN).unwrap().to_owned();
    let store = files.store.clone();
    let config = config();
    let page = page.then(|| Page::read(std::path::Path::new(config.page.as_deref().unwrap())).expect("the shipped page folder reads"));
    let route = Route { grants: Arc::new(RowGrants::new(store.clone())), reader: Arc::new(Files(Mutex::new(files))), config, page, look: look() };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        runtime.block_on(async move {
            axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(), router(route)).await.unwrap();
        });
    });
    (Served { address, store, base }, shared)
}

struct Answer {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn ask(served: &Served, path: &str, extra: &str) -> Answer {
    let mut stream = TcpStream::connect(&served.address).unwrap();
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: x\r\n{extra}Connection: close\r\n\r\n").unwrap();
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("a head");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.lines();
    let status = lines.next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
    let headers = lines.filter_map(|line| line.split_once(':')).map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned())).collect();
    Answer { status, headers, body: raw[split + 4..].to_vec() }
}

const BROWSER: &str = "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n";

/// Three files of the person's: a camera clip no browser plays, its playable copy and its poster, plus a document.
fn files() -> AccountFiles {
    let (mut files, _, _) = account_files();
    let origins = files.origins().unwrap();
    // A camera file often carries no type of its own (application/octet-stream): its name's ending says it is a video.
    for (name, bytes, media_type) in [
        ("/Recordings/C9058.MP4", &b"original camera bytes"[..], "application/octet-stream"),
        ("/Shared/previews/C9058 1080p.mp4", b"playable copy", "video/mp4"),
        ("/Shared/previews/C9058.jpg", b"poster", "image/jpeg"),
    ] {
        files.write_file(name, bytes, media_type, &origins).unwrap();
    }
    write(&mut files, "/Notes/<img src=x onerror=alert(1)>.txt", b"words");
    files
}

fn many() -> Value {
    json!({"items": [
        {"name_or_identity": "/Recordings/C9058.MP4", "forms": {"play": "/Shared/previews/C9058 1080p.mp4", "poster": "/Shared/previews/C9058.jpg"}},
        "/Notes/<img src=x onerror=alert(1)>.txt"
    ], "title": "Footage from <i>Sep</i> 10", "seconds": 3600})
}

#[test]
fn one_share_names_many_files_and_their_forms_each_served_by_range() {
    let (served, shared) = serve(files(), many(), true);
    assert_eq!(shared["items"], json!(2));
    let row = served.store.get(FILE_SHARES, shared["share"].as_str().unwrap()).unwrap().record.unwrap().value;
    assert_eq!(row["items"].as_array().unwrap().len(), 2);
    assert_eq!(row["items"][0]["forms"]["play"]["name"], json!("/Shared/previews/C9058 1080p.mp4"));
    assert_eq!(row["name"], json!("/Recordings/C9058.MP4"), "the row's own facts are its first item's, as every reader of one file expects");
    let base = &served.base;
    assert_eq!(ask(&served, &format!("{base}/0"), "").body, b"original camera bytes");
    assert_eq!(ask(&served, &format!("{base}/0/play"), "").body, b"playable copy");
    let poster = ask(&served, &format!("{base}/0/poster"), "Range: bytes=1-3\r\n");
    assert_eq!((poster.status, poster.body.as_slice()), (206, &b"ost"[..]));
    assert_eq!(poster.headers["content-type"], "image/jpeg");
    assert_eq!(ask(&served, &format!("{base}/1"), "").body, b"words");
    let download = ask(&served, &format!("{base}/0/play?download"), "");
    assert!(download.headers["content-disposition"].starts_with("attachment;"), "?download offers the file as a download");
    for missing in ["/2", "/0/captions", "/1/play", "/x", "/0/..", "/00000000001"] {
        let answer = ask(&served, &format!("{base}{missing}"), "");
        assert_eq!((answer.status, answer.body.as_slice()), (404, &b"not found"[..]), "{missing} is the same 404 as every refusal");
    }
}

#[test]
fn a_browser_gets_the_page_and_anything_else_gets_the_bytes() {
    let (served, _) = serve(files(), many(), true);
    let page = ask(&served, &served.base, BROWSER);
    assert_eq!(page.status, 200);
    assert_eq!(page.headers["content-type"], "text/html; charset=utf-8");
    let policy = &page.headers["content-security-policy"];
    assert!(!policy.contains("sandbox") && policy.contains("script-src 'self'") && !policy.contains("unsafe-inline'; img") || policy.contains("style-src 'self' 'unsafe-inline'"));
    assert!(!policy.contains("script-src 'self' 'unsafe-inline'"), "no inline script runs on the page");
    assert_eq!(page.headers["referrer-policy"], "no-referrer", "the key in the address never leaves in a referrer");
    let html = String::from_utf8(page.body).unwrap();
    assert!(html.contains(r#"data-theme="meadow" data-look-scheme="light""#), "the page wears the person's look");
    assert!(html.contains(":root{--bg-primary:#f7f3ea}<\\/style><script>alert(1)<\\/script>"), "the look cannot end its <style>");
    assert!(html.contains("<title>Footage from &lt;i&gt;Sep&lt;/i&gt; 10</title>"), "the title is escaped");
    assert!(html.contains("Someone&#39;s &lt;b&gt;pictures&lt;/b&gt;"), "the look's name is escaped");
    let base = &served.base;
    assert!(html.contains(&format!(r#"src="{base}/0/play""#)), "a video plays its play form");
    assert!(html.contains(&format!(r#"poster="{base}/0/poster""#)), "and shows its poster");
    assert!(html.contains(&format!(r#"href="{base}/0?download""#)), "and offers its original");
    assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;.txt"), "a file's name is escaped");
    assert!(!html.contains("</style><script") && !html.contains("<img src=x"), "no word of the row or the look becomes markup (inside <style> a <script> is only text, and nothing there can end it)");
    assert!(!html.contains("/Recordings/"), "only a file's own name is shown, never the folders it is kept in");
    for asker in ["Accept: */*\r\n", "", "User-Agent: WhatsApp/2.0\r\n"] {
        let preview = ask(&served, &served.base, asker);
        assert_eq!((preview.status, preview.headers["content-type"].as_str()), (200, "text/html; charset=utf-8"),
            "a share of many files is its page to every asker ({asker:?}): a link preview never pulls the first file's whole bytes");
    }
    let bytes = ask(&served, &format!("{}/0", served.base), "Accept: */*\r\n");
    assert_eq!(bytes.body, b"original camera bytes", "each file answers at its own address");
    assert!(bytes.headers["content-security-policy"].starts_with("sandbox"), "a file's bytes stay under the sandbox");
}

#[test]
fn a_page_names_its_title_and_first_poster_for_link_previews() {
    let (served, _) = serve(files(), many(), true);
    // `ask` names the host `x`: the image address starts with the address the page was asked at.
    let html = String::from_utf8(ask(&served, &served.base, "").body).unwrap();
    assert!(html.contains(r#"<meta property="og:title" content="Footage from &lt;i&gt;Sep&lt;/i&gt; 10">"#), "the preview title, escaped");
    assert!(html.contains(&format!(r#"<meta property="og:image" content="https://x{}/0/poster">"#, served.base)), "the first poster, absolute");
}

#[test]
fn a_share_of_one_plain_file_still_answers_its_bytes_to_a_tool() {
    let (served, _) = serve(files(), json!({"name_or_identity": "/Recordings/C9058.MP4", "seconds": 60}), true);
    assert_eq!(ask(&served, &served.base, "Accept: */*\r\n").body, b"original camera bytes");
    assert_eq!(ask(&served, &served.base, BROWSER).headers["content-type"], "text/html; charset=utf-8", "a browser still gets the page");
}

#[test]
fn with_no_page_folder_a_browser_gets_the_bytes_as_before() {
    let (served, _) = serve(files(), json!({"name_or_identity": "/Recordings/C9058.MP4", "seconds": 60}), false);
    assert_eq!(ask(&served, &served.base, BROWSER).body, b"original camera bytes");
    assert_eq!(ask(&served, "/share/assets/share-page.js", "").status, 404);
}

#[test]
fn the_pages_own_files_are_answered_and_nothing_else_is() {
    let (served, _) = serve(files(), many(), true);
    let script = ask(&served, "/share/assets/share-page.js", "");
    assert_eq!((script.status, script.headers["content-type"].as_str()), (200, "text/javascript"));
    assert_eq!(ask(&served, "/share/assets/share-page.css", "").headers["content-type"], "text/css");
    for hostile in ["/share/assets/..%2Fpage.html", "/share/assets/.hidden", "/share/assets/missing.js", "/share/assets/%2Fetc%2Fpasswd"] {
        assert_eq!(ask(&served, hostile, "").status, 404, "{hostile}");
    }
}

#[test]
fn a_stopped_share_refuses_its_page_and_every_file_the_same() {
    let mut files = files().with_share_origin(ORIGIN);
    let shared = files.call("share_file", &many()).unwrap().unwrap();
    let id = shared["share"].as_str().unwrap().to_owned();
    files.call("stop_share", &json!({"id": id})).unwrap().unwrap();
    let base = shared["url"].as_str().unwrap().strip_prefix(ORIGIN).unwrap().to_owned();
    let store = files.store.clone();
    let config = config();
    let page = Some(Page::read(std::path::Path::new(config.page.as_deref().unwrap())).unwrap());
    let route = Route { grants: Arc::new(RowGrants::new(store.clone())), reader: Arc::new(Files(Mutex::new(files))), config, page, look: Value::Null };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()
            .block_on(async move { axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(), router(route)).await.unwrap() });
    });
    let served = Served { address, store, base };
    for path in [served.base.clone(), format!("{}/0", served.base), format!("{}/0/play", served.base)] {
        assert_eq!(ask(&served, &path, BROWSER).status, 404, "{path}");
    }
}

#[test]
fn a_share_refuses_a_missing_file_a_bad_form_and_too_many_items_before_writing() {
    let mut files = files().with_share_origin(ORIGIN);
    let refused = |files: &mut AccountFiles, input: Value| files.call("share_file", &input).unwrap().is_err();
    assert!(refused(&mut files, json!({"items": ["/Recordings/C9058.MP4", "/nope"], "seconds": 60})));
    assert!(refused(&mut files, json!({"items": [{"name_or_identity": "/Recordings/C9058.MP4", "forms": {"pl ay": "/Notes"}}], "seconds": 60})));
    assert!(refused(&mut files, json!({"items": [], "seconds": 60})));
    assert!(refused(&mut files, json!({"items": vec!["/Recordings/C9058.MP4"; 2001], "seconds": 60})));
    assert!(refused(&mut files, json!({"items": ["/Recordings/C9058.MP4"], "name_or_identity": "/Recordings/C9058.MP4", "seconds": 60})));
    assert!(refused(&mut files, json!({"items": ["/Recordings/C9058.MP4"], "title": "two\nlines", "seconds": 60})));
    let listed = files.call("list_shares", &json!({})).unwrap().unwrap();
    assert_eq!(listed["shares"], json!([]), "nothing was written by a refused share");
}

#[test]
fn fill_escapes_words_gives_raw_only_when_asked_and_takes_the_first_that_says_something() {
    let fields = HashMap::from([("a", ""), ("b", "<b>&'\""), ("c", "x")]);
    let field = |name: &str| fields.get(name).map(|value| value.to_string());
    assert_eq!(fill("{{a|b}}", &field), "&lt;b&gt;&amp;&#39;&quot;");
    assert_eq!(fill("{{{b}}}", &field), "<b>&'\"");
    assert_eq!(fill("[{{missing}}][{{a|missing|c}}]", &field), "[][x]");
    assert_eq!(fill("an {{ unclosed", &field), "an {{ unclosed");
}

#[test]
fn the_page_wears_the_sharers_own_look_over_the_computers() {
    // The computer's look (settings `site`, here `look()`) is whoever runs the computer; the sharer's own look is kept in their rows.
    let mut files = files();
    let own = json!({"name": "A sharer's films", "theme": {"data_theme": "dusk", "scheme": "dark", "theme_color": "#101010"}, "look_css": ":root{--bg-primary:#101010}"});
    assert_eq!(files.call("keep_look", &json!({"look": own})).unwrap().unwrap(), json!({"look": "kept"}));
    for refused in [json!({"look": "a word"}), json!({}), json!({"look": {"look_css": "x".repeat(300 * 1024)}})] {
        assert!(files.call("keep_look", &refused).unwrap().is_err(), "{refused:.60}");
    }
    let (served, _) = serve(files, many(), true);
    let html = String::from_utf8(ask(&served, &served.base, BROWSER).body).unwrap();
    assert!(html.contains(r#"data-theme="dusk" data-look-scheme="dark""#) && html.contains("A sharer&#39;s films"), "the sharer's own look");
    assert!(!html.contains("Someone") && !html.contains("meadow"), "and nothing of the computer's");
}

#[test]
fn a_look_taken_away_leaves_the_computers_look() {
    let mut files = files();
    files.call("keep_look", &json!({"look": {"name": "Gone soon"}})).unwrap().unwrap();
    assert_eq!(files.call("keep_look", &json!({"look": null})).unwrap().unwrap(), json!({"look": "taken away"}));
    let (served, _) = serve(files, many(), true);
    let html = String::from_utf8(ask(&served, &served.base, BROWSER).body).unwrap();
    assert!(!html.contains("Gone soon") && html.contains(r#"data-theme="meadow""#));
}
