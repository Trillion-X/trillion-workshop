// examples/account_files_standin.rs
//
// Purpose: The stand-in S3-compatible store every clone proof points its files at, so a proof that writes files
// never reaches a real bucket. `serve` runs a loopback store that keeps objects in a scratch folder; `point` rewrites
// a CLONE's origin records so the stand-in is the only store that takes new bytes (every other origin still answers
// reads and takes nothing new); `show` prints the clone's origin records.
// Invariants:
// - The store listens on 127.0.0.1 only. Every request is checked against AWS Signature V4 under the stand-in's own
//   fixed key id and secret (below: public constants of this program, not a credential of anyone); a PUT is kept only
//   when its body's SHA-256 is the one signed; a GET is answered only for an exact `Range` (206 with `Content-Range`),
//   HEAD with the object's length and type; a bucket listing answers one empty page.
// - `point` changes only the `@namespace/origins` records of the store file it is given, naming the version read, and
//   sends no request anywhere. It refuses a store file whose folder holds a live app state lock (an app serving
//   that state), so it is never run against a live account.
// - The stand-in's secret is a vault name in the origin record (`standin-application-key`): the caller puts the value
//   `STAND_IN_SECRET` under that name in the clone's vault (`trillion-local connect-service STORE ACCOUNT
//   --kind s3-compatible --service standin --field application-key --from-file VALUE_FILE`, which holds it as the
//   SigV4 signing root; `secrets put` would hold it bare and the store could not sign with it), the same road
//   every other store's secret takes.
// Key concepts: `account_files::objects::Origin`, `account_files::ORIGINS`, record store versioned writes, `Origin::takes_new_bytes`.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage:
//   account_files_standin serve FOLDER PORT          keep objects in FOLDER; prints {"listening": "127.0.0.1:PORT", "bucket", "key_id"}
//   account_files_standin point RECORD_STORE_SQLITE ACCOUNT PORT   make the stand-in at PORT the one store taking new bytes; makes
//                                                     RECORD_STORE_SQLITE (an empty store) when the file is absent
//   account_files_standin show RECORD_STORE_SQLITE ACCOUNT    print every origin record with its version

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::Arc,
    thread,
};
use trillion_local::{
    account_files::{
        objects::{Origin, Reach, Source},
        ORIGINS,
    },
    records::{Mutation, Records, MAX_PAGE_ITEMS},
    sqlite_work::WorkMeter,
    storage::record_store_resources,
};

type Failure = Box<dyn std::error::Error>;

/// The stand-in's own facts. They name nothing real and open nothing but this program.
const BUCKET: &str = "standin";
const KEY_ID: &str = "standin-key";
/// The value to put under the vault name `SECRET_NAME` in a clone's vault.
const STAND_IN_SECRET: &str = "standin-secret";
const SECRET_NAME: &str = "standin-application-key";
const ORIGIN_ID: &str = "standin";
const USAGE: &str = "usage: account_files_standin serve FOLDER PORT | point RECORD_STORE_SQLITE ACCOUNT PORT | show RECORD_STORE_SQLITE ACCOUNT";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn mac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac takes any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// Whether a request's AWS Signature V4 (its `Authorization` header, over the headers it names) is the one the
/// stand-in's secret makes for it.
fn signature_matches(method: &str, path: &str, query: &str, header: &dyn Fn(&str) -> Option<String>) -> bool {
    let Some(authorization) = header("authorization") else { return false };
    let Some(fields) = authorization.strip_prefix("AWS4-HMAC-SHA256 ") else { return false };
    let field = |name: &str| fields.split(", ").find_map(|part| part.strip_prefix(name)).map(str::to_owned);
    let (Some(credential), Some(signed), Some(signature)) = (field("Credential="), field("SignedHeaders="), field("Signature=")) else {
        return false;
    };
    let Some((key_id, scope)) = credential.split_once('/') else { return false };
    let parts: Vec<&str> = scope.split('/').collect();
    let (Some(date), [day, region, service, terminator]) = (header("x-amz-date"), parts.as_slice()) else { return false };
    if key_id != KEY_ID {
        return false;
    }
    let mut canonical = format!("{method}\n{path}\n{query}\n");
    for name in signed.split(';') {
        canonical.push_str(&format!("{name}:{}\n", header(name).unwrap_or_default()));
    }
    canonical.push_str(&format!("\n{signed}\n{}", header("x-amz-content-sha256").unwrap_or_default()));
    let to_sign = format!("AWS4-HMAC-SHA256\n{date}\n{scope}\n{}", hex(&Sha256::digest(canonical.as_bytes())));
    let mut key = mac(format!("AWS4{STAND_IN_SECRET}").as_bytes(), day);
    for part in [region, service, terminator] {
        key = mac(&key, part);
    }
    hex(&mac(&key, &to_sign)) == signature
}

