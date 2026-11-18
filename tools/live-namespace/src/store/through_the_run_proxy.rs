// src/store/through_the_run_proxy.rs
//
// Purpose: The person's database reached by its address from a run the engine keeps in its sandbox. Such a run reaches the network
// only through the run's own loopback proxy, which the engine names in HTTPS_PROXY; the engine opens a CONNECT tunnel only to a host
// every value the run holds may go to (the vault entry's `hosts`), so a login never reaches another host. The Postgres client opens its
// own socket, so the link is handed a loopback relay instead: one listener on 127.0.0.1 that takes the client's one connection and
// joins it to one CONNECT tunnel to the database's host and port. The database's own TLS runs end to end through it, checked against
// the database's name (the config keeps `host`; only `hostaddr` and the port point at the relay).
//
// Non-Negotiable Invariants:
// - The relay listens on loopback only and takes exactly one connection; then it stops listening.
// - The proxy's answer is read up to its blank line and only a 200 opens the tunnel; any other answer closes the client's connection.
// - Nothing of the connection string is kept or printed here.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, TcpListener, TcpStream};

/// The config that reaches `config`'s database through the run's proxy at `proxy` (an http:// loopback address): the same login,
/// database and TLS name, with the TCP connection made to a relay this call starts.
pub(super) fn through_proxy(config: &postgres::Config, proxy: &str) -> io::Result<postgres::Config> {
    let host = match config.get_hosts().first() {
        Some(postgres::config::Host::Tcp(host)) => host.clone(),
        _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "the database connection names no host")),
    };
    let port = config.get_ports().first().copied().unwrap_or(5432);
    let proxy = proxy_address(proxy)?;
    let tls_name = host.clone();
    let relay = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let local = relay.local_addr()?.port();
    std::thread::spawn(move || {
        if let Ok((client, _)) = relay.accept() {
            drop(relay);
            match tunnel(&proxy, &host, port) {
                Ok(far) => join(client, far),
                Err(_) => {
                    let _ = client.shutdown(Shutdown::Both);
                }
            }
        }
    });
    // A Config's hosts and ports only grow, so the config is made again from the parts a connection uses.
    let mut through = postgres::Config::new();
    through.host(&tls_name);
    through.hostaddr(IpAddr::V4(Ipv4Addr::LOCALHOST)).port(local).ssl_mode(config.get_ssl_mode()).channel_binding(config.get_channel_binding());
    if let Some(user) = config.get_user() {
        through.user(user);
    }
    if let Some(password) = config.get_password() {
        through.password(password);
    }
    if let Some(database) = config.get_dbname() {
        through.dbname(database);
    }
    if let Some(options) = config.get_options() {
        through.options(options);
    }
    if let Some(name) = config.get_application_name() {
        through.application_name(name);
    }
    if let Some(timeout) = config.get_connect_timeout() {
        through.connect_timeout(*timeout);
    }
    Ok(through)
}

/// The proxy's host and port from its http:// address.
fn proxy_address(proxy: &str) -> io::Result<String> {
    let url = url::Url::parse(proxy).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the run's proxy is not an address"))?;
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => Ok(format!("{host}:{port}")),
        _ => Err(io::Error::new(io::ErrorKind::InvalidInput, "the run's proxy names no host and port")),
    }
}

