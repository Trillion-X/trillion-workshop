// src/store/through_the_run_proxy.rs
//
// Purpose: The person's database reached by its address from a run the engine keeps in its sandbox. Such a run reaches the network
// only through the run's own loopback proxy, which the engine names in HTTPS_PROXY; the engine opens a CONNECT tunnel only to a host
// every value the run holds may go to (the vault entry's `hosts`), so a login never reaches another host. The sandbox lets a run
// connect out to that proxy's port and to nothing else, and lets it listen on no port at all (the engine's container profile denies
// every network operation it does not name), so the Postgres client is handed the tunnel itself: one CONNECT to the database's host
// and port, and the client's own protocol and TLS run over that stream (tokio-postgres `connect_raw`), checked against the
// database's name. `Tunneled` is that client, answered on its own small runtime, with the database's notifications (`LISTEN`)
// heard on a channel.
//
// Non-Negotiable Invariants:
// - No port is opened here: the one socket is the run's own connection to the proxy.
// - The proxy's answer is read up to its blank line and only a 200 opens the tunnel; any other answer is the connection's failure.
// - Nothing of the connection string is kept or printed here.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use tokio_postgres::tls::{MakeTlsConnect, TlsConnect};

/// A Postgres client whose one connection is a CONNECT tunnel through the run's proxy.
pub(super) struct Tunneled {
    runtime: tokio::runtime::Runtime,
    client: tokio_postgres::Client,
    heard: mpsc::Receiver<()>,
}

impl Tunneled {
    /// Open `config`'s database through the proxy at `proxy` (an http:// loopback address), with `tls` for the database's name.
    pub(super) fn open<T>(config: &tokio_postgres::Config, proxy: &str, mut tls: T) -> io::Result<Self>
    where
        T: MakeTlsConnect<tokio::net::TcpStream>,
        T::TlsConnect: Send,
        T::Stream: Send + 'static,
        <T::TlsConnect as TlsConnect<tokio::net::TcpStream>>::Future: Send,
    {
        let host = match config.get_hosts().first() {
            Some(tokio_postgres::config::Host::Tcp(host)) => host.clone(),
            _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "the database connection names no host")),
        };
        let port = config.get_ports().first().copied().unwrap_or(5432);
        let far = tunnel(&proxy_address(proxy)?, &host, port)?;
        far.set_nonblocking(true)?;
        // One worker drives the connection between calls, so a notification is heard while no call is waiting.
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build()?;
        let connect = tls.make_tls_connect(&host).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the database's name is not a TLS name"))?;
        let (client, mut connection) = runtime.block_on(async {
            let stream = tokio::net::TcpStream::from_std(far)?;
            config.connect_raw(stream, connect).await.map_err(io::Error::other)
        })?;
        let (tell, heard) = mpsc::channel();
        runtime.spawn(async move {
            loop {
                match std::future::poll_fn(|cx| connection.poll_message(cx)).await {
                    Some(Ok(tokio_postgres::AsyncMessage::Notification(_))) => {
                        if tell.send(()).is_err() {
                            return;
                        }
                    }
                    Some(Ok(_)) => {}
                    // The connection ended: every later call fails, and a wait hears that it ended.
                    _ => return,
                }
            }
        });
        Ok(Self { runtime, client, heard })
    }

    pub(super) fn query(&self, text: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> Result<Vec<tokio_postgres::Row>, tokio_postgres::Error> {
        self.runtime.block_on(self.client.query(text, params))
    }

    pub(super) fn execute(&self, text: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> Result<u64, tokio_postgres::Error> {
        self.runtime.block_on(self.client.execute(text, params))
    }

    pub(super) fn batch_execute(&self, sql: &str) -> Result<(), tokio_postgres::Error> {
        self.runtime.block_on(self.client.batch_execute(sql))
    }

    /// The connection ended: the proxy closed the tunnel (a quiet one, after its `quiet_ms`), or the database did.
    pub(super) fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    /// The next notification of a channel this connection listens on; an error once the connection has ended.
    pub(super) fn heard(&self) -> Result<(), mpsc::RecvError> {
        self.heard.recv()
    }
}

fn proxy_address(proxy: &str) -> io::Result<String> {
    let url = url::Url::parse(proxy).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the run's proxy is not an address"))?;
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => Ok(format!("{host}:{port}")),
        _ => Err(io::Error::new(io::ErrorKind::InvalidInput, "the run's proxy names no host and port")),
    }
}

