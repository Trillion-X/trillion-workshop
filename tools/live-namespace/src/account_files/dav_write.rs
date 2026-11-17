//! The person's files as a writable WebDAV folder: the write half beside the read-only folder (`dav.rs`), so Finder,
//! Explorer, rclone, Cyberduck or any WebDAV client that mounts a person's files can also put, make, move, copy and
//! remove names there, on the account files' own writes (RFC 4918 methods PUT, DELETE, MKCOL, COPY and MOVE).
//!
//! This module answers one request already signed in, as `dav.rs` does: the door decides whose files they are and
//! passes the path below its own prefix, the headers this needs and the body. It is the account files' `dav_write`
//! operation, a different operation from the read-only `dav`, so a right that reaches only reads never reaches
//! these (account-files-routes.json `operations`; neither is ever a tool run's).
//!
//! Invariants:
//! - Built on the account files' own operations only: `write_file` keeps a PUT's bytes and names them; the folder
//!   records of `ensure_folders` make a MKCOL; `carry_names` carries a MOVE, a COPY and a DELETE. Nothing here writes
//!   a record of its own kind.
//! - A DELETE never forgets: the name or folder is set aside at the same full name (the person's Recently Deleted,
//!   `put_back` brings it back), and its file and bytes are kept. A DELETE of a file whose full name is already set
//!   aside for another file forgets that older set-aside name first (`forget_set_aside`): the newest deletion is the
//!   one kept for putting back.
//! - An overwrite never forgets either: a PUT names the new bytes and the old file keeps its bytes until the byte
//!   release finds nothing holds it; a MOVE or COPY onto an existing name with `Overwrite: T` first sets the existing
//!   name or folder aside.
//! - Version conflicts are the client's to state: `If-Match` (the entity tag is the file identity, as PROPFIND and GET
//!   answer it, or `*`) and `If-None-Match` are checked against the name as it is now and refused with 412 when they
//!   do not hold. The check and the write are two steps: a write that lands between them is not seen (the account
//!   files have no compare-and-set of a name by its file yet), which is named as a gap in the PR that added this.
//! - RFC 4918 conflicts: a PUT, MKCOL, MOVE or COPY whose parent folder does not exist is refused with 409 and makes
//!   no folder; a MKCOL of a name that exists is 405; a MOVE or COPY onto itself or into itself is 403; `Overwrite:
//!   F` onto an existing name is 412.
//! - Bounded: one PUT keeps at most `put_most_bytes` (the account files' `WRITE_MAX_BYTES`); a larger file is refused
//!   with 413 and goes in pieces through `write_file_start`. A carry takes at most `carry_step` steps a call and at
//!   most `carry_calls` calls a request; a folder too large for that answers 503 and the same request again resumes
//!   it (a move and a set-aside resume because their carried names left the source; a copy is idempotent).
//! - Locks are held (RFC 4918 class 2, so Finder mounts the folder writable and Office can save): LOCK keeps one
//!   exclusive write lock per full name as a record (`LOCKS`, kind `namespace-dav-lock`) with its token and when it
//!   ends (at most `lock_most_seconds`); while it lasts, a PUT, DELETE, MKCOL, MOVE (source and destination) or COPY
//!   (destination) of that name, or of a name under a folder locked at depth infinity, is refused with 423 unless its
//!   `If` header presents the token. UNLOCK, a DELETE or a MOVE of the name lets the lock go. A LOCK of a name that
//!   does not exist makes it an empty file (RFC 4918 7.3). Not checked yet: a LOCK of a folder at depth infinity does
//!   not look for locks already held below it.

use super::{
    dav::{decode, Entry, Response, ALLOW},
    folder_name, names::Carry, now_iso, parent,
    settings::{settings, word},
    text, AccountFiles, AccountFilesError, Answer, LIVE, SET_ASIDE, WRITE_MAX_BYTES,
};
use content_crypto::advanced::blake3;
use serde_json::Value;

