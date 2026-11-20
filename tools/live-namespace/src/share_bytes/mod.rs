// src/share_bytes/mod.rs
//
// Purpose: The public byte route of a share: `GET` and `HEAD` at `/share/<id>/<key>` answer the bytes of the one file a share names, whole
// or by `Range` (200, 206, 416), to anyone who holds the share's key and for as long as the person's own share stands. It replaces the
// signed store link a share used to be (a link that stayed valid until its expiry however the share was stopped, and that could not
// name a file kept in chunks): no link to the store is made any more, the bytes are read here, by range, through the account files.
//
// What a share is, is one row of the person's own store (`@namespace/file-shares`, made by `share_file`: `{ identity, name, byte_length,
// media_type, key_blake3, can, published, revoked_at, expires_at, made_at }`), read with plain SQL on EVERY request and on every
// `recheck_seconds` of a long body, so a share stopped (`stop_share`) or ended refuses the very next read. Nothing is cached about a share.
//
// A share names one file or many (`items`), and each item may name other files of the person's as its forms (`forms`: a copy every
// browser plays, a poster, captions, any name the sharer gives): `/share/<id>/<key>/<n>` is item n's bytes and
// `/share/<id>/<key>/<n>/<form>` the bytes of its form, each by range like the whole share. The route reads no meaning into a form's
// name; the page does.
//
// The share's page: when the route's settings name a page folder (`share_bytes.page`: `page.html`, `items.json`, `assets/`), a browser
// that opens `/share/<id>/<key>` (it asks for `text/html`) gets that page filled from the share row and the person's look (settings
// `site`: `name`, `theme`, `look_css`, the block every site of the person's wears), and its player and style come from
// `/share/assets/<file>`. Anything else that asks (a download tool, `curl`) gets item 0's bytes as before. The page is the route's own,
// filled only with escaped words from the row, so it is served without the sandbox, under a policy that runs only this address's own
// script files.
//
// Non-Negotiable Invariants:
// - A request is served only when, read now: the share row's `key_blake3` is the BLAKE3 of the presented key (compared in constant
//   time), it is published, not revoked, not expired and `can` holds `view`.
// - Every refusal of a key, a share, a record or a file answers the same 404 with the same body, so a key, an id or a stopped share can
//   not be told from one that never was. Only a store that cannot answer is told apart (503), which says nothing about the key.
// - The route never answers a byte it did not read by range through the byte check of the account files (`Reader`), so each read is
//   counted as every read is.
// - The route holds no credential: not the store's, not the share's key (only a digest of it is compared).
// - Every number is DATA (`Config`, settings.json `share_bytes`).
//
// Key Concepts:
// - `Grants`: what the route asks of the person's store (the share row). `Reader`: ranged bytes of a file by identity.
// - `router`: the axum router over both; `admit`: the whole decision about one request.
//
// Security Considerations:
// - Content is served `no-store`, `nosniff` and under `sandbox` (no script, an origin of its own); only the media types `inline_types`
//   names display in the browser, every other is an attachment. A shared page that displays (`text/html` in `inline_types`) can show
//   its words, its own styles and the images and media of the same address, and can never run on the person's own address.
// - The media type a share is served as is its file's stored type, without its parameters for the inline decision. A stored type that
//   says nothing (none, or `application/octet-stream`, as files brought in from the old index or from a camera often carry) is read
//   from the name's ending through `types_by_ending` (DATA); a name it does not know stays `application/octet-stream`.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::Response,
    routing::get,
    Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc, time::{Duration, Instant}};

/// The kind of a share row (`account_files::FILE_SHARE_KIND`).
pub use crate::account_files::FILE_SHARE_KIND;
/// The start of a share's key.
const KEY_PREFIX: &str = "shr_";
/// The most characters a key of a share has.
const MOST_KEY_CHARS: usize = 128;

