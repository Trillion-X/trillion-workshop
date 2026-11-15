// src/storage/supplies/s3/mod.rs
//
// Purpose: The S3-API `Backend` for the shared key-value supply, spoken to MinIO over HTTP with Signature V4 (the same
// wire as S3 and R2). An object store has no ordered batch and no reverse listing, so this backend builds what the
// contract needs from the two things S3 does give: lexicographic listing and conditional puts.
//
// Non-Negotiable Invariants:
// - Order: a key is an object named by the lowercase hex of its bytes, so S3's ascending listing is byte order. Reverse
//   order is a second set of objects, one empty object per key named by the key's hex digits reversed in value plus a
//   terminator, so ascending listing of that set is descending key order. Both sets are written and deleted together.
// - Batches are crash-atomic, not isolated: the record protocol of `kv::wal` over conditional puts (`If-None-Match: *`).
//   A concurrent reader can see a batch half applied; a second concurrent writer is refused while a record stands.
//   `Atomicity::CrashSafe` says so.
// - Reads are by key, one object per request: a range with values costs one listing plus one request per key.
//
// Key Concepts:
// - `S3::connect(url, store_name)`: `http://access:secret@host:port/bucket`; makes the bucket if missing.
// - Object names: `<namespace>/d/<hex key>` (data), `<namespace>/r/<reversed hex>~` (reverse index).
//
// Security Considerations:
// - Requests are signed with the caller's access key; the secret never leaves this process and `place` omits it.
// - SHA-256 and HMAC are the signature algorithm S3 mandates, not an internal content identity.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::kv::{
    names::{hex, reversed, unhex, unreversed},
    wal::{self, Plain},
    Atomicity, Backend, Limits, Outcome, Write,
};
use hmac::{Hmac, Mac};
use local_engine::storage::{Error, Result};
use sha2::{Digest, Sha256};
use std::{cell::Cell, fmt::Write as _, time::Instant};
use crate::provider_units::{self, Quantity, Recorder};

type HmacSha256 = Hmac<Sha256>;

pub struct S3 {
    agent: ureq::Agent,
    endpoint: String,
    host: String,
    bucket: String,
    store_name: String,
    access: String,
    secret: String,
    rounds: Cell<u64>,
    measurements: Recorder,
}

fn sign(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            other => {
                let _ = write!(out, "%{other:02X}");
            }
        }
    }
    out
}

/// What a request answered: the status and the body.
struct Answer {
    status: u16,
    body: Vec<u8>,
}

impl S3 {
    /// Connect with `http://access:secret@host:port/bucket` and use the object names of `store_name`.
    pub fn connect(url: &str, store_name: &str) -> Result<Self> {
        let rest = url.strip_prefix("http://").ok_or(local_engine::cause!(Error::Invalid))?;
        let (credentials, rest) = rest.split_once('@').ok_or(local_engine::cause!(Error::Invalid))?;
        let (access, secret) = credentials.split_once(':').ok_or(local_engine::cause!(Error::Invalid))?;
        let (host, bucket) = rest.split_once('/').ok_or(local_engine::cause!(Error::Invalid))?;
        let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(60)).build();
        let s3 = Self {
            agent,
            endpoint: format!("http://{host}"),
            host: host.to_owned(),
            bucket: bucket.trim_end_matches('/').to_owned(),
            store_name: store_name.to_owned(),
            access: access.to_owned(),
            secret: secret.to_owned(),
            rounds: Cell::new(0),
            measurements: Recorder::default(),
        };
        // Making a bucket that exists answers 409 (or 200 on some servers); both mean it is there.
        let made = s3.request("PUT", "", &[], &[], &[])?;
        if !matches!(made.status, 200 | 409) {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        wal::recover(&s3)?;
        Ok(s3)
    }