/// The methods the writable folder answers beside the read-only ones (LOCK and UNLOCK write lock records).
pub const WRITES: &[&str] = &["PUT", "DELETE", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK"];

/// Every method the folder answers, read and write (the OPTIONS `Allow`).
pub const ALLOW_ALL: &str = "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK";

/// The locks held (`LOCK`): one record per locked full name.
pub const LOCKS: &str = "@namespace/dav-locks";
/// The `kind` of a lock record.
pub const LOCK_KIND: &str = "namespace-dav-lock";

/// True when `method` is one of the writes (`WRITES`), answered by `dav_write` rather than the read-only `dav`.
pub fn is_write(method: &str) -> bool {
    WRITES.iter().any(|write| write.eq_ignore_ascii_case(method))
}

/// One write request below the caller's prefix.
#[derive(Default)]
pub struct WriteRequest<'a> {
    pub method: &'a str,
    /// The path below the prefix, percent-encoded as it arrived.
    pub path: &'a str,
    /// The `Depth` header, when sent (a COPY of a folder at depth "0" copies the folder alone).
    pub depth: Option<&'a str>,
    /// The `Destination` header of a COPY or MOVE: an absolute URL or a path, at or below the same prefix.
    pub destination: Option<&'a str>,
    /// The `Overwrite` header ("F" refuses an existing destination; anything else, or none, overwrites it).
    pub overwrite: Option<&'a str>,
    /// The `If-Match` header.
    pub if_match: Option<&'a str>,
    /// The `If-None-Match` header.
    pub if_none_match: Option<&'a str>,
    /// The `Content-Type` of a PUT.
    pub content_type: Option<&'a str>,
    /// The `If` header: the lock tokens a write presents.
    pub if_header: Option<&'a str>,
    /// The `Lock-Token` header of an UNLOCK.
    pub lock_token: Option<&'a str>,
    /// The `Timeout` header of a LOCK.
    pub timeout: Option<&'a str>,
    /// The body of a PUT or a LOCK (a MKCOL's must be empty).
    pub body: &'a [u8],
}

/// The lock tokens an `If` header presents: each `<...>` in it (state tokens; resource tags are not checked).
fn presented_tokens(if_header: Option<&str>) -> Vec<&str> {
    let Some(header) = if_header else { return Vec::new() };
    header.split('<').skip(1).filter_map(|rest| rest.split_once('>').map(|(token, _)| token.trim())).collect()
}

/// The seconds a LOCK asks for (`Timeout: Second-n` or `Infinite`, the first one given), never more than the most.
fn lock_seconds(timeout: Option<&str>) -> u64 {
    let limits = &settings().dav;
    let asked = timeout.and_then(|timeout| timeout.split(',').next()).map(str::trim);
    let seconds = match asked {
        Some(asked) if asked.eq_ignore_ascii_case("infinite") => limits.lock_most_seconds,
        Some(asked) => asked.strip_prefix("Second-").and_then(|n| n.parse().ok()).unwrap_or(limits.lock_default_seconds),
        None => limits.lock_default_seconds,
    };
    seconds.clamp(1, limits.lock_most_seconds)
}

/// A new lock token: `opaquelocktoken:` and a random UUID (RFC 4918 appendix C).
fn new_lock_token() -> Answer<String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; 16];
    SystemRandom::new().fill(&mut bytes).map_err(|_| AccountFilesError::Invalid("no random source", crate::cause!()))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("opaquelocktoken:{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

/// The LOCK answer's body: the one lock held (RFC 4918 14.11 `lockdiscovery`).
fn lock_discovery(token: &str, depth: &str, seconds: u64, root: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><D:prop xmlns:D=\"DAV:\"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>{depth}</D:depth><D:timeout>Second-{seconds}</D:timeout><D:locktoken><D:href>{}</D:href></D:locktoken><D:lockroot><D:href>{}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>",
        super::dav::escape_xml(token),
        super::dav::escape_xml(root)
    )
}

