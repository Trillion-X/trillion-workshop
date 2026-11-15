//! A fresh Computer's whole test lifetime. Starting rows are the existing synthetic owner fixture;
//! no account, vault, key or config is read from the person's computer.
use super::{tls, Settings};
use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    net::{SocketAddr, TcpListener, TcpStream},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use trillion_local::native_entry::computer::{read_config, Computer};

pub struct Fixture {
    pub origin: String,
    pub ca_pem: Vec<u8>,
    pub address: SocketAddr,
    computer: Option<Arc<Computer>>,
    server: Option<tls::Server>,
    folder: Option<tempfile::TempDir>,
    settings: Settings,
}

impl Fixture {
    pub fn start(settings: Settings) -> Self {
        // macOS's advertised temp parent can contain a /var alias. The real storage owner intentionally opens
        // sign-in SQLite with NOFOLLOW, so create this owned fixture under the actual canonical temp parent.
        // Diagnostic evidence: alias NOFOLLOW open returned SQLITE_CANTOPEN(14); the same owned canonical parent
        // returned SQLITE_OK(0). Seeding an account failed at that same sign-in database open and was not a cure.
        let temporary_parent = fs::canonicalize(std::env::temp_dir()).expect("canonical test temp parent");
        let folder = tempfile::Builder::new()
            .prefix("trillion-isolated-computer-")
            .tempdir_in(temporary_parent)
            .unwrap();
        assert_eq!(fs::canonicalize(folder.path()).unwrap(), folder.path());
        fs::set_permissions(folder.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let accounts = folder.path().join(&settings.accounts_folder);
        fs::create_dir(&accounts).unwrap();
        fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
        let key_file = folder.path().join(&settings.key_file);
        let mut key = [0u8; 32];
        SystemRandom::new().fill(&mut key).unwrap();
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&key_file)
            .unwrap();
        output
            .write_all(
                base64::engine::general_purpose::STANDARD
                    .encode(key)
                    .as_bytes(),
            )
            .unwrap();
        drop(output);
        let listener = TcpListener::bind(&settings.loopback).unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        let origin = format!("https://{}:{}", settings.host, address.port());
        let starting: Value =
            serde_json::from_str(include_str!("../../src/account/rows/new-accounts.json")).unwrap();
        let config = json!({
            "listen": address.to_string(), "accounts": accounts, "place_key_file": key_file, "public_origin": origin,
            "report": {"storage":{"keep_free_bytes":0},"reach":origin,"cost_per_month_cents":0,
                "contained_tools":false,"takes_new_accounts":true},
            "sign_in":{"relying_party_drop_labels":0,"max_body_bytes":settings.maximum_head_bytes,"expired_rows_per_write":100},
            "new_accounts":starting, "tools_at_start":false,
        });
        let config_path = folder.path().join("computer.json");
        fs::write(&config_path, config.to_string()).unwrap();
        let computer = Arc::new(
            Computer::start(read_config(&config_path).expect("synthetic Computer config admitted"))
                .expect("synthetic Computer starts"),
        );
        assert!(computer.accounts().is_empty(), "fixture starts without any account");
        let (ca_pem, identity) = tls::identity(&folder.path().join("tls"));
        let server = tls::Server::start(listener, identity, computer.app(), settings.clone());
        let fixture = Self {
            origin,
            ca_pem,
            address,
            computer: Some(computer),
            server: Some(server),
            folder: Some(folder),
            settings,
        };
        // Ready means a real strict-TLS request reached the actual sign-up route, not merely that a socket was bound.
        let (status, _, body) = fixture.request("GET", "/sign-up", &[], b"");
        assert_eq!(status, 200, "fixture signup page is ready");
        assert!(String::from_utf8_lossy(&body).contains("data-purpose=\"sign-up\""));
        fixture
    }

    pub fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> (u16, Vec<(String, String)>, Vec<u8>) {
        tls::request(self.address, &self.ca_pem, method, path, headers, body)
    }

    /// Independent of signup's response and the browser: read the actual account objects the Computer serves.
    pub fn read_created_account(&self, address: &str) -> Option<Value> {
        if address.len() != 64
            || !address
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return None;
        }
        let computer = self.computer.as_ref()?;
        let matches: Vec<_> = computer
            .accounts()
            .into_iter()
            .filter(|account| account.address() == address)
            .collect();
        if matches.len() != 1 {
            return None;
        }
        let account = &matches[0];
        let accounts = self
            .folder
            .as_ref()?
            .path()
            .join(&self.settings.accounts_folder);
        assert_eq!(
            account.state_root().parent(),
            Some(accounts.as_path()),
            "the account belongs to this temporary root"
        );
        Some(json!({"address":account.address(),"ownerId":account.owner_id()}))
    }

    pub fn close(&mut self) -> Value {
        if self.folder.is_none() {
            return json!({"closed":true,"listener_closed":true,"temporary_root_removed":true});
        }
        if let Some(mut server) = self.server.take() {
            server.close();
        }
        let computer = self.computer.take().unwrap();
        let background = computer.background();
        assert_eq!(
            background.forwarder_sessions, 0,
            "fixture starts no forwarder sessions"
        );
        assert_eq!(
            background.account_timers, 0,
            "fixture starts no account timers"
        );
        assert_eq!(
            background.computer_timers, 0,
            "fixture starts no computer timers"
        );
        let loopbacks: Vec<_> = computer
            .accounts()
            .iter()
            .filter_map(|account| account.loopback_door())
            .collect();
        assert_eq!(
            Arc::strong_count(&computer),
            1,
            "no HTTPS router retains the Computer"
        );
        drop(computer);
        let deadline = Instant::now() + Duration::from_millis(self.settings.close_timeout_ms);
        for address in loopbacks {
            while TcpStream::connect_timeout(&address, Duration::from_millis(self.settings.poll_ms))
                .is_ok()
            {
                assert!(
                    Instant::now() < deadline,
                    "an account loopback door remained open after its owner dropped"
                );
                thread::sleep(Duration::from_millis(self.settings.poll_ms));
            }
        }
        let folder = self.folder.take().unwrap();
        let root = folder.path().to_owned();
        folder
            .close()
            .expect("the fixture removed only its own temporary root");
        assert!(!root.exists());
        json!({"closed":true,"listener_closed":true,"temporary_root_removed":true})
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            self.close();
        }
    }
}