/// `settings.json` `share_bytes`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(rename = "_what")]
    _what: String,
    /// Where the route listens: a loopback address (`127.0.0.1:7421`, a front door's route for `/share/*` reaches it), or `unix:` and
    /// the absolute path of a socket (a front door that sends a name's every request to the socket of the name's own program, as
    /// keep-a-caddy-front-door-on-a-computer's each-name-its-own-folder does at /run/sites/<name>/http.sock).
    pub listen: String,
    /// The most bytes one read of the store answers a body with.
    pub window_bytes: u64,
    /// How often a long body asks the person's store again whether the share still stands.
    pub recheck_seconds: u64,
    /// The media types (a whole type, or a prefix ending in `/`) shown in the browser; every other is offered as a download.
    pub inline_types: Vec<String>,
    /// The media type of a file whose stored type says nothing, by the ending of its name (`.mp4` → `video/mp4`), matched without
    /// regard to case. Absent, no type is read from a name.
    #[serde(default)]
    pub types_by_ending: BTreeMap<String, String>,
    /// The absolute path of the share's page folder (`page.html`, `items.json`, `assets/`). Absent, a share has no page and every
    /// request is answered with bytes.
    #[serde(default)]
    pub page: Option<String>,
}

impl Config {
    /// The socket the route listens on, when `listen` names one (`unix:<path>`).
    pub fn socket_path(&self) -> Option<&std::path::Path> {
        self.listen.strip_prefix("unix:").map(std::path::Path::new)
    }

    /// Why a config is refused, in words.
    pub fn check(&self) -> Result<(), &'static str> {
        let loopback = self.listen.parse::<std::net::SocketAddr>().is_ok_and(|address| address.ip().is_loopback());
        let socket = self.socket_path().is_some_and(|path| path.is_absolute() && !path.as_os_str().is_empty());
        if !loopback && !socket {
            return Err("the share route listens on a loopback address or a unix socket (unix:/absolute/path)");
        }
        if !(1..=32 * 1024 * 1024).contains(&self.window_bytes) {
            return Err("a share route window is 1 byte up to 32 MiB");
        }
        if self.inline_types.iter().any(|kind| kind.is_empty() || kind.chars().any(|c| c.is_control() || c.is_whitespace())) {
            return Err("an inline type is plain text with no space");
        }
        if self.types_by_ending.iter().any(|(ending, kind)| {
            !ending.starts_with('.') || ending.len() < 2 || ending.chars().any(|c| c.is_control() || c.is_whitespace() || c == '/')
                || !plain_type(kind)
        }) {
            return Err("a type by ending maps a name ending such as .mp4 to a plain media type such as video/mp4");
        }
        if self.page.as_deref().is_some_and(|page| !page.starts_with('/') || page.split('/').any(|part| part == "..")) {
            return Err("the share page folder is an absolute path with no ..");
        }
        Ok(())
    }

    /// The media type a file named `name` and stored as `stored` is served as: the stored type when it says something (its whole
    /// value, and its type without parameters for the inline decision), else the type of the name's ending, else
    /// `application/octet-stream`. Answers (the header value, the bare type).
    pub fn served_type(&self, name: &str, stored: &str) -> (String, String) {
        const UNKNOWN: &str = "application/octet-stream";
        let bare = stored.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
        if plain_type(&bare) && bare != UNKNOWN {
            let whole = if stored.chars().all(|c| c.is_ascii() && !c.is_ascii_control()) { stored.trim().to_owned() } else { bare.clone() };
            return (whole, bare);
        }
        let leaf = name.rsplit('/').next().unwrap_or_default().to_ascii_lowercase();
        let named = self.types_by_ending.iter().filter(|(ending, _)| leaf.ends_with(&ending.to_ascii_lowercase()))
            .max_by_key(|(ending, _)| ending.len()).map(|(_, kind)| kind.to_ascii_lowercase());
        let bare = named.unwrap_or_else(|| UNKNOWN.to_owned());
        (bare.clone(), bare)
    }
}

/// Why the person's store could not answer.
#[derive(Debug, PartialEq, Eq)]
pub struct Unavailable;

/// What the route reads of the person's own store.
pub trait Grants: Send + Sync {
    /// The share row `id`, or None when there is none.
    fn share(&self, id: &str) -> Result<Option<Value>, Unavailable>;
}