/// An entity tag as sent: `W/` and the quotes taken off.
fn bare_tag(tag: &str) -> &str {
    let tag = tag.trim();
    let tag = tag.strip_prefix("W/").unwrap_or(tag);
    tag.strip_prefix('"').and_then(|tag| tag.strip_suffix('"')).unwrap_or(tag)
}

/// True when a list of entity tags (`If-Match` or `If-None-Match`) names `current` (a file's identity), or is `*`
/// and the name exists at all.
fn tags_name(tags: &str, exists: bool, current: Option<&str>) -> bool {
    tags.split(',').map(str::trim).any(|tag| if tag == "*" { exists } else { current.is_some_and(|current| bare_tag(tag) == current) })
}

/// True when the request's preconditions hold for the name as it is now (RFC 9110 13.1.1 and 13.1.2).
fn preconditions_hold(request: &WriteRequest<'_>, entry: Option<&Entry>) -> bool {
    let current = match entry {
        Some(Entry::File { identity, .. }) => Some(identity.as_str()),
        _ => None,
    };
    let exists = entry.is_some();
    request.if_match.is_none_or(|tags| tags_name(tags, exists, current))
        && request.if_none_match.is_none_or(|tags| !tags_name(tags, exists, current))
}

/// The full name a `Destination` header names below `prefix`; None when it is not below it or does not decode.
pub fn destination_name(prefix: &str, destination: &str) -> Option<String> {
    let path = match destination.find("://") {
        Some(at) => {
            let rest = &destination[at + 3..];
            &rest[rest.find('/')?..]
        }
        None => destination,
    };
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let below = path.strip_prefix(prefix)?;
    if !below.is_empty() && !below.starts_with('/') {
        return None;
    }
    let decoded = decode(below)?;
    Some(folder_name(if decoded.is_empty() { "/" } else { &decoded }))
}

/// A request key for one write of `name`, unique to this request.
fn request_key(method: &str, name: &str, now: &str) -> String {
    format!("dav-{}:{}", method.to_ascii_lowercase(), blake3::hash(format!("{method}\0{name}\0{now}").as_bytes()).to_hex())
}

fn plain(status: u16, words: &str) -> Response {
    Response::new(status, &[("content-type", "text/plain; charset=utf-8")], words)
}

/// How a carry of a name or a whole folder ended.
enum Carried {
    Done,
    /// Stopped inside its bounds; the same request again resumes it.
    Unfinished,
    /// A name at the destination already names another file.
    Conflict,
}

impl AccountFiles {
    /// True when `name` is a folder, or a name of any file (stored or not): what a MKCOL or a new folder would collide with.
    fn dav_taken(&self, name: &str) -> Answer<bool> {
        if name == "/" {
            return Ok(true);
        }
        Ok(self.get(&LIVE.names(parent(name)), name)?.is_some() || self.get(&LIVE.folders(parent(name)), name)?.is_some())
    }

    /// True when the folder `folder` exists (the root always does).
    fn dav_folder_exists(&self, folder: &str) -> Answer<bool> {
        Ok(folder == "/" || self.get(&LIVE.folders(parent(folder)), folder)?.is_some())
    }

    /// Carry `from` to `to` (`Carry`) in bounded calls until done, or until this request's bounds end.
    fn dav_carry(&mut self, carry: Carry<'_>) -> Answer<Carried> {
        let limits = &settings().dav;
        let mut after: Option<String> = None;
        for _ in 0..limits.carry_calls {
            let answer = match self.carry_names(carry, after.as_deref(), Some(limits.carry_step)) {
                Ok(answer) => answer,
                Err(AccountFilesError::Invalid(why, _)) if why.contains("already names another file") => return Ok(Carried::Conflict),
                Err(error) => return Err(error),
            };
            let next = answer["next_after"].as_str().map(str::to_owned);
            match next {
                None => return Ok(Carried::Done),
                // No step taken since the last call: this call's time is spent.
                Some(next) if after.as_deref() == Some(next.as_str()) => return Ok(Carried::Unfinished),
                Some(next) => after = Some(next),
            }
        }
        Ok(Carried::Unfinished)
    }

