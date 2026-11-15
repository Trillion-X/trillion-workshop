//! Runnable forwarder. The process owner supplies the listener address (`TRILLION_MCP_LISTEN`, the loopback address the
//! front door carries requests to), the public Host and the door's public origin (the OAuth authorization server the MCP
//! discovery names, `TRILLION_MCP_ISSUER_ORIGIN`) as nonsecret configuration. The front door in front of it (Workshop
//! tool start-a-computer, a layout's `caddy` row with `front_door`) holds TLS and its certificates; this program serves
//! plain HTTP and holds no key. A caller's bearer is checked by the one signed-in check (src/account/signed_in.rs: a JWT
//! the sign-in tool signed, against its JWKS), and the computer that answers the account admits it again for every
//! operation.
//! `TRILLION_MCP_ROOT_ACCOUNT`, when set, is the address of the account the account routes that name no account in
//! their path (src/forwarder/origins.json `root_account_paths`) go to. Unset, those paths answer 404.
// A module its host runs (.cargo/build-targets.json `host` = "module") has no process to start: its host calls the
// module computer's exports (src/native_entry/module_computer) instead, so this program is empty there.
#![cfg_attr(host = "module", no_main)]
#![cfg(not(host = "module"))]

use std::{env, io, net::TcpListener, sync::{atomic::AtomicBool, Arc}};
use trillion_local::forwarder::{gateway::Gateway, ingress::Ingress, origin_dns::DnsTxt};

fn required(name: &str) -> io::Result<String> {
    trillion_local::io_operation!(env::var(name).ok().filter(|value| !value.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "required public configuration absent")))
}

fn run() -> io::Result<()> {
    let listen = trillion_local::io_operation!(required("TRILLION_MCP_LISTEN"))?;
    let public_host = trillion_local::io_operation!(required("TRILLION_MCP_PUBLIC_HOST"))?;
    let issuer = trillion_local::io_operation!(required("TRILLION_MCP_ISSUER_ORIGIN"))?;
    let listener = trillion_local::io_operation!(TcpListener::bind(listen))?;
    let mut gateway = trillion_local::io_operation!(Gateway::with_door(public_host, &issuer, Arc::new(trillion_local::storage::time_source::RealClock))
        .map_err(io::Error::other))?;
    if let Some(address) = env::var("TRILLION_MCP_ROOT_ACCOUNT").ok().filter(|value| !value.is_empty()) {
        gateway = trillion_local::io_operation!(gateway.with_root_account(&address).map_err(|refusal| {
            let cause = trillion_local::refusal_cause::Caused::stored_cause(&refusal).unwrap_or_else(|| trillion_local::cause!());
            trillion_local::refusal_cause::locate_io(io::Error::new(io::ErrorKind::InvalidInput, refusal), cause)
        }))?;
    }
    // A person's own domain is believed by its TXT proof, read from the resolvers this system names
    // (src/forwarder/origin_dns.rs). None named: no such domain is believed, and the log says so once.
    match DnsTxt::system() {
        Ok(resolver) => gateway = gateway.with_origin_proof(Arc::new(resolver)),
        Err(error) => trillion_local::quiet_eprintln!("forwarder origins event=no-resolver error={:?}", error.kind()),
    }
    let ingress = trillion_local::io_operation!(Ingress::new(listener, Arc::new(gateway)))?;
    let stop = Arc::new(AtomicBool::new(false));
    trillion_local::io_operation!(ingress.serve(stop))
}

fn main() {
    if let Err(error) = run() {
        let cause = trillion_local::refusal_cause::stored_error_cause(&error).unwrap_or_else(|| trillion_local::cause!(condition: forwarder_unavailable));
        trillion_local::quiet_eprintln!("forwarder unavailable: {} cause={cause}", error.kind());
        std::process::exit(1);
    }
}