/// Where an object's bytes and its media type are kept in the scratch folder: named by the SHA-256 of its key.
fn object_files(folder: &Path, key: &str) -> (PathBuf, PathBuf) {
    let name = hex(&Sha256::digest(key.as_bytes()));
    (folder.join(&name), folder.join(format!("{name}.type")))
}

/// One request to the stand-in store.
fn answer(client: TcpStream, folder: &Path) -> Result<(), Failure> {
    let mut reader = BufReader::new(client.try_clone()?);
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        if reader.read_until(b'\n', &mut head)? == 0 {
            return Ok(());
        }
    }
    let mut slots = [httparse::EMPTY_HEADER; 32];
    let mut request = httparse::Request::new(&mut slots);
    request.parse(&head)?;
    let header = |name: &str| request.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| String::from_utf8_lossy(h.value).trim().to_owned());
    let method = request.method.ok_or("no method")?.to_owned();
    let target = request.path.ok_or("no target")?.to_owned();
    let length: usize = header("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    let mut client = client;
    let mut reply = |status: &str, headers: &[(&str, String)], body: &[u8]| -> Result<(), Failure> {
        let mut text = format!("HTTP/1.1 {status}\r\nConnection: close\r\n");
        for (name, value) in headers {
            text.push_str(&format!("{name}: {value}\r\n"));
        }
        if !headers.iter().any(|(name, _)| *name == "Content-Length") {
            text.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        text.push_str("\r\n");
        client.write_all(text.as_bytes())?;
        if method != "HEAD" {
            client.write_all(body)?;
        }
        Ok(())
    };
    let payload = header("x-amz-content-sha256").unwrap_or_default();
    if !signature_matches(&method, path, query, &header) || payload != hex(&Sha256::digest(&body)) {
        eprintln!("account_files_standin: refused {method} {path}");
        return reply("403 Forbidden", &[], b"<Error><Code>SignatureDoesNotMatch</Code><Message>stand-in</Message></Error>");
    }
    let Some(key) = path.strip_prefix(&format!("/{BUCKET}/")) else {
        let xml = "<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>0</KeyCount></ListBucketResult>";
        return reply("200 OK", &[("Content-Type", "application/xml".into())], xml.as_bytes());
    };
    let (bytes_file, type_file) = object_files(folder, key);
    match method.as_str() {
        "PUT" => {
            fs::write(&bytes_file, &body)?;
            fs::write(&type_file, header("content-type").unwrap_or_default())?;
            eprintln!("account_files_standin: kept {} bytes at {key}", body.len());
            reply("200 OK", &[], b"")
        }
        "HEAD" => match fs::metadata(&bytes_file) {
            Ok(meta) => reply("200 OK", &[("Content-Length", meta.len().to_string()), ("Content-Type", fs::read_to_string(&type_file).unwrap_or_default())], b""),
            Err(_) => reply("404 Not Found", &[("Content-Length", "0".into())], b""),
        },
        "GET" => {
            let Ok(bytes) = fs::read(&bytes_file) else { return reply("404 Not Found", &[], b"") };
            let range = header("range").and_then(|range| {
                let (from, to) = range.strip_prefix("bytes=")?.split_once('-')?;
                Some((from.parse::<usize>().ok()?, to.parse::<usize>().ok()?))
            });
            match range {
                Some((from, to)) if from <= to && from < bytes.len() => {
                    let to = to.min(bytes.len() - 1);
                    reply("206 Partial Content", &[("Content-Range", format!("bytes {from}-{to}/{}", bytes.len()))], &bytes[from..=to])
                }
                _ => reply("416 Range Not Satisfiable", &[], b""),
            }
        }
        _ => reply("405 Method Not Allowed", &[], b""),
    }
}

/// Bind the stand-in's loopback port (0: any free port) over the scratch `folder`.
fn listen(folder: &str, port: u16) -> Result<(TcpListener, Arc<PathBuf>), Failure> {
    Ok((TcpListener::bind((Ipv4Addr::LOCALHOST, port))?, Arc::new(fs::canonicalize(folder)?)))
}

/// Answer every request that comes in, each on its own thread.
fn accept(listener: TcpListener, folder: Arc<PathBuf>) {
    for client in listener.incoming().flatten() {
        let folder = folder.clone();
        thread::spawn(move || {
            if let Err(error) = answer(client, &folder) {
                eprintln!("account_files_standin: {error}");
            }
        });
    }
}

fn serve(folder: &str, port: u16) -> Result<(), Failure> {
    let (listener, folder) = listen(folder, port)?;
    println!("{}", json!({ "listening": listener.local_addr()?.to_string(), "bucket": BUCKET, "key_id": KEY_ID }));
    std::io::stdout().flush()?;
    accept(listener, folder);
    Ok(())
}

/// Open the store file `path` of a clone (its folder must hold no live app state lock).
fn open_clone(path: &str) -> Result<trillion_local::storage::record_store::RecordStore<impl trillion_local::storage::Storage + Send>, Failure> {
    // The folder must exist; the store file is made there when absent (a clone that gets only the stand-in, no copy of
    // the person's real store and so no real origin at all).
    let given = Path::new(path);
    let folder = fs::canonicalize(given.parent().filter(|folder| !folder.as_os_str().is_empty()).unwrap_or(Path::new(".")))?;
    let path = folder.join(given.file_name().ok_or("a store file has a name")?);
    let folder = folder.as_path();
    if folder.join("local-runtime.lock").exists() {
        return Err("the store's folder holds a local-runtime.lock: an app may be serving it; clone it and remove the clone's lock first".into());
    }
    Ok(record_store_resources::open(&path, WorkMeter::new())?)
}

fn put<T: trillion_local::storage::Storage + Send>(store: &mut trillion_local::storage::record_store::RecordStore<T>, account: &str, id: &str, origin: &Origin) -> Result<Value, Failure> {
    let value = serde_json::to_value(origin)?;
    let (version, _) = store.held_record_with_version(account, ORIGINS, id)?;
    let request_key = format!("{id}@{version}@{}", content_crypto::advanced::blake3::hash(value.to_string().as_bytes()).to_hex());
    let change = store.mutate(account, ORIGINS, Mutation { id: id.to_owned(), expected_version: version, request_key, deleted: false, value })?;
    Ok(json!({ "origin": id, "version_before": version, "version": change.version, "takes_new_bytes": origin.takes_new_bytes }))
}

fn point(path: &str, account: &str, port: u16) -> Result<(), Failure> {
    let mut store = open_clone(path)?;
    let others: Vec<(String, Origin)> = store
        .list_page(account, ORIGINS, "", MAX_PAGE_ITEMS)?
        .items
        .into_iter()
        .filter(|record| record.id != ORIGIN_ID)
        .map(|record| Ok((record.id, serde_json::from_value(record.value)?)))
        .collect::<Result<_, serde_json::Error>>()?;
    for (id, mut origin) in others {
        if origin.takes_new_bytes {
            origin.takes_new_bytes = false;
            println!("{}", put(&mut store, account, &id, &origin)?);
        }
    }
    let standin = Origin {
        kind: "namespace-origin".into(),
        rank: 0,
        takes_new_bytes: true,
        file_key_prefix: "people/standin/files/".into(),
        bound_to: None,
        reach: Reach {
            key_id: Source::Value(KEY_ID.into()),
            secret: Source::Held(SECRET_NAME.into()),
            bucket: Source::Value(BUCKET.into()),
            endpoint: Source::Value(format!("http://127.0.0.1:{port}")),
            region: Source::Value("us-east-1".into()),
        },
    };
    println!("{}", put(&mut store, account, ORIGIN_ID, &standin)?);
    println!("{}", json!({ "next": format!("put the value `{STAND_IN_SECRET}` under the vault name `{SECRET_NAME}` in the clone's vault with `connect-service --kind s3-compatible --service standin --field application-key --from-file`") }));
    Ok(())
}

fn show(path: &str, account: &str) -> Result<(), Failure> {
    let store = open_clone(path)?;
    for record in store.list_page(account, ORIGINS, "", MAX_PAGE_ITEMS)?.items {
        println!("{}", json!({ "origin": record.id, "version": record.version, "record": record.value }));
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["serve", folder, port] => port.parse().map_err(Failure::from).and_then(|port| serve(folder, port)),
        ["point", path, account, port] => port.parse().map_err(Failure::from).and_then(|port| point(path, account, port)),
        ["show", path, account] => show(path, account),
        _ => Err(USAGE.into()),
    };
    if let Err(error) = result {
        eprintln!("account_files_standin: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use trillion_local::account_files::objects::{Secrets, ObjectError, Objects, S3Objects};
    use zeroize::Zeroizing;

    /// The vault the engine would hold the stand-in's connection facts in; `secret` is the value held under
    /// `SECRET_NAME`.
    struct Vault {
        secret: &'static str,
    }
    impl Secrets for Vault {
        fn plain(&self, name: &str) -> Result<Zeroizing<String>, ObjectError> {
            Err(ObjectError::NotHeld(name.into(), trillion_local::cause!()))
        }
        fn sigv4_day_key(&self, name: &str, day: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError> {
            if name != SECRET_NAME {
                return Err(ObjectError::NotHeld(name.into(), trillion_local::cause!()));
            }
            Ok(Zeroizing::new(mac(format!("AWS4{}", self.secret).as_bytes(), day)))
        }
        fn holds(&self, name: &str) -> Result<bool, ObjectError> {
            Ok(name == SECRET_NAME)
        }
    }

    fn origins(port: u16) -> Vec<(String, Origin)> {
        let reach = Reach {
            key_id: Source::Value(KEY_ID.into()),
            secret: Source::Held(SECRET_NAME.into()),
            bucket: Source::Value(BUCKET.into()),
            endpoint: Source::Value(format!("http://127.0.0.1:{port}")),
            region: Source::Value("us-east-1".into()),
        };
        vec![(ORIGIN_ID.into(), Origin { kind: "namespace-origin".into(), rank: 0, takes_new_bytes: true, file_key_prefix: "p/".into(), bound_to: None, reach })]
    }

    #[test]
    fn the_stand_in_keeps_a_signed_put_serves_exact_ranges_and_refuses_a_wrong_secret() {
        let folder = tempfile::tempdir().unwrap();
        let (listener, kept) = listen(folder.path().to_str().unwrap(), 0).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || accept(listener, kept));
        let right = S3Objects::unmetered(origins(port), Box::new(Vault { secret: STAND_IN_SECRET }), "operator example account_files_standin").unwrap();
        right.write(ORIGIN_ID, "p/object", b"hello stand-in", "text/plain").unwrap();
        assert_eq!(right.read(ORIGIN_ID, "p/object", 6, 8).unwrap(), b"stand-in");
        let wrong = S3Objects::unmetered(origins(port), Box::new(Vault { secret: "another-secret" }), "operator example account_files_standin").unwrap();
        assert!(matches!(wrong.write(ORIGIN_ID, "p/refused", b"never kept", "text/plain"), Err(ObjectError::Refused(403, _)) | Err(ObjectError::Denied(403, _, _))));
        assert!(wrong.read(ORIGIN_ID, "p/object", 0, 1).is_err(), "a wrong secret reads nothing either");
        let bytes_files = fs::read_dir(folder.path()).unwrap().flatten().filter(|entry| entry.path().extension().is_none()).count();
        assert_eq!(bytes_files, 1, "only the signed object was kept");
    }
}