    /// Set `name` (a file name or a whole folder) aside at the same full name. A file name already set aside for
    /// another file is forgotten there first, so the newest deletion is the one kept.
    fn dav_set_aside(&mut self, name: &str) -> Answer<Carried> {
        if let Some(named) = self.get(&LIVE.names(parent(name)), name)? {
            let older = self.get(&SET_ASIDE.names(parent(name)), name)?;
            if older.is_some_and(|older| text(&older.value, "file") != text(&named.value, "file")) {
                let mut after: Option<String> = None;
                loop {
                    let forgotten = self.forget_set_aside(name, after.as_deref(), Some(settings().dav.carry_step))?;
                    match forgotten["next_after"].as_str() {
                        Some(next) if after.as_deref() != Some(next) => after = Some(next.to_owned()),
                        Some(_) => return Ok(Carried::Unfinished),
                        None => break,
                    }
                }
            }
        }
        self.dav_carry(Carry { source: &LIVE, from: name, target: &SET_ASIDE, to: name, kept: false })
    }

    /// The lock that holds `name` now: its own, or one of a folder above it locked at depth infinity. None when no lock
    /// holds it or the lock ended.
    fn dav_lock_on(&self, name: &str) -> Answer<Option<crate::store::Record>> {
        let now = self.now_ms();
        let mut at = name.to_owned();
        loop {
            if let Some(lock) = self.get(LOCKS, &at)? {
                let lasting = lock.value.get("expires_at_ms").and_then(Value::as_u64).is_some_and(|ends| ends > now);
                if lasting && (at == name || text(&lock.value, "depth") == Some("infinity")) {
                    return Ok(Some(lock));
                }
            }
            if at == "/" {
                return Ok(None);
            }
            at = parent(&at).to_owned();
        }
    }

    /// True when a lock holds `name` and the request does not present its token.
    fn dav_locked(&self, name: &str, request: &WriteRequest<'_>) -> Answer<bool> {
        let Some(lock) = self.dav_lock_on(name)? else { return Ok(false) };
        let token = text(&lock.value, "token").unwrap_or_default();
        Ok(!presented_tokens(request.if_header).contains(&token))
    }

    /// Let go of the lock record of `name`, if any (an UNLOCK, or the name deleted or moved away).
    fn dav_drop_lock(&mut self, name: &str, now: &str) -> Answer<()> {
        let (version, held) = self.held(LOCKS, name)?;
        if held.is_some() {
            let gone = crate::store::Mutation { id: name.to_owned(), expected_version: version, request_key: request_key("unlock", name, now), deleted: true, value: Value::Null };
            self.mutate(LOCKS, gone)?;
        }
        Ok(())
    }