    /// One signed request. `object` is the name below the bucket ("" for the bucket itself).
    fn request(&self, method: &str, object: &str, query: &[(&str, String)], headers: &[(&str, &str)], body: &[u8]) -> Result<Answer> {
        self.rounds.set(self.rounds.get() + 1);
        let operation = match (method, query.iter().any(|(key, _)| *key == "list-type"), object.is_empty()) {
            ("GET", true, _) => "s3.list_objects_v2",
            ("GET", false, _) => "s3.get_object",
            ("PUT", _, true) => "s3.create_bucket",
            ("PUT", _, false) => "s3.put_object",
            ("DELETE", _, _) => "s3.delete_object",
            _ => "s3.other_request",
        };
        let items = if operation == "s3.list_objects_v2" { Quantity::Unknown } else { Quantity::Measured(1) };
        let started_unix_ms = provider_units::now_unix_ms();
        let started = Instant::now();
        let now = chrono::DateTime::from_timestamp(
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))?.as_secs() as i64,
            0,
        )
        .ok_or(local_engine::cause!(Error::Unavailable))?;
        let stamp = now.format("%Y%m%dT%H%M%SZ").to_string();
        let day = now.format("%Y%m%d").to_string();
        let path = if object.is_empty() { format!("/{}", self.bucket) } else { format!("/{}/{}", self.bucket, object) };
        let mut pairs: Vec<(String, String)> = query.iter().map(|(name, value)| (encode_component(name), encode_component(value))).collect();
        pairs.sort();
        let canonical_query: Vec<String> = pairs.iter().map(|(name, value)| format!("{name}={value}")).collect();
        let canonical_query = canonical_query.join("&");
        let payload = hex(&Sha256::digest(body));
        let canonical = format!(
            "{method}\n{path}\n{canonical_query}\nhost:{}\nx-amz-content-sha256:{payload}\nx-amz-date:{stamp}\n\nhost;x-amz-content-sha256;x-amz-date\n{payload}",
            self.host
        );
        let scope = format!("{day}/us-east-1/s3/aws4_request");
        let to_sign = format!("AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{}", hex(&Sha256::digest(canonical.as_bytes())));
        let mut key = sign(format!("AWS4{}", self.secret).as_bytes(), &day);
        for part in ["us-east-1", "s3", "aws4_request"] {
            key = sign(&key, part);
        }
        let signature = hex(&sign(&key, &to_sign));
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}",
            self.access
        );
        let url = if canonical_query.is_empty() { format!("{}{path}", self.endpoint) } else { format!("{}{path}?{canonical_query}", self.endpoint) };
        let mut call = self
            .agent
            .request(method, &url)
            .set("x-amz-date", &stamp)
            .set("x-amz-content-sha256", &payload)
            .set("Authorization", &authorization);
        for (name, value) in headers {
            call = call.set(name, value);
        }
        let response = if body.is_empty() && method != "PUT" { call.call() } else { call.send_bytes(body) };
        let (status, response) = match response {
            Ok(response) => (response.status(), response),
            Err(ureq::Error::Status(status, response)) => (status, response),
            Err(_) => {
                self.measurements.record("s3", operation, &format!("{}/{}", self.bucket, self.store_name), started_unix_ms,
                    started.elapsed().as_millis() as u64, Quantity::Measured(body.len() as u64), Quantity::Unknown,
                    Quantity::Unknown, items.clone(), Quantity::Unknown, Quantity::Unknown, 1);
                return Err(local_engine::cause!(Error::Unavailable));
            }
        };
        let request_bytes = body.len() as u64;
        let mut response_body = Vec::new();
        if std::io::Read::read_to_end(&mut response.into_reader(), &mut response_body).is_err() {
            self.measurements.record("s3", operation, &format!("{}/{}", self.bucket, self.store_name), started_unix_ms,
                started.elapsed().as_millis() as u64, Quantity::Measured(request_bytes), Quantity::Unknown,
                Quantity::Measured(status), items.clone(), Quantity::Unknown, Quantity::Unknown, 1);
            return Err(local_engine::cause!(Error::Unavailable));
        }
        self.measurements.record("s3", operation, &format!("{}/{}", self.bucket, self.store_name), started_unix_ms,
            started.elapsed().as_millis() as u64, Quantity::Measured(request_bytes), Quantity::Measured(response_body.len() as u64),
            Quantity::Measured(status), items, Quantity::Unknown, Quantity::Unknown,
            u64::from(status >= 400 && !expected_status(operation, status, headers)));
        Ok(Answer { status, body: response_body })
    }

    /// A snapshot of actual signed HTTP attempts, grouped by S3 API operation
    /// class. Payload byte counts exclude headers and are not billing units.
    pub fn measurements(&self) -> Vec<provider_units::Observation> { self.measurements.snapshot() }

    fn data(&self, key: &[u8]) -> String {
        format!("{}/d/{}", self.store_name, hex(key))
    }
    fn mirror(&self, key: &[u8]) -> String {
        format!("{}/r/{}", self.store_name, reversed(key))
    }

    fn store(&self, object: &str, body: &[u8], headers: &[(&str, &str)]) -> Result<u16> {
        Ok(self.request("PUT", object, &[], headers, body)?.status)
    }

    /// Object names under `prefix`, ascending, after `start_after` (exclusive), until `stop` says to.
    fn list(&self, prefix: &str, start_after: &str, limit: usize, stop: impl Fn(&str) -> bool) -> Result<Vec<String>> {
        let mut found = Vec::new();
        let mut token: Option<String> = None;
        let mut start = Some(start_after.to_owned());
        loop {
            let ask = (limit - found.len()).clamp(1, 1000);
            let mut query = vec![("list-type", "2".to_owned()), ("prefix", prefix.to_owned()), ("max-keys", ask.to_string())];
            if let Some(token) = &token {
                query.push(("continuation-token", token.clone()));
            } else if let Some(start) = start.as_ref().filter(|start| !start.is_empty()) {
                query.push(("start-after", start.clone()));
            }
            start = None;
            let answer = self.request("GET", "", &query, &[], &[])?;
            if answer.status != 200 {
                return Err(local_engine::cause!(Error::Unavailable));
            }
            let text = String::from_utf8(answer.body).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error))?;
            for name in tags(&text, "Key") {
                let tail = name.strip_prefix(prefix).ok_or(local_engine::cause!(Error::Unavailable))?;
                if stop(tail) {
                    return Ok(found);
                }
                found.push(tail.to_owned());
                if found.len() >= limit {
                    return Ok(found);
                }
            }
            if tags(&text, "IsTruncated").first().map(String::as_str) != Some("true") {
                return Ok(found);
            }
            token = tags(&text, "NextContinuationToken").into_iter().next();
            if token.is_none() {
                return Ok(found);
            }
        }
    }

    fn remove(&self, object: &str) -> Result<()> {
        match self.request("DELETE", object, &[], &[], &[])?.status {
            200 | 204 | 404 => Ok(()),
            _ => Err(local_engine::cause!(Error::Unavailable)),
        }
    }

    fn fetch(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let answer = self.request("GET", &self.data(key), &[], &[], &[])?;
        match answer.status {
            200 => Ok(Some(answer.body)),
            404 => Ok(None),
            _ => Err(local_engine::cause!(Error::Unavailable)),
        }
    }
}