/// One CONNECT tunnel through the proxy to `host:port`, open once the proxy answers 200.
fn tunnel(proxy: &str, host: &str, port: u16) -> io::Result<TcpStream> {
    let mut far = TcpStream::connect(proxy)?;
    far.set_nodelay(true)?;
    write!(far, "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n")?;
    // Read one byte at a time up to the blank line, so no byte of the database's own answer is taken into the head.
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

/// Copies each side to the other until either ends, then ends the other side's writing.
fn join(client: TcpStream, far: TcpStream) {
    let _ = client.set_nodelay(true);
    let (Ok(mut client_in), Ok(mut far_in)) = (client.try_clone(), far.try_clone()) else { return };
    let (mut client_out, mut far_out) = (client, far);
    std::thread::spawn(move || {
        let _ = io::copy(&mut client_in, &mut far_out);
        let _ = far_out.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut far_in, &mut client_out);
    let _ = client_out.shutdown(Shutdown::Write);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for the run's proxy: answers each CONNECT with `status`, and on 200 joins it to `to`.
    fn stand_in_proxy(status: &'static str, to: std::net::SocketAddr) -> String {
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
                assert!(String::from_utf8_lossy(&head).starts_with(&format!("CONNECT {to} HTTP/1.1\r\n")));
                write!(stream, "HTTP/1.1 {status}\r\n\r\n").unwrap();
                if status.starts_with("200") {
                    join(stream, TcpStream::connect(to).unwrap());
                }
            }
        });
        address
    }

    /// A stand-in database: answers each line it reads with the same line upper-cased.
    fn stand_in_database() -> std::net::SocketAddr {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut read = [0u8; 64];
                while let Ok(n) = stream.read(&mut read) {
                    if n == 0 {
                        break;
                    }
                    stream.write_all(&read[..n].to_ascii_uppercase()).unwrap();
                }
            }
        });
        address
    }

    fn config_for(database: std::net::SocketAddr) -> postgres::Config {
        format!("postgresql://someone:a-password@{}:{}/rows?options=-c%20search_path%3Dx", database.ip(), database.port()).parse().unwrap()
    }

    #[test]
    fn the_relay_joins_one_connection_to_the_database_through_the_proxy_and_keeps_the_login() {
        let database = stand_in_database();
        let proxy = stand_in_proxy("200 Connection established", database);
        let through = through_proxy(&config_for(database), &proxy).unwrap();
        assert_eq!(through.get_hosts(), &[postgres::config::Host::Tcp(database.ip().to_string())]);
        assert_eq!(through.get_hostaddrs(), &[IpAddr::V4(Ipv4Addr::LOCALHOST)]);
        assert_eq!((through.get_user(), through.get_password(), through.get_dbname()), (Some("someone"), Some(&b"a-password"[..]), Some("rows")));
        assert_eq!(through.get_options(), Some("-c search_path=x"));
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, through.get_ports()[0])).unwrap();
        client.write_all(b"select 1\n").unwrap();
        let mut answer = [0u8; 9];
        client.read_exact(&mut answer).unwrap();
        assert_eq!(&answer, b"SELECT 1\n");
        // The relay took its one connection and listens no more.
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, through.get_ports()[0])).is_err());
    }

    #[test]
    fn a_proxy_that_refuses_the_host_closes_the_connection() {
        let database = stand_in_database();
        let proxy = stand_in_proxy("403 Forbidden", database);
        let through = through_proxy(&config_for(database), &proxy).unwrap();
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, through.get_ports()[0])).unwrap();
        let _ = client.write_all(b"select 1\n");
        let mut answer = Vec::new();
        assert_eq!(client.read_to_end(&mut answer).unwrap_or(0), 0);
    }

    /// Live proof against a real database (not run by default): `LIVE_DATABASE_CONNECTION` holds a connection string, read from the
    /// vault and never printed. A stand-in proxy opens whatever CONNECT names, as the engine's does for a host the run's values may go to.
    #[test]
    #[ignore]
    fn a_real_database_answers_through_a_proxy_with_its_tls_checked() {
        let connection = std::env::var("LIVE_DATABASE_CONNECTION").expect("LIVE_DATABASE_CONNECTION");
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let proxy = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                }
                let target = String::from_utf8_lossy(&head).split(' ').nth(1).unwrap().to_owned();
                write!(stream, "HTTP/1.1 200 Connection established\r\n\r\n").unwrap();
                join(stream, TcpStream::connect(target).unwrap());
            }
        });
        std::env::set_var("HTTPS_PROXY", &proxy);
        let mut link = super::super::link::Link::postgres(&connection).unwrap_or_else(|error| panic!("the database did not answer through the proxy: {error:?}"));
        let rows = link.query("SELECT session_user::text, current_user::text", &[]).unwrap();
        // pg_stat_ssl shows a connection's row to its own login, so the role it acts as is set to none first (RESET ROLE would go back to the login's own default role).
        link.batch("SET ROLE NONE").unwrap();
        let ssl = link.query("SELECT ssl::text || ' ' || version FROM pg_stat_ssl WHERE pid = pg_backend_pid()", &[]).unwrap();
        eprintln!("session_user={:?} current_user={:?} ssl={:?}", rows[0][0], rows[0][1], ssl[0][0]);
        assert!(ssl[0][0].as_text().is_some_and(|text| text.starts_with("true TLS")));
    }
}