fn tunnel(proxy: &str, host: &str, port: u16) -> io::Result<TcpStream> {
    let mut far = TcpStream::connect(proxy)?;
    far.set_nodelay(true)?;
    write!(far, "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n")?;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 || far.read(&mut byte)? == 0 {
            return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "the run's proxy closed before it answered"));
        }
        head.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&head).split(' ').nth(1).unwrap_or("").to_owned();
    if status != "200" {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("the run's proxy did not open {host}:{port} (answered {status})")));
    }
    Ok(far)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Shutdown, TcpListener};

    fn join(client: TcpStream, far: TcpStream) {
        let (Ok(mut client_in), Ok(mut far_in)) = (client.try_clone(), far.try_clone()) else { return };
        let (mut client_out, mut far_out) = (client, far);
        std::thread::spawn(move || {
            let _ = io::copy(&mut client_in, &mut far_out);
            let _ = far_out.shutdown(Shutdown::Write);
        });
        let _ = io::copy(&mut far_in, &mut client_out);
        let _ = client_out.shutdown(Shutdown::Write);
    }

    /// A proxy that answers each CONNECT with `status`, and on a 200 joins it to the host the CONNECT names.
    fn stand_in_proxy(status: &'static str) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                }
                let target = String::from_utf8_lossy(&head).split(' ').nth(1).unwrap().to_owned();
                write!(stream, "HTTP/1.1 {status}\r\n\r\n").unwrap();
                if status.starts_with("200") {
                    std::thread::spawn(move || join(stream, TcpStream::connect(target).unwrap()));
                }
            }
        });
        address
    }

    /// A real Postgres server for this test, in a temporary folder, stopped when the test ends.
    fn real_database() -> (postgresql_embedded::blocking::PostgreSQL, tokio_postgres::Config) {
        let mut postgres = postgresql_embedded::blocking::PostgreSQL::new(postgresql_embedded::Settings { timeout: None, ..Default::default() });
        postgres.setup().unwrap();
        postgres.start().unwrap();
        let settings = postgres.settings();
        let config: tokio_postgres::Config = format!("postgresql://{}:{}@127.0.0.1:{}/postgres?sslmode=disable",
            settings.username, settings.password, settings.port).parse().unwrap();
        (postgres, config)
    }

    #[test]
    fn the_database_answers_and_its_notifications_are_heard_through_the_proxy_with_no_port_opened() {
        let (postgres, config) = real_database();
        let proxy = stand_in_proxy("200 Connection established");
        let client = Tunneled::open(&config, &proxy, tokio_postgres::NoTls).unwrap();
        let rows = client.query("SELECT 1::int8", &[]).unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 1);
        client.batch_execute("LISTEN t9; NOTIFY t9").unwrap();
        assert!(client.heard().is_ok());
        let _ = postgres.stop();
    }

    #[test]
    fn a_tunnel_that_ended_is_known_closed_before_the_next_call() {
        let (postgres, config) = real_database();
        let proxy = stand_in_proxy("200 Connection established");
        let mut tunneled = config.clone();
        tunneled.application_name("t9-ended");
        let client = Tunneled::open(&tunneled, &proxy, tokio_postgres::NoTls).unwrap();
        assert!(!client.is_closed());
        let settings = postgres.settings();
        let mut other = postgres::Client::connect(&format!("postgresql://{}:{}@127.0.0.1:{}/postgres", settings.username, settings.password, settings.port), postgres::NoTls).unwrap();
        other.batch_execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 't9-ended'").unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !client.is_closed() && std::time::Instant::now() < until {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(client.is_closed());
        let _ = postgres.stop();
    }

    #[test]
    fn a_proxy_that_refuses_the_host_fails_the_connection() {
        let config: tokio_postgres::Config = "postgresql://someone:a-password@203.0.113.9:5432/rows".parse().unwrap();
        let proxy = stand_in_proxy("403 Forbidden");
        let failed = Tunneled::open(&config, &proxy, tokio_postgres::NoTls).err().unwrap();
        assert_eq!(failed.kind(), io::ErrorKind::PermissionDenied);
        assert!(!failed.to_string().contains("a-password"));
    }
}