impl Plain for S3 {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.fetch(key)
    }

    fn put(&self, key: &[u8], value: &[u8]) -> Result<()> {
        if self.store(&self.data(key), value, &[])? != 200 || self.store(&self.mirror(key), &[], &[])? != 200 {
            return Err(local_engine::cause!(Error::Unavailable));
        }
        Ok(())
    }

    fn put_new(&self, key: &[u8], value: &[u8]) -> Result<bool> {
        match self.store(&self.data(key), value, &[("If-None-Match", "*")])? {
            200 => {
                if self.store(&self.mirror(key), &[], &[])? != 200 {
                    return Err(local_engine::cause!(Error::Unavailable));
                }
                Ok(true)
            }
            412 => Ok(false),
            _ => Err(local_engine::cause!(Error::Unavailable)),
        }
    }

    fn delete(&self, key: &[u8]) -> Result<()> {
        self.remove(&self.data(key))?;
        self.remove(&self.mirror(key))
    }
}

fn expected_status(operation: &str, status: u16, headers: &[(&str, &str)]) -> bool {
    match (operation, status) {
        ("s3.get_object" | "s3.delete_object", 404) => true,
        ("s3.create_bucket", 409) => true,
        ("s3.put_object", 412) if headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("If-None-Match") && *value == "*") => true,
        _ => false,
    }
}