    /// LOCK (a new lock, or a refresh when the body is empty and `If` presents the token) and UNLOCK.
    fn dav_lock(&mut self, prefix: &str, method: &str, name: &str, request: &WriteRequest<'_>, now: &str) -> Answer<Response> {
        if name == "/" {
            return Ok(plain(403, word("dav_root")));
        }
        if method == "UNLOCK" {
            let asked = request.lock_token.map(|token| token.trim().trim_start_matches('<').trim_end_matches('>').trim());
            let held = self.get(LOCKS, name)?;
            if held.is_none() || asked.is_none() || held.as_ref().and_then(|lock| text(&lock.value, "token")) != asked {
                return Ok(plain(409, word("dav_not_locked")));
            }
            self.dav_drop_lock(name, now)?;
            return Ok(Response::new(204, &[], Vec::new()));
        }
        let seconds = lock_seconds(request.timeout);
        let expires_at_ms = self.now_ms() + seconds * 1000;
        let root = super::dav::href_of(name, prefix);
        let (version, held) = self.held(LOCKS, name)?;
        // A refresh: no body, and the token of the lock on this very name.
        if request.body.is_empty() {
            let Some(lock) = held.filter(|lock| lock.value.get("expires_at_ms").and_then(Value::as_u64).is_some_and(|ends| ends > self.now_ms())) else {
                return Ok(plain(412, word("dav_not_locked")));
            };
            let token = text(&lock.value, "token").unwrap_or_default().to_owned();
            if !presented_tokens(request.if_header).contains(&token.as_str()) {
                return Ok(plain(412, word("dav_not_locked")));
            }
            let depth = text(&lock.value, "depth").unwrap_or("infinity").to_owned();
            let mut value = lock.value.clone();
            value["expires_at_ms"] = serde_json::json!(expires_at_ms);
            self.mutate(LOCKS, crate::store::Mutation { id: name.to_owned(), expected_version: version, request_key: request_key("lock-refresh", name, now), deleted: false, value })?;
            let body = lock_discovery(&token, &depth, seconds, &root);
            return Ok(Response::new(200, &[("content-type", "application/xml; charset=utf-8")], body));
        }
        if self.dav_lock_on(name)?.is_some() {
            return Ok(plain(423, word("dav_locked")));
        }
        // A lock of a name that does not exist makes it an empty file (RFC 4918 7.3).
        let made = if self.dav_taken(name)? {
            false
        } else {
            if !self.dav_folder_exists(parent(name))? {
                return Ok(plain(409, word("dav_no_parent")));
            }
            let origins = self.origins()?;
            self.write_file(name, &[], "application/octet-stream", &origins)?;
            true
        };
        let depth = if request.depth.map(str::trim) == Some("0") { "0" } else { "infinity" };
        let token = new_lock_token()?;
        let value = serde_json::json!({
            "kind": LOCK_KIND, "name": name, "token": token, "depth": depth, "expires_at_ms": expires_at_ms, "locked_at": now,
        });
        self.mutate(LOCKS, crate::store::Mutation { id: name.to_owned(), expected_version: version, request_key: request_key("lock", name, now), deleted: false, value })?;
        let held_token = format!("<{token}>");
        let body = lock_discovery(&token, depth, seconds, &root);
        Ok(Response::new(if made { 201 } else { 200 }, &[("content-type", "application/xml; charset=utf-8"), ("lock-token", &held_token)], body))
    }

