//! A Better Auth signer for integration tests: signs a person in to an account the way the Better Auth Workshop tool
//! does (trillion-workshop tools/better-auth), so a test reaches an account's door end to end with a real token.
//!
//! The engine checks a token by its signature against a JWKS it reads from `jwks_url` (src/account/signed_in.rs and
//! src/auth_pass.rs, http on a loopback host is allowed), with every value from `src/account/signed_in/settings.json` or the file its
//! `override_env` names. This module serves its own JWKS on a loopback port in this test process and names it in an
//! override settings file, so the engine (and every `trillion-local` process the test starts, which inherits the
//! environment) reads this signer's public key. Nothing else of the shipped settings changes.
//!
//! The settings are read once per process: `install` runs before the first computer of a test starts
//! (`computer_config` calls it), so no check in this process reads the shipped JWKS address first.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::signature::{Ed25519KeyPair, KeyPair as _};
use serde_json::{json, Value};
use std::{
    io::{Read as _, Write as _},
    net::TcpListener,
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

/// The key id this signer's JWKS names.
const KID: &str = "integration-tests";
/// How long a token this signer makes lives, in seconds.
const TOKEN_SECONDS: u64 = 3600;

struct Signer {
    pkcs8: Vec<u8>,
    settings: Value,
    /// The override settings file's folder, kept for the life of the process.
    _folder: tempfile::TempDir,
}

/// The process's signer: made, served and named in the environment at its first use.
fn signer() -> &'static Signer {
    static SIGNER: OnceLock<Signer> = OnceLock::new();
    SIGNER.get_or_init(|| {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap().as_ref().to_vec();
        let public = Ed25519KeyPair::from_pkcs8(&pkcs8).unwrap().public_key().as_ref().to_vec();
        let jwks = json!({"keys": [{"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": KID,
            "x": URL_SAFE_NO_PAD.encode(public)}]})
        .to_string();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || serve_jwks(listener, jwks));
        let mut settings: Value = serde_json::from_str(include_str!("../../src/account/signed_in/settings.json")).unwrap();
        settings["jwks_url"] = json!(format!("http://127.0.0.1:{port}/api/auth/jwks"));
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("signed-in-settings.json");
        std::fs::write(&path, settings.to_string()).unwrap();
        std::env::set_var(settings["override_env"].as_str().unwrap(), &path);
        Signer { pkcs8, settings, _folder: folder }
    })
}

/// Answer every GET with the JWKS, one request per connection.
fn serve_jwks(listener: TcpListener, jwks: String) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") && head.len() < 16 * 1024 {
            match stream.read(&mut byte) {
                Ok(1) => head.push(byte[0]),
                _ => break,
            }
        }
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{jwks}",
            jwks.len()
        );
    }
}

/// Point this process's sign-in check at the signer. Idempotent; call before the first computer starts.
pub fn install() {
    signer();
}

/// A signed-in token for the account at `address`, as Better Auth signs one after a person signs in: the first pass the
/// settings accept (`passes[0]`), with its issuer, audience and header type, and the address at its `account_pointer`.
pub fn token(address: &str) -> String {
    let signer = signer();
    let pass = &signer.settings["passes"][0];
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let mut claims = json!({"sub": format!("integration-test-{address}"), "iss": pass["iss"], "aud": pass["aud"],
        "iat": now, "nbf": now, "exp": now + TOKEN_SECONDS});
    let pointer: Vec<&str> = pass["account_pointer"].as_str().unwrap().trim_start_matches('/').split('/').collect();
    let mut at = &mut claims;
    for (index, name) in pointer.iter().enumerate() {
        if index + 1 == pointer.len() { at[*name] = json!(address); } else { at = &mut at[*name]; }
    }
    let mut header = json!({"alg": "EdDSA", "kid": KID});
    if let Some(typ) = pass["typ"].as_str() {
        header["typ"] = json!(typ);
    }
    let head = URL_SAFE_NO_PAD.encode(header.to_string());
    let body = URL_SAFE_NO_PAD.encode(claims.to_string());
    let pair = Ed25519KeyPair::from_pkcs8(&signer.pkcs8).unwrap();
    let signature = URL_SAFE_NO_PAD.encode(pair.sign(format!("{head}.{body}").as_bytes()));
    format!("{head}.{body}.{signature}")
}