/// Ranged bytes of the person's files, each read through the account files' byte check.
pub trait Reader: Send + Sync {
    /// `length` (at least 1) bytes of the file `identity` from `offset`.
    fn read(&self, identity: &str, offset: u64, length: u64) -> Result<Vec<u8>, Unavailable>;
}

/// The route's state: the person's store, the files, the numbers.
pub struct Route {
    pub grants: Arc<dyn Grants>,
    pub reader: Arc<dyn Reader>,
    pub config: Config,
    /// The share's page (`Config::page`, read when the route starts); none, and every request is answered with bytes.
    pub page: Option<Page>,
    /// The person's look (settings `site`), worn by the page.
    pub look: Value,
}

/// The file a request is let read, as the shared-file record holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admitted {
    pub identity: String,
    pub name: String,
    pub byte_length: u64,
    pub media_type: String,
}

/// Why a request is not let in.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Every reason a key, a share or a file is not there to this reader.
    NotFound,
    /// The person's store did not answer.
    Unavailable,
}

impl From<Unavailable> for Refusal {
    fn from(_: Unavailable) -> Self {
        Refusal::Unavailable
    }
}

fn text<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn plain_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn plain_key(key: &str) -> bool {
    key.starts_with(KEY_PREFIX) && key.len() <= MOST_KEY_CHARS && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn instant(value: &Value, field: &str) -> Result<Option<DateTime<Utc>>, Refusal> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(at)) => DateTime::parse_from_rfc3339(at).map(|at| Some(at.with_timezone(&Utc))).map_err(|_| Refusal::NotFound),
        Some(_) => Err(Refusal::NotFound),
    }
}

/// Whether two byte strings are equal, taking the same time whatever they hold.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |bits, (x, y)| bits | (x ^ y)) == 0
}

/// The whole decision about one request: the share row is read now and answered only when it stands for this key.
pub fn admit_share(grants: &dyn Grants, id: &str, key: &str, now: DateTime<Utc>) -> Result<Value, Refusal> {
    if !plain_id(id) || !plain_key(key) {
        return Err(Refusal::NotFound);
    }
    let share = grants.share(id)?.ok_or(Refusal::NotFound)?;
    let digest = content_crypto::advanced::blake3::hash(key.as_bytes()).to_hex().to_string();
    let held = text(&share, "key_blake3").unwrap_or("");
    let open = share.get("published").and_then(Value::as_bool) == Some(true)
        && share.get("revoked_at").is_none_or(Value::is_null)
        && instant(&share, "expires_at")?.is_some_and(|end| end > now);
    let may_view = share.get("can").and_then(Value::as_array).is_some_and(|can| can.iter().any(|word| word.as_str() == Some("view")));
    if text(&share, "kind") != Some(FILE_SHARE_KIND) || !same(digest.as_bytes(), held.as_bytes()) || !open || !may_view {
        return Err(Refusal::NotFound);
    }
    Ok(share)
}

/// The whole decision about one request for the first file of a share: the share row is read now, and the file is the row's.
pub fn admit(grants: &dyn Grants, id: &str, key: &str, now: DateTime<Utc>) -> Result<Admitted, Refusal> {
    picked(&admit_share(grants, id, key, now)?, &Pick::default())
}

/// Which file of a share a request reads: item `n` (0 is the first), or the form named `form` of it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Pick {
    pub n: usize,
    pub form: Option<String>,
}

/// The items of a share row: its `items` when it names any, else the row itself (a share of one file, as every share made before
/// items were named is).
pub fn items(share: &Value) -> Vec<&Value> {
    match share.get("items").and_then(Value::as_array) {
        Some(items) if !items.is_empty() => items.iter().collect(),
        _ => vec![share],
    }
}