    /// Answer one signed-in write request below `prefix` (PUT, DELETE, MKCOL, COPY, MOVE, LOCK or UNLOCK).
    pub fn dav_write(&mut self, prefix: &str, request: &WriteRequest<'_>) -> Answer<Response> {
        let method = request.method.to_ascii_uppercase();
        if !is_write(&method) {
            return Ok(Response::new(405, &[("allow", ALLOW)], word("dav_not_a_write")));
        }
        let Some(decoded) = decode(request.path) else { return Ok(plain(404, word("dav_not_found"))) };
        let name = folder_name(if decoded.is_empty() { "/" } else { &decoded });
        let entry = self.dav_entry(&name)?.map(|(entry, _)| entry);
        if !preconditions_hold(request, entry.as_ref()) {
            return Ok(plain(412, word("dav_precondition")));
        }
        let now = now_iso();
        if method == "LOCK" || method == "UNLOCK" {
            return self.dav_lock(prefix, &method, &name, request, &now);
        }
        // A locked name is written only by the request that presents its lock's token.
        if method != "COPY" && self.dav_locked(&name, request)? {
            return Ok(plain(423, word("dav_locked")));
        }
        match method.as_str() {
            "PUT" => {
                if name == "/" || decoded.ends_with('/') || matches!(entry, Some(Entry::Folder)) {
                    return Ok(Response::new(405, &[("allow", ALLOW)], word("dav_folder")));
                }
                if request.body.len() > settings().dav.put_most_bytes.min(WRITE_MAX_BYTES) {
                    return Ok(plain(413, word("dav_too_large")));
                }
                if !self.dav_folder_exists(parent(&name))? {
                    return Ok(plain(409, word("dav_no_parent")));
                }
                let media_type = request.content_type.map(str::trim).filter(|media| !media.is_empty()).unwrap_or("application/octet-stream");
                let origins = self.origins()?;
                let kept = match self.write_file(&name, request.body, media_type, &origins) {
                    Ok(kept) => kept,
                    Err(AccountFilesError::Invalid(why, _)) => return Ok(plain(400, why)),
                    Err(error) => return Err(error),
                };
                let etag = format!("\"{}\"", kept["identity"].as_str().unwrap_or_default());
                let status = if entry.is_some() { 204 } else { 201 };
                Ok(Response::new(status, &[("etag", &etag)], Vec::new()))
            }
            "MKCOL" => {
                if !request.body.is_empty() {
                    return Ok(plain(415, word("dav_mkcol_body")));
                }
                if self.dav_taken(&name)? {
                    return Ok(Response::new(405, &[("allow", ALLOW_ALL)], word("dav_exists")));
                }
                if !self.dav_folder_exists(parent(&name))? {
                    return Ok(plain(409, word("dav_no_parent")));
                }
                self.ensure_folders(&LIVE, &name, &request_key(&method, &name, &now))?;
                Ok(Response::new(201, &[], Vec::new()))
            }
            "DELETE" => {
                if name == "/" {
                    return Ok(plain(403, word("dav_root")));
                }
                if !self.dav_taken(&name)? {
                    return Ok(plain(404, word("dav_not_found")));
                }
                Ok(match self.dav_set_aside(&name)? {
                    Carried::Done => {
                        self.dav_drop_lock(&name, &now)?;
                        Response::new(204, &[], Vec::new())
                    }
                    Carried::Unfinished => Response::new(503, &[("retry-after", "1")], word("dav_unfinished")),
                    Carried::Conflict => plain(409, word("dav_conflict")),
                })
            }
            // COPY and MOVE.
            _ => {
                if name == "/" {
                    return Ok(plain(403, word("dav_root")));
                }
                let Some(entry) = entry else { return Ok(plain(404, word("dav_not_found"))) };
                let Some(to) = request.destination.and_then(|destination| destination_name(prefix, destination)) else {
                    return Ok(plain(400, word("dav_destination")));
                };
                if to == "/" || to == name || to.strip_prefix(&name).is_some_and(|rest| rest.starts_with('/')) {
                    return Ok(plain(403, word("dav_onto_itself")));
                }
                if !self.dav_folder_exists(parent(&to))? {
                    return Ok(plain(409, word("dav_no_parent")));
                }
                if self.dav_locked(&to, request)? {
                    return Ok(plain(423, word("dav_locked")));
                }
                let replaced = self.dav_taken(&to)?;
                if replaced {
                    if request.overwrite.is_some_and(|overwrite| overwrite.trim().eq_ignore_ascii_case("F")) {
                        return Ok(plain(412, word("dav_exists")));
                    }
                    match self.dav_set_aside(&to)? {
                        Carried::Done => {}
                        Carried::Unfinished => return Ok(Response::new(503, &[("retry-after", "1")], word("dav_unfinished"))),
                        Carried::Conflict => return Ok(plain(409, word("dav_conflict"))),
                    }
                }
                let kept = method == "COPY";
                let carried = if kept && matches!(entry, Entry::Folder) && request.depth.map(str::trim) == Some("0") {
                    self.ensure_folders(&LIVE, &to, &request_key(&method, &to, &now))?;
                    Carried::Done
                } else {
                    self.dav_carry(Carry { source: &LIVE, from: &name, target: &LIVE, to: &to, kept })?
                };
                Ok(match carried {
                    Carried::Done => {
                        if !kept {
                            self.dav_drop_lock(&name, &now)?;
                        }
                        Response::new(if replaced { 204 } else { 201 }, &[], Vec::new())
                    }
                    Carried::Unfinished => Response::new(503, &[("retry-after", "1")], word("dav_unfinished")),
                    Carried::Conflict => plain(409, word("dav_conflict")),
                })
            }
        }
    }
}

