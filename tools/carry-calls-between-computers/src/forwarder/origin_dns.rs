// src/forwarder/origin_dns.rs
//
// Purpose: The production resolver for a person's own domain (`origins::OriginProof`): the TXT strings at one DNS name,
// asked of the resolvers the forwarder's own system names, by hickory-resolver (the maintained DNS stub resolver), over
// plain DNS: UDP first and TCP when the answer was cut short.
//
// Non-Negotiable Invariants:
// - An answer is read only when it answers our own question (hickory checks the random id, the response flag and the
//   one question); this file builds and parses no DNS bytes.
// - Nothing is cached or written: every proof is read again when a row is taken (the forwarder stores nothing).
// - A refused, cut, malformed or late answer is no TXT strings at all, never a guess.
//
// Key Concepts:
// - DnsTxt: the resolver (hickory, built from the system's resolver settings, or from given servers) and how long one
//   question may wait in all.
// - txt: one TXT IN question for a fully qualified name; the TXT records of the answer, each record's character-strings
//   joined (RFC 7208 §3.3).
//
// Security Considerations:
// - A spoofed answer must guess the 16-bit random id and the source port; the proof it could fake names one account for
//   one domain, as the domain's own DNS does. The hosting owner chooses the resolvers (the system's, normally a local
//   validating resolver).
// - Every bound is DATA (origins.json `resolver`): at most `most_servers` resolvers, `wait_ms` in all; one answer is
//   at most the 65,535 bytes of a DNS message over TCP; one question is asked of one resolver at a time, once.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! The DNS TXT resolver the forwarder believes a person's own domain by.
//!
//! Old trillion read the `_trillion-verify` record through one vendor's DNS-over-HTTPS JSON
//! (`src/public-app-domains.mjs:61-69` `visibleTxt`: the answers of type 16, each with its quotes taken off). Here the
//! same question goes to the resolvers the forwarder's own system names, with no vendor in the design, through
//! hickory-resolver: the answers of type 16 are the TXT strings. The resolver is asynchronous; `OriginProof::txt` is
//! called from a blocking thread (`gateway.rs` `spawn_blocking`), so the question runs on one small runtime of its own.

use super::origins::OriginProof;
use hickory_resolver::{
    config::{ConnectionConfig, NameServerConfig, ResolveHosts, ResolverConfig, ResolverOpts},
    net::runtime::TokioRuntimeProvider,
    proto::rr::{Name, RData},
    system_conf::read_system_conf,
    Resolver, TokioResolver,
};
use serde::Deserialize;
use std::{net::SocketAddr, sync::OnceLock, time::Duration};
use tokio::runtime::Runtime;

/// The settings DATA beside this code (origins.json `resolver`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    wait_ms: u64,
    most_servers: usize,
}

#[derive(Deserialize)]
struct Outer {
    resolver: Settings,
}

pub(crate) fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| serde_json::from_slice::<Outer>(include_bytes!("origins.json")).map(|outer| outer.resolver)
        .expect("origins.json names a resolver"))
}

/// The one runtime the resolver's questions run on: one worker, started by the first resolver built.
fn runtime() -> std::io::Result<&'static Runtime> {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime);
    }
    let built = crate::io_operation!(tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build())?;
    Ok(RUNTIME.get_or_init(|| built))
}

/// The resolvers a TXT question is asked of, in order, and how long one question may wait in all.
#[derive(Clone)]
pub struct DnsTxt {
    resolver: TokioResolver,
    wait: Duration,
}

impl DnsTxt {
    /// The resolvers the system names (at most `most_servers`). None named: an error, so the hosting owner learns at
    /// start that no domain could be believed.
    pub fn system() -> std::io::Result<Self> {
        let (config, _) = crate::io_operation!((read_system_conf()).map_err(std::io::Error::other))?;
        let (_, _, mut servers) = config.into_parts();
        servers.truncate(settings().most_servers);
        if servers.is_empty() {
            return crate::io_operation!(Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no nameserver named")));
        }
        Self::with_servers(servers)
    }

    /// The resolvers at `servers`, each asked in turn until one answers, within `wait_ms` in all (each an even share of
    /// the time).
    pub fn new(servers: Vec<SocketAddr>) -> std::io::Result<Self> {
        Self::with_servers(servers.into_iter().map(|server| {
            let (mut udp, mut tcp) = (ConnectionConfig::udp(), ConnectionConfig::tcp());
            (udp.port, tcp.port) = (server.port(), server.port());
            NameServerConfig::new(server.ip(), true, vec![udp, tcp])
        }).collect())
    }

    fn with_servers(servers: Vec<NameServerConfig>) -> std::io::Result<Self> {
        let wait = Duration::from_millis(settings().wait_ms);
        let mut options = ResolverOpts::default();
        // One question to one resolver at a time, once, within its share of the wait; nothing kept, no hosts file.
        options.timeout = wait / u32::try_from(servers.len().max(1)).unwrap_or(u32::MAX);
        options.attempts = 1;
        options.num_concurrent_reqs = 1;
        options.cache_size = 0;
        options.use_hosts_file = ResolveHosts::Never;
        let runtime = runtime()?;
        // The resolver spawns its connection tasks where it is built.
        let resolver = runtime.block_on(async {
            Resolver::builder_with_config(ResolverConfig::from_name_servers(servers), TokioRuntimeProvider::default())
                .with_options(options)
                .build()
        }).map_err(std::io::Error::other);
        Ok(Self { resolver: crate::io_operation!(resolver)?, wait })
    }

    /// The TXT strings at `name` from the first resolver that answers it; none when no resolver answers.
    fn ask(&self, name: &str) -> Vec<String> {
        // Fully qualified, so the system's search list is never tried.
        let Ok(name) = Name::from_ascii(format!("{}.", name.trim_end_matches('.'))) else { return Vec::new() };
        let Ok(runtime) = runtime() else { return Vec::new() };
        let Ok(Ok(lookup)) = runtime.block_on(async { tokio::time::timeout(self.wait, self.resolver.txt_lookup(name)).await }) else {
            return Vec::new();
        };
        lookup.answers().iter().filter_map(|record| match &record.data {
            RData::TXT(txt) => Some(txt.txt_data.iter().flat_map(|part| part.iter().copied()).collect::<Vec<u8>>()),
            _ => None,
        }).map(|text| String::from_utf8_lossy(&text).into_owned()).collect()
    }
}

impl OriginProof for DnsTxt {
    fn txt(&self, name: &str) -> Vec<String> {
        self.ask(name)
    }
}

#[cfg(test)]
mod tests;