fn file_of(value: &Value) -> Result<Admitted, Refusal> {
    Ok(Admitted {
        identity: text(value, "identity").filter(|identity| !identity.is_empty()).ok_or(Refusal::NotFound)?.to_owned(),
        name: text(value, "name").unwrap_or("file").to_owned(),
        byte_length: value.get("byte_length").and_then(Value::as_u64).ok_or(Refusal::NotFound)?,
        media_type: text(value, "media_type").unwrap_or("application/octet-stream").to_owned(),
    })
}

/// The file `pick` names in a standing share row; an item or a form the row does not name is the same 404 as every refusal.
pub fn picked(share: &Value, pick: &Pick) -> Result<Admitted, Refusal> {
    let item = *items(share).get(pick.n).ok_or(Refusal::NotFound)?;
    match &pick.form {
        None => file_of(item),
        Some(form) => file_of(item.get("forms").and_then(|forms| forms.get(form.as_str())).ok_or(Refusal::NotFound)?),
    }
}

/// The share's page, read once from its folder when the route starts: the page, the markup of one item by media type, and the folder
/// its player and style files are answered from.
#[derive(Debug, Clone)]
pub struct Page {
    /// `page.html`: the whole page, with `{{field}}` (escaped words) and `{{{field}}}` (as given) to fill; `{{a|b}}` is the first of
    /// `a`, `b` that says something.
    pub html: String,
    /// `items.json`: the markup of one item, by media type (a whole type, or a prefix ending in `/`; `""` for every other type).
    pub items: BTreeMap<String, String>,
    /// `assets/`: the files the page names at `/share/assets/<file>`.
    pub assets: std::path::PathBuf,
}

/// The most bytes one of the page's own files (`assets/`) is answered with.
const MOST_ASSET_BYTES: u64 = 32 * 1024 * 1024;

/// The most bytes a page file or its items file is read as.
const MOST_PAGE_BYTES: u64 = 1024 * 1024;

impl Page {
    /// Read the page folder `folder`; why it cannot be read, in words.
    pub fn read(folder: &std::path::Path) -> Result<Self, &'static str> {
        let small = |name: &str| -> Result<String, &'static str> {
            let path = folder.join(name);
            let fits = std::fs::metadata(&path).is_ok_and(|kept| kept.is_file() && kept.len() <= MOST_PAGE_BYTES);
            if !fits {
                return Err("the share page folder holds page.html and items.json, each a file of at most 1 MiB");
            }
            std::fs::read_to_string(&path).map_err(|_| "a file of the share page folder is not UTF-8 text")
        };
        let html = small("page.html")?;
        let items: BTreeMap<String, String> =
            serde_json::from_str(&small("items.json")?).map_err(|_| "items.json maps a media type (or a prefix ending in /, or \"\") to the markup of one item")?;
        Ok(Page { html, items, assets: folder.join("assets") })
    }

    /// The markup of an item of media type `media_type`: the longest type or prefix that names it, else `""`'s.
    fn item_markup(&self, media_type: &str) -> &str {
        self.items
            .iter()
            .filter(|(kind, _)| kind.is_empty() || if kind.ends_with('/') { media_type.starts_with(kind.as_str()) } else { media_type == kind.as_str() })
            .max_by_key(|(kind, _)| kind.len())
            .map(|(_, markup)| markup.as_str())
            .unwrap_or("")
    }

    /// The page of the standing share `share` at `base` (`/share/<id>/<key>`), wearing `look` (settings `site`).
    pub fn draw(&self, config: &Config, look: &Value, share: &Value, base: &str) -> String {
        let leaf = |name: &str| name.rsplit('/').next().unwrap_or(name).to_owned();
        let mut drawn = String::new();
        let mut listed = Vec::new();
        let all = items(share);
        for (n, item) in all.iter().enumerate() {
            let Ok(file) = file_of(item) else { continue };
            let (_, media_type) = config.served_type(&file.name, &file.media_type);
            let url = format!("{base}/{n}");
            let mut fields: BTreeMap<String, String> = BTreeMap::from([
                ("n".into(), n.to_string()),
                ("name".into(), leaf(&file.name)),
                ("url".into(), url.clone()),
                ("download_url".into(), format!("{url}?download")),
                ("type".into(), media_type.clone()),
                ("size".into(), size_words(file.byte_length)),
            ]);
            let mut forms = serde_json::Map::new();
            if let Some(named) = item.get("forms").and_then(Value::as_object) {
                for (form, value) in named {
                    let Ok(kept) = file_of(value) else { continue };
                    let (_, form_type) = config.served_type(&kept.name, &kept.media_type);
                    fields.insert(format!("form_{form}_url"), format!("{url}/{form}"));
                    fields.insert(format!("form_{form}_type"), form_type.clone());
                    fields.insert(format!("form_{form}_name"), leaf(&kept.name));
                    forms.insert(form.clone(), serde_json::json!({"url": format!("{url}/{form}"), "type": form_type}));
                }
            }
            drawn.push_str(&fill(self.item_markup(&media_type), &|field| fields.get(field).cloned()));
            listed.push(serde_json::json!({"n": n, "name": leaf(&file.name), "url": url, "type": media_type, "size": file.byte_length, "forms": forms}));
        }
        let first = all.first().and_then(|item| text(item, "name")).map(leaf).unwrap_or_default();
        let theme = look.get("theme").cloned().unwrap_or(Value::Null);
        let words = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or("").to_owned();
        let page: BTreeMap<&str, String> = BTreeMap::from([
            ("title", text(share, "title").map(str::to_owned).unwrap_or(first)),
            ("count", listed.len().to_string()),
            ("expires_at", words(share.get("expires_at"))),
            ("site_name", words(look.get("name"))),
            ("theme", words(theme.get("data_theme"))),
            ("scheme", words(theme.get("scheme"))),
            ("theme_color", words(theme.get("theme_color"))),
            // The person's own style, kept inside its <style>: no `</` in it can end the element.
            ("look_css", words(look.get("look_css")).replace("</", "<\\/")),
            ("items", drawn),
            ("items_json", script_json(&Value::Array(listed))),
        ]);
        fill(&self.html, &|field| page.get(field).cloned())
    }
}