/// The write half as the account files' `dav_write` operation input: {prefix, method, path, depth?, destination?,
/// overwrite?, if_match?, if_none_match?, content_type?, body_base64?}.
pub fn request_of<'a>(input: &'a Value, body: &'a [u8]) -> Option<WriteRequest<'a>> {
    let field = |name: &str| input.get(name).and_then(Value::as_str);
    Some(WriteRequest {
        method: field("method")?,
        path: field("path").unwrap_or(""),
        depth: field("depth"),
        destination: field("destination"),
        overwrite: field("overwrite"),
        if_match: field("if_match"),
        if_none_match: field("if_none_match"),
        content_type: field("content_type"),
        if_header: field("if"),
        lock_token: field("lock_token"),
        timeout: field("timeout"),
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_destination_is_a_name_below_the_same_prefix() {
        assert_eq!(destination_name("/dav", "https://door.test/dav/a%20b.txt").as_deref(), Some("/a b.txt"));
        assert_eq!(destination_name("/dav", "/dav/Notes/").as_deref(), Some("/Notes"));
        assert_eq!(destination_name("/dav", "http://door.test/dav").as_deref(), Some("/"));
        assert_eq!(destination_name("/dav", "/dav/x?y=1").as_deref(), Some("/x"));
        assert_eq!(destination_name("/dav", "/davs/x"), None);
        assert_eq!(destination_name("/dav", "/other/x"), None);
        assert_eq!(destination_name("/dav", "/dav/%FF"), None);
    }

    #[test]
    fn preconditions_are_the_file_identity_or_any() {
        let file = Entry::File { identity: "1f:ab".into(), byte_length: 1, modified_at_ms: None, media_type: None };
        let ask = |if_match: Option<&'static str>, if_none_match: Option<&'static str>| WriteRequest { if_match, if_none_match, ..Default::default() };
        assert!(preconditions_hold(&ask(Some("\"1f:ab\""), None), Some(&file)));
        assert!(preconditions_hold(&ask(Some("W/\"1f:ab\", \"x\""), None), Some(&file)));
        assert!(!preconditions_hold(&ask(Some("\"1f:cd\""), None), Some(&file)));
        assert!(!preconditions_hold(&ask(Some("*"), None), None));
        assert!(preconditions_hold(&ask(None, Some("*")), None));
        assert!(!preconditions_hold(&ask(None, Some("*")), Some(&file)));
        assert!(preconditions_hold(&ask(Some("*"), None), Some(&Entry::Folder)));
        assert!(!preconditions_hold(&ask(Some("\"1f:ab\""), None), Some(&Entry::Folder)));
    }

    #[test]
    fn a_lock_token_is_a_random_uuid_and_its_time_is_bounded() {
        let token = new_lock_token().unwrap();
        assert_eq!(token.len(), "opaquelocktoken:".len() + 36);
        assert_ne!(token, new_lock_token().unwrap());
        assert_eq!(presented_tokens(Some("(<opaquelocktoken:a> [\"1f:x\"]) (<b>)")), vec!["opaquelocktoken:a", "b"]);
        assert!(presented_tokens(None).is_empty());
        let limits = &settings().dav;
        assert_eq!(lock_seconds(None), limits.lock_default_seconds);
        assert_eq!(lock_seconds(Some("Second-60, Infinite")), 60);
        assert_eq!(lock_seconds(Some("Infinite")), limits.lock_most_seconds);
        assert_eq!(lock_seconds(Some("Second-99999999")), limits.lock_most_seconds);
    }

    #[test]
    fn only_the_five_writes_are_writes() {
        for method in ["PUT", "delete", "MKCOL", "Copy", "MOVE", "LOCK", "unlock"] {
            assert!(is_write(method), "{method}");
        }
        for method in ["GET", "HEAD", "PROPFIND", "OPTIONS", "PROPPATCH"] {
            assert!(!is_write(method), "{method}");
        }
    }
}