/// The text of every `<tag>...</tag>` in an XML answer.
fn tags(xml: &str, tag: &str) -> Vec<String> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut found = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        found.push(after[..end].to_owned());
        rest = &after[end + close.len()..];
    }
    found
}

impl Backend for S3 {
    fn atomicity(&self) -> Atomicity {
        Atomicity::CrashSafe
    }

    fn limits(&self) -> Limits {
        // An object name is at most 1024 bytes: the store name, `/d/`, and two hex digits per key byte.
        Limits { max_key: (1024 - self.store_name.len() - 8) / 2, max_value: 64 * 1024 * 1024, max_writes: usize::MAX / 2 }
    }

    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.fetch(key)
    }

    fn get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>> {
        keys.iter().map(|key| self.fetch(key)).collect()
    }

    fn range(&self, lo: &[u8], hi: Option<&[u8]>, reverse: bool, limit: usize, values: bool) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        let keys: Vec<Vec<u8>> = if reverse {
            // Ascending names of the reverse index, after the upper end (exclusive), until a key below the lower end.
            let lowest = reversed(lo);
            let start = hi.map_or(String::new(), reversed);
            let prefix = format!("{}/r/", self.store_name);
            let after = if start.is_empty() { String::new() } else { format!("{prefix}{start}") };
            self.list(&prefix, &after, limit, |name| name > lowest.as_str())?.iter().filter_map(|name| unreversed(name)).collect()
        } else {
            // The greatest name below `hex(lo)`: its last digit lowered, then `~` (or the shorter prefix for a `0`).
            let low = hex(lo);
            let prefix = format!("{}/d/", self.store_name);
            let after = match low.chars().last() {
                None | Some('0') => format!("{prefix}{}", &low[..low.len().saturating_sub(1)]),
                Some(last) => {
                    let lowered = char::from_digit(last.to_digit(16).unwrap_or(1) - 1, 16).unwrap_or('0');
                    format!("{prefix}{}{lowered}~", &low[..low.len() - 1])
                }
            };
            let end = hi.map(hex);
            self.list(&prefix, &after, limit, |name| end.as_deref().is_some_and(|end| name >= end))?
                .iter()
                .filter_map(|name| unhex(name))
                .collect()
        };
        keys.into_iter()
            .map(|key| {
                let value = if values { self.fetch(&key)?.ok_or(local_engine::cause!(Error::Unavailable))? } else { Vec::new() };
                Ok((key, value))
            })
            .collect()
    }

    fn apply(&self, guard: (&[u8], Option<&[u8]>), writes: &[Write]) -> Result<Outcome> {
        wal::apply(self, 8 * 1024 * 1024, guard, writes)
    }

    fn reclaim(&self) -> Result<()> {
        // A deleted object is gone from the store's drives when its delete returns; there is nothing to rewrite.
        Ok(())
    }

    fn rounds(&self) -> u64 {
        self.rounds.get()
    }

    fn measurements(&self) -> Vec<provider_units::Observation> { self.measurements.snapshot() }
    fn measurement_count(&self) -> usize { self.measurements.len() }
    fn measurements_since(&self, index: usize) -> Vec<provider_units::Observation> { self.measurements.snapshot_since(index) }

    fn place(&self) -> String {
        format!("{}/{} store_name={}", self.endpoint, self.bucket, self.store_name)
    }
}