/// `bytes` in words a person reads (`1.6 GB`).
fn size_words(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
    let (mut size, mut unit) = (bytes as f64, 0);
    while size >= 1000.0 && unit < UNITS.len() - 1 {
        size /= 1000.0;
        unit += 1;
    }
    if unit == 0 { format!("{bytes} bytes") } else { format!("{size:.1} {}", UNITS[unit]) }
}

/// JSON that can sit inside a `<script type="application/json">`: no `<`, `>` or `&` in it can end or open an element.
fn script_json(value: &Value) -> String {
    value.to_string().replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026")
}

/// Words made safe inside an element or a quoted attribute.
fn escaped(words: &str) -> String {
    let mut out = String::with_capacity(words.len());
    for c in words.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// `template` with each `{{a|b}}` the escaped first of its fields that says something, each `{{{a}}}` that field as given, and a
/// field nothing says left empty.
pub fn fill(template: &str, field: &dyn Fn(&str) -> Option<String>) -> String {
    let first = |names: &str| names.split('|').map(str::trim).find_map(|name| field(name).filter(|value| !value.is_empty())).unwrap_or_default();
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(at) = rest.find("{{") {
        out.push_str(&rest[..at]);
        let after = &rest[at..];
        if let Some(inner) = after.strip_prefix("{{{").and_then(|tail| tail.find("}}}").map(|end| (&tail[..end], end + 6))) {
            out.push_str(&first(inner.0));
            rest = &after[inner.1..];
        } else if let Some(end) = after[2..].find("}}") {
            out.push_str(&escaped(&first(&after[2..2 + end])));
            rest = &after[end + 4..];
        } else {
            out.push_str(after);
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

/// What a `Range` header asks of a file of `length` bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum Wanted {
    /// No range, or one that is not a single byte range: the whole file.
    Whole,
    /// The bytes `from` up to and including `to`.
    Span { from: u64, to: u64 },
    /// A range no byte of the file is in.
    Unsatisfiable,
}

/// The single byte range of a `Range` header (`bytes=a-b`, `bytes=a-`, `bytes=-n`); anything else asks for the whole file.
pub fn wanted(header: Option<&str>, length: u64) -> Wanted {
    let Some(spec) = header.and_then(|value| value.trim().strip_prefix("bytes=")) else { return Wanted::Whole };
    let Some((first, last)) = spec.split_once('-').filter(|_| !spec.contains(',')) else { return Wanted::Whole };
    let (first, last) = (first.trim(), last.trim());
    let number = |text: &str| -> Option<u64> { if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) { None } else { text.parse().ok() } };
    if first.is_empty() {
        return match number(last) {
            Some(0) => Wanted::Unsatisfiable,
            Some(_) if length == 0 => Wanted::Unsatisfiable,
            Some(suffix) => Wanted::Span { from: length.saturating_sub(suffix), to: length - 1 },
            None => Wanted::Whole,
        };
    }
    let Some(from) = number(first) else { return Wanted::Whole };
    let to = if last.is_empty() { u64::MAX } else if let Some(to) = number(last) { to } else { return Wanted::Whole };
    if to < from {
        return Wanted::Whole;
    }
    if from >= length {
        return Wanted::Unsatisfiable;
    }
    Wanted::Span { from, to: to.min(length - 1) }
}

fn plain_type(media_type: &str) -> bool {
    let valid = |c: char| c.is_ascii_alphanumeric() || "!#$&-^_.+/".contains(c);
    media_type.len() <= 127 && media_type.contains('/') && media_type.chars().all(valid)
}

fn download_name(name: &str) -> String {
    let leaf = name.rsplit('/').next().unwrap_or("file");
    let safe: String = leaf.chars().map(|c| if (c.is_ascii_graphic() && !"\"\\;%".contains(c)) || c == ' ' { c } else { '_' }).take(120).collect();
    if safe.trim().is_empty() { "file".into() } else { safe }
}

fn refuse(status: StatusCode) -> Response {
    let mut response = Response::new(Body::from("not found"));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response
}

/// The route's router: `/share/<id>/<key>` (the page to a browser when there is one, else the first file's bytes),
/// `/share/<id>/<key>/<n>` and `/share/<id>/<key>/<n>/<form>` (a file's bytes), `/share/assets/<file>` (the page's own files).
pub fn router(route: Route) -> Router {
    Router::new()
        .route("/share/assets/{file}", get(asset))
        .route("/share/{id}/{key}", get(serve_share))
        .route("/share/{id}/{key}/{n}", get(serve_item))
        .route("/share/{id}/{key}/{n}/{form}", get(serve_form))
        .fallback(|| async { refuse(StatusCode::NOT_FOUND) })
        .with_state(Arc::new(route))
}

/// The policy of the share's page: only this address's own script, style, pictures and media; nothing framed, posted or based elsewhere.
const PAGE_POLICY: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Whether the asker reads pages (a browser opening the link), not bytes.
fn wants_page(headers: &HeaderMap) -> bool {
    headers.get(header::ACCEPT).and_then(|value| value.to_str().ok()).is_some_and(|accept| accept.contains("text/html"))
}

fn item_number(n: &str) -> Option<usize> {
    if n.is_empty() || n.len() > 9 || !n.bytes().all(|b| b.is_ascii_digit()) { None } else { n.parse().ok() }
}

fn plain_form(form: &str) -> bool {
    !form.is_empty() && form.len() <= 64 && form.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

async fn serve_share(State(route): State<Arc<Route>>, Path((id, key)): Path<(String, String)>, uri: Uri, headers: HeaderMap) -> Response {
    if route.page.is_some() && wants_page(&headers) {
        return page(route, id, key).await;
    }
    let mut response = serve(route, id, key, Pick::default(), uri, headers).await;
    response.headers_mut().insert(header::VARY, HeaderValue::from_static("Accept"));
    response
}

async fn serve_item(State(route): State<Arc<Route>>, Path((id, key, n)): Path<(String, String, String)>, uri: Uri, headers: HeaderMap) -> Response {
    let Some(n) = item_number(&n) else { return refuse(StatusCode::NOT_FOUND) };
    serve(route, id, key, Pick { n, form: None }, uri, headers).await
}

async fn serve_form(State(route): State<Arc<Route>>, Path((id, key, n, form)): Path<(String, String, String, String)>, uri: Uri, headers: HeaderMap) -> Response {
    let Some(n) = item_number(&n).filter(|_| plain_form(&form)) else { return refuse(StatusCode::NOT_FOUND) };
    serve(route, id, key, Pick { n, form: Some(form) }, uri, headers).await
}

/// The share's page, filled from the share row read now.
async fn page(route: Arc<Route>, id: String, key: String) -> Response {
    let admitted = {
        let (route, id, key) = (route.clone(), id.clone(), key.clone());
        tokio::task::spawn_blocking(move || admit_share(route.grants.as_ref(), &id, &key, Utc::now())).await
    };
    let share = match admitted {
        Ok(Ok(share)) => share,
        Ok(Err(Refusal::NotFound)) => return refuse(StatusCode::NOT_FOUND),
        _ => return refuse(StatusCode::SERVICE_UNAVAILABLE),
    };
    let Some(page) = route.page.as_ref() else { return refuse(StatusCode::NOT_FOUND) };
    let drawn = page.draw(&route.config, &route.look, &share, &format!("/share/{id}/{key}"));
    let mut response = Response::new(Body::from(drawn));
    let out = response.headers_mut();
    out.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    out.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    out.insert(header::VARY, HeaderValue::from_static("Accept"));
    out.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(PAGE_POLICY));
    response
}

/// One of the page's own files (its player, its style), the same to every share: a plain file name in the page folder's `assets/`.
async fn asset(State(route): State<Arc<Route>>, Path(file): Path<String>) -> Response {
    let plain = !file.starts_with('.') && file.len() <= 128 && file.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    let Some(folder) = route.page.as_ref().map(|page| page.assets.clone()).filter(|_| plain) else { return refuse(StatusCode::NOT_FOUND) };
    let path = folder.join(&file);
    let read = tokio::task::spawn_blocking(move || {
        std::fs::metadata(&path).ok().filter(|kept| kept.is_file() && kept.len() <= MOST_ASSET_BYTES).and_then(|_| std::fs::read(&path).ok())
    }).await;
    let Ok(Some(bytes)) = read else { return refuse(StatusCode::NOT_FOUND) };
    let (header_type, _) = route.config.served_type(&file, "");
    let mut response = Response::new(Body::from(bytes));
    let out = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&header_type) {
        out.insert(header::CONTENT_TYPE, value);
    }
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=300"));
    out.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

async fn serve(route: Arc<Route>, id: String, key: String, pick: Pick, uri: Uri, headers: HeaderMap) -> Response {
    let admitted = {
        let (route, id, key, pick) = (route.clone(), id.clone(), key.clone(), pick.clone());
        tokio::task::spawn_blocking(move || admit_share(route.grants.as_ref(), &id, &key, Utc::now()).and_then(|share| picked(&share, &pick))).await
    };
    let file = match admitted {
        Ok(Ok(file)) => file,
        Ok(Err(Refusal::NotFound)) => return refuse(StatusCode::NOT_FOUND),
        _ => return refuse(StatusCode::SERVICE_UNAVAILABLE),
    };
    let download = uri.query().is_some_and(|query| query.split('&').any(|part| part == "download"));
    let length = file.byte_length;
    let ask = headers.get(header::RANGE).and_then(|value| value.to_str().ok());
    let (status, from, to) = match wanted(ask, length) {
        Wanted::Whole => (StatusCode::OK, 0, length.saturating_sub(1)),
        Wanted::Span { from, to } => (StatusCode::PARTIAL_CONTENT, from, to),
        Wanted::Unsatisfiable => {
            let mut response = refuse(StatusCode::RANGE_NOT_SATISFIABLE);
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{length}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            return response;
        }
    };
    let size = if length == 0 { 0 } else { to - from + 1 };
    let (header_type, media_type) = route.config.served_type(&file.name, &file.media_type);
    let inline = !download && route.config.inline_types.iter().any(|kind| if kind.ends_with('/') { media_type.starts_with(kind.as_str()) } else { media_type == *kind });
    let mut response = Response::new(if size == 0 {
        Body::empty()
    } else {
        Body::from_stream(window_stream(route.clone(), id, key, pick, file.clone(), from, to))
    });
    *response.status_mut() = status;
    let out = response.headers_mut();
    let mut put = |name: header::HeaderName, value: String| {
        if let Ok(value) = HeaderValue::from_str(&value) {
            out.insert(name, value);
        }
    };
    put(header::CONTENT_TYPE, header_type);
    put(header::CONTENT_LENGTH, size.to_string());
    put(header::ACCEPT_RANGES, "bytes".into());
    put(header::CACHE_CONTROL, "no-store".into());
    put(header::X_CONTENT_TYPE_OPTIONS, "nosniff".into());
    put(header::REFERRER_POLICY, "no-referrer".into());
    // A shared page shows its own styles and the images and media of this address; the sandbox lets no script run.
    put(header::CONTENT_SECURITY_POLICY, "sandbox; default-src 'none'; media-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'".into());
    put(header::CONTENT_DISPOSITION, format!("{}; filename=\"{}\"", if inline { "inline" } else { "attachment" }, download_name(&file.name)));
    if status == StatusCode::PARTIAL_CONTENT {
        put(header::CONTENT_RANGE, format!("bytes {from}-{to}/{length}"));
    }
    response
}

struct Cursor {
    route: Arc<Route>,
    id: String,
    key: String,
    pick: Pick,
    file: Admitted,
    next: u64,
    end: u64,
    checked: Instant,
}

/// The body: one read of the store a window at a time, so the first byte leaves after the first window and memory holds one window.
/// Each `recheck_seconds` the share is read again; a share that no longer stands, or no longer names this file, ends the body with an
/// error, never with more bytes.
fn window_stream(route: Arc<Route>, id: String, key: String, pick: Pick, file: Admitted, from: u64, to: u64) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    let cursor = Cursor { route, id, key, pick, file, next: from, end: to, checked: Instant::now() };
    futures_util::stream::unfold(Some(cursor), |state| async move {
        let mut cursor = state?;
        if cursor.next > cursor.end {
            return None;
        }
        let window = cursor.route.config.window_bytes.min(cursor.end - cursor.next + 1);
        let again = cursor.checked.elapsed() >= Duration::from_secs(cursor.route.config.recheck_seconds);
        let step = {
            let (route, id, key, pick, file, at) = (cursor.route.clone(), cursor.id.clone(), cursor.key.clone(), cursor.pick.clone(), cursor.file.clone(), cursor.next);
            tokio::task::spawn_blocking(move || {
                if again && admit_share(route.grants.as_ref(), &id, &key, Utc::now()).and_then(|share| picked(&share, &pick)).ok().as_ref() != Some(&file) {
                    return Err(());
                }
                route.reader.read(&file.identity, at, window).map_err(|_| ())
            })
            .await
        };
        match step {
            Ok(Ok(bytes)) if bytes.len() as u64 == window => {
                if again {
                    cursor.checked = Instant::now();
                }
                cursor.next += window;
                Some((Ok(Bytes::from(bytes)), Some(cursor)))
            }
            _ => Some((Err(std::io::Error::other("the share ended or its bytes could not be read")), None)),
        }
    })
}

/// The share rows of the person's own store, read with one `get` each time.
pub struct RowGrants {
    rows: crate::store::Store,
}

impl RowGrants {
    pub fn new(rows: crate::store::Store) -> Self {
        Self { rows }
    }
}

impl Grants for RowGrants {
    fn share(&self, id: &str) -> Result<Option<Value>, Unavailable> {
        self.rows.get(crate::account_files::FILE_SHARES, id).map(|read| read.record.map(|record| record.value)).map_err(|_| Unavailable)
    }
}
